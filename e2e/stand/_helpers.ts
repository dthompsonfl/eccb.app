/**
 * Shared helpers for the Digital Music Stand workflow suite.
 *
 * These are NOT axe helpers: they assert that a PDF actually rendered and that
 * an annotation actually persisted. Every wait here is an explicit condition on
 * real state (canvas backing-store size, API response, DOM attribute). There are
 * no fixed sleeps anywhere, because a sleep here would silently convert a race
 * into a false green.
 */
import { expect, type Locator, type Page } from '@playwright/test';

/** zustand persist key for the stand's durable view preferences. */
export const STAND_VIEW_PREF_KEY = 'stand-view-preferences';

/** sessionStorage marker recording that this tab already reset the view prefs. */
const STAND_PREFS_CLEARED_SENTINEL = 'eccb:e2e-stand-prefs-reset';

/**
 * The first-run onboarding tour is a modal Dialog. While it is open, Radix marks
 * the rest of the page `aria-hidden`, which hides every stand control from the
 * accessibility tree and from Playwright's role engine. It is also a first-run
 * experience a returning musician never sees. Marking it seen is the honest
 * equivalent of being a returning member, and it keeps these specs measuring the
 * stand rather than the tour.
 */
export const ONBOARDING_SEEN_KEY = 'eccb:onboarding-seen';

export const STAND_HUB = '/member/stand';

/**
 * Composer of the seeded stand fixture ("Avengers", a 27-page generated PDF).
 *
 * This is the marker the fixture lookup keys on. It is written by
 * `prisma/seed-stand-fixture.ts`, which owns the fixture's sentinel catalog
 * number `E2E-FIXTURE-0001`. Using the composer rather than a piece id is the
 * point: the id is a cuid that differs on every fresh database, so hardcoding one
 * made 12 of these specs fail on any machine that had not been seeded by hand.
 */
export const SEEDED_PIECE_COMPOSER = 'Stand Fixture Composer';

/**
 * Suppress the onboarding modal, if the caller has not already done so.
 *
 * `resolveSeededPieceId` navigates the page itself, so it cannot rely on the
 * caller having run `prepareStandPage` first — and the first-run onboarding Dialog
 * is a modal that intercepts pointer events, which would block the tab click and
 * report the fixture as "missing" when it is present. `addInitScript` is
 * idempotent, so applying it twice is harmless.
 */
async function ensureOnboardingSuppressed(page: Page): Promise<void> {
  // Deliberately unconditional. `addInitScript` registers a script that runs on
  // every subsequent navigation and re-setting the same key is a no-op, so this
  // needs no read-before-write — and reading localStorage to decide would itself
  // throw on the initial `about:blank` document, where storage is denied.
  await page.addInitScript(
    ([onboardingKey]) => window.localStorage.setItem(onboardingKey, '1'),
    [ONBOARDING_SEEN_KEY] as const,
  );
}

/**
 * How long to wait for the fixture's library card.
 *
 * Explicitly generous: the suite runs fully parallel against a Next dev server,
 * where a route's first concurrent compile can take far longer than Playwright's
 * 5s default. A too-short wait here reports "no fixture was seeded" for what is
 * really a slow compile — a misleading failure, so the wait is stated rather than
 * defaulted.
 */
export const CARD_WAIT_MS = 60_000;

let seededPieceIdPromise: Promise<string> | null = null;

/** Clear the memoised fixture id. Only useful if a test deliberately re-seeds. */
export function resetSeededPieceIdCache(): void {
  seededPieceIdPromise = null;
}

/**
 * Resolve the seeded fixture piece's id at runtime, from the real library page.
 *
 * The stand hub lists every non-archived library piece as a card linking to
 * `/member/stand/library/<id>`, and the fixture is the only piece credited to
 * {@link SEEDED_PIECE_COMPOSER}. So the id is discovered the way a member finds
 * the piece, rather than being asserted by the test suite. The result is memoised
 * per worker because the id cannot change while the suite runs, and a rejected
 * lookup is not cached — a transient failure must not poison every later test.
 */
export async function resolveSeededPieceId(page: Page): Promise<string> {
  if (!seededPieceIdPromise) {
    seededPieceIdPromise = lookupSeededPieceId(page).catch((error) => {
      // Allow a retry: only a successful lookup is memoised.
      seededPieceIdPromise = null;
      throw error;
    });
  }
  return seededPieceIdPromise;
}

