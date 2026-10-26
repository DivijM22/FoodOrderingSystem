import mongoose from 'mongoose';
import type { Logger } from 'pino';

/**
 * Connects Mongoose with bounded retries so a service can start before Mongo is ready.
 * After the initial connection, the MongoDB driver handles reconnection itself.
 */
export async function connectMongo(uri: string, logger: Logger, { retries = 10, delayMs = 3000 } = {}): Promise<typeof mongoose> {
  mongoose.set('strictQuery', true);

  for (let attempt = 1; ; attempt++) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
      logger.info({ db: mongoose.connection.name }, 'Connected to MongoDB');
      break;
    } catch (err) {
      if (attempt >= retries) throw err;
      logger.warn({ attempt, err: (err as Error).message }, 'MongoDB connection failed; retrying');
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  // Registered only after the first successful connect, so startup retries log one line each.
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB error'));
  return mongoose;
}

export function isMongoConnected(): boolean {
  return mongoose.connection.readyState === mongoose.ConnectionStates.connected;
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}
