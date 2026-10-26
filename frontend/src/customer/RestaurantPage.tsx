import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { catalogApi } from '../api/catalog';
import { ApiError } from '../api/client';
import { ordersApi } from '../api/orders';
import type { Address, MenuItem } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Badge, Empty, ErrorBox, Field, Loading, Notice, PageHeader, VegMark } from '../components/ui';
import { useAsync } from '../components/useAsync';
import { rupees } from '../format';

type Cart = Record<string, number>; // menuItemId → quantity
const MAX_QTY = 20; // the Order Service accepts 1–20 per line
const cartKey = (restaurantId: string) => `food.cart.${restaurantId}`;

function loadCart(restaurantId: string): Cart {
  try {
    return JSON.parse(sessionStorage.getItem(cartKey(restaurantId)) ?? '{}') as Cart;
  } catch {
    return {};
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function RestaurantPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useAsync(async () => {
    const [restaurant, menu] = await Promise.all([catalogApi.get(id), catalogApi.menu(id)]);
    return { restaurant: restaurant.data, menu: menu.data };
  }, [id]);

  const [cart, setCart] = useState<Cart>(() => loadCart(id));
  const saved = user?.addresses[0];
  const [address, setAddress] = useState<Address>({ line1: saved?.line1 ?? '', city: saved?.city ?? '', pincode: saved?.pincode ?? '', landmark: saved?.landmark ?? '' });
  const [notes, setNotes] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [placeError, setPlaceError] = useState<unknown>(null);
  const [status, setStatus] = useState<string | null>(null);
  // One key per checkout attempt: retries of the same submission can never create a second order.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    try {
      sessionStorage.setItem(cartKey(id), JSON.stringify(cart));
    } catch {
      /* ignore */
    }
  }, [id, cart]);

  const items = data?.menu.items ?? [];
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const lines = Object.entries(cart)
    .map(([itemId, qty]) => ({ item: byId.get(itemId), qty }))
    .filter((l): l is { item: MenuItem; qty: number } => !!l.item && l.qty > 0);
  const unavailableInCart = lines.filter((l) => !l.item.isAvailable);
  const estimate = lines.reduce((s, l) => s + l.item.price * l.qty, 0);
  const open = !!data?.restaurant.isOpen && data.restaurant.status === 'active';

  const setQty = (itemId: string, qty: number) => {
    setCart((c) => {
      const next = { ...c };
      if (qty <= 0) delete next[itemId];
      else next[itemId] = Math.min(qty, MAX_QTY);
      return next;
    });
    setIdempotencyKey(crypto.randomUUID()); // the order content changed: a new submission
  };

  async function placeOrder(e: FormEvent) {
    e.preventDefault();
    setPlaceError(null);
    setFieldErrors({});
    const body = {
      restaurantId: id,
      items: lines.map((l) => ({ menuItemId: l.item.id, quantity: l.qty })),
      deliveryAddress: {
        line1: address.line1.trim(),
        city: address.city.trim(),
        pincode: address.pincode.trim(),
        ...(address.landmark?.trim() ? { landmark: address.landmark.trim() } : {}),
      },
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    };
    try {
      setStatus('Placing your order…');
      for (let attempt = 0; ; attempt++) {
        try {
          const { data: order } = await ordersApi.place(body, idempotencyKey);
          sessionStorage.removeItem(cartKey(id));
          navigate(`/orders/${order.id}`);
          return;
        } catch (err) {
          // The Order Service's catalog copy is still syncing (fresh start): safe to retry with the same key.
          if (err instanceof ApiError && err.code === 'CATALOG_SYNC_PENDING' && attempt < 5) {
            setStatus('The menu is still syncing, retrying…');
            await sleep(1500);
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      if (err instanceof ApiError) {
        const fe = err.fieldErrors();
        setFieldErrors(Object.fromEntries(Object.entries(fe).map(([k, v]) => [k.replace(/^deliveryAddress\./, ''), v])));
      }
      setPlaceError(err);
      setStatus(null);
    }
  }

  if (loading) return <Loading />;
  if (error || !data) return <ErrorBox error={error ?? new Error('Restaurant not found')} onRetry={reload} />;
  const { restaurant, menu } = data;

  return (
    <>
      <p>
        <Link to="/restaurants">← All restaurants</Link>
      </p>
      <PageHeader title={restaurant.name}>
        <Badge value={open ? 'open' : 'closed'} />
        {restaurant.isPureVeg && <span className="veg is-veg">Pure veg</span>}
      </PageHeader>
      <p className="muted">
        {restaurant.description} · {restaurant.address.area}, {restaurant.address.city} · about {restaurant.avgDeliveryMinutes} min
      </p>
      {!open && <Notice kind="warning">This restaurant is not accepting orders right now.</Notice>}

      <div className="two-col">
        <div>
          {menu.items.length === 0 && <Empty>This restaurant has no menu items yet.</Empty>}
          {menu.categories.map((cat) => (
            <section key={cat} className="card">
              <h2>{cat}</h2>
              <ul className="menu-list">
                {menu.items
                  .filter((i) => i.category === cat)
                  .map((i) => {
                    const qty = cart[i.id] ?? 0;
                    return (
                      <li key={i.id} className={`menu-item ${i.isAvailable ? '' : 'is-unavailable'}`}>
                        <div>
                          <div className="row">
                            <VegMark isVeg={i.isVeg} />
                            <b>{i.name}</b>
                            {!i.isAvailable && <Badge value="unavailable" label="Unavailable" />}
                          </div>
                          {i.description && <p className="muted small-print">{i.description}</p>}
                        </div>
                        <div className="menu-item-side">
                          <span className="price">{rupees(i.price)}</span>
                          {qty === 0 ? (
                            <button type="button" className="secondary small" disabled={!open || !i.isAvailable} onClick={() => setQty(i.id, 1)}>
                              Add
                            </button>
                          ) : (
                            <div className="stepper">
                              <button type="button" className="secondary small" onClick={() => setQty(i.id, qty - 1)} aria-label={`Remove one ${i.name}`}>
                                −
                              </button>
                              <span>{qty}</span>
                              <button type="button" className="secondary small" disabled={qty >= MAX_QTY || !i.isAvailable} onClick={() => setQty(i.id, qty + 1)} aria-label={`Add one ${i.name}`}>
                                +
                              </button>
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
              </ul>
            </section>
          ))}
        </div>

        <aside className="card cart">
          <h2>Your order</h2>
          {lines.length === 0 ? (
            <Empty>Add items from the menu.</Empty>
          ) : (
            <form onSubmit={placeOrder} className="form">
              <table>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.item.id}>
                      <td>
                        {l.qty} × {l.item.name}
                      </td>
                      <td className="right">{rupees(l.item.price * l.qty)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted small-print">
                Items at current menu prices: about {rupees(estimate)}. This is an estimate: the server calculates the order total, including
                delivery, when you place the order, and the final amount appears on your invoice.
              </p>
              {unavailableInCart.length > 0 && <Notice kind="warning">Some items are no longer available. Remove them to continue.</Notice>}
              <h3>Delivery address</h3>
              <Field label="Address" required minLength={3} maxLength={200} value={address.line1} onChange={(e) => setAddress({ ...address, line1: e.target.value })} error={fieldErrors.line1} />
              <div className="form-row">
                <Field label="City" required minLength={2} value={address.city} onChange={(e) => setAddress({ ...address, city: e.target.value })} error={fieldErrors.city} />
                <Field label="PIN code" required pattern="[1-9][0-9]{5}" title="6-digit PIN code" value={address.pincode} onChange={(e) => setAddress({ ...address, pincode: e.target.value })} error={fieldErrors.pincode} />
              </div>
              <Field label="Landmark (optional)" maxLength={120} value={address.landmark ?? ''} onChange={(e) => setAddress({ ...address, landmark: e.target.value })} />
              <Field label="Notes for the restaurant (optional)" maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} />
              <ErrorBox error={placeError} />
              {status && <p className="muted">{status}</p>}
              <button type="submit" disabled={!open || unavailableInCart.length > 0 || !!status}>
                Place order
              </button>
            </form>
          )}
        </aside>
      </div>
    </>
  );
}