/**
 * Open the stand hub's "All Music" library tab, with the cards actually mounted.
 *
 * Two things make a bare `tab.click()` unreliable here, and both look like
 * "the fixture is missing" when they go wrong:
 *
 *  1. The library cards live inside a Radix `TabsContent`, which is unmounted until
 *     its tab is activated — so they genuinely do not exist before the click.
 *  2. Clicking before React hydrates is SILENTLY LOST. The tab is then a plain
 *     button with no listener, so Playwright's click "succeeds", nothing activates,
 *     and the cards are never mounted. Nothing intercepts the pointer, so
 *     Playwright has no way to notice — the click must be retried until the tab's
 *     activated state is observable.
 */
export async function gotoLibraryTab(page: Page): Promise<void> {
  await ensureOnboardingSuppressed(page);
  await page.goto(STAND_HUB, { waitUntil: 'domcontentloaded' });

  const libraryTab = page.getByRole('tab', { name: /All Music/i });
  await expect(libraryTab, 'the stand hub should offer an All Music tab').toBeVisible({
    timeout: CARD_WAIT_MS,
  });

  await expect
    .poll(
      async () => {
        if ((await libraryTab.getAttribute('aria-selected')) !== 'true') {
          await libraryTab.click({ timeout: 5_000 }).catch(() => {});
        }
        return (await libraryTab.getAttribute('aria-selected')) === 'true';
      },
      { timeout: CARD_WAIT_MS, message: 'the All Music tab never activated' },
    )
    .toBe(true);
}

async function lookupSeededPieceId(page: Page): Promise<string> {
  await gotoLibraryTab(page);

  const card = page
    .locator('[data-slot="card"]')
    .filter({ hasText: SEEDED_PIECE_COMPOSER })
    .first();
  await expect(
    card,
    `no library card for the seeded fixture (composer "${SEEDED_PIECE_COMPOSER}") — has \`npm run db:seed\` been run?`,
  ).toBeVisible({ timeout: CARD_WAIT_MS });

  const link = card.locator('a[href^="/member/stand/library/"]');
  await expect(link, 'the fixture card must offer a link into the viewer').toBeVisible({
    timeout: CARD_WAIT_MS,
  });

  const href = await link.getAttribute('href');
  const id = href?.split('/').filter(Boolean).pop();
  expect(id, `could not read a piece id out of "${href}"`).toBeTruthy();
  return id!;
}

/** The viewer's route for a given piece id. */
export function pieceViewerPath(pieceId: string): string {
  return `/member/stand/library/${pieceId}`;
}

/**
 * Open the seeded score and wait until PDF.js has rasterised it.
 *
 * Replaces a module-level `PIECE_VIEWER` constant: the route cannot be known until
 * the fixture's id has been resolved from the database.
 */
export async function openSeededPiece(page: Page): Promise<string> {
  const pieceId = await resolveSeededPieceId(page);
  // Always navigate. `resolveSeededPieceId` may have answered from the per-worker
  // memo without touching the page, so this cannot assume it is already on the
  // hub — and the viewer URL is the only thing this helper guarantees.
  await page.goto(pieceViewerPath(pieceId), { waitUntil: 'domcontentloaded' });
  await waitForPdfRendered(page);
  return pieceId;
}

/**
 * Suppress the onboarding modal and start every test from the documented
 * default view preferences.
 *
 * Clearing the persisted store between tests is deliberate: zoom, night mode and
 * crop are now genuinely persisted, so a test that zoomed to 130% would
 * otherwise leak that zoom into the next test and make it order-dependent.
 *
 * The clear is guarded by a sessionStorage sentinel. `addInitScript` runs on
 * EVERY navigation, including the reloads that the persistence specs are
 * testing — without the guard the helper would wipe the very preference the
 * test just set and make persistence untestable. sessionStorage is scoped to the
 * tab and survives reloads, which is exactly the lifetime needed here.
 */
export async function prepareStandPage(page: Page): Promise<void> {
  await page.addInitScript(
    ([onboardingKey, prefKey, sentinelKey]) => {
      window.localStorage.setItem(onboardingKey, '1');
      if (!window.sessionStorage.getItem(sentinelKey)) {
        window.sessionStorage.setItem(sentinelKey, '1');
        window.localStorage.removeItem(prefKey);
      }
    },
    [ONBOARDING_SEEN_KEY, STAND_VIEW_PREF_KEY, STAND_PREFS_CLEARED_SENTINEL] as const,
  );
}

/** The stand's main PDF canvas, as opposed to the annotation/offscreen layers. */
export function pdfCanvas(page: Page): Locator {
  return page.locator('[aria-label="PDF viewer"] canvas').first();
}

