import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { authApi } from '../api/auth';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ErrorBox, Field } from '../components/ui';
import { homeFor } from '../routes';

/** Public sign-up. The Auth Service always creates a `customer`; staff accounts are created by a platform admin. */
export function RegisterPage() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (role) return <Navigate to={homeFor(role)} replace />;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (form.password !== form.confirm) return setErrors({ confirm: 'Passwords do not match' });
    setErrors({});
    setBusy(true);
    try {
      const { data } = await authApi.register({ name: form.name.trim(), email: form.email.trim(), password: form.password });
      navigate('/login', { state: { registered: data.email } });
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors());
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-card card">
      <h1>Create a customer account</h1>
      <form onSubmit={submit} className="form">
        <Field label="Name" required minLength={2} maxLength={80} value={form.name} onChange={set('name')} error={errors.name} autoComplete="name" />
        <Field label="Email" type="email" required value={form.email} onChange={set('email')} error={errors.email} autoComplete="email" />
        <Field label="Password" type="password" required minLength={8} maxLength={72} value={form.password} onChange={set('password')} error={errors.password} hint="At least 8 characters, with a letter and a digit." autoComplete="new-password" />
        <Field label="Confirm password" type="password" required value={form.confirm} onChange={set('confirm')} error={errors.confirm} autoComplete="new-password" />
        <ErrorBox error={error} />
        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>
      <p className="muted">
        Already registered? <Link to="/login">Log in</Link>
      </p>
    </div>
  );
}
