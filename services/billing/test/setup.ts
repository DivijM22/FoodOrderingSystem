import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll } from 'vitest';

let replSet: MongoMemoryReplSet;

/** Boots a throwaway MongoDB replica set for the test file and wipes data between tests. */
export function useTestDatabase() {
  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(replSet.getUri('billing_test'));
    await mongoose.connection.syncIndexes();
  });
  afterEach(async () => {
    const collections = await mongoose.connection.db!.collections();
    await Promise.all(collections.map((c) => c.deleteMany({})));
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await replSet?.stop();
  });
}
