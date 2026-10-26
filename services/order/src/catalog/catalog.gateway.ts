import { ServiceUnavailableError } from '@food/common';
import { CatalogProjectionModel } from './projection.model.js';

export interface CatalogMenuItem {
  id: string;
  name: string;
  price: number;
  isVeg: boolean;
  isAvailable: boolean;
}

export interface CatalogMenu {
  restaurant: { id: string; name: string; isOpen: boolean; status: 'active' | 'inactive'; catalogVersion?: number };
  items: CatalogMenuItem[];
}

export interface CatalogRestaurant {
  id: string;
  name: string;
  adminIds: string[];
}

/** What the Order Service needs from catalog data. An interface so tests can substitute a fake. */
export interface CatalogGateway {
  /** Returns null when the restaurant is unknown. Throws ServiceUnavailableError if freshness cannot be established. */
  getMenu(restaurantId: string): Promise<CatalogMenu | null>;
  getRestaurant(restaurantId: string): Promise<CatalogRestaurant | null>;
}

/**
 * Catalog data from the Order Service's local read model (no HTTP to the Catalog Service).
 * Staleness policy: refuse to validate orders when correctness cannot be established —
 * before the first snapshot arrived, or while this service's broker connection is down
 * (catalog changes could be in flight).
 */
export class ProjectionCatalog implements CatalogGateway {
  private bootstrapped = false;

  constructor(private readonly isBrokerConnected: () => boolean) {}

  async getMenu(restaurantId: string): Promise<CatalogMenu | null> {
    await this.assertFresh();
    const r = await CatalogProjectionModel.findById(restaurantId).lean();
    if (!r) return null;
    return {
      restaurant: { id: r._id, name: r.name, isOpen: r.isOpen, status: r.status, catalogVersion: r.catalogVersion },
      items: r.items.map((i) => ({ id: i.id, name: i.name, price: i.price, isVeg: i.isVeg, isAvailable: i.isAvailable })),
    };
  }

  /** Ownership lookups tolerate staleness (no money involved); no freshness check. */
  async getRestaurant(restaurantId: string): Promise<CatalogRestaurant | null> {
    const r = await CatalogProjectionModel.findById(restaurantId, { name: 1, adminIds: 1 }).lean();
    return r ? { id: r._id, name: r.name, adminIds: r.adminIds ?? [] } : null;
  }

  private async assertFresh() {
    if (!this.isBrokerConnected()) {
      throw new ServiceUnavailableError('Catalog data cannot be confirmed as current while the event broker is unavailable; please retry shortly', 'CATALOG_SYNC_UNAVAILABLE');
    }
    if (!this.bootstrapped) {
      this.bootstrapped = (await CatalogProjectionModel.estimatedDocumentCount()) > 0;
      if (!this.bootstrapped) throw new ServiceUnavailableError('Catalog data is still synchronising; please retry shortly', 'CATALOG_SYNC_PENDING');
    }
  }
}
