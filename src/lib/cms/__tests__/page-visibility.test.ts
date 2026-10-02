import { describe, it, expect } from 'vitest';
import {
  isPagePubliclyVisible,
  isPublishPending,
  getEffectivePublishAt,
  getPagePublishState,
  publicPageVisibilityWhere,
} from '../page-visibility';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const FUTURE = new Date('2026-06-02T12:00:00.000Z');
const PAST = new Date('2026-05-31T12:00:00.000Z');

describe('page visibility', () => {
  it('does NOT expose a page before its publishAt', () => {
    const page = { status: 'PUBLISHED', publishAt: FUTURE };
    expect(isPagePubliclyVisible(page, NOW)).toBe(false);
  });

  it('exposes a page once publishAt has passed', () => {
    const page = { status: 'PUBLISHED', publishAt: PAST };
    expect(isPagePubliclyVisible(page, NOW)).toBe(true);
  });

  it('exposes a page the instant publishAt equals now (inclusive boundary)', () => {
    const page = { status: 'PUBLISHED', publishAt: NOW };
    expect(isPagePubliclyVisible(page, NOW)).toBe(true);
  });

  it('exposes a page with a null publishAt regardless of time', () => {
    expect(isPagePubliclyVisible({ status: 'PUBLISHED', publishAt: null }, NOW)).toBe(true);
    expect(isPagePubliclyVisible({ status: 'PUBLISHED' }, NOW)).toBe(true);
  });

  it('never exposes a non-PUBLISHED page, even with a past publishAt', () => {
    for (const status of ['DRAFT', 'SCHEDULED', 'ARCHIVED']) {
      expect(isPagePubliclyVisible({ status, publishAt: PAST }, NOW)).toBe(false);
    }
  });

  it('never exposes a soft-deleted page', () => {
    const page = { status: 'PUBLISHED', publishAt: null, deletedAt: PAST };
    expect(isPagePubliclyVisible(page, NOW)).toBe(false);
  });

  it('transitions from hidden to visible purely by advancing the clock', () => {
    // The core no-redeploy guarantee: the same row object, read at two different
    // instants, flips from withheld to readable with no mutation in between.
    const page = { status: 'PUBLISHED', publishAt: FUTURE };

    expect(isPagePubliclyVisible(page, new Date('2026-06-01T11:59:59.999Z'))).toBe(false);

    const after = new Date(FUTURE.getTime() + 1);
    expect(isPublishPending(page, after)).toBe(false);
    expect(isPagePubliclyVisible(page, after)).toBe(true);
  });

  it('accepts ISO string instants as well as Date objects', () => {
    expect(
      isPagePubliclyVisible(
        { status: 'PUBLISHED', publishAt: FUTURE.toISOString() },
        NOW,
      ),
    ).toBe(false);
    expect(
      isPagePubliclyVisible(
        { status: 'PUBLISHED', publishAt: PAST.toISOString() },
        NOW,
      ),
    ).toBe(true);
  });

  it('treats an unparseable instant as no schedule rather than hiding forever', () => {
    expect(isPagePubliclyVisible({ status: 'PUBLISHED', publishAt: 'not-a-date' }, NOW)).toBe(
      true,
    );
  });

  it('falls back to the legacy scheduledFor column when publishAt is absent', () => {
    expect(
      isPagePubliclyVisible({ status: 'PUBLISHED', scheduledFor: FUTURE }, NOW),
    ).toBe(false);
    expect(
      isPagePubliclyVisible({ status: 'PUBLISHED', scheduledFor: PAST }, NOW),
    ).toBe(true);
  });

  it('prefers publishAt over scheduledFor when both are set', () => {
    // A cleared publishAt with a stale future scheduledFor must still go live.
    const page = { status: 'PUBLISHED', publishAt: PAST, scheduledFor: FUTURE };
    expect(getEffectivePublishAt(page)).toEqual(PAST);
    expect(isPagePubliclyVisible(page, NOW)).toBe(true);
  });
});

describe('getPagePublishState', () => {
  it('reports a future publishAt as scheduled, not published', () => {
    expect(getPagePublishState({ status: 'PUBLISHED', publishAt: FUTURE }, NOW)).toBe(
      'scheduled',
    );
  });

  it('reports a published page with no schedule as published', () => {
    expect(getPagePublishState({ status: 'PUBLISHED', publishAt: null }, NOW)).toBe(
      'published',
    );
  });

  it('reports a passed publishAt on a PUBLISHED page as published', () => {
    expect(getPagePublishState({ status: 'PUBLISHED', publishAt: PAST }, NOW)).toBe(
      'published',
    );
  });

  it('reports DRAFT and ARCHIVED distinctly', () => {
    expect(getPagePublishState({ status: 'DRAFT' }, NOW)).toBe('draft');
    expect(getPagePublishState({ status: 'ARCHIVED' }, NOW)).toBe('archived');
  });

  it('never labels a page published while it is still withheld', () => {
    const state = getPagePublishState({ status: 'PUBLISHED', publishAt: FUTURE }, NOW);
    expect(state).not.toBe('published');
  });
});

describe('publicPageVisibilityWhere', () => {
  it('requires PUBLISHED status and no future instant on either column', () => {
    const where = publicPageVisibilityWhere(NOW);

    expect(where.status).toBe('PUBLISHED');
    expect(where.deletedAt).toBeNull();

    // Both schedule columns must be null-or-past, otherwise a scheduled page
    // would leak through a list query that skipped the JS re-check.
    const and = where.AND as Array<{ OR: Array<Record<string, unknown>> }>;
    expect(and).toHaveLength(2);

    const publishAtBranch = and[0].OR as Array<Record<string, unknown>>;
    expect(publishAtBranch[0]).toEqual({ publishAt: null });
    expect(publishAtBranch[1]).toEqual({ publishAt: { lte: NOW } });

    const scheduledForBranch = and[1].OR as Array<Record<string, unknown>>;
    expect(scheduledForBranch[0]).toEqual({ scheduledFor: null });
    expect(scheduledForBranch[1]).toEqual({ scheduledFor: { lte: NOW } });
  });
});
