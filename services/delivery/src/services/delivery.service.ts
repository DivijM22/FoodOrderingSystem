import type { KeyObject } from 'node:crypto';
import mongoose, { type ClientSession, type QueryFilter } from 'mongoose';
import {
  AppError,
  ConflictError,
  enqueueEvent,
  EventTypes,
  ForbiddenError,
  NotFoundError,
  sealedBox,
  type AuthUser,
  type EventData,
  type Logger,
} from '@food/common';
import { AccountBlockModel, isBlocked, type IAccountBlock } from '../models/account-block.model.js';
import { AgentModel, maskPhone, toAgentProfile, type AgentStatus, type IAgent } from '../models/agent.model.js';
import { ACTIVE_STATUSES, DeliveryModel, toAgentView, type DeliveryStatus, type IDelivery } from '../models/delivery.model.js';
import { OtpModel } from '../models/otp.model.js';
import { generateOtp, otpMatches, otpVerifier } from './otp.js';

export const SERVICE_NAME = 'delivery-service';

export interface DeliveryRules {
  preparationDelayMs: number;
  assignmentDelayMs: number;
  assignmentRetryMs: number;
  assignmentMaxAttempts: number;
  assignmentTimeoutMs: number;
  otpTtlMs: number;
  otpMaxAttempts: number;
  otpMaxIssues: number;
  otpResendCooldownMs: number;
}

type ConfirmedOrder = EventData<typeof EventTypes.OrderConfirmed>;

async function inTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

const iso = (d: Date) => d.toISOString();

/** Thrown inside a transaction to abort it (rolls back e.g. an agent reservation). */
class Abort extends Error {}

export class DeliveryService {
  constructor(
    private readonly rules: DeliveryRules,
    private readonly otpKey: string,
    private readonly notificationKey: KeyObject,
    private readonly logger: Logger,
    /** Called after a transaction that wrote outbox events commits (kicks the relay). */
    private readonly onCommitted: () => void = () => undefined,
  ) {}

  // ================================================================ event-driven creation / cancellation

  /**
   * order.confirmed → one delivery per order (unique orderId). A tombstone left by an earlier
   * cancellation/expiry wins: a delayed confirmation never starts a delivery for a closed order.
   */
  async createFromConfirmed(session: ClientSession, d: ConfirmedOrder, eventId: string): Promise<'created' | 'duplicate' | 'closed'> {
    const existing = await DeliveryModel.findOne({ orderId: d.orderId }).session(session).lean();
    if (existing) return existing.status === 'cancelled' ? 'closed' : 'duplicate';
    const now = new Date();
    await DeliveryModel.create(
      [
        {
          orderId: d.orderId,
          orderNumber: d.orderNumber,
          customerId: d.customerId,
          customerEmail: d.customerEmail,
          customerName: d.customerName,
          restaurantId: d.restaurantId,
          restaurantName: d.restaurantName,
          deliveryAddress: d.deliveryAddress,
          items: d.items.map((i) => ({ name: i.name, quantity: i.quantity })),
          status: 'preparing',
          sourceEventId: eventId,
          prepareReadyAt: new Date(now.getTime() + this.rules.preparationDelayMs),
          history: [{ status: 'preparing', at: now, by: 'order-service', note: 'Order confirmed; restaurant preparing' }],
        },
      ],
      { session },
    );
    return 'created';
  }

