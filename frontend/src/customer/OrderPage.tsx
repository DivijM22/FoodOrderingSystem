import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError } from '../api/client';
import { billingApi, ordersApi, paymentsApi } from '../api/orders';
import type { Invoice, Order, Payment } from '../api/types';
import { CancelOrder, OrderSummary, TrackingPanel, canCancel } from '../components/OrderParts';
import { AsyncButton, Badge, ErrorBox, Loading, Notice, PageHeader } from '../components/ui';
import { useAsync } from '../components/useAsync';
import { useTracking } from '../components/useTracking';
import { dateTime, rupees } from '../format';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function OrderPage() {
  const { id = '' } = useParams();
  const order = useAsync(async () => (await ordersApi.get(id)).data, [id]);
  const { tracking, mode } = useTracking(id);
  const [cancelled, setCancelled] = useState<string | null>(null);

  // Keep the order details (amounts, billing, cancellation) in step with the live status.
  const { reload } = order;
  useEffect(() => {
    if (tracking && order.data && (tracking.status !== order.data.status || tracking.paymentStatus !== order.data.paymentStatus)) void reload();
    // Only when the live status changes; the order itself is compared inside.
  }, [tracking?.status, tracking?.paymentStatus]);

  if (order.loading && !order.data) return <Loading />;
  if (!order.data) return <ErrorBox error={order.error ?? new Error('Order not found')} onRetry={order.reload} />;
  const o: Order = order.data;
  const status = tracking?.status ?? o.status;
  const paymentStatus = tracking?.paymentStatus ?? o.paymentStatus;

  return (
    <>
      <p>
        <Link to="/orders">← My orders</Link>
      </p>
      <PageHeader title={`Order ${o.orderNumber}`}>
        {canCancel('customer', status) && (
          <CancelOrder
            orderId={o.id}
            paid={paymentStatus === 'paid'}
            onCancelled={(c) => {
              order.setData(c);
              setCancelled(c.paymentStatus === 'refund_pending' ? 'Order cancelled. Your refund is being processed.' : 'Order cancelled.');
            }}
          />
        )}
      </PageHeader>
      {cancelled && <Notice kind="success">{cancelled}</Notice>}
      <div className="two-col">
        <div>
          <TrackingPanel tracking={tracking} mode={mode} />
          <OrderSummary order={o} />
        </div>
        <div>
          {/* Re-read when the payment outcome changes (paid, refunded): the invoice status is derived from the ledger. */}
          <InvoicePanel key={paymentStatus} orderId={o.id} />
          {status === 'pending_payment' && <PaymentPanel order={o} expiresAt={tracking?.expiresAt ?? o.expiresAt ?? null} />}
          {status !== 'pending_payment' && <PaymentStatus orderId={o.id} paymentStatus={paymentStatus} />}
        </div>
      </div>
    </>
  );
}

/** The Billing Service's invoice: the authoritative amount. Issued asynchronously, so it may take a moment. */
function InvoicePanel({ orderId }: { orderId: string }) {
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [waiting, setWaiting] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    setWaiting(true);
    for (let i = 0; i < 15; i++) {
      try {
        setInvoice((await billingApi.invoiceForOrder(orderId)).data);
        setWaiting(false);
        return;
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 404)) {
          setError(err);
          setWaiting(false);
          return;
        }
      }
      await sleep(1000);
    }
    setWaiting(false);
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="card">
      <h2>Invoice</h2>
      <ErrorBox error={error} onRetry={load} />
      {!invoice && waiting && <p className="muted">Preparing your invoice…</p>}
      {!invoice && !waiting && !error && (
        <p className="muted">
          The invoice is not ready yet.{' '}
          <button type="button" className="link" onClick={load}>
            Check again
          </button>
        </p>
      )}
      {invoice && (
        <>
          <table>
            <tbody>
              {invoice.lines.map((l, i) => (
                <tr key={i}>
                  <td>{l.kind === 'item' ? `${l.quantity} × ${l.description}` : l.description}</td>
                  <td className="right">{rupees(l.lineTotal)}</td>
                </tr>
              ))}
              {invoice.discountAmount > 0 && (
                <tr>
                  <td>Discount {invoice.discount?.code}</td>
                  <td className="right">− {rupees(invoice.discountAmount)}</td>
                </tr>
              )}
              <tr>
                <td className="muted">Tax</td>
                <td className="right">{rupees(invoice.taxAmount)}</td>
              </tr>
              <tr>
                <th>Amount payable</th>
                <th className="right">{rupees(invoice.finalAmount)}</th>
              </tr>
            </tbody>
          </table>
          {invoice.discountRejection && <p className="small-print muted">Discount not applied: {invoice.discountRejection.reason}</p>}
          <p className="muted small-print">
            {invoice.invoiceNumber} · <Badge value={invoice.status} />
            {invoice.amountRefunded > 0 && <> · refunded {rupees(invoice.amountRefunded)}</>}
          </p>
        </>
      )}
    </div>
  );
}

