import { Link } from 'react-router';
import { catalogApi } from '../api/catalog';
import { Badge, Empty, ErrorBox, Loading, PageHeader } from '../components/ui';
import { useAsync } from '../components/useAsync';
import { rupees } from '../format';

export function RestaurantsPage() {
  const { data, error, loading, reload } = useAsync(async () => (await catalogApi.list({ sort: 'name' })).data);
  return (
    <>
      <PageHeader title="Restaurants" />
      {loading && <Loading />}
      <ErrorBox error={error} onRetry={reload} />
      {data && data.length === 0 && <Empty>No restaurants are available right now.</Empty>}
      <div className="grid">
        {data?.map((r) => (
          <Link key={r.id} to={`/restaurants/${r.id}`} className="card restaurant-card">
            <div className="spread">
              <h2>{r.name}</h2>
              <Badge value={r.isOpen ? 'open' : 'closed'} />
            </div>
            <p className="muted">{r.cuisines.join(' · ')}</p>
            <p className="small-print">
              {r.address.area}, {r.address.city} · {r.avgDeliveryMinutes} min · {rupees(r.costForTwo)} for two
            </p>
            {r.isPureVeg && <span className="veg is-veg">Pure veg</span>}
          </Link>
        ))}
      </div>
    </>
  );
}