  /**
   * order.cancelled / order.expired → stop the delivery (release the agent, invalidate any OTP) and
   * publish delivery.cancelled. With no delivery yet, a tombstone blocks a later (delayed) confirmation.
   * A delivered order is never touched.
   */
  async closeForOrder(session: ClientSession, orderId: string, reason: string, eventId: string): Promise<'cancelled' | 'tombstoned' | 'ignored'> {
    const d = await DeliveryModel.findOne({ orderId }).session(session).lean();
    const now = new Date();
    if (!d) {
      await DeliveryModel.create(
        [{ orderId, status: 'cancelled', sourceEventId: eventId, tombstone: true, cancelledAt: now, cancellation: { reason, previousStatus: 'preparing' }, history: [{ status: 'cancelled', at: now, by: 'order-service', note: reason }] }],
        { session },
      );
      return 'tombstoned';
    }
    if (!ACTIVE_STATUSES.includes(d.status)) return 'ignored'; // already cancelled, or delivered
    const res = await DeliveryModel.updateOne(
      { _id: d._id, status: d.status },
      {
        $set: { status: 'cancelled', cancelledAt: now, cancellation: { reason, previousStatus: d.status } },
        $unset: { nextAssignAt: 1 },
        $push: { history: { status: 'cancelled', at: now, by: 'order-service', note: reason } },
      },
      { session },
    );
    if (res.modifiedCount !== 1) throw new Error('Delivery changed concurrently'); // retried by the broker
    if (d.agentId) await this.releaseAgent(session, d.agentId, d._id.toString(), false);
    await OtpModel.updateMany({ deliveryId: d._id.toString(), status: 'active' }, { $set: { status: 'cancelled' } }, { session });
    await this.emit(session, d, EventTypes.DeliveryCancelled, {
      deliveryId: d._id.toString(),
      orderId,
      previousStatus: d.status,
      reason,
      ...(d.agentId ? { agentId: d.agentId } : {}),
      cancelledAt: iso(now),
    });
    if (d.status === 'picked_up' || d.status === 'arrived') {
      this.logger.warn({ deliveryId: d._id, orderId, status: d.status }, 'Order cancelled after pickup; partner must return the order');
    }
    return 'cancelled';
  }

  // ================================================================ scheduler (persisted deadlines)

  /** Restaurant preparation finished (deadline passed) → ready for pickup. Returns how many moved. */
  async promoteReady(now = new Date(), limit = 20): Promise<number> {
    const due = await DeliveryModel.find({ status: 'preparing', prepareReadyAt: { $lte: now } }).sort({ prepareReadyAt: 1 }).limit(limit).lean();
    let moved = 0;
    for (const d of due) {
      const ok = await inTransaction(async (session) => {
        const at = new Date();
        const res = await DeliveryModel.updateOne(
          { _id: d._id, status: 'preparing' },
          {
            $set: {
              status: 'awaiting_partner',
              readyAt: at,
              nextAssignAt: new Date(at.getTime() + this.rules.assignmentDelayMs),
              assignmentDeadline: new Date(at.getTime() + this.rules.assignmentTimeoutMs),
              assignmentAttempts: 0,
            },
            $push: { history: { status: 'awaiting_partner', at, by: 'scheduler', note: 'Food ready; assigning a partner' } },
          },
          { session },
        );
        if (res.modifiedCount !== 1) return false; // cancelled or handled by another instance
        await this.emit(session, d, EventTypes.DeliveryReadyForPickup, {
          deliveryId: d._id.toString(),
          orderId: d.orderId,
          restaurantId: d.restaurantId ?? '',
          readyAt: iso(at),
        });
        return true;
      });
      if (ok) moved++;
    }
    if (moved) this.onCommitted();
    return moved;
  }

  /** Assign partners to deliveries whose next attempt is due. Returns how many were assigned. */
  async assignDue(now = new Date(), limit = 20): Promise<number> {
    const due = await DeliveryModel.find({ status: 'awaiting_partner', nextAssignAt: { $lte: now } }).sort({ nextAssignAt: 1 }).limit(limit).lean();
    let assigned = 0;
    for (const d of due) if ((await this.tryAssign(d, now)) === 'assigned') assigned++;
    return assigned;
  }

