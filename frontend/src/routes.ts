import type { Role } from './api/types';

/** Central route map: each role's home and its navigation entries. Route elements are wired in App.tsx. */
export const HOME: Record<Role, string> = {
  customer: '/restaurants',
  restaurant_admin: '/manage',
  delivery_agent: '/deliveries',
  platform_admin: '/admin/users',
};

export const homeFor = (role: Role | null) => (role ? HOME[role] : '/login');

export const NAV: Record<Role, { to: string; label: string }[]> = {
  customer: [
    { to: '/restaurants', label: 'Restaurants' },
    { to: '/orders', label: 'My orders' },
  ],
  restaurant_admin: [{ to: '/manage', label: 'My restaurants' }],
  delivery_agent: [{ to: '/deliveries', label: 'Deliveries' }],
  platform_admin: [
    { to: '/admin/users', label: 'Users' },
    { to: '/admin/restaurants', label: 'Restaurants' },
  ],
};