/** Mock payment flow: initiate → simulated card step → signed webhook (server side) → payment.succeeded / failed. */
function PaymentPanel({ order, expiresAt }: { order: Order; expiresAt: string | null }) {
  const [payment, setPayment] = useState<Payment | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    paymentsApi
      .forOrder(order.id)
      .then(({ data }) => setPayment(data))
      .catch(() => undefined); // 404 until the Payment Service has seen the order
  }, [order.id]);

  async function initiate() {
    setError(null);
    for (let i = 0; i < 15; i++) {
      try {
        const { data } = await paymentsApi.initiate(order.id);
        setPayment(data.payment);
        setStatus(null);
        return;
      } catch (err) {
        if (err instanceof ApiError && err.code === 'BILLING_PENDING') {
          setStatus('Waiting for the final bill…');
          await sleep((err.retryAfter ?? 2) * 1000);
          continue;
        }
        setStatus(null);
        setError(err);
        return;
      }
    }
    setStatus(null);
    setError(new Error('The bill is not ready yet. Please try again in a moment.'));
  }

  async function simulate(outcome: 'succeed' | 'fail') {
    if (!payment) return;
    setError(null);
    try {
      await paymentsApi.simulate(payment.id, outcome);
      setStatus('Processing payment…');
      for (let i = 0; i < 15; i++) {
        await sleep(800);
        const { data } = await paymentsApi.forOrder(order.id);
        setPayment(data);
        if (['succeeded', 'failed', 'cancelled'].includes(data.status)) break;
      }
    } catch (err) {
      setError(err);
    } finally {
      setStatus(null);
    }
  }

  const awaitingCard = payment?.status === 'requires_action';
  const failed = payment?.status === 'failed';
  const succeeded = payment?.status === 'succeeded';

  return (
    <div className="card">
      <h2>Payment</h2>
      <Notice kind="info">Simulated payment for testing. No real card is used and no money is charged.</Notice>
      {expiresAt && <p className="muted small-print">Pay before {dateTime(expiresAt)}, or the order expires.</p>}
      {payment?.provider === 'stripe' && <Notice kind="warning">This platform is configured for Stripe. Card payments are not supported in this app.</Notice>}
      {payment && payment.amount !== null && (
        <p>
          Amount: <b>{rupees(payment.amount)}</b> <Badge value={payment.status} />
        </p>
      )}
      {failed && payment?.lastFailure && <Notice kind="error">Payment failed: {payment.lastFailure.message}</Notice>}
      {succeeded && <Notice kind="success">Payment received. Your order is being confirmed…</Notice>}
      <ErrorBox error={error} />
      {status && <p className="muted">{status}</p>}
      {!succeeded && payment?.provider !== 'stripe' && !status && (
        <div className="actions">
          {awaitingCard ? (
            <>
              <AsyncButton className="secondary" onClick={() => simulate('fail')}>
                Simulate declined card
              </AsyncButton>
              <AsyncButton onClick={() => simulate('succeed')}>Simulate successful payment</AsyncButton>
            </>
          ) : (
            <AsyncButton onClick={initiate}>{failed ? 'Retry payment' : 'Pay now'}</AsyncButton>
          )}
        </div>
      )}
    </div>
  );
}

/** After the payment stage: the payment and refund outcome as mirrored on the order. */
function PaymentStatus({ orderId, paymentStatus }: { orderId: string; paymentStatus: string }) {
  const { data } = useAsync(async () => {
    try {
      return (await paymentsApi.forOrder(orderId)).data;
    } catch {
      return null;
    }
  }, [orderId, paymentStatus]);
  return (
    <div className="card">
      <h2>Payment</h2>
      <p>
        <Badge value={paymentStatus} />
        {data?.amount !== undefined && data?.amount !== null && <span> {rupees(data.amount)}</span>}
        {data?.provider === 'mock' && <span className="muted small-print"> (simulated)</span>}
      </p>
      {data && data.refundedAmount > 0 && <p className="muted">Refunded: {rupees(data.refundedAmount)}</p>}
    </div>
  );
}