  /**
   * One assignment attempt: random available partner, reserved atomically (compare-and-set on the agent
   * and the delivery in one transaction). No partner → bounded retry; past the limit → assignment_failed.
   */
  async tryAssign(d: IDelivery, now = new Date()): Promise<'assigned' | 'retry' | 'failed' | 'skipped'> {
    const attempt = d.assignmentAttempts + 1;
    const exhausted = attempt > this.rules.assignmentMaxAttempts || (d.assignmentDeadline && d.assignmentDeadline.getTime() <= now.getTime());
    if (exhausted) {
      const failed = await inTransaction(async (session) => {
        const reason = `No delivery partner available after ${d.assignmentAttempts} attempts`;
        const res = await DeliveryModel.updateOne(
          { _id: d._id, status: 'awaiting_partner', assignmentAttempts: d.assignmentAttempts },
          { $set: { status: 'assignment_failed', failureReason: reason }, $unset: { nextAssignAt: 1 }, $push: { history: { status: 'assignment_failed', at: now, by: 'scheduler', note: reason } } },
          { session },
        );
        if (res.modifiedCount !== 1) return false;
        await this.emit(session, d, EventTypes.DeliveryAssignmentFailed, {
          deliveryId: d._id.toString(),
          orderId: d.orderId,
          attempts: Math.max(1, d.assignmentAttempts),
          reason,
          failedAt: iso(now),
        });
        return true;
      });
      if (failed) {
        this.onCommitted();
        this.logger.warn({ deliveryId: d._id, orderId: d.orderId }, 'Delivery assignment failed; needs an operator');
      }
      return failed ? 'failed' : 'skipped';
    }

    const candidates = await AgentModel.aggregate<{ _id: string; block: IAccountBlock[] }>([
      { $match: { status: 'available' } },
      { $sample: { size: 5 } },
      // Deactivated or deleted accounts (Auth events) never receive a new delivery.
      { $lookup: { from: AccountBlockModel.collection.name, localField: '_id', foreignField: '_id', as: 'block' } },
    ]).then((rows) => rows.filter((r) => !isBlocked(r.block[0])));
    let outcome: 'assigned' | 'retry' | 'skipped' = 'retry';
    try {
      outcome = await inTransaction(async (session) => {
        for (const c of candidates) {
          const agent = await AgentModel.findOneAndUpdate(
            { _id: c._id, status: 'available', activeDeliveryId: { $exists: false } },
            { $set: { status: 'busy', activeDeliveryId: d._id.toString(), lastAssignedAt: now } },
            { session, returnDocument: 'after' },
          ).lean();
          if (!agent) continue; // taken meanwhile; try the next candidate
          const phoneMasked = maskPhone(agent.phone);
          const res = await DeliveryModel.updateOne(
            { _id: d._id, status: 'awaiting_partner' },
            {
              $set: { status: 'partner_assigned', agentId: agent._id, agentName: agent.name, agentPhoneMasked: phoneMasked, assignedAt: now, assignmentAttempts: attempt },
              $unset: { nextAssignAt: 1 },
              $push: { history: { status: 'partner_assigned', at: now, by: 'scheduler', note: `Assigned to ${agent.name}` } },
            },
            { session },
          );
          if (res.modifiedCount !== 1) throw new Abort(); // cancelled meanwhile: roll back the reservation
          await this.emit(session, d, EventTypes.DeliveryPartnerAssigned, {
            deliveryId: d._id.toString(),
            orderId: d.orderId,
            agentId: agent._id,
            agentName: agent.name,
            agentPhoneMasked: phoneMasked,
            assignedAt: iso(now),
          });
          return 'assigned';
        }
        // Nobody free: schedule the next bounded attempt.
        const res = await DeliveryModel.updateOne(
          { _id: d._id, status: 'awaiting_partner', assignmentAttempts: d.assignmentAttempts },
          { $set: { assignmentAttempts: attempt, nextAssignAt: new Date(now.getTime() + this.rules.assignmentRetryMs) } },
          { session },
        );
        return res.modifiedCount === 1 ? 'retry' : 'skipped';
      });
    } catch (err) {
      // Abort: cancelled meanwhile. Duplicate key on activeDeliveryId: another instance assigned this
      // delivery first (the unique index is the last line of defence). Either way the reservation rolled back.
      if (err instanceof Abort || (err as { code?: number })?.code === 11000) return 'skipped';
      throw err;
    }
    if (outcome === 'assigned') {
      this.onCommitted();
      this.logger.info({ deliveryId: d._id, orderId: d.orderId }, 'Delivery partner assigned');
    } else if (outcome === 'retry') {
      this.logger.info({ deliveryId: d._id, attempt }, 'No delivery partner available; will retry');
    }
    return outcome;
  }

  // ================================================================ agent actions (REST)

  async pickup(user: AuthUser, id: string) {
    const d = await this.ownDelivery(user, id);
    if (d.status !== 'partner_assigned') throw this.stateError(d.status, 'pickup');
    const now = new Date();
    await inTransaction(async (session) => {
      const res = await DeliveryModel.updateOne(
        { _id: d._id, status: 'partner_assigned', agentId: user.id },
        { $set: { status: 'picked_up', pickedUpAt: now }, $push: { history: { status: 'picked_up', at: now, by: user.id, note: 'Picked up from the restaurant' } } },
        { session },
      );
      if (res.modifiedCount !== 1) throw new ConflictError('Delivery changed concurrently; refresh and retry', 'CONCURRENT_UPDATE');
      await this.emit(session, d, EventTypes.DeliveryPickedUp, { deliveryId: id, orderId: d.orderId, agentId: user.id, pickedUpAt: iso(now) });
    });
    this.onCommitted();
    return this.agentView(id);
  }

