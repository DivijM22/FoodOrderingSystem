/**
 * CLI: npm run seed -w @food/catalog-service [-- --reset] [-- --sample]
 * Uses MONGO_URI from the environment.
 * --sample seeds only the 5-restaurant manual-testing set (sample-data.ts) instead of the full demo catalog.
 * Restaurants that gained documents get a catalog.restaurant.updated snapshot in the outbox; the running
 * Catalog Service's relay publishes it, so the Order Service projection follows without waiting for a broadcast.
 */
import mongoose from 'mongoose';
import { connectMongo, createLogger, disconnectMongo } from '@food/common';
import { publishRestaurantSnapshot } from '../services/catalog.service.js';
import { SAMPLE_RESTAURANTS } from './sample-data.js';
import { seedCatalog } from './seed.js';

const logger = createLogger('catalog-seed');
const uri = process.env.MONGO_URI;
if (!uri) {
  logger.fatal('MONGO_URI is required');
  process.exit(1);
}

const reset = process.argv.includes('--reset');
const sample = process.argv.includes('--sample');
try {
  await connectMongo(uri, logger, { retries: 3 });
  const { insertedRestaurantIds, ...result } = await seedCatalog({ reset, ...(sample ? { restaurants: SAMPLE_RESTAURANTS } : {}) });
  for (const id of insertedRestaurantIds) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(() => publishRestaurantSnapshot(session, id, 'change'));
    } finally {
      await session.endSession();
    }
  }
  logger.info({ ...result, reset, sample, snapshotsQueued: insertedRestaurantIds.length }, 'Seed complete');
} catch (err) {
  logger.fatal({ err }, 'Seed failed');
  process.exitCode = 1;
} finally {
  await disconnectMongo();
}
