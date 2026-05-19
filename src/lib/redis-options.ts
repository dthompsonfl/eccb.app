import type { RedisOptions } from 'ioredis';

function toInt(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function buildRedisOptionsFromUrl(redisUrl: string): RedisOptions {
  const parsed = new URL(redisUrl);
  const protocol = parsed.protocol.toLowerCase();

  if (protocol !== 'redis:' && protocol !== 'rediss:') {
    throw new Error(`Unsupported Redis URL protocol: ${parsed.protocol}`);
  }

  const options: RedisOptions = {
    host: parsed.hostname || 'localhost',
    port: toInt(parsed.port) ?? 6379,
  };

  if (parsed.username) {
    options.username = decodeURIComponent(parsed.username);
  }

  if (parsed.password) {
    options.password = decodeURIComponent(parsed.password);
  }

  const dbFromPath = toInt(parsed.pathname.replace(/^\//, ''));
  const dbFromQuery = toInt(parsed.searchParams.get('db'));
  const db = dbFromQuery ?? dbFromPath;
  if (typeof db === 'number') {
    options.db = db;
  }

  if (protocol === 'rediss:') {
    options.tls = {};
  }

  return options;
}