  /** Arrival commits, in one transaction: the milestone, the first OTP verifier and the sealed OTP command. */
  async arrive(user: AuthUser, id: string) {
    const d = await this.ownDelivery(user, id);
    if (d.status !== 'picked_up') throw this.stateError(d.status, 'arrive');
    const now = new Date();
    await inTransaction(async (session) => {
      const res = await DeliveryModel.updateOne(
        { _id: d._id, status: 'picked_up', agentId: user.id },
        {
          $set: { status: 'arrived', arrivedAt: now, otpIssues: 1, lastOtpIssuedAt: now },
          $push: { history: { status: 'arrived', at: now, by: user.id, note: 'Partner reached the customer' } },
        },
        { session },
      );
      if (res.modifiedCount !== 1) throw new ConflictError('Delivery changed concurrently; refresh and retry', 'CONCURRENT_UPDATE');
      const otpExpiresAt = await this.issueOtp(session, d, 1, now);
      await this.emit(session, d, EventTypes.DeliveryLocationReached, {
        deliveryId: id,
        orderId: d.orderId,
        agentId: user.id,
        reachedAt: iso(now),
        otpExpiresAt: iso(otpExpiresAt),
      });
    });
    this.onCommitted();
    return this.agentView(id);
  }

  /** Limited reissue (customer did not receive it, it expired, or attempts were exhausted). */
  async resendOtp(user: AuthUser, id: string) {
    const d = await this.ownDelivery(user, id);
    if (d.status !== 'arrived') throw this.stateError(d.status, 'resend');
    if (d.otpIssues >= this.rules.otpMaxIssues) {
      throw new AppError(429, 'OTP_RESEND_LIMIT', `No more codes can be issued for this delivery (limit ${this.rules.otpMaxIssues}); contact support`);
    }
    const now = new Date();
    const nextAllowed = (d.lastOtpIssuedAt?.getTime() ?? 0) + this.rules.otpResendCooldownMs;
    if (now.getTime() < nextAllowed) {
      throw new AppError(429, 'OTP_RESEND_TOO_SOON', `Please wait ${Math.ceil((nextAllowed - now.getTime()) / 1000)} s before requesting a new code`);
    }
    await inTransaction(async (session) => {
      const seq = d.otpIssues + 1;
      const res = await DeliveryModel.updateOne(
        { _id: d._id, status: 'arrived', otpIssues: d.otpIssues },
        { $set: { otpIssues: seq, lastOtpIssuedAt: now }, $push: { history: { status: 'arrived', at: now, by: user.id, note: `Delivery code reissued (#${seq})` } } },
        { session },
      );
      if (res.modifiedCount !== 1) throw new ConflictError('A new code was just issued; refresh and retry', 'CONCURRENT_UPDATE');
      await OtpModel.updateMany({ deliveryId: id, status: { $in: ['active', 'locked', 'expired'] } }, { $set: { status: 'superseded' } }, { session });
      await this.issueOtp(session, d, seq, now);
    });
    this.onCommitted();
    return this.agentView(id);
  }

