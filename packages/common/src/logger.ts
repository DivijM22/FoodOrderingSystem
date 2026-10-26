import { pino, type Logger } from 'pino';

export type { Logger };

/** Structured JSON logger. Every line carries the service name for log aggregation. */
export function createLogger(service: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['req.headers.authorization', 'password', '*.password', 'passwordHash', '*.passwordHash'],
      censor: '[REDACTED]',
    },
  });
}
