import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { catalogApi } from '../api/catalog';
import { ApiError } from '../api/client';
import { ordersApi } from '../api/orders';
import type { MenuItem, Restaurant } from '../api/types';
import { AsyncButton, Badge, ConfirmDialog, Empty, ErrorBox, Field, Loading, Notice, PageHeader, SelectField, TextArea, VegMark } from '../components/ui';
import { useAsync } from '../components/useAsync';
import { dateTime, rupees, toPaise } from '../format';

type Tab = 'menu' | 'details' | 'orders';

export function ManageRestaurantPage() {
  const { id = '' } = useParams();
  const [tab, setTab] = useState<Tab>('menu');
  const restaurant = useAsync(async () => (await catalogApi.get(id)).data, [id]);
  const [openError, setOpenError] = useState<unknown>(null);

  if (restaurant.loading && !restaurant.data) return <Loading />;
  if (!restaurant.data) return <ErrorBox error={restaurant.error ?? new Error('Restaurant not found')} onRetry={restaurant.reload} />;
  const r = restaurant.data;

  return (
    <>
      <p>
        <Link to="/manage">← My restaurants</Link>
      </p>
      <PageHeader title={r.name}>
        <Badge value={r.isOpen ? 'open' : 'closed'} />
        <AsyncButton
          className={r.isOpen ? 'secondary' : ''}
          onClick={async () => {
            setOpenError(null);
            try {
              restaurant.setData((await catalogApi.setOpen(r.id, !r.isOpen)).data);
            } catch (err) {
              setOpenError(err);
            }
          }}
        >
          {r.isOpen ? 'Close for orders' : 'Open for orders'}
        </AsyncButton>
      </PageHeader>
      {r.status === 'inactive' && <Notice kind="warning">This restaurant is inactive and hidden from customers. Only a platform administrator can reactivate it.</Notice>}
      <ErrorBox error={openError} />
      <div className="tabs">
        {(['menu', 'details', 'orders'] as Tab[]).map((t) => (
          <button key={t} type="button" className={`secondary ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {{ menu: 'Menu', details: 'Restaurant details', orders: 'Orders' }[t]}
          </button>
        ))}
      </div>
      {tab === 'menu' && <MenuManager restaurant={r} />}
      {tab === 'details' && <DetailsForm restaurant={r} onSaved={(x) => restaurant.setData(x)} />}
      {tab === 'orders' && <RestaurantOrders restaurantId={r.id} />}
    </>
  );
}

function DetailsForm({ restaurant: r, onSaved }: { restaurant: Restaurant; onSaved: (r: Restaurant) => void }) {
  const [f, setF] = useState({
    name: r.name,
    description: r.description,
    cuisines: r.cuisines.join(', '),
    line1: r.address.line1,
    area: r.address.area,
    city: r.address.city,
    pincode: r.address.pincode,
    costForTwo: String(r.costForTwo / 100),
    avgDeliveryMinutes: String(r.avgDeliveryMinutes),
    opens: r.openingHours.opens,
    closes: r.openingHours.closes,
    isPureVeg: r.isPureVeg,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => (setF({ ...f, [k]: e.target.value }), setSaved(false));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setErrors({});
    try {
      const { data } = await catalogApi.update(r.id, {
        name: f.name.trim(),
        description: f.description.trim(),
        cuisines: f.cuisines.split(',').map((c) => c.trim()).filter(Boolean),
        address: { line1: f.line1.trim(), area: f.area.trim(), city: f.city.trim(), pincode: f.pincode.trim() },
        costForTwo: toPaise(f.costForTwo),
        avgDeliveryMinutes: Number(f.avgDeliveryMinutes),
        openingHours: { opens: f.opens, closes: f.closes },
        isPureVeg: f.isPureVeg,
      });
      onSaved(data);
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiError) setErrors(Object.fromEntries(Object.entries(err.fieldErrors()).map(([k, v]) => [k.replace(/^address\./, ''), v])));
      setError(err);
    }
  }

  return (
    <form className="card form" onSubmit={submit}>
      <div className="form-row">
        <Field label="Name" required minLength={2} maxLength={100} value={f.name} onChange={set('name')} error={errors.name} />
        <Field label="Cuisines (comma-separated)" required value={f.cuisines} onChange={set('cuisines')} error={errors.cuisines} />
      </div>
      <TextArea label="Description" required minLength={10} maxLength={500} value={f.description} onChange={set('description')} error={errors.description} />
      <div className="form-row">
        <Field label="Street address" required minLength={3} value={f.line1} onChange={set('line1')} error={errors.line1} />
        <Field label="Area" required value={f.area} onChange={set('area')} error={errors.area} />
        <Field label="City" required value={f.city} onChange={set('city')} error={errors.city} />
        <Field label="PIN code" required pattern="[1-9][0-9]{5}" value={f.pincode} onChange={set('pincode')} error={errors.pincode} />
      </div>
      <div className="form-row">
        <Field label="Cost for two (₹)" type="number" min={0} step="1" required value={f.costForTwo} onChange={set('costForTwo')} error={errors.costForTwo} />
        <Field label="Average delivery time (min)" type="number" min={5} max={180} required value={f.avgDeliveryMinutes} onChange={set('avgDeliveryMinutes')} error={errors.avgDeliveryMinutes} />
        <Field label="Opens" type="time" required value={f.opens} onChange={set('opens')} />
        <Field label="Closes" type="time" required value={f.closes} onChange={set('closes')} />
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={f.isPureVeg} onChange={(e) => (setF({ ...f, isPureVeg: e.target.checked }), setSaved(false))} /> Pure vegetarian restaurant
      </label>
      {saved && <Notice kind="success">Saved.</Notice>}
      <ErrorBox error={error} />
      <div className="actions">
        <button type="submit">Save details</button>
      </div>
    </form>
  );
}

const emptyItem = { name: '', description: '', category: '', price: '', isVeg: true };

function MenuManager({ restaurant }: { restaurant: Restaurant }) {
  const menu = useAsync(async () => (await catalogApi.menu(restaurant.id)).data, [restaurant.id]);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<MenuItem | null>(null);
  const [error, setError] = useState<unknown>(null);

  const replace = (item: MenuItem) => menu.setData((m) => (m ? { ...m, items: m.items.map((i) => (i.id === item.id ? item : i)) } : m));

  return (
    <>
      <AddItemForm restaurant={restaurant} onAdded={() => menu.reload()} />
      <div className="card">
        <h2>Menu items</h2>
        {menu.loading && <Loading />}
        <ErrorBox error={menu.error ?? error} onRetry={menu.reload} />
        {menu.data?.items.length === 0 && <Empty>No items yet. Add the first one above.</Empty>}
        <ul className="menu-list">
          {menu.data?.items.map((i) =>
            editing === i.id ? (
              <li key={i.id}>
                <EditItemForm restaurantId={restaurant.id} item={i} onDone={(x) => (x && replace(x), setEditing(null))} />
              </li>
            ) : (
              <li key={i.id} className={`menu-item ${i.isAvailable ? '' : 'is-unavailable'}`}>
                <div>
                  <div className="row">
                    <VegMark isVeg={i.isVeg} />
                    <b>{i.name}</b>
                    <span className="muted small-print">{i.category}</span>
                    {!i.isAvailable && <Badge value="unavailable" label="Unavailable" />}
                  </div>
                  {i.description && <p className="muted small-print">{i.description}</p>}
                </div>
                <div className="menu-item-side">
                  <span className="price">{rupees(i.price)}</span>
                  <div className="row">
                    <AsyncButton
                      className="secondary small"
                      onClick={async () => {
                        setError(null);
                        try {
                          replace((await catalogApi.setAvailability(restaurant.id, i.id, !i.isAvailable)).data);
                        } catch (err) {
                          setError(err);
                        }
                      }}
                    >
                      {i.isAvailable ? 'Mark unavailable' : 'Mark available'}
                    </AsyncButton>
                    <button type="button" className="secondary small" onClick={() => setEditing(i.id)}>
                      Edit
                    </button>
                    <button type="button" className="secondary small" onClick={() => setDeleting(i)}>
                      Delete
                    </button>
                  </div>
                </div>
              </li>
            ),
          )}
        </ul>
      </div>
      <ConfirmDialog
        open={!!deleting}
        title={`Delete ${deleting?.name}?`}
        danger
        confirmLabel="Delete"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          try {
            await catalogApi.deleteItem(restaurant.id, deleting!.id);
            menu.setData((m) => (m ? { ...m, items: m.items.filter((x) => x.id !== deleting!.id) } : m));
          } catch (err) {
            setError(err);
          }
          setDeleting(null);
        }}
      >
        <p>The item is removed from the menu. Orders that already contain it keep their copy.</p>
      </ConfirmDialog>
    </>
  );
}

function ItemFields({ f, set, errors, categories }: { f: typeof emptyItem; set: (patch: Partial<typeof emptyItem>) => void; errors: Record<string, string>; categories?: string[] }) {
  return (
    <>
      <div className="form-row">
        <Field label="Name" required minLength={2} maxLength={100} value={f.name} onChange={(e) => set({ name: e.target.value })} error={errors.name} />
        <Field label="Category" required minLength={2} maxLength={60} value={f.category} onChange={(e) => set({ category: e.target.value })} error={errors.category} list="menu-categories" />
        <Field label="Price (₹)" type="number" min={1} step="0.01" required value={f.price} onChange={(e) => set({ price: e.target.value })} error={errors.price} />
        <SelectField label="Type" value={f.isVeg ? 'veg' : 'non-veg'} onChange={(e) => set({ isVeg: e.target.value === 'veg' })} error={errors.isVeg}>
          <option value="veg">Veg</option>
          <option value="non-veg">Non-veg</option>
        </SelectField>
      </div>
      <Field label="Description (optional)" maxLength={300} value={f.description} onChange={(e) => set({ description: e.target.value })} error={errors.description} />
      {categories && (
        <datalist id="menu-categories">
          {categories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      )}
    </>
  );
}

function AddItemForm({ restaurant, onAdded }: { restaurant: Restaurant; onAdded: () => void }) {
  const [f, setF] = useState(emptyItem);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [added, setAdded] = useState<string | null>(null);
  const categories = useAsync(async () => (await catalogApi.menu(restaurant.id)).data.categories, [restaurant.id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setErrors({});
    try {
      const { data } = await catalogApi.addItem(restaurant.id, {
        name: f.name.trim(),
        description: f.description.trim(),
        category: f.category.trim(),
        price: toPaise(f.price),
        isVeg: f.isVeg,
        isAvailable: true,
      });
      setAdded(`Added ${data.name}.`);
      setF(emptyItem);
      onAdded();
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors());
      setError(err);
    }
  }

  return (
    <form className="card form" onSubmit={submit}>
      <h2>Add a menu item</h2>
      {restaurant.isPureVeg && <p className="muted small-print">This is a pure-veg restaurant: non-veg items are rejected.</p>}
      <ItemFields f={f} set={(p) => (setF({ ...f, ...p }), setAdded(null))} errors={errors} categories={categories.data} />
      {added && <Notice kind="success">{added}</Notice>}
      <ErrorBox error={error} />
      <div className="actions">
        <button type="submit">Add item</button>
      </div>
    </form>
  );
}

function EditItemForm({ restaurantId, item, onDone }: { restaurantId: string; item: MenuItem; onDone: (updated: MenuItem | null) => void }) {
  const [f, setF] = useState({ name: item.name, description: item.description, category: item.category, price: String(item.price / 100), isVeg: item.isVeg });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setErrors({});
    // Send only what changed.
    const next = { name: f.name.trim(), description: f.description.trim(), category: f.category.trim(), price: toPaise(f.price), isVeg: f.isVeg };
    const patch = Object.fromEntries(Object.entries(next).filter(([k, v]) => item[k as keyof typeof next] !== v));
    if (!Object.keys(patch).length) return onDone(null);
    try {
      onDone((await catalogApi.updateItem(restaurantId, item.id, patch)).data);
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors());
      setError(err);
    }
  }

  return (
    <form className="form edit-item" onSubmit={submit}>
      <ItemFields f={f} set={(p) => setF({ ...f, ...p })} errors={errors} />
      <ErrorBox error={error} />
      <div className="actions">
        <button type="button" className="secondary" onClick={() => onDone(null)}>
          Cancel
        </button>
        <button type="submit">Save item</button>
      </div>
    </form>
  );
}

function RestaurantOrders({ restaurantId }: { restaurantId: string }) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const orders = useAsync(async () => ordersApi.list({ restaurantId, page, limit: 20, status: status || undefined }), [restaurantId, page, status]);
  const list = orders.data?.data ?? [];
  return (
    <div className="card">
      <div className="spread">
        <h2>Orders</h2>
        <div className="row">
          <SelectField label="Status" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
            <option value="">All</option>
            {['pending_payment', 'confirmed', 'assigning_delivery_partner', 'partner_assigned', 'out_for_delivery', 'location_reached', 'delivered', 'cancelled', 'expired'].map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, ' ')}
              </option>
            ))}
          </SelectField>
          <button type="button" className="secondary small" onClick={() => orders.reload()}>
            Refresh
          </button>
        </div>
      </div>
      {orders.loading && <Loading />}
      <ErrorBox error={orders.error} onRetry={orders.reload} />
      {!orders.loading && list.length === 0 && <Empty>No orders.</Empty>}
      {list.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Items</th>
                <th>Total</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {list.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link to={`/manage/orders/${o.id}`}>{o.orderNumber}</Link>
                    <div className="muted small-print">{dateTime(o.createdAt)}</div>
                  </td>
                  <td className="small-print">{o.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}</td>
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
      {orders.data?.meta && orders.data.meta.totalPages > 1 && (
        <div className="row">
          <button type="button" className="secondary small" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span className="muted">
            Page {page} of {orders.data.meta.totalPages}
          </span>
          <button type="button" className="secondary small" disabled={page >= orders.data.meta.totalPages} onClick={() => setPage(page + 1)}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}