  /**
   * Verifies the customer's code. The attempt is counted atomically BEFORE comparing, so concurrent
   * submissions can never exceed the limit; completion is a compare-and-set on the OTP and the delivery,
   * so it happens exactly once. delivery.completed is published only from here.
   */
  async verifyOtp(user: AuthUser, id: string, code: string) {
    const d = await this.ownDelivery(user, id);
    if (d.status === 'delivered') throw new ConflictError('This delivery is already completed', 'ALREADY_DELIVERED');
    if (d.status !== 'arrived') throw this.stateError(d.status, 'verify');

    const now = new Date();
    const otp = await OtpModel.findOneAndUpdate(
      { deliveryId: id, status: 'active', expiresAt: { $gt: now }, $expr: { $lt: ['$attempts', '$maxAttempts'] } },
      { $inc: { attempts: 1 } },
      { returnDocument: 'after' },
    )
      .select('+verifier')
      .lean();
    if (!otp) throw await this.otpUnavailable(id, now);

    if (!otpMatches(this.otpKey, id, otp.sequence, code, otp.verifier)) {
      const remaining = otp.maxAttempts - otp.attempts;
      if (remaining <= 0) {
        await OtpModel.updateOne({ _id: otp._id, status: 'active' }, { $set: { status: 'locked' } });
        throw new AppError(423, 'OTP_LOCKED', 'Too many incorrect codes. Request a new code for the customer.');
      }
      throw new AppError(422, 'OTP_INVALID', `Incorrect code. ${remaining} attempt(s) remaining.`, [{ path: 'otp', message: `${remaining} attempt(s) remaining` }]);
    }

    const completed = await inTransaction(async (session) => {
      const consumed = await OtpModel.updateOne({ _id: otp._id, status: 'active' }, { $set: { status: 'consumed', consumedAt: now } }, { session });
      if (consumed.modifiedCount !== 1) return false; // a concurrent correct submission won
      const res = await DeliveryModel.updateOne(
        { _id: d._id, status: 'arrived', agentId: user.id },
        { $set: { status: 'delivered', deliveredAt: now }, $push: { history: { status: 'delivered', at: now, by: user.id, note: 'Delivery code verified' } } },
        { session },
      );
      if (res.modifiedCount !== 1) throw new Abort();
      await this.releaseAgent(session, user.id, id, true);
      await this.emit(session, d, EventTypes.DeliveryCompleted, { deliveryId: id, orderId: d.orderId, agentId: user.id, deliveredAt: iso(now), otpVerified: true });
      return true;
    }).catch((err) => {
      if (err instanceof Abort) return false;
      throw err;
    });
    if (!completed) throw new ConflictError('This delivery is already completed', 'ALREADY_DELIVERED');
    this.onCommitted();
    this.logger.info({ deliveryId: id, orderId: d.orderId }, 'Delivery completed (code verified)');
    return this.agentView(id);
  }

  // ================================================================ agents

  /** The agent's own profile, created/updated from the verified JWT (never from body-supplied ids). */
  async upsertMe(user: AuthUser, input: { phone?: string; available?: boolean }) {
    await this.assertAccountUsable(user);
    const existing = await AgentModel.findById(user.id).lean();
    if (!existing && !input.phone) throw new AppError(422, 'PHONE_REQUIRED', 'A phone number is required to register as a delivery partner');
    if (input.available === false && existing?.status === 'busy') {
      throw new ConflictError('Finish your active delivery before going offline', 'AGENT_BUSY');
    }
    const set: Record<string, unknown> = { name: user.name, email: user.email };
    if (input.phone) set.phone = input.phone;
    if (input.available !== undefined && existing?.status !== 'busy') set.status = input.available ? 'available' : 'offline';
    const agent = await AgentModel.findOneAndUpdate({ _id: user.id }, { $set: set, $setOnInsert: { completedDeliveries: 0 } }, { upsert: true, returnDocument: 'after' }).lean();
    return toAgentProfile(agent!);
  }

  async getMe(user: AuthUser) {
    const agent = await AgentModel.findById(user.id).lean();
    if (!agent) throw new NotFoundError('You are not registered as a delivery partner yet (PUT /deliveries/agents/me)');
    return { ...toAgentProfile(agent), activeDelivery: agent.activeDeliveryId ? await this.agentView(agent.activeDeliveryId) : null };
  }

  async listAgents(status?: AgentStatus) {
    const filter: QueryFilter<IAgent> = status ? { status } : {};
    const agents = await AgentModel.find(filter).sort({ name: 1 }).lean<IAgent[]>();
    return agents.map(toAgentProfile);
  }

