import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { ErrorBox, Field, Notice } from '../components/ui';
import { homeFor } from '../routes';

export function LoginPage() {
  const { login, role, notice } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const registered = (location.state as { registered?: string } | null)?.registered;

  if (role) return <Navigate to={homeFor(role)} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await login(email.trim(), password);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== '/login' ? from : homeFor(user.role), { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-card card">
      <h1>Log in</h1>
      <p className="muted">Customers, restaurant administrators, delivery agents and platform administrators all sign in here.</p>
      {notice && <Notice kind="warning">{notice}</Notice>}
      {registered && <Notice kind="success">Account created for {registered}. You can log in now.</Notice>}
      <form onSubmit={submit} className="form">
        <Field label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <ErrorBox error={error} />
        <button type="submit" disabled={busy}>
          {busy ? 'Logging in…' : 'Log in'}
        </button>
      </form>
      <p className="muted">
        New customer? <Link to="/register">Create an account</Link>
      </p>
    </div>
  );
}
