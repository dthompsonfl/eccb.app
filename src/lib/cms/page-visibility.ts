/**
 * Page publish-scheduling visibility rules.
 *
 * A page is publicly readable only when every one of these holds:
 *   1. its status is PUBLISHED,
 *   2. it is not soft-deleted, and
 *   3. it has no future publish instant.
 *
 * Rule 3 is what makes scheduled publishing work without a redeploy. The public
 * catch-all route is `force-dynamic`, so this predicate is re-evaluated on every
 * request against the current clock; a page that was withheld a millisecond ago
 * becomes readable the instant its publish instant passes, with no build, no
 * restart, and no cache flush. Because the comparison happens per request, it is
 * also immune to the Redis page cache in src/lib/cache.ts, which caches the
 * *record* (including its publish instant) rather than a pre-baked visibility
 * decision — see CmsService.getPageBySlug.
 *
 * The predicate is deliberately a pure function of (page, now) so it can be unit
 * tested without a database, a Redis instance, or a running Next.js server.
 */

/** The subset of Page that visibility depends on. */
export interface PageVisibilityFields {
  status: string;
  /** Future publish instant; null means "no schedule". */
  publishAt?: Date | string | null;
  /** Legacy schedule column, honoured for rows predating the publishAt backfill. */
  scheduledFor?: Date | string | null;
  deletedAt?: Date | string | null;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The effective publish instant for a page: publishAt wins, falling back to the
 * legacy scheduledFor so rows written before the publishAt backfill (or by code
 * that still writes scheduledFor) are scheduled rather than going live early.
 */
export function getEffectivePublishAt(page: PageVisibilityFields): Date | null {
  return toDate(page.publishAt) ?? toDate(page.scheduledFor);
}

/** True when the page carries a publish instant that has not yet arrived. */
export function isPublishPending(
  page: PageVisibilityFields,
  now: Date = new Date(),
): boolean {
  const publishAt = getEffectivePublishAt(page);
  if (!publishAt) return false;
  return publishAt.getTime() > now.getTime();
}

/**
 * Whether a page may be served publicly right now.
 *
 * Exported as the single source of truth so the public route, the CMS service
 * read path, and the scheduler all agree on what "published" means.
 */
export function isPagePubliclyVisible(
  page: PageVisibilityFields,
  now: Date = new Date(),
): boolean {
  if (page.deletedAt) return false;
  if (page.status !== 'PUBLISHED') return false;
  return !isPublishPending(page, now);
}

/**
 * Prisma `where` fragment matching every publicly visible page at `now`.
 *
 * Used by list queries so a scheduled page never leaks into a public index even
 * when the caller forgets to re-check visibility in JS. publishAt is nullable,
 * hence the explicit `OR` with the null branch.
 */
export function publicPageVisibilityWhere(now: Date = new Date()): Record<string, unknown> {
  return {
    status: 'PUBLISHED',
    deletedAt: null,
    AND: [
      {
        OR: [
          { publishAt: null },
          { publishAt: { lte: now } },
        ],
      },
      {
        OR: [
          { scheduledFor: null },
          { scheduledFor: { lte: now } },
        ],
      },
    ],
  };
}

/**
 * How a page should be labelled in the admin UI, derived from the same rules the
 * public site uses so the badge can never disagree with reality.
 */
export type PagePublishState = 'draft' | 'scheduled' | 'published' | 'archived';

export function getPagePublishState(
  page: PageVisibilityFields,
  now: Date = new Date(),
): PagePublishState {
  if (page.deletedAt) return 'archived';
  if (page.status === 'ARCHIVED') return 'archived';
  if (page.status === 'DRAFT') return 'draft';
  // PUBLISHED with a future instant, or an explicit SCHEDULED status, both mean
  // "not live yet".
  if (isPublishPending(page, now) || page.status === 'SCHEDULED') return 'scheduled';
  if (page.status === 'PUBLISHED') return 'published';
  return 'draft';
}