  /**
   * auth.user.deactivated / auth.user.deleted for a delivery agent: block new assignments and take the agent offline
   * unless they hold a delivery (that one stays theirs and they go offline when it is released). Idempotent; a
   * delayed deactivation older than a re-enable is ignored by `isBlocked`. Returns the delivery still held, if any.
   */
  async blockAgent(userId: string, at: Date, kind: 'disabled' | 'deleted'): Promise<string | null> {
    const field = kind === 'deleted' ? { $min: { deletedAt: at } } : { $max: { disabledAt: at } };
    const block = await AccountBlockModel.findOneAndUpdate({ _id: userId }, field, { upsert: true, returnDocument: 'after' }).lean();
    if (!isBlocked(block)) return null;
    await AgentModel.updateOne({ _id: userId, status: { $ne: 'busy' } }, { $set: { status: 'offline' } });
    const agent = await AgentModel.findById(userId, { activeDeliveryId: 1 }).lean();
    return agent?.activeDeliveryId ?? null;
  }

  /**
   * A deleted agent can never register or go available again. A deactivated one can only after logging in again
   * (a token issued after the deactivation, which Auth grants only to a reactivated account).
   */
  private async assertAccountUsable(user: AuthUser) {
    const block = await AccountBlockModel.findById(user.id).lean();
    if (!isBlocked(block)) return;
    if (block!.deletedAt) throw new AppError(403, 'ACCOUNT_DELETED', 'This account has been deleted');
    if (user.issuedAt && user.issuedAt > block!.disabledAt!) {
      await AccountBlockModel.updateOne({ _id: user.id }, { $max: { reenabledAt: user.issuedAt } });
      return;
    }
    throw new AppError(403, 'ACCOUNT_DISABLED', 'This account has been deactivated. Sign in again after it is reactivated.');
  }

  // ================================================================ reads + operator actions

  async get(user: AuthUser, id: string) {
    if (user.role === 'platform_admin') return this.agentView(id);
    await this.ownDelivery(user, id);
    return this.agentView(id);
  }

  async getByOrder(orderId: string) {
    const d = await DeliveryModel.findOne({ orderId }).lean();
    if (!d) throw new NotFoundError('Delivery not found');
    return this.agentView(d._id.toString());
  }

  async list(user: AuthUser, q: { status?: DeliveryStatus; page: number; limit: number }) {
    const filter: QueryFilter<IDelivery> = { tombstone: false };
    if (q.status) filter.status = q.status;
    if (user.role === 'delivery_agent') filter.agentId = user.id;
    const [rows, total] = await Promise.all([
      DeliveryModel.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
      DeliveryModel.countDocuments(filter),
    ]);
    return { deliveries: rows.map((d) => toAgentView(d)), total };
  }

  /** Operator: put an assignment_failed delivery back into the assignment queue (no automatic refunds). */
  async retryAssignment(id: string) {
    const now = new Date();
    const res = await DeliveryModel.updateOne(
      { _id: id, status: 'assignment_failed' },
      {
        $set: { status: 'awaiting_partner', nextAssignAt: now, assignmentDeadline: new Date(now.getTime() + this.rules.assignmentTimeoutMs), assignmentAttempts: 0 },
        $unset: { failureReason: 1 },
        $push: { history: { status: 'awaiting_partner', at: now, by: 'platform_admin', note: 'Assignment retried by an operator' } },
      },
    );
    if (res.modifiedCount !== 1) throw new ConflictError('Only a delivery whose assignment failed can be retried', 'DELIVERY_NOT_RETRYABLE');
    return this.agentView(id);
  }

  // ================================================================ internals

  private async issueOtp(session: ClientSession, d: IDelivery, sequence: number, now: Date): Promise<Date> {
    if (!d.customerEmail) throw new AppError(409, 'CUSTOMER_EMAIL_MISSING', 'No customer email on record for this delivery');
    const code = generateOtp();
    const expiresAt = new Date(now.getTime() + this.rules.otpTtlMs);
    const deliveryId = d._id.toString();
    // The code exists only in this scope: sealed for the Notification Service, stored as a keyed verifier.
    const notificationEventId = await enqueueEvent(session, {
      source: SERVICE_NAME,
      eventType: EventTypes.DeliveryOtpNotification,
      aggregateId: d.orderId,
      data: {
        deliveryId,
        orderId: d.orderId,
        orderNumber: d.orderNumber ?? '',
        customerId: d.customerId ?? '',
        customerEmail: d.customerEmail,
        customerName: d.customerName ?? 'Customer',
        agentName: d.agentName ?? 'Your delivery partner',
        otpSequence: sequence,
        otpCiphertext: sealedBox.seal(code, this.notificationKey),
        otpExpiresAt: iso(expiresAt),
      },
    });
    await OtpModel.create(
      [{ deliveryId, sequence, verifier: otpVerifier(this.otpKey, deliveryId, sequence, code), maxAttempts: this.rules.otpMaxAttempts, issuedAt: now, expiresAt, notificationEventId }],
      { session },
    );
    return expiresAt;
  }

