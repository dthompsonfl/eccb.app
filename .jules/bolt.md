## 2024-03-06 - Initial\n**Learning:** Just starting out.\n**Action:** Need to find something to optimize.
## 2024-03-06 - Smart Upload Counts Optimization\n**Learning:** Grouping by status using `prisma.groupBy` is more performant than executing multiple concurrent `prisma.count` queries, especially as the number of queried statuses increases, because it reduces the number of database connections and queries from O(N) to O(1).\n**Action:** Use `groupBy` over multiple concurrent `count` queries when fetching metrics grouped by categorical fields.

## 2024-03-05 - Vitest Transaction Mocking
**Learning:** When changing sequential database calls to `prisma.$transaction([])` arrays, Vitest test cases that stub `prisma.model.method` but not `prisma.$transaction` will fail with "is not a function".
**Action:** When introducing `prisma.$transaction` with arrays, mock it dynamically like: `vi.mocked(prisma.$transaction).mockImplementation(async (arg) => Array.isArray(arg) ? Promise.all(arg) : arg(prisma));` or globally in `vi.mock('@/lib/db')`

## 2026-03-09 - N+1 Query Batching in Loops
**Learning:** When loops execute sequential `findUnique` followed by `update`/`create` operations (e.g. tracking assignments or user states), it exhausts the database connection pool via N+1 queries.
**Action:** Replace iterative database calls with a single bulk fetch (`findMany({ where: { id: { in: ids } } })`), filter in-memory, and use `validIds.flatMap(...)` to construct an array of `update`/`create` operations to pass into a single `prisma.$transaction(operations)`.

## 2026-03-13 - LLM Configuration Caching and Parallelization
**Learning:** Frequent database reads of system configuration and sequential fetching of multiple secrets (API keys) introduce significant latency and database pressure, especially in background workers. Caching the configuration promise for a short TTL and parallelizing secret fetches reduces DB hits and total latency.
**Action:** Implement memory caching for configuration loaders and use `Promise.all` for independent parallel database lookups. Ensure cache invalidation is handled in all relevant update paths.
