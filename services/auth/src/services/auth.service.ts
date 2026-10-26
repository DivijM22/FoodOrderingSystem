import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import {
  AppError,
  ConflictError,
  enqueueEvent,
  EventTypes,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  signAccessToken,
  type JwtOptions,
  type Role,
} from '@food/common';
import type { z } from 'zod';
import { AgentDeliveryModel, LockModel } from '../models/agent-delivery.model.js';
import { UserModel, toPublicUser, type UserDocument } from '../models/user.model.js';
import type { addressInput } from '../schemas.js';

export interface AuthServiceOptions {
  jwt: JwtOptions & { expiresIn: string };
  bcryptRounds: number;
  /** Called after a transaction that wrote outbox events commits (kicks the outbox relay). */
  onEventsCommitted?: () => void;
}

type Address = z.infer<typeof addressInput>;

export class AuthService {
  /** Hash compared against when the email is unknown, so response time does not reveal which emails exist. */
  private readonly dummyHash: string;

  constructor(private readonly opts: AuthServiceOptions) {
    this.dummyHash = bcrypt.hashSync('dummy-password-for-timing', opts.bcryptRounds);
  }

  async register(input: { name: string; email: string; password: string; phone?: string }) {
    return this.createUser({ ...input, role: 'customer' });
  }

  async createUser(input: { name: string; email: string; password: string; phone?: string; role: Role }) {
    if (await UserModel.exists({ email: input.email })) {
      throw new ConflictError('An account with this email already exists', 'EMAIL_TAKEN');
    }
    const passwordHash = await bcrypt.hash(input.password, this.opts.bcryptRounds);
    try {
      const user = await UserModel.create({
        name: input.name,
        email: input.email,
        phone: input.phone,
        role: input.role,
        passwordHash,
      });
      return toPublicUser(user);
    } catch (err) {
      // Lost a race with a concurrent registration for the same email.
      if ((err as { code?: number }).code === 11000) {
        throw new ConflictError('An account with this email already exists', 'EMAIL_TAKEN');
      }
      throw err;
    }
  }

  async login(email: string, password: string) {
    const user = await UserModel.findOne({ email }).select('+passwordHash');
    const valid = await bcrypt.compare(password, user?.passwordHash ?? this.dummyHash);
    if (!user || !valid) throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
    if (!user.isActive) throw new ForbiddenError('This account has been deactivated');

    user.lastLoginAt = new Date();
    await user.save();
    return { accessToken: this.issueToken(user), tokenType: 'Bearer' as const, expiresIn: this.opts.jwt.expiresIn, user: toPublicUser(user) };
  }

  async getProfile(userId: string) {
    return toPublicUser(await this.findActive(userId));
  }

