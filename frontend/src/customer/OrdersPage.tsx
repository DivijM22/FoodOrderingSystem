import { useState } from 'react';
import { Link } from 'react-router';
import { ordersApi } from '../api/orders';
import { Badge, Empty, ErrorBox, Loading, PageHeader } from '../components/ui';
import { useAsync } from '../components/useAsync';
import { dateTime, rupees } from '../format';

export function OrdersPage() {
  const [page, setPage] = useState(1);
  const { data, error, loading, reload } = useAsync(async () => ordersApi.list({ page, limit: 20 }), [page]);
  const orders = data?.data ?? [];
  return (
    <>
      <PageHeader title="My orders" />
      {loading && <Loading />}
      <ErrorBox error={error} onRetry={reload} />
      {!loading && orders.length === 0 && (
        <Empty>
          No orders yet. <Link to="/restaurants">Browse restaurants</Link>
        </Empty>
      )}
      {orders.length > 0 && (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Restaurant</th>
                <th>Total</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link to={`/orders/${o.id}`}>{o.orderNumber}</Link>
                    <div className="muted small-print">{dateTime(o.createdAt)}</div>
                  </td>
                  <td>{o.restaurantName}</td>
                  <td>{rupees(o.billing?.finalAmount ?? o.provisionalTotal)}</td>
                  <td>
                    <Badge value={o.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data?.meta && data.meta.totalPages > 1 && (
        <div className="row">
          <button type="button" className="secondary small" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span className="muted">
            Page {page} of {data.meta.totalPages}
          </span>
          <button type="button" className="secondary small" disabled={page >= data.meta.totalPages} onClick={() => setPage(page + 1)}>
            Next
          </button>
        </div>
      )}
    </>
  );
}
