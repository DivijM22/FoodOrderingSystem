import { UnprocessableError, type ErrorDetail } from '@food/common';
import type { CatalogMenu } from '../catalog/catalog.gateway.js';
import type { IOrderItem } from '../models/order.model.js';

export interface PricingRules {
  deliveryFee: number;
  freeDeliveryThreshold: number;
}

export interface PricedOrder {
  items: IOrderItem[];
  subtotal: number;
  deliveryFee: number;
  provisionalTotal: number;
}

/** Combines repeated lines for the same item so quantities are validated on the total. */
export function mergeLines(lines: { menuItemId: string; quantity: number }[]) {
  const merged = new Map<string, number>();
  for (const l of lines) merged.set(l.menuItemId.toLowerCase(), (merged.get(l.menuItemId.toLowerCase()) ?? 0) + l.quantity);
  return [...merged].map(([menuItemId, quantity]) => ({ menuItemId, quantity }));
}

/**
 * Validates requested items against the live catalog and prices them.
 * Prices come only from the catalog; the client never supplies amounts.
 */
export function priceOrder(menu: CatalogMenu, lines: { menuItemId: string; quantity: number }[], rules: PricingRules): PricedOrder {
  if (menu.restaurant.status !== 'active') throw new UnprocessableError('Restaurant not found', 'RESTAURANT_NOT_FOUND');
  if (!menu.restaurant.isOpen) throw new UnprocessableError(`${menu.restaurant.name} is not accepting orders right now`, 'RESTAURANT_CLOSED');

  const byId = new Map(menu.items.map((i) => [i.id, i]));
  const problems: ErrorDetail[] = [];
  const items: IOrderItem[] = [];

  mergeLines(lines).forEach((line, index) => {
    const item = byId.get(line.menuItemId);
    if (!item) {
      problems.push({ path: `items.${index}.menuItemId`, message: `Item ${line.menuItemId} is not on this restaurant's menu` });
    } else if (!item.isAvailable) {
      problems.push({ path: `items.${index}.menuItemId`, message: `${item.name} is currently unavailable` });
    } else if (line.quantity > 20) {
      problems.push({ path: `items.${index}.quantity`, message: `At most 20 of ${item.name} per order` });
    } else {
      items.push({
        menuItemId: item.id,
        name: item.name,
        unitPrice: item.price,
        isVeg: item.isVeg,
        quantity: line.quantity,
        lineTotal: item.price * line.quantity,
      });
    }
  });

  if (problems.length > 0) throw new UnprocessableError('Some items cannot be ordered', 'ORDER_ITEMS_INVALID', problems);

  const subtotal = items.reduce((sum, i) => sum + i.lineTotal, 0);
  const deliveryFee = subtotal >= rules.freeDeliveryThreshold ? 0 : rules.deliveryFee;
  return { items, subtotal, deliveryFee, provisionalTotal: subtotal + deliveryFee };
}
