import { Navigate, Outlet, useLocation } from 'react-router';
import type { Role } from '../api/types';
import { homeFor } from '../routes';
import { useAuth } from './AuthContext';

/** Requires a session; with `roles`, also one of those roles (others are sent to their own home). */
export function ProtectedRoute({ roles }: { roles?: Role[] }) {
  const { role } = useAuth();
  const location = useLocation();
  if (!role) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (roles && !roles.includes(role)) return <Navigate to={homeFor(role)} replace />;
  return <Outlet />;
}
