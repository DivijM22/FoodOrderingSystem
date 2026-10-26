import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ordersApi } from '../api/orders';
import { CancelOrder, OrderSummary, TrackingPanel, canCancel } from '../components/OrderParts';
import { ErrorBox, Loading, Notice, PageHeader } from '../components/ui';
import { useAsync } from '../components/useAsync';
import { useTracking } from '../components/useTracking';

/** Order details for an administrator of the order's restaurant (the Order Service checks the assignment). */
export function RestaurantOrderPage() {
  const { orderId = '' } = useParams();
  const order = useAsync(async () => (await ordersApi.get(orderId)).data, [orderId]);
  const { tracking, mode } = useTracking(orderId);
  const [message, setMessage] = useState<string | null>(null);

  if (order.loading && !order.data) return <Loading />;
  if (!order.data) return <ErrorBox error={order.error ?? new Error('Order not found')} onRetry={order.reload} />;
  const o = order.data;
  const status = tracking?.status ?? o.status;
  const paymentStatus = tracking?.paymentStatus ?? o.paymentStatus;

  return (
    <>
      <p>
        <Link to={`/manage/${o.restaurantId}`}>← {o.restaurantName}</Link>
      </p>
      <PageHeader title={`Order ${o.orderNumber}`}>
        {canCancel('restaurant_admin', status) && (
          <CancelOrder
            orderId={o.id}
            paid={paymentStatus === 'paid'}
            onCancelled={(c) => {
              order.setData(c);
              setMessage(c.paymentStatus === 'refund_pending' ? 'Order cancelled. The customer is refunded automatically.' : 'Order cancelled.');
            }}
          />
        )}
      </PageHeader>
      {message && <Notice kind="success">{message}</Notice>}
      <div className="two-col">
        <OrderSummary order={o} />
        <TrackingPanel tracking={tracking} mode={mode} />
      </div>
    </>
  );
}
