import { useState, type FormEvent } from 'react';
import { allUsers } from '../api/auth';
import { allRestaurants, catalogApi } from '../api/catalog';
import { ApiError } from '../api/client';
import type { Restaurant, User } from '../api/types';
import { CheckList } from '../components/CheckList';
import { AsyncButton, Badge, ConfirmDialog, Empty, ErrorBox, Field, Loading, Notice, PageHeader, SelectField, TextArea } from '../components/ui';
import { useAsync } from '../components/useAsync';
import { rupees, toPaise } from '../format';

/** Platform admin: create restaurants and manage the many-to-many restaurant ↔ administrator assignments (adminIds). */
export function AdminRestaurantsPage() {
  const restaurants = useAsync(() => allRestaurants({ includeInactive: true }));
  const admins = useAsync(() => allUsers('restaurant_admin'));
  const [showCreate, setShowCreate] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  const replace = (r: Restaurant) => restaurants.setData((list) => list?.map((x) => (x.id === r.id ? r : x)));

  return (
    <>
      <PageHeader title="Restaurants">
        <button type="button" onClick={() => (setShowCreate(!showCreate), setCreated(null))}>
          {showCreate ? 'Close form' : 'Create restaurant'}
        </button>
      </PageHeader>
      {created && <Notice kind="success">{created}</Notice>}
      {showCreate && (
        <CreateRestaurantForm
          admins={admins.data ?? []}
          onCreated={(r) => {
            setShowCreate(false);
            setCreated(`Created ${r.name} with ${r.adminIds?.length ?? 0} administrator(s). Its administrators can now add the menu.`);
            restaurants.setData((list) => [...(list ?? []), r].sort((a, b) => a.name.localeCompare(b.name)));
          }}
        />
      )}
      {restaurants.loading && <Loading />}
      <ErrorBox error={restaurants.error ?? admins.error} onRetry={() => (restaurants.reload(), admins.reload())} />
      {restaurants.data?.length === 0 && <Empty>No restaurants yet.</Empty>}
      {restaurants.data?.map((r) => (
        <RestaurantAdminsCard key={r.id} restaurant={r} admins={admins.data ?? []} onChange={replace} />
      ))}
    </>
  );
}

function RestaurantAdminsCard({ restaurant: r, admins, onChange }: { restaurant: Restaurant; admins: User[]; onChange: (r: Restaurant) => void }) {
  const [adding, setAdding] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const ids = r.adminIds ?? [];
  const label = (id: string) => {
    const u = admins.find((a) => a.id === id);
    return u ? `${u.name} (${u.email})${u.isActive === false ? ' · inactive' : ''}` : 'Unknown or non-admin account';
  };
  const candidates = admins.filter((a) => !ids.includes(a.id) && a.isActive !== false);

  return (
    <div className="card">
      <div className="spread">
        <div>
          <h2>{r.name}</h2>
          <p className="muted small-print">
            {r.address.area}, {r.address.city} · {r.cuisines.join(', ')} · {rupees(r.costForTwo)} for two
          </p>
        </div>
        <div className="row">
          <Badge value={r.status} />
          <Badge value={r.isOpen ? 'open' : 'closed'} />
        </div>
      </div>
      <h3>Administrators ({ids.length})</h3>
      {ids.length === 0 && <p className="muted small-print">No administrators assigned.</p>}
      <div>
        {ids.map((id) => (
          <span key={id} className="chip" title={id}>
            {label(id)} <span className="mono">{id}</span>
            <button type="button" className="secondary small" onClick={() => (setError(null), setRemoving(id))} aria-label="Remove administrator">
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="row">
        <SelectField label="Add administrator" value={adding} onChange={(e) => setAdding(e.target.value)}>
          <option value="">{candidates.length ? 'Choose a restaurant administrator…' : 'No other active restaurant administrators'}</option>
          {candidates.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.email})
            </option>
          ))}
        </SelectField>
        <AsyncButton
          className="secondary"
          disabled={!adding}
          onClick={async () => {
            setError(null);
            try {
              onChange((await catalogApi.addAdmin(r.id, adding)).data);
              setAdding('');
            } catch (err) {
              setError(err);
            }
          }}
        >
          Assign
        </AsyncButton>
      </div>
      <ErrorBox error={error} />
      <ConfirmDialog
        open={!!removing}
        title="Remove administrator?"
        danger
        confirmLabel="Remove"
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          try {
            onChange((await catalogApi.removeAdmin(r.id, removing!)).data);
            setRemoving(null);
          } catch (err) {
            setError(err);
            setRemoving(null);
          }
        }}
      >
        <p>
          {removing && label(removing)} will no longer be able to manage {r.name} or its orders. Other administrators are not affected.
        </p>
      </ConfirmDialog>
    </div>
  );
}

