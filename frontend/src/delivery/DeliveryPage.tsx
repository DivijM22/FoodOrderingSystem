import { Link, useParams } from 'react-router';
import { deliveriesApi } from '../api/deliveries';
import { ErrorBox, Loading, PageHeader } from '../components/ui';
import { useAsync } from '../components/useAsync';
import { DeliveryDetails } from './DeliveriesPage';

/** One of the agent's own deliveries (others return 404 from the Delivery Service). */
export function DeliveryPage() {
  const { id = '' } = useParams();
  const { data, error, loading, reload } = useAsync(async () => (await deliveriesApi.get(id)).data, [id]);
  return (
    <>
      <p>
        <Link to="/deliveries">← Deliveries</Link>
      </p>
      <PageHeader title="Delivery" />
      {loading && <Loading />}
      <ErrorBox error={error} onRetry={reload} />
      {data && (
        <div className="card">
          <DeliveryDetails delivery={data} />
        </div>
      )}
    </>
  );
}