  async updateProfile(userId: string, changes: { name?: string; phone?: string; addresses?: Address[] }) {
    const user = await this.findActive(userId);
    if (changes.name !== undefined) user.name = changes.name;
    if (changes.phone !== undefined) user.phone = changes.phone;
    if (changes.addresses !== undefined) user.set('addresses', changes.addresses);
    await user.save();
    return toPublicUser(user);
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await UserModel.findById(userId).select('+passwordHash');
    if (!user || !user.isActive) throw new NotFoundError('User not found');
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw new UnauthorizedError('Current password is incorrect', 'INVALID_CREDENTIALS');
    }
    user.passwordHash = await bcrypt.hash(newPassword, this.opts.bcryptRounds);
    await user.save();
  }

  async listUsers(filter: { role?: Role; page: number; limit: number }) {
    const query = filter.role ? { role: filter.role } : {};
    const [users, total] = await Promise.all([
      UserModel.find(query).sort({ createdAt: -1 }).skip((filter.page - 1) * filter.limit).limit(filter.limit),
      UserModel.countDocuments(query),
    ]);
    return { users: users.map(toPublicUser), total };
  }

  /**
   * Activates or deactivates an account. A real deactivation (active → inactive) is a compare-and-set that commits
   * together with `auth.user.deactivated.v1` in the outbox, so the event exists exactly when the change happened;
   * deactivating an already-inactive account publishes nothing. Reactivation publishes nothing: restaurant
   * assignments removed on deactivation are never restored automatically. The last active platform admin cannot be
   * deactivated (409 LAST_ACTIVE_ADMIN); concurrent admin deactivations serialize on a lock document.
   */
  async setActive(actorId: string, userId: string, isActive: boolean) {
    if (actorId === userId && !isActive) throw new ForbiddenError('You cannot deactivate your own account');
    if (isActive) {
      const user = await UserModel.findByIdAndUpdate(userId, { isActive: true }, { returnDocument: 'after' });
      if (!user) throw new NotFoundError('User not found');
      return toPublicUser(user);
    }
    const session = await mongoose.startSession();
    let published = false;
    try {
      let result!: UserDocument;
      await session.withTransaction(async () => {
        published = false;
        const deactivatedAt = new Date();
        const target = await UserModel.findById(userId).session(session);
        if (target?.role === 'platform_admin' && target.isActive) await this.assertAnotherActiveAdmin(session, userId);
        const changed = await UserModel.findOneAndUpdate({ _id: userId, isActive: true }, { $set: { isActive: false } }, { returnDocument: 'after', session });
        if (!changed) {
          const existing = await UserModel.findById(userId).session(session);
          if (!existing) throw new NotFoundError('User not found');
          result = existing; // already inactive: no redundant event
          return;
        }
        await enqueueEvent(session, {
          source: 'auth-service',
          eventType: EventTypes.AuthUserDeactivated,
          aggregateId: changed._id.toString(),
          data: { userId: changed._id.toString(), role: changed.role, deactivatedAt: deactivatedAt.toISOString(), deactivatedBy: actorId },
        });
        result = changed;
        published = true;
      });
      if (published) this.opts.onEventsCommitted?.();
      return toPublicUser(result);
    } finally {
      await session.endSession();
    }
  }

  /**
   * Permanently deletes an INACTIVE account. The delete and `auth.user.deleted.v1` commit together in one transaction
   * (outbox), so the event exists exactly when an account was removed. Refused when: the target is the caller (403),
   * the caller is no longer an active platform admin in this database (403, covers a still-valid JWT of a deactivated
   * admin), the target does not exist (404, also for a repeated request), the target is active (409 USER_ACTIVE), or a
   * delivery agent still holds an active delivery (409 AGENT_HAS_ACTIVE_DELIVERY, from the event-fed projection).
   * Deleting an inactive platform admin cannot reduce the number of active admins, and the caller is one.
   */
  async deleteUser(actorId: string, userId: string) {
    if (actorId === userId) throw new AppError(403, 'CANNOT_DELETE_SELF', 'You cannot delete your own account');
    const session = await mongoose.startSession();
    try {
      let result!: { id: string; role: Role; deletedAt: string };
      await session.withTransaction(async () => {
        const actor = await UserModel.exists({ _id: actorId, role: 'platform_admin', isActive: true }).session(session);
        if (!actor) throw new AppError(403, 'ACTOR_NOT_ACTIVE', 'Your administrator account is no longer active');
        const target = await UserModel.findById(userId).session(session);
        if (!target) throw new NotFoundError('User not found');
        if (target.isActive) throw new ConflictError('Deactivate the account before deleting it', 'USER_ACTIVE');
        if (target.role === 'delivery_agent' && (await AgentDeliveryModel.exists({ agentId: userId, active: true }).session(session))) {
          throw new ConflictError('This delivery agent still has an active delivery. Delete the account once it is completed or cancelled.', 'AGENT_HAS_ACTIVE_DELIVERY');
        }
        // Compare-and-delete: a concurrent reactivation or deletion makes this match nothing (write conflict → retry → 404/409).
        const res = await UserModel.deleteOne({ _id: userId, isActive: false }, { session });
        if (res.deletedCount !== 1) throw new NotFoundError('User not found');
        const deletedAt = new Date().toISOString();
        await enqueueEvent(session, {
          source: 'auth-service',
          eventType: EventTypes.AuthUserDeleted,
          aggregateId: userId,
          data: { userId, role: target.role, deletedAt },
        });
        result = { id: userId, role: target.role, deletedAt };
      });
      this.opts.onEventsCommitted?.();
      return result;
    } finally {
      await session.endSession();
    }
  }

  /** delivery.partner_assigned → the agent holds the delivery (unless it was already seen closed). Idempotent. */
  async recordAgentDelivery(deliveryId: string, agentId: string) {
    await AgentDeliveryModel.updateOne({ _id: deliveryId }, { $setOnInsert: { agentId, active: true, updatedAt: new Date() } }, { upsert: true });
  }

  /** delivery.completed / delivery.cancelled → the delivery is closed for good. Idempotent. */
  async closeAgentDelivery(deliveryId: string, agentId: string) {
    await AgentDeliveryModel.updateOne({ _id: deliveryId }, { $set: { active: false, updatedAt: new Date() }, $setOnInsert: { agentId } }, { upsert: true });
  }

  /** Creates the bootstrap platform admin if it does not exist yet. Returns true when created. */
  async ensureAdmin(input: { email: string; password: string; name: string }): Promise<boolean> {
    const email = input.email.toLowerCase();
    if (await UserModel.exists({ email })) return false;
    await this.createUser({ ...input, email, role: 'platform_admin' });
    return true;
  }

  /** Inside a transaction: bump the shared lock (serializes concurrent admin deactivations), then require another active admin. */
  private async assertAnotherActiveAdmin(session: mongoose.ClientSession, exceptUserId: string) {
    await LockModel.updateOne({ _id: 'platform-admins' }, { $inc: { version: 1 } }, { upsert: true, session });
    const others = await UserModel.countDocuments({ role: 'platform_admin', isActive: true, _id: { $ne: exceptUserId } }).session(session);
    if (others === 0) throw new ConflictError('At least one active platform administrator must remain', 'LAST_ACTIVE_ADMIN');
  }

  private issueToken(user: UserDocument): string {
    return signAccessToken(
      { id: user._id.toString(), email: user.email, role: user.role, name: user.name },
      this.opts.jwt,
    );
  }

  private async findActive(userId: string) {
    const user = await UserModel.findById(userId);
    if (!user || !user.isActive) throw new NotFoundError('User not found');
    return user;
  }
}