/** A specific annotation layer canvas, e.g. 'personal'. */
export function annotationLayer(page: Page, layer: 'personal' | 'section' | 'director'): Locator {
  return page.locator(`canvas[aria-label*="${layer} annotation layer"]`);
}

/**
 * Wait until PDF.js has genuinely rasterised a page into the visible canvas.
 *
 * A freshly mounted <canvas> has a 300x150 default backing store, so "the canvas
 * exists" and "the PDF rendered" are completely different claims. We wait on a
 * backing store large enough to be a real page (a letter page at scale 1 is
 * ~612x792 CSS px) and then assert the same value, so a stuck render fails
 * loudly instead of being mistaken for a slow one.
 */
export async function waitForPdfRendered(page: Page): Promise<{ width: number; height: number }> {
  await expect(page.getByRole('region', { name: 'PDF viewer' })).toBeVisible();

  await page.waitForFunction(
    () => {
      const c = document.querySelector<HTMLCanvasElement>(
        '[aria-label="PDF viewer"] canvas',
      );
      return !!c && c.width > 400 && c.height > 400;
    },
    undefined,
    { timeout: 60_000 },
  );

  const size = await pdfCanvas(page).evaluate((el) => {
    const c = el as HTMLCanvasElement;
    return { width: c.width, height: c.height };
  });
  expect(size.width, 'PDF canvas should be wider than the 300px canvas default').toBeGreaterThan(400);
  expect(size.height, 'PDF canvas should be taller than the 150px canvas default').toBeGreaterThan(400);
  return size;
}

/**
 * Wait until a canvas has actually been painted.
 *
 * PDF.js resizes the backing store at the *start* of a render and paints at the
 * end, so a canvas with correct dimensions is briefly empty. Asserting ink the
 * instant the size looks right is a guaranteed race. Poll the pixel count
 * instead, and fail with the final observed value so a genuinely blank page is
 * diagnosable rather than just "timed out".
 */
export async function waitForCanvasInk(page: Page, canvas: Locator): Promise<number> {
  let last = 0;
  await expect
    .poll(
      async () => {
        last = await canvas
          .evaluate((el) => {
            const c = el as HTMLCanvasElement;
            const ctx = c.getContext('2d');
            if (!ctx || c.width === 0 || c.height === 0) return 0;
            const { data } = ctx.getImageData(0, 0, c.width, c.height);
            let nonTransparent = 0;
            for (let i = 3; i < data.length; i += 4) {
              if (data[i] !== 0) nonTransparent++;
            }
            return nonTransparent;
          })
          .catch(() => 0);
        return last;
      },
      {
        timeout: 30_000,
        message: `canvas never painted (last non-transparent pixel count: ${last})`,
      },
    )
    .toBeGreaterThan(0);
  return last;
}

/**
 * Assert the page really painted something.
 *
 * A canvas can have a correct backing-store size and still be entirely
 * transparent — that is what a cancelled or errored PDF.js render leaves
 * behind. Counting non-zero pixels is the only assertion that distinguishes
 * "the viewer initialised" from "an empty canvas is present".
 */
export async function expectCanvasHasInk(canvas: Locator): Promise<number> {
  const painted = await canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('annotation canvas has no 2d context');
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let nonTransparent = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0) nonTransparent++;
    }
    return { nonTransparent, width: c.width, height: c.height };
  });

  expect(
    painted.nonTransparent,
    `canvas ${painted.width}x${painted.height} should contain rendered pixels`,
  ).toBeGreaterThan(0);
  return painted.nonTransparent;
}

/** Enter annotate mode using the toolbar's Edit toggle. */
export async function enterEditMode(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: 'Toggle edit mode for annotations' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
}

/**
 * Draw a stroke with trusted mouse input across the personal layer.
 *
 * Uses real `page.mouse` events rather than synthetic dispatch so the whole
 * pointer pipeline is exercised: hit-testing, pointer capture, the gesture
 * overlay's pass-through decision, and React's pointer handlers. A synthetic
 * event would bypass exactly the arbitration this is meant to test.
 */
export async function drawStrokeOnPersonalLayer(page: Page): Promise<void> {
  const layer = annotationLayer(page, 'personal');
  await expect(layer).toHaveAttribute('aria-hidden', 'false');

  // The layer must cover the rendered page, or a stroke would be captured
  // against a fraction of it and replayed at the wrong scale.
  const layerBox = await layer.boundingBox();
  const pageBox = await pdfCanvas(page).boundingBox();
  expect(layerBox, 'personal annotation layer should have a box').not.toBeNull();
  expect(pageBox, 'PDF canvas should have a box').not.toBeNull();
  expect(
    Math.abs(layerBox!.width - pageBox!.width),
    'annotation layer should be the same width as the rendered page',
  ).toBeLessThanOrEqual(2);
  expect(
    Math.abs(layerBox!.height - pageBox!.height),
    'annotation layer should be the same height as the rendered page',
  ).toBeLessThanOrEqual(2);

  await drawStrokeAt(page, layerBox!, 0.5);
}

