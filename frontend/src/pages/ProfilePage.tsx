import { useEffect } from 'react';
import { ROLE_LABELS } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { PageHeader } from '../components/ui';
import { dateTime } from '../format';

export function ProfilePage() {
  const { user, session, refreshUser } = useAuth();
  useEffect(() => {
    void refreshUser();
    // Only on mount: refreshUser changes identity whenever the session object is replaced.
  }, []);
  if (!user || !session) return null;
  return (
    <>
      <PageHeader title="My profile" />
      <div className="card">
        <dl className="kv">
          <dt>Name</dt>
          <dd>{user.name}</dd>
          <dt>Email</dt>
          <dd>{user.email}</dd>
          <dt>Role</dt>
          <dd>{ROLE_LABELS[user.role]}</dd>
          {user.addresses.length > 0 && (
            <>
              <dt>Saved addresses</dt>
              <dd>
                {user.addresses.map((a) => (
                  <div key={a.id}>
                    {a.label ? <b>{a.label}: </b> : null}
                    {[a.line1, a.city, a.pincode].join(', ')}
                  </div>
                ))}
              </dd>
            </>
          )}
          <dt>Session ends</dt>
          <dd>{dateTime(new Date(session.expiresAt))}</dd>
        </dl>
      </div>
    </>
  );
}
