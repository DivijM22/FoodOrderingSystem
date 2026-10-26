import { api } from './client';
import type { Menu, MenuItem, Restaurant } from './types';

export interface RestaurantInput {
  name: string;
  description: string;
  cuisines: string[];
  address: Restaurant['address'];
  isPureVeg: boolean;
  costForTwo: number;
  avgDeliveryMinutes: number;
  openingHours?: { opens: string; closes: string };
}
export type MenuItemInput = Pick<MenuItem, 'name' | 'description' | 'category' | 'price' | 'isVeg' | 'isAvailable'>;

export const catalogApi = {
  list: (q: { page?: number; limit?: number; includeInactive?: boolean; sort?: string } = {}) => api.get<Restaurant[]>('/restaurants', { query: { limit: 50, ...q } }),
  get: (id: string) => api.get<Restaurant>(`/restaurants/${id}`),
  menu: (id: string) => api.get<Menu>(`/restaurants/${id}/menu`),
  // restaurant administrators
  mine: () => api.get<Restaurant[]>('/restaurants/mine'),
  update: (id: string, body: Partial<RestaurantInput>) => api.patch<Restaurant>(`/restaurants/${id}`, body),
  setOpen: (id: string, isOpen: boolean) => api.patch<Restaurant>(`/restaurants/${id}/open`, { isOpen }),
  addItem: (id: string, body: MenuItemInput) => api.post<MenuItem>(`/restaurants/${id}/menu`, body),
  updateItem: (id: string, itemId: string, body: Partial<MenuItemInput>) => api.patch<MenuItem>(`/restaurants/${id}/menu/${itemId}`, body),
  setAvailability: (id: string, itemId: string, isAvailable: boolean) => api.patch<MenuItem>(`/restaurants/${id}/menu/${itemId}/availability`, { isAvailable }),
  deleteItem: (id: string, itemId: string) => api.del<void>(`/restaurants/${id}/menu/${itemId}`),
  // platform administrators
  create: (body: RestaurantInput & { adminIds?: string[] }) => api.post<Restaurant>('/restaurants', body),
  addAdmin: (id: string, userId: string) => api.post<Restaurant>(`/restaurants/${id}/admins`, { userId }),
  removeAdmin: (id: string, userId: string) => api.del<Restaurant>(`/restaurants/${id}/admins/${userId}`),
};

/** All restaurants (the API pages at 50). */
export async function allRestaurants(q: { includeInactive?: boolean } = {}): Promise<Restaurant[]> {
  const out: Restaurant[] = [];
  for (let page = 1; page <= 20; page++) {
    const { data, meta } = await catalogApi.list({ ...q, page, sort: 'name' });
    out.push(...data);
    if (!meta || page >= meta.totalPages) break;
  }
  return out;
}
