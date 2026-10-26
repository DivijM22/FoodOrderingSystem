import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../api/client';
import { deliveriesApi, type AgentDelivery, type AgentProfile } from '../api/deliveries';
import { AsyncButton, Badge, Empty, ErrorBox, Field, Loading, Notice, PageHeader } from '../components/ui';
import { useAsync } from '../components/useAsync';
import { dateTime, time } from '../format';

const REFRESH_MS = 10_000;

export function DeliveriesPage() {
  const [profile, setProfile] = useState<AgentProfile | null | undefined>(undefined); // null = not registered yet
  const [error, setError] = useState<unknown>(null);
  // Kept here: the active-delivery card disappears once a delivery completes, its outcome must stay visible.
  const [flash, setFlash] = useState<string | null>(null);

  async function load() {
    try {
      setProfile((await deliveriesApi.me()).data);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setProfile(null);
      else setError(err);
    }
  }

  // New assignments arrive automatically; refresh periodically (the delivery API has no push channel).
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  if (profile === undefined && !error) return <Loading />;
  return (
    <>
      <PageHeader title="Deliveries">
        <button type="button" className="secondary small" onClick={() => void load()}>
          Refresh
        </button>
      </PageHeader>
      <ErrorBox error={error} onRetry={load} />
      {flash && <Notice kind="success">{flash}</Notice>}
      <AvailabilityCard profile={profile ?? null} onChange={setProfile} />
      {profile?.activeDelivery ? (
        <ActiveDelivery delivery={profile.activeDelivery} onChange={() => void load()} onSuccess={setFlash} />
      ) : (
        profile && (
          <div className="card">
            <h2>Current delivery</h2>
            <Empty>{profile.status === 'available' ? 'No delivery assigned yet. New assignments appear here automatically.' : 'Go available to receive deliveries.'}</Empty>
          </div>
        )
      )}
      {profile && <DeliveryHistory key={`${profile.activeDeliveryId ?? 'none'}-${profile.activeDelivery?.status ?? ''}-${profile.completedDeliveries}`} />}
    </>
  );
}

