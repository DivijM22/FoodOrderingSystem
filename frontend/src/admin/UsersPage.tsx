import { useMemo, useState, type FormEvent } from 'react';
import { allUsers, authApi } from '../api/auth';
import { allRestaurants, catalogApi } from '../api/catalog';
import { ApiError, errorMessage } from '../api/client';
import { ROLE_LABELS, ROLES, type Restaurant, type Role, type User } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { CheckList } from '../components/CheckList';
import { AsyncButton, Badge, ConfirmDialog, Empty, ErrorBox, Field, Loading, Notice, PageHeader, SelectField } from '../components/ui';
import { useAsync } from '../components/useAsync';
import { dateTime } from '../format';

const PAGE_SIZE = 20;

/** Case-insensitive match on name, email or the exact/partial user id. */
function matches(u: User, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || u.id.toLowerCase().includes(q);
}

export function UsersPage() {
  const { user: me } = useAuth();
  const [role, setRole] = useState<Role | ''>('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  // Every account of the selected role is loaded (all API pages), so search covers the whole list, not one page.
  const list = useAsync(async () => allUsers(role || undefined), [role]);
  const restaurants = useAsync(async () => allRestaurants({ includeInactive: true }));
  const [target, setTarget] = useState<User | null>(null);
  const [statusError, setStatusError] = useState<unknown>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);

  const filtered = useMemo(() => (list.data ?? []).filter((u) => matches(u, search)), [list.data, search]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, totalPages);
  const rows = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  async function toggle(u: User) {
    setStatusError(null);
    try {
      await authApi.setStatus(u.id, !u.isActive);
      setStatusMsg(`${u.name} is now ${u.isActive ? 'deactivated' : 'active'}.`);
      setTarget(null);
      await list.reload();
    } catch (err) {
      setStatusError(err);
    }
  }

  function askDelete(u: User) {
    setDeleteError(null);
    setAcknowledged(false);
    setDeleting(u);
  }

  async function remove(u: User) {
    setDeleteError(null);
    try {
      await authApi.deleteUser(u.id);
      setStatusMsg(`${u.name} (${u.email}) was permanently deleted.`);
      setDeleting(null);
      await list.reload();
    } catch (err) {
      setDeleteError(err);
    }
  }

  return (
    <>
      <PageHeader title="Users" />
      <CreateUserCard restaurants={restaurants.data ?? []} restaurantsError={restaurants.error} onCreated={() => list.reload()} />

      <div className="card">
        <div className="spread">
          <h2>All accounts</h2>
          <div className="row">
            <Field label="Search" type="search" placeholder="Name, email or user id" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} />
            <SelectField label="Role" value={role} onChange={(e) => (setRole(e.target.value as Role | ''), setPage(1))}>
              <option value="">All roles</option>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </SelectField>
          </div>
        </div>
        {statusMsg && <Notice kind="success">{statusMsg}</Notice>}
        {list.loading && <Loading />}
        <ErrorBox error={list.error} onRetry={list.reload} />
        {list.data && filtered.length === 0 && <Empty>{search.trim() ? 'No accounts match your search.' : 'No accounts.'}</Empty>}
        {list.data && filtered.length > 0 && (
          <>
            {search.trim() && (
              <p className="muted small-print">
                {filtered.length} of {list.data.length} accounts match.
              </p>
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>User id</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u) => {
                    const self = u.id === me?.id;
                    return (
                      <tr key={u.id}>
                        <td>
                          {u.name}
                          <div className="muted small-print">{u.email}</div>
                        </td>
                        <td>{ROLE_LABELS[u.role]}</td>
                        <td>
                          <Badge value={u.isActive ? 'active' : 'inactive'} />
                          {u.lastLoginAt && <div className="muted small-print">last login {dateTime(u.lastLoginAt)}</div>}
                        </td>
                        <td className="mono">{u.id}</td>
                        <td className="right">
                          <div className="row row-end">
                            {!self && (
                              <button type="button" className="secondary small" onClick={() => (setStatusError(null), setTarget(u))}>
                                {u.isActive ? 'Deactivate' : 'Activate'}
                              </button>
                            )}
                            <button
                              type="button"
                              className="danger small"
                              disabled={self || u.isActive}
                              title={self ? 'You cannot delete your own account' : u.isActive ? 'Deactivate the account before deleting it' : undefined}
                              onClick={() => askDelete(u)}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
        {totalPages > 1 && (
          <div className="row">
            <button type="button" className="secondary small" disabled={current <= 1} onClick={() => setPage(current - 1)}>
              Previous
            </button>
            <span className="muted">
              Page {current} of {totalPages}
            </span>
            <button type="button" className="secondary small" disabled={current >= totalPages} onClick={() => setPage(current + 1)}>
              Next
            </button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!target}
        title={target?.isActive ? `Deactivate ${target?.name}?` : `Activate ${target?.name}?`}
        danger={target?.isActive}
        confirmLabel={target?.isActive ? 'Deactivate' : 'Activate'}
        onCancel={() => setTarget(null)}
        onConfirm={() => toggle(target!)}
      >
        {target?.isActive ? (
          <>
            <p>The account can no longer log in. Sessions that are already open stay valid until their token expires (up to 1 hour).</p>
            {target.role === 'restaurant_admin' && (
              <p>
                <b>Deactivating removes this administrator from all of their restaurants.</b> Reactivating the account later does <b>not</b>{' '}
                restore those assignments; you would assign them again.
              </p>
            )}
            {target.role === 'delivery_agent' && <p>The agent receives no new deliveries. A delivery they already hold stays with them.</p>}
          </>
        ) : (
          <p>The account can log in again. Earlier restaurant assignments are not restored automatically.</p>
        )}
        <ErrorBox error={statusError} />
      </ConfirmDialog>

      <ConfirmDialog
        open={!!deleting}
        title="Permanently delete this account?"
        danger
        confirmLabel="Delete permanently"
        confirmDisabled={!acknowledged}
        onCancel={() => setDeleting(null)}
        onConfirm={() => remove(deleting!)}
      >
        {deleting && (
          <>
            <dl className="facts">
              <dt>Name</dt>
              <dd>{deleting.name}</dd>
              <dt>Email</dt>
              <dd>{deleting.email}</dd>
              <dt>Role</dt>
              <dd>{ROLE_LABELS[deleting.role]}</dd>
            </dl>
            <p>
              <b>This cannot be undone.</b> The account is removed from the Authentication Service and can never sign in again; its id is never
              reused. Orders, payments, invoices and delivery history are kept and still show this user&apos;s id and the details captured at
              the time.
            </p>
            {deleting.role === 'restaurant_admin' && <p>Any remaining restaurant assignments are removed. Restaurants and menus are kept.</p>}
            {deleting.role === 'delivery_agent' && <p>Deletion is refused while the agent still holds an active delivery.</p>}
            <label className="checkbox">
              <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} /> I understand this permanently
              deletes {deleting.email}
            </label>
          </>
        )}
        <ErrorBox error={deleteError} />
      </ConfirmDialog>
    </>
  );
}

/**
 * One form for every role. A new restaurant administrator must be assigned to ≥ 1 restaurant: the account is created
 * first (POST /auth/users), then each assignment (POST /restaurants/:id/admins). If an assignment fails, the created
 * account is kept and "Retry" re-sends only the failed assignments; the account is never created twice.
 */
function CreateUserCard({ restaurants, restaurantsError, onCreated }: { restaurants: Restaurant[]; restaurantsError: unknown; onCreated: () => void }) {
  const empty = { name: '', email: '', password: '', confirm: '', role: 'customer' as Role };
  const [form, setForm] = useState(empty);
  const [selected, setSelected] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [pending, setPending] = useState<{ user: User; restaurantIds: string[]; failures: Record<string, string> } | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const nameOf = (id: string) => restaurants.find((r) => r.id === id)?.name ?? id;

  async function assign(user: User, restaurantIds: string[]) {
    const failures: Record<string, string> = {};
    for (const id of restaurantIds) {
      try {
        await catalogApi.addAdmin(id, user.id);
      } catch (err) {
        failures[id] = errorMessage(err);
      }
    }
    const failed = Object.keys(failures);
    if (failed.length) {
      setPending({ user, restaurantIds: failed, failures });
    } else {
      setPending(null);
      setDone(`Restaurant administrator ${user.email} is assigned to ${restaurantIds.map(nameOf).join(', ')}.`);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(null);
    const fe: Record<string, string> = {};
    if (form.password !== form.confirm) fe.confirm = 'Passwords do not match';
    if (form.role === 'restaurant_admin' && selected.length === 0) fe.restaurants = 'Select at least one restaurant';
    setErrors(fe);
    if (Object.keys(fe).length) return;
    setBusy(true);
    try {
      const { data: user } = await authApi.createUser({ name: form.name.trim(), email: form.email.trim(), password: form.password, role: form.role });
      if (user.role === 'restaurant_admin') await assign(user, selected);
      else setDone(`Created ${ROLE_LABELS[user.role].toLowerCase()} ${user.email}.`);
      setForm({ ...empty, role: form.role });
      setSelected([]);
      onCreated();
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors());
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Create an account</h2>
      {pending ? (
        <>
          <Notice kind="warning">
            The account {pending.user.email} was created, but {pending.restaurantIds.length} restaurant assignment(s) failed. The account is kept. Retrying
            only re-sends the failed assignments.
          </Notice>
          <ul>
            {pending.restaurantIds.map((id) => (
              <li key={id}>
                {nameOf(id)}: <span className="field-error">{pending.failures[id]}</span>
              </li>
            ))}
          </ul>
          <div className="actions">
            <button type="button" className="secondary" onClick={() => setPending(null)}>
              Dismiss (assign later on the Restaurants page)
            </button>
            <AsyncButton onClick={() => assign(pending.user, pending.restaurantIds)}>Retry failed assignments</AsyncButton>
          </div>
        </>
      ) : (
        <form onSubmit={submit} className="form">
          <div className="form-row">
            <Field label="Name" required minLength={2} maxLength={80} value={form.name} onChange={set('name')} error={errors.name} />
            <Field label="Email" type="email" required value={form.email} onChange={set('email')} error={errors.email} />
          </div>
          <div className="form-row">
            <Field label="Password" type="password" required minLength={8} maxLength={72} value={form.password} onChange={set('password')} error={errors.password} hint="8+ characters with a letter and a digit" autoComplete="new-password" />
            <Field label="Confirm password" type="password" required value={form.confirm} onChange={set('confirm')} error={errors.confirm} autoComplete="new-password" />
            <SelectField label="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })} error={errors.role}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </SelectField>
          </div>
          {form.role === 'restaurant_admin' && (
            <div className="field">
              <span>Restaurants to manage (at least one)</span>
              <ErrorBox error={restaurantsError} />
              <CheckList
                options={restaurants.map((r) => ({ value: r.id, label: r.name, hint: `${r.address.city}${r.status === 'inactive' ? ' · inactive' : ''}` }))}
                selected={selected}
                onChange={setSelected}
                empty="No restaurants yet. Create a restaurant first."
              />
              {errors.restaurants && <small className="field-error">{errors.restaurants}</small>}
            </div>
          )}
          {done && <Notice kind="success">{done}</Notice>}
          <ErrorBox error={error} />
          <div className="actions">
            <button type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create account'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
