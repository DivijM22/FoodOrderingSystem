import { NavLink, Outlet, useNavigate } from 'react-router';
import { ROLE_LABELS } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { homeFor, NAV } from '../routes';

export function Layout() {
  const { user, role, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="app">
      <header className="topbar">
        <NavLink to={homeFor(role)} className="brand">
          FoodApp
        </NavLink>
        <nav className="nav">
          {role && NAV[role].map((n) => (
            <NavLink key={n.to} to={n.to}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="userbox">
          {user ? (
            <>
              <NavLink to="/profile" className="user-link" title={user.email}>
                {user.name} <small>{ROLE_LABELS[user.role]}</small>
              </NavLink>
              <button
                type="button"
                className="secondary small"
                onClick={() => {
                  logout();
                  navigate('/login');
                }}
              >
                Log out
              </button>
            </>
          ) : (
            <>
              <NavLink to="/login">Log in</NavLink>
              <NavLink to="/register">Sign up</NavLink>
            </>
          )}
        </div>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
