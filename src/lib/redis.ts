import Redis from 'ioredis';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { buildRedisOptionsFromUrl } from '@/lib/redis-options';

const globalForRedis = global as unknown as { redis: Redis | undefined };

function createRedis(): Redis {
  const client = new Redis({
    ...buildRedisOptionsFromUrl(env.REDIS_URL),
    // Importing a module during `next build` must not open a network
    // connection. ioredis connects automatically on the first real command.
    lazyConnect: true,
    maxRetriesPerRequest: null,
    retryStrategy: (times: number) => {
      const delay = Math.min(times * 1000, 30_000);
      return delay;
    },
  });

  client.on('error', (err: Error) => {
    logger.error('Redis client error', { error: err.message });
  });

  client.on('reconnecting', () => {
    logger.warn('Redis client reconnecting...');
  });

  return client;
}

export const redis = globalForRedis.redis ?? createRedis();

if (process.env.NODE_ENV !== 'production') globalForRedis.redis = redis;

export default redis;