  /** Why no OTP could be checked: expired, locked, or none issued. Marks an expired one as such. */
  private async otpUnavailable(deliveryId: string, now: Date): Promise<AppError> {
    const latest = await OtpModel.findOne({ deliveryId }).sort({ sequence: -1 }).lean();
    if (!latest) return new ConflictError('No delivery code has been issued', 'OTP_NOT_ISSUED');
    if (latest.status === 'active' && latest.expiresAt.getTime() <= now.getTime()) {
      await OtpModel.updateOne({ _id: latest._id, status: 'active' }, { $set: { status: 'expired' } });
      return new AppError(410, 'OTP_EXPIRED', 'The delivery code has expired. Request a new code for the customer.');
    }
    if (latest.status === 'expired') return new AppError(410, 'OTP_EXPIRED', 'The delivery code has expired. Request a new code for the customer.');
    if (latest.status === 'consumed') return new ConflictError('This delivery is already completed', 'ALREADY_DELIVERED');
    return new AppError(423, 'OTP_LOCKED', 'Too many incorrect codes. Request a new code for the customer.');
  }

  private async releaseAgent(session: ClientSession, agentId: string, deliveryId: string, completed: boolean) {
    const blocked = isBlocked(await AccountBlockModel.findById(agentId).session(session).lean());
    await AgentModel.updateOne(
      { _id: agentId, activeDeliveryId: deliveryId },
      { $set: { status: blocked ? 'offline' : 'available', lastReleasedAt: new Date() }, $unset: { activeDeliveryId: 1 }, ...(completed ? { $inc: { completedDeliveries: 1 } } : {}) },
      { session },
    );
  }

  /** Assigned agent only. Anyone else (including other agents) gets 404, so delivery ids are not probeable. */
  private async ownDelivery(user: AuthUser, id: string): Promise<IDelivery> {
    if (user.role !== 'delivery_agent') throw new ForbiddenError('Only the assigned delivery partner can do this');
    const d = mongoose.isValidObjectId(id) ? await DeliveryModel.findById(id).lean() : null;
    if (!d || d.agentId !== user.id) throw new NotFoundError('Delivery not found');
    return d;
  }

  private stateError(status: DeliveryStatus, action: 'pickup' | 'arrive' | 'verify' | 'resend'): AppError {
    if (status === 'cancelled') return new ConflictError('This delivery was cancelled', 'DELIVERY_CANCELLED');
    if (status === 'delivered') return new ConflictError('This delivery is already completed', 'ALREADY_DELIVERED');
    const rank = ['preparing', 'awaiting_partner', 'partner_assigned', 'picked_up', 'arrived'].indexOf(status);
    switch (action) {
      case 'pickup':
        return rank > 2 ? new ConflictError('The order has already been picked up', 'DELIVERY_ALREADY_PICKED_UP') : new ConflictError(`Cannot pick up a delivery that is ${status.replaceAll('_', ' ')}`, 'INVALID_DELIVERY_STATE');
      case 'arrive':
        return rank > 3 ? new ConflictError('Arrival was already recorded', 'DELIVERY_ALREADY_ARRIVED') : new ConflictError('Pick the order up before marking arrival', 'DELIVERY_NOT_PICKED_UP');
      default:
        return new ConflictError('The partner has not reached the customer yet', 'DELIVERY_NOT_ARRIVED');
    }
  }

  private async agentView(id: string) {
    const d = await DeliveryModel.findById(id).lean();
    if (!d) throw new NotFoundError('Delivery not found');
    const otp = await OtpModel.findOne({ deliveryId: id }).sort({ sequence: -1 }).lean();
    return toAgentView(d, otp);
  }

  private async emit<T extends Parameters<typeof enqueueEvent>[1]['eventType']>(session: ClientSession, d: IDelivery, eventType: T, data: EventData<T>) {
    await enqueueEvent(session, { source: SERVICE_NAME, eventType, aggregateId: d.orderId, data });
  }

}
