import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { authApi } from '../api/auth';
import { configureClient } from '../api/client';
import type { Role, User } from '../api/types';

/**
 * Session = the Auth Service's JWT plus the user it was issued for, kept in sessionStorage (survives reloads in this
 * tab, cleared when the tab closes). The backend verifies every request; this context only drives the UI.
 */
interface Session {
  token: string;
  user: User;
  /** Epoch ms from the token's `exp` claim. */
  expiresAt: number;
}

interface AuthState {
  session: Session | null;
  user: User | null;
  role: Role | null;
  /** Why the last session ended (expired, invalid…), shown on the login page. */
  notice: string | null;
  login: (email: string, password: string) => Promise<User>;
  logout: (notice?: string) => void;
  refreshUser: () => Promise<void>;
}

const STORAGE_KEY = 'food.session';
const AuthContext = createContext<AuthState | null>(null);

function tokenExpiry(token: string): number {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const s = raw ? (JSON.parse(raw) as Session) : null;
    return s && s.expiresAt > Date.now() ? s : null;
  } catch {
    return null;
  }
}

function saveSession(s: Session | null) {
  try {
    if (s) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable (private mode): the session simply lives in memory */
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(loadSession);
  const [notice, setNotice] = useState<string | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const logout = useCallback((why?: string) => {
    sessionRef.current = null;
    saveSession(null);
    setSession(null);
    setNotice(why ?? null);
  }, []);

  // The API client reads the token through this ref. It is set during render (not in an effect) because child
  // components' effects run before this provider's, and a page's first request after a reload must carry the token.
  configureClient(
    () => sessionRef.current?.token ?? null,
    (code) => logout(code === 'TOKEN_EXPIRED' ? 'Your session has expired. Please log in again.' : 'Your session is no longer valid. Please log in again.'),
  );

  // End the session in the UI when the token expires, even without a request.
  useEffect(() => {
    if (!session) return;
    const ms = session.expiresAt - Date.now();
    const timer = setTimeout(() => logout('Your session has expired. Please log in again.'), Math.max(0, ms));
    return () => clearTimeout(timer);
  }, [session, logout]);

  const login = useCallback(async (email: string, password: string) => {
    const { data } = await authApi.login(email, password);
    const s: Session = { token: data.accessToken, user: data.user, expiresAt: tokenExpiry(data.accessToken) || Date.now() + 3600_000 };
    saveSession(s);
    sessionRef.current = s;
    setNotice(null);
    setSession(s);
    return data.user;
  }, []);

  /** Re-reads the profile (e.g. after editing it). A deactivated account gets 404 → session ends. */
  const refreshUser = useCallback(async () => {
    if (!session) return;
    try {
      const { data } = await authApi.me();
      // The JWT carries the role the backend enforces; if the profile disagrees, the token is stale.
      if (data.role !== session.user.role) return logout('Your account changed. Please log in again.');
      const s = { ...session, user: data };
      saveSession(s);
      setSession(s);
    } catch (err) {
      if ((err as { status?: number }).status === 404) logout('This account is no longer active.');
    }
  }, [session, logout]);

  const value = useMemo<AuthState>(
    () => ({ session, user: session?.user ?? null, role: session?.user.role ?? null, notice, login, logout, refreshUser }),
    [session, notice, login, logout, refreshUser],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