/**
 * Draw a horizontal zigzag at a fractional height of the annotation layer.
 *
 * The height is clamped to the part of the layer that is actually inside the
 * viewport. A 27-page score renders taller than the window, and trusted mouse
 * events dispatched below the viewport never reach the canvas at all — the
 * pointerdown lands on <html> and the stroke is silently lost, which looks
 * exactly like a product bug.
 */
async function drawStrokeAt(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  heightFraction: number,
): Promise<void> {
  const viewport = page.viewportSize();
  expect(viewport, 'a viewport size is required to aim the stroke').not.toBeNull();

  const visibleTop = Math.max(box.y, 0);
  const visibleBottom = Math.min(box.y + box.height, viewport!.height);
  expect(
    visibleBottom - visibleTop,
    'the annotation layer must have a visible area to draw on',
  ).toBeGreaterThan(100);

  const wanted = box.y + box.height * heightFraction;
  const midY = Math.min(Math.max(wanted, visibleTop + 30), visibleBottom - 30);
  const startX = box.x + 40;

  await page.mouse.move(startX, midY);
  await page.mouse.down();
  // A zigzag, so the stroke has genuine curvature and many sample points.
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(startX + i * 18, midY + (i % 2 === 0 ? 14 : -14));
  }
  await page.mouse.up();
}

/** Draw a second stroke in a clearly different band of the page. */
export async function drawSecondStrokeOnPersonalLayer(page: Page): Promise<void> {
  const layer = annotationLayer(page, 'personal');
  await expect(layer).toHaveAttribute('aria-hidden', 'false');
  const box = (await layer.boundingBox())!;
  await drawStrokeAt(page, box, 0.25);
}

/** Read annotations for the seeded piece back through the real API. */
export interface StoredAnnotation {
  id: string;
  page: number;
  layer: string;
  strokeData: {
    type?: string;
    points?: Array<{ x: number; y: number }>;
    [k: string]: unknown;
  };
}

export async function fetchAnnotations(page: Page): Promise<StoredAnnotation[]> {
  const pieceId = await resolveSeededPieceId(page);
  const response = await page.request.get(`/api/stand/annotations?musicId=${pieceId}`);
  expect(response.status(), 'annotations API should be readable').toBe(200);
  const body = (await response.json()) as { annotations?: StoredAnnotation[] };
  return body.annotations ?? [];
}

/**
 * Delete every annotation this suite created on the seeded piece.
 *
 * Annotation tests share one seeded score, so without cleanup a leftover stroke
 * would make the next run's "starts empty" baseline fail — and with parallel
 * workers it would make runs order-dependent. Cleanup runs in `afterEach` so a
 * failing test still tidies up, and it only removes PERSONAL annotations, which
 * are the only ones this suite creates.
 */
export async function clearSeededAnnotations(page: Page): Promise<void> {
  // fetchAnnotations resolves the fixture id itself (memoised per worker).
  const existing = await fetchAnnotations(page);
  const personal = existing.filter((a) => a.layer === 'PERSONAL');
  if (personal.length === 0) return;

  // Issued via in-page fetch, not page.request, so the browser attaches the
  // same-origin Origin header the CSRF middleware requires. A bare APIRequest
  // call is correctly rejected with 403, which is the CSRF protection working.
  const statuses = await page.evaluate(async (ids) => {
    const out: Array<{ id: string; status: number }> = [];
    for (const id of ids) {
      const response = await fetch(`/api/stand/annotations/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      out.push({ id, status: response.status });
    }
    return out;
  }, personal.map((a) => a.id));

  for (const { id, status } of statuses) {
    expect(status, `cleanup should delete annotation ${id}`).toBe(200);
  }

  // Cleanup is only trustworthy if it actually emptied the piece.
  expect(
    (await fetchAnnotations(page)).filter((a) => a.layer === 'PERSONAL'),
    'cleanup should leave no PERSONAL annotations behind',
  ).toHaveLength(0);
}

/** Reload and wait for the viewer to come back up. */
export async function reloadAndWaitForPdf(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForPdfRendered(page);
}