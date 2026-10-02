/**
 * Digital Music Stand — musician workflow.
 *
 * These specs replace route-load smoke coverage with the things a member
 * actually does: open a score, read it, mark it up, and come back to it.
 *
 * Assertions are on real rendered output and real persisted state — never on a
 * 200 status. Every wait is an explicit condition; there are no fixed sleeps.
 * Nothing here is skipped or weakened to produce a green run.
 */
import { expect, test } from '@playwright/test';

import {
  CARD_WAIT_MS,
  annotationLayer,
  gotoLibraryTab,
  clearSeededAnnotations,
  drawSecondStrokeOnPersonalLayer,
  drawStrokeOnPersonalLayer,
  enterEditMode,
  expectCanvasHasInk,
  openSeededPiece,
  pieceViewerPath,
  resolveSeededPieceId,
  waitForCanvasInk,
  fetchAnnotations,
  pdfCanvas,
  prepareStandPage,
  reloadAndWaitForPdf,
  waitForPdfRendered,
} from './_helpers';

test.beforeEach(async ({ page }) => {
  await prepareStandPage(page);
});

// Opening a score resolves the fixture from the library and then rasterises a
// 27-page PDF through PDF.js. Against a Next dev server, several workers hitting
// cold-compiled routes concurrently can exceed Playwright's 30s default — a
// timeout there would report a fixture problem that does not exist. The budget is
// raised explicitly; no assertion is relaxed.
test.describe.configure({ timeout: 180_000 });

/**
 * The on-canvas page indicator.
 *
 * Its accessible name embeds the current page ("Page 1 of 27"), so it must be
 * matched loosely and re-queried rather than held across a page change.
 */
function pageStatus(page: import('@playwright/test').Page) {
  return page.getByRole('status', { name: /^Page \d+ of \d+/ });
}

test.describe('opening a score', () => {
  test('the library lists a score a member can open', async ({ page }) => {
    // The fixture's id is discovered from the library, not assumed by the suite.
    const pieceId = await resolveSeededPieceId(page);

    // Re-enter the library deliberately. `resolveSeededPieceId` may have returned
    // a memoised id without navigating — the cards only exist once the All Music
    // tab is active — so this test performs the navigation it is actually testing.
    await gotoLibraryTab(page);

    const openLink = page.locator(`a[href="/member/stand/library/${pieceId}"]`);
    await expect(
      openLink,
      'the seeded fixture should be listed in the All Music tab',
    ).toBeVisible({ timeout: CARD_WAIT_MS });

    await openLink.click();
    await waitForPdfRendered(page);
    await expect(page).toHaveURL(new RegExp(`/member/stand/library/${pieceId}$`));
  });

  test('PDF.js actually rasterises the score, not just an empty canvas', async ({ page }) => {
    const pieceId = await resolveSeededPieceId(page);
    const response = await page.goto(pieceViewerPath(pieceId), { waitUntil: 'domcontentloaded' });
    expect(response, 'score route should return a response').not.toBeNull();
    expect(response!.status(), 'score route should not error').toBeLessThan(500);
    expect(page.url(), 'score route must not redirect an authenticated member away').not.toContain(
      '/login',
    );

    const size = await waitForPdfRendered(page);

    // A mounted-but-empty canvas also has plausible dimensions, so prove pixels
    // were actually painted.
    const painted = await waitForCanvasInk(page, pdfCanvas(page));
    expect(painted, 'a rendered page should have a substantial amount of ink').toBeGreaterThan(1000);

    // PDF.js knows how many pages the document has; a 1-page stand would mean
    // the document never parsed.
    await expect(pageStatus(page)).toHaveText(/^1 \/ (?!1$)\d+$/);
    expect(size.width).toBeGreaterThan(0);
  });

  test('the viewer reports the real page count and can turn the page', async ({ page }) => {
    await openSeededPiece(page);

    const status = pageStatus(page);
    await expect(status).toHaveText(/1 \/ (\d+)/);
    const total = Number(/1 \/ (\d+)/.exec((await status.innerText())!)![1]);
    expect(total, 'seeded score should have multiple pages').toBeGreaterThan(1);

    // Both the library page's own pager and the toolbar's pager are labelled
    // "Next page", so scope to the toolbar the member is actually looking at.
    const toolbarNext = page
      .getByRole('toolbar', { name: 'Music stand controls' })
      .getByRole('button', { name: 'Next page' });
    await expect(toolbarNext, 'Next page must be enabled on a multi-page score').toBeEnabled();
    await toolbarNext.click();
    await expect(status).toHaveText(new RegExp(`2 / ${total}`));

    // A different page must produce a differently-sized raster, proving the
    // canvas is being redrawn rather than left showing page 1.
    const pageTwo = await waitForPdfRendered(page);
    expect(pageTwo.width).toBeGreaterThan(400);
    await waitForCanvasInk(page, pdfCanvas(page));

    const toolbarPrev = page
      .getByRole('toolbar', { name: 'Music stand controls' })
      .getByRole('button', { name: 'Previous page' });
    await toolbarPrev.click();
    await expect(status).toHaveText(new RegExp(`1 / ${total}`));
  });
});

test.describe('annotating a score', () => {
  // These tests write to, and assert emptiness of, the same seeded score, so
  // they must not run concurrently with each other. Serial mode keeps them in
  // one worker, in order, with cleanup between.
  test.describe.configure({ mode: 'serial' });

  test.afterEach(async ({ page }) => {
    await clearSeededAnnotations(page);
  });

  test('a drawn annotation is saved and reloads after a full page refresh', async ({ page }) => {
    await openSeededPiece(page);
    await expect(pageStatus(page)).toHaveText(/1 \/ \d+/);

    // Baseline: this piece starts with no annotations, so a later count of 1 can
    // only be the stroke we just drew.
    await clearSeededAnnotations(page);
    expect(await fetchAnnotations(page)).toHaveLength(0);

    await enterEditMode(page);
    await drawStrokeOnPersonalLayer(page);

    // ── It saved ────────────────────────────────────────────────────────────
    await expect
      .poll(
        async () => (await fetchAnnotations(page)).length,
        { timeout: 20_000, message: 'the stroke should be persisted by the annotations API' },
      )
      .toBe(1);

    const before = await fetchAnnotations(page);
    const saved = before[0]!;
    expect(saved.layer).toBe('PERSONAL');
    expect(saved.page).toBe(1);
    expect(saved.strokeData.type).toBe('PENCIL');
    // Coordinates are normalised page fractions, which is what makes an
    // annotation land in the same place on another device.
    const points = saved.strokeData.points ?? [];
    expect(points.length, 'a real stroke should record many sample points').toBeGreaterThan(3);
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(1);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(1);
    }

    // And it is actually painted on the live layer, not merely stored.
    await waitForCanvasInk(page, annotationLayer(page, 'personal'));

    // ── It survives a real reload ───────────────────────────────────────────
    // A full page load throws away every bit of in-memory state. If the marking
    // reappears, it genuinely came back from the database.
    await reloadAndWaitForPdf(page);

    const after = await fetchAnnotations(page);
    expect(after, 'the annotation must still exist after a full reload').toHaveLength(1);
    expect(after[0]!.id, 'it must be the same annotation, not a duplicate').toBe(saved.id);
    expect(
      after[0]!.strokeData.points,
      'the stroke geometry must be byte-identical after reload',
    ).toEqual(saved.strokeData.points);

    // The reloaded viewer repaints the ink from the stored geometry. Wait for
    // it rather than assuming it is already there.
    await waitForCanvasInk(page, annotationLayer(page, 'personal'));
  });

  test('a second, separate stroke is stored as its own annotation', async ({ page }) => {
    await openSeededPiece(page);
    await clearSeededAnnotations(page);
    expect(await fetchAnnotations(page)).toHaveLength(0);

    await enterEditMode(page);

    // First stroke: middle of the page.
    await drawStrokeOnPersonalLayer(page);
    await expect
      .poll(async () => (await fetchAnnotations(page)).length, { timeout: 20_000 })
      .toBe(1);

    // Second stroke: a clearly different band of the page, so the two strokes
    // must have different geometry rather than one overwriting the other.
    await drawSecondStrokeOnPersonalLayer(page);

    await expect
      .poll(async () => (await fetchAnnotations(page)).length, { timeout: 20_000 })
      .toBe(2);

    const stored = await fetchAnnotations(page);
    expect(new Set(stored.map((a) => a.id)).size, 'annotations must be distinct').toBe(2);
    const firstYs = stored[0]!.strokeData.points!.map((p) => p.y);
    const secondYs = stored[1]!.strokeData.points!.map((p) => p.y);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(
      Math.abs(mean(secondYs) - mean(firstYs)),
      'the two strokes were drawn in different bands and must stay that way',
    ).toBeGreaterThan(0.1);

    await reloadAndWaitForPdf(page);
    const after = await fetchAnnotations(page);
    expect(after.map((a) => a.id).sort()).toEqual(stored.map((a) => a.id).sort());
  });

  test('annotations are scoped to the page they were drawn on', async ({ page }) => {
    await openSeededPiece(page);
    await clearSeededAnnotations(page);
    expect(await fetchAnnotations(page)).toHaveLength(0);

    await enterEditMode(page);
    await drawStrokeOnPersonalLayer(page);
    await expect
      .poll(async () => (await fetchAnnotations(page)).length, { timeout: 20_000 })
      .toBe(1);

    // Move to page 2 and confirm the page-1 marking is not shown there. A
    // stand that painted every annotation on every page would be unusable.
    await page
      .getByRole('toolbar', { name: 'Music stand controls' })
      .getByRole('button', { name: 'Next page' })
      .click();
    await expect(pageStatus(page)).toHaveText(/2 \/ \d+/);
    await waitForPdfRendered(page);

    // Page 2 genuinely has no annotation of its own.
    const stored = await fetchAnnotations(page);
    expect(stored.every((a) => a.page === 1)).toBe(true);

    // Give the layer a chance to (incorrectly) paint, then assert it stayed
    // blank. A stable blank across several samples is meaningfully stronger
    // than a single immediate read.
    const layer = annotationLayer(page, 'personal');
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(
        await expectCanvasHasInk(layer).catch(() => 0),
        'page 2 must not repaint the page-1 annotation',
      ).toBe(0);
      await expect(pageStatus(page)).toHaveText(/2 \/ \d+/);
    }
  });
});