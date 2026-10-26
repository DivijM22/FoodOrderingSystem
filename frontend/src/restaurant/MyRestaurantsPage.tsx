import { Link } from 'react-router';
import { catalogApi } from '../api/catalog';
import { Badge, Empty, ErrorBox, Loading, PageHeader } from '../components/ui';
import { useAsync } from '../components/useAsync';

/** Restaurants whose adminIds include the signed-in restaurant administrator (GET /restaurants/mine). */
export function MyRestaurantsPage() {
  const { data, error, loading, reload } = useAsync(async () => (await catalogApi.mine()).data);
  return (
    <>
      <PageHeader title="My restaurants" />
      {loading && <Loading />}
      <ErrorBox error={error} onRetry={reload} />
      {data?.length === 0 && <Empty>You are not assigned to any restaurant yet. A platform administrator assigns restaurants to you.</Empty>}
      <div className="grid">
        {data?.map((r) => (
          <Link key={r.id} to={`/manage/${r.id}`} className="card restaurant-card">
            <div className="spread">
              <h2>{r.name}</h2>
              <Badge value={r.isOpen ? 'open' : 'closed'} />
            </div>
            <p className="muted">
              {r.address.area}, {r.address.city}
            </p>
            {r.status === 'inactive' && <Badge value="inactive" label="Inactive (hidden from customers)" />}
            <p className="muted small-print">{r.adminIds?.length ?? 0} administrator(s)</p>
          </Link>
        ))}
      </div>
    </>
  );
}
