import { api } from './client';
import type { LoginResult, Role, User } from './types';

export const authApi = {
  login: (email: string, password: string) => api.post<LoginResult>('/auth/login', { email, password }, { anonymous: true }),
  /** Public self-registration: the Auth Service always creates a `customer`. */
  register: (body: { name: string; email: string; password: string }) => api.post<User>('/auth/register', body, { anonymous: true }),
  me: () => api.get<User>('/auth/me'),
  // platform admin
  listUsers: (q: { role?: Role; page?: number; limit?: number }) => api.get<User[]>('/auth/users', { query: q }),
  createUser: (body: { name: string; email: string; password: string; role: Role }) => api.post<User>('/auth/users', body),
  setStatus: (id: string, isActive: boolean) => api.patch<User>(`/auth/users/${id}/status`, { isActive }),
  /** Permanent; the backend accepts only inactive accounts other than the caller's own. */
  deleteUser: (id: string) => api.del<{ id: string; role: Role; deletedAt: string }>(`/auth/users/${id}`),
};

/** Every user of a role (the API pages at 100). */
export async function allUsers(role?: Role): Promise<User[]> {
  const out: User[] = [];
  for (let page = 1; page <= 50; page++) {
    const { data, meta } = await authApi.listUsers({ role, page, limit: 100 });
    out.push(...data);
    if (!meta || page >= meta.totalPages) break;
  }
  return out;
}
