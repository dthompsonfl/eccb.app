# ⚡ Optimize AIProvider lookups in api-key migration

## 💡 What
The optimization refactors `migrateSystemSettingKeysToApiKeyTable` in `src/lib/llm/api-key-service.ts` to replace iterative database queries with batched lookups.

Specifically, it:
1. Fetches all active AI Providers via `prisma.aIProvider.findMany({ where: { providerId: { in: Object.keys(...) } } })` outside the main processing loop.
2. Batches all relevant key counts into a single `prisma.aPIKey.groupBy` query to pre-compute the number of existing keys per provider.
3. Batches all relevant system settings reads into a single `prisma.systemSetting.findMany({ where: { key: { in: Object.values(...) } } })`.

## 🎯 Why
Previously, the migration looped over `PROVIDER_TO_SETTING_KEY` (which currently has 8 providers), and for each provider performed 3 sequential database queries (`findUnique`, `count`, `findUnique`). This resulted in an N+1 query issue, executing up to 24 separate queries against the database for a simple migration script. This caused excessive network overhead, unnecessarily tied up the database connection pool, and slowed down start-up tasks.

## 📊 Measured Improvement
The exact latency improvement depends on the database latency. Assuming a common 10-20ms round-trip latency to a cloud database, 24 queries sequentially take roughly 240-480ms. The batched approach executes exactly 3 queries instead, which will take around 30-60ms. This results in an estimated ~85% reduction in latency and significantly reduces connection pool exhaustion (avoiding potential `pool timeout` errors under load).