function CreateRestaurantForm({ admins, onCreated }: { admins: User[]; onCreated: (r: Restaurant) => void }) {
  const [f, setF] = useState({ name: '', description: '', cuisines: '', line1: '', area: '', city: '', pincode: '', isPureVeg: false, costForTwo: '', avgDeliveryMinutes: '30', opens: '10:00', closes: '23:00' });
  const [adminIds, setAdminIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      const { data } = await catalogApi.create({
        name: f.name.trim(),
        description: f.description.trim(),
        cuisines: f.cuisines.split(',').map((c) => c.trim()).filter(Boolean),
        address: { line1: f.line1.trim(), area: f.area.trim(), city: f.city.trim(), pincode: f.pincode.trim() },
        isPureVeg: f.isPureVeg,
        costForTwo: toPaise(f.costForTwo),
        avgDeliveryMinutes: Number(f.avgDeliveryMinutes),
        openingHours: { opens: f.opens, closes: f.closes },
        adminIds,
      });
      onCreated(data);
    } catch (err) {
      if (err instanceof ApiError) setErrors(Object.fromEntries(Object.entries(err.fieldErrors()).map(([k, v]) => [k.replace(/^address\./, ''), v])));
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form" onSubmit={submit}>
      <h2>New restaurant</h2>
      <div className="form-row">
        <Field label="Name" required minLength={2} maxLength={100} value={f.name} onChange={set('name')} error={errors.name} />
        <Field label="Cuisines (comma-separated)" required value={f.cuisines} onChange={set('cuisines')} error={errors.cuisines} placeholder="North Indian, Biryani" />
      </div>
      <TextArea label="Description" required minLength={10} maxLength={500} value={f.description} onChange={set('description')} error={errors.description} />
      <div className="form-row">
        <Field label="Street address" required minLength={3} value={f.line1} onChange={set('line1')} error={errors.line1} />
        <Field label="Area" required minLength={2} value={f.area} onChange={set('area')} error={errors.area} />
        <Field label="City" required minLength={2} value={f.city} onChange={set('city')} error={errors.city} />
        <Field label="PIN code" required pattern="[1-9][0-9]{5}" value={f.pincode} onChange={set('pincode')} error={errors.pincode} />
      </div>
      <div className="form-row">
        <Field label="Cost for two (₹)" type="number" min={0} step="1" required value={f.costForTwo} onChange={set('costForTwo')} error={errors.costForTwo} />
        <Field label="Average delivery time (min)" type="number" min={5} max={180} required value={f.avgDeliveryMinutes} onChange={set('avgDeliveryMinutes')} error={errors.avgDeliveryMinutes} />
        <Field label="Opens" type="time" required value={f.opens} onChange={set('opens')} />
        <Field label="Closes" type="time" required value={f.closes} onChange={set('closes')} />
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={f.isPureVeg} onChange={(e) => setF({ ...f, isPureVeg: e.target.checked })} /> Pure vegetarian restaurant
      </label>
      <div className="field">
        <span>Initial administrators (optional)</span>
        <CheckList
          options={admins.filter((a) => a.isActive !== false).map((a) => ({ value: a.id, label: a.name, hint: a.email }))}
          selected={adminIds}
          onChange={setAdminIds}
          empty="No restaurant administrator accounts yet. You can assign them later."
        />
      </div>
      <ErrorBox error={error} />
      <div className="actions">
        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create restaurant'}
        </button>
      </div>
    </form>
  );
}
