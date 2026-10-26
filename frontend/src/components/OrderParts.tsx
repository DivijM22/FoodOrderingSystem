import { useState } from 'react';
import { ordersApi } from '../api/orders';
import type { Order, OrderStatus, Tracking } from '../api/types';
import { dateTime, humanize, rupees, time } from '../format';
import type { TrackingMode } from './useTracking';
import { Badge, ConfirmDialog, ErrorBox, Field, VegMark } from './ui';

/** Items and server-calculated amounts of an order. */
export function OrderSummary({ order }: { order: Order }) {
  return (
    <div className="card">
      <div className="spread">
        <h2>{order.restaurantName}</h2>
        <span className="muted">Placed {dateTime(order.createdAt)}</span>
      </div>
      <table>
        <tbody>
          {order.items.map((i) => (
            <tr key={i.menuItemId}>
              <td>
                {i.isVeg !== undefined && <VegMark isVeg={i.isVeg} />} {i.quantity} × {i.name} <span className="muted">@ {rupees(i.unitPrice)}</span>
              </td>
              <td className="right">{rupees(i.lineTotal)}</td>
            </tr>
          ))}
          <tr>
            <td className="muted">Items subtotal</td>
            <td className="right">{rupees(order.subtotal)}</td>
          </tr>
          <tr>
            <td className="muted">Delivery fee</td>
            <td className="right">{rupees(order.deliveryFee)}</td>
          </tr>
          <tr>
            <th>{order.billing ? 'Order total (before discounts)' : 'Order total'}</th>
            <th className="right">{rupees(order.provisionalTotal)}</th>
          </tr>
          {order.billing && (
            <tr>
              <th>Final amount (invoice {order.billing.invoiceNumber})</th>
              <th className="right">{rupees(order.billing.finalAmount)}</th>
            </tr>
          )}
        </tbody>
      </table>
      <p className="muted small-print">
        Deliver to: {[order.deliveryAddress.line1, order.deliveryAddress.landmark, order.deliveryAddress.city, order.deliveryAddress.pincode].filter(Boolean).join(', ')}
      </p>
      {order.notes && <p className="muted small-print">Notes: {order.notes}</p>}
      {order.cancellation && (
        <p className="small-print">
          Cancelled by {order.cancellation.role ? humanize(order.cancellation.role) : 'the platform'}: {order.cancellation.reason}
        </p>
      )}
    </div>
  );
}

const MODE_LABEL: Record<TrackingMode, string> = { connecting: 'Connecting…', live: 'Live', polling: 'Refreshing every few seconds', ended: 'Final' };

/** Progress steps, delivery partner and the authoritative status history from the Order Service. */
export function TrackingPanel({ tracking, mode }: { tracking: Tracking | null; mode: TrackingMode }) {
  if (!tracking) return <div className="card muted">Loading order progress…</div>;
  const closed = tracking.status === 'cancelled' || tracking.status === 'expired';
  return (
    <div className="card">
      <div className="spread">
        <h2>Order progress</h2>
        <span className="muted small-print">{MODE_LABEL[mode]}</span>
      </div>
      <div className="row">
        <Badge value={tracking.status} label={tracking.statusLabel} />
        <span className="muted">Payment:</span> <Badge value={tracking.paymentStatus} />
      </div>
      {closed ? (
        <p className="muted">This order is {tracking.status}. No further delivery steps will happen.</p>
      ) : (
        <ol className="steps">
          {tracking.steps.map((s) => (
            <li key={s.status} className={`${s.reached ? 'done' : ''} ${s.current ? 'current' : ''}`}>
              <span className="step-label">{s.label}</span>
              {s.at && <span className="muted small-print">{time(s.at)}</span>}
            </li>
          ))}
        </ol>
      )}
      {tracking.deliveryPartner && (
        <p>
          Delivery partner: <b>{tracking.deliveryPartner.name}</b>
          {tracking.deliveryPartner.phoneMasked && <span className="muted"> · {tracking.deliveryPartner.phoneMasked}</span>}
        </p>
      )}
      {tracking.status === 'location_reached' && (
        <p className="alert info">
          Your delivery partner has arrived. Share the 6-digit delivery code from your email with them
          {tracking.deliveryCodeExpiresAt ? ` (valid until ${time(tracking.deliveryCodeExpiresAt)})` : ''}.
        </p>
      )}
      {tracking.deliveryIssue && <p className="alert warning">Delivery issue: {tracking.deliveryIssue}. Our team will follow up.</p>}
      <details>
        <summary>Status history ({tracking.history.length})</summary>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Status</th>
                <th>Recorded by</th>
              </tr>
            </thead>
            <tbody>
              {tracking.history.map((h, i) => (
                <tr key={i}>
                  <td>{dateTime(h.at)}</td>
                  <td>
                    {humanize(h.status)}
                    {h.note ? <span className="muted"> · {h.note}</span> : null}
                  </td>
                  <td className="muted">{h.sourceService ?? h.role ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/** Statuses from which each kind of actor may cancel (mirrors the Order Service's CANCELLABLE_BY; the server decides). */
const CANCELLABLE: Record<'customer' | 'restaurant_admin' | 'platform_admin', OrderStatus[]> = {
  customer: ['pending_payment', 'confirmed'],
  restaurant_admin: ['pending_payment', 'confirmed', 'assigning_delivery_partner'],
  platform_admin: ['pending_payment', 'confirmed', 'assigning_delivery_partner', 'partner_assigned'],
};

export function canCancel(role: keyof typeof CANCELLABLE, status: OrderStatus) {
  return CANCELLABLE[role].includes(status);
}

export function CancelOrder({ orderId, paid, onCancelled }: { orderId: string; paid: boolean; onCancelled: (o: Order) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  return (
    <>
      <button type="button" className="secondary" onClick={() => setOpen(true)}>
        Cancel order
      </button>
      <ConfirmDialog
        open={open}
        title="Cancel this order?"
        danger
        confirmLabel="Cancel order"
        onCancel={() => {
          setOpen(false);
          setError(null);
        }}
        onConfirm={async () => {
          if (reason.trim().length < 3) return setError(new Error('Please enter a reason (at least 3 characters).'));
          try {
            const { data } = await ordersApi.cancel(orderId, reason.trim());
            setOpen(false);
            onCancelled(data);
          } catch (err) {
            setError(err);
          }
        }}
      >
        <p>{paid ? 'The payment will be refunded automatically.' : 'Nothing has been charged for this order.'}</p>
        <Field label="Reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} autoFocus />
        <ErrorBox error={error} />
      </ConfirmDialog>
    </>
  );
}
