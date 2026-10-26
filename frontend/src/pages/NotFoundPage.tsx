import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { homeFor } from '../routes';

export function NotFoundPage() {
  const { role } = useAuth();
  return (
    <div className="card">
      <h1>Page not found</h1>
      <p>
        <Link to={homeFor(role)}>Go to the start page</Link>
      </p>
    </div>
  );
}