function AvailabilityCard({ profile, onChange }: { profile: AgentProfile | null; onChange: (p: AgentProfile) => void }) {
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [error, setError] = useState<unknown>(null);

  async function update(available: boolean) {
    setError(null);
    try {
      const { data } = await deliveriesApi.updateMe({ available, ...(phone.trim() && phone.trim() !== profile?.phone ? { phone: phone.trim() } : {}) });
      onChange({ ...profile, ...data });
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="card">
      <div className="spread">
        <h2>My availability</h2>
        {profile && <Badge value={profile.status} />}
      </div>
      {!profile && <p className="muted">Register as a delivery partner: enter your contact phone and go available.</p>}
      {profile && (
        <p className="muted small-print">
          {profile.completedDeliveries} completed deliveries · customers only see a masked phone number.
        </p>
      )}
      <div className="row">
        <Field label="Contact phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="9876543210" pattern="\+?[0-9]{10,15}" />
        {profile?.status !== 'available' && profile?.status !== 'busy' && (
          <AsyncButton disabled={!profile && !phone.trim()} onClick={() => update(true)}>
            Go available
          </AsyncButton>
        )}
        {profile?.status === 'available' && (
          <AsyncButton className="secondary" onClick={() => update(false)}>
            Go offline
          </AsyncButton>
        )}
      </div>
      {profile?.status === 'busy' && <p className="muted small-print">You are on a delivery. You can go offline after finishing it.</p>}
      <ErrorBox error={error} />
    </div>
  );
}

function address(d: AgentDelivery) {
  const a = d.deliveryAddress;
  return a ? [a.line1, a.line2, a.landmark, a.city, a.pincode].filter(Boolean).join(', ') : '—';
}

export function DeliveryDetails({ delivery: d }: { delivery: AgentDelivery }) {
  return (
    <dl className="kv">
      <dt>Order</dt>
      <dd>
        <b>{d.orderNumber ?? d.orderId}</b> <Badge value={d.status} />
      </dd>
      <dt>Pick up from</dt>
      <dd>{d.restaurantName ?? '—'}</dd>
      <dt>Deliver to</dt>
      <dd>
        {d.customerName ?? 'Customer'} · {address(d)}
      </dd>
      <dt>Items</dt>
      <dd>{d.items.map((i) => `${i.quantity} × ${i.name}`).join(', ') || '—'}</dd>
      {d.timestamps.assignedAt && (
        <>
          <dt>Assigned</dt>
          <dd>{dateTime(d.timestamps.assignedAt)}</dd>
        </>
      )}
      {d.timestamps.pickedUpAt && (
        <>
          <dt>Picked up</dt>
          <dd>{dateTime(d.timestamps.pickedUpAt)}</dd>
        </>
      )}
      {d.timestamps.arrivedAt && (
        <>
          <dt>Arrived</dt>
          <dd>{dateTime(d.timestamps.arrivedAt)}</dd>
        </>
      )}
      {d.timestamps.deliveredAt && (
        <>
          <dt>Delivered</dt>
          <dd>{dateTime(d.timestamps.deliveredAt)}</dd>
        </>
      )}
      {d.cancellation?.reason && (
        <>
          <dt>Cancelled</dt>
          <dd>{d.cancellation.reason}</dd>
        </>
      )}
    </dl>
  );
}

/** The agent's current delivery: pickup → arrival (the customer is emailed a code) → code verification. */
function ActiveDelivery({ delivery: d, onChange, onSuccess }: { delivery: AgentDelivery; onChange: () => void; onSuccess: (message: string | null) => void }) {
  const [otp, setOtp] = useState('');
  const [error, setError] = useState<unknown>(null);

  async function act(fn: () => Promise<unknown>, success: string) {
    setError(null);
    onSuccess(null);
    try {
      await fn();
      onSuccess(success);
      onChange();
    } catch (err) {
      setError(err);
      onChange(); // e.g. the attempt counter changed
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    await act(() => deliveriesApi.verifyOtp(d.id, otp.trim()), 'Code verified. The delivery is complete.');
    setOtp('');
  }

  return (
    <div className="card">
      <h2>Current delivery</h2>
      <DeliveryDetails delivery={d} />
      <ErrorBox error={error} />
      {d.status === 'partner_assigned' && (
        <div className="actions">
          <AsyncButton onClick={() => act(() => deliveriesApi.pickup(d.id), 'Pickup confirmed.')}>Confirm pickup</AsyncButton>
        </div>
      )}
      {d.status === 'picked_up' && (
        <div className="actions">
          <AsyncButton onClick={() => act(() => deliveriesApi.arrived(d.id), 'Arrival reported. The customer has been emailed a delivery code.')}>
            Report arrival at customer
          </AsyncButton>
        </div>
      )}
      {d.status === 'arrived' && (
        <form className="form" onSubmit={verify}>
          <p className="muted">Ask the customer for the 6-digit delivery code they received by email.</p>
          {d.otp && (
            <p className="muted small-print">
              Code {d.otp.status} · expires {time(d.otp.expiresAt)} · {d.otp.attemptsRemaining} attempt(s) left · {d.otpIssues} code(s) issued
            </p>
          )}
          <div className="row">
            <Field label="Delivery code" inputMode="numeric" pattern="\d{6}" maxLength={6} required value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} autoComplete="one-time-code" />
            <button type="submit" disabled={otp.length !== 6}>
              Verify code
            </button>
            <AsyncButton className="secondary" onClick={() => act(() => deliveriesApi.resendOtp(d.id), 'A new code was emailed to the customer. The previous code no longer works.')}>
              Send a new code
            </AsyncButton>
          </div>
        </form>
      )}
    </div>
  );
}

function DeliveryHistory() {
  const { data, error, loading, reload } = useAsync(async () => (await deliveriesApi.list({ limit: 20 })).data);
  return (
    <div className="card">
      <h2>My deliveries</h2>
      {loading && <Loading />}
      <ErrorBox error={error} onRetry={reload} />
      {data?.length === 0 && <Empty>No deliveries yet.</Empty>}
      {data && data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Restaurant</th>
                <th>Status</th>
                <th>Assigned</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.id}>
                  <td>
                    <Link to={`/deliveries/${d.id}`}>{d.orderNumber ?? d.orderId}</Link>
                  </td>
                  <td>{d.restaurantName}</td>
                  <td>
                    <Badge value={d.status} />
                  </td>
                  <td className="muted small-print">{dateTime(d.timestamps.assignedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
