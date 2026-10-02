/**
 * Digital Music Stand — view preferences a musician sets once and expects to
 * keep: zoom level, and the two-page spread layout.
 *
 * A musician who enlarges the music to read a hard bar, or switches the stand
 * into a two-page spread for a conductor score, expects that to still be true
 * when they come back. These specs assert that through the real UI and through
 * a real reload — not by reading the store directly.
 */
import { expect, test } from '@playwright/test';

import {
  STAND_VIEW_PREF_KEY,
  gotoLibraryTab,
  openSeededPiece,
  pdfCanvas,
  resolveSeededPieceId,
  prepareStandPage,
  waitForPdfRendered,
} from './_helpers';

/** The toolbar's zoom readout, e.g. "Zoom 130%, click to reset". */
function zoomReadout(page: import('@playwright/test').Page) {
  return page.getByRole('button', { name: /^Zoom \d+%, click to reset$/ });
}

function standToolbar(page: import('@playwright/test').Page) {
  return page.getByRole('toolbar', { name: 'Music stand controls' });
}

/** Zoom in by clicking the toolbar button `times` times. */
async function zoomIn(page: import('@playwright/test').Page, times: number): Promise<number> {
  const button = standToolbar(page).getByRole('button', { name: 'Zoom in' });
  for (let i = 0; i < times; i++) await button.click();
  const label = await zoomReadout(page).getAttribute('aria-label');
  const percent = Number(/Zoom (\d+)%/.exec(label ?? '')?.[1]);
  expect(Number.isNaN(percent), `unreadable zoom label: ${label}`).toBe(false);
  return percent;
}

/**
 * Navigate client-side to the library hub and back into the SAME score.
 *
 * The link is located by the resolved fixture id rather than by taking whichever
 * card happens to be first, so this exercises "leave and return to the piece I was
 * reading" instead of accidentally testing a different piece.
 */
async function navigateAwayAndBack(page: import('@playwright/test').Page): Promise<void> {
  const pieceId = await resolveSeededPieceId(page);
  await gotoLibraryTab(page);
  const link = page.locator(`a[href="/member/stand/library/${pieceId}"]`);
  await expect(link).toBeVisible();
  await link.click();
  await waitForPdfRendered(page);
}

test.beforeEach(async ({ page }) => {
  await prepareStandPage(page);
});

// Opening a score resolves the fixture from the library and then rasterises a
// 27-page PDF through PDF.js. Against a Next dev server, several workers hitting
// cold-compiled routes concurrently can exceed Playwright's 30s default — a
// timeout there would report a fixture problem that does not exist. The budget is
// raised explicitly; no assertion is relaxed.
test.describe.configure({ timeout: 180_000 });

test.describe('zoom level persistence', () => {
  test('zooming in enlarges the rendered page', async ({ page }) => {
    await openSeededPiece(page);
    const at100 = await waitForPdfRendered(page);
    await expect(zoomReadout(page)).toHaveAttribute('aria-label', 'Zoom 100%, click to reset');

    const percent = await zoomIn(page, 3);
    expect(percent, 'three zoom-in steps from 100% should reach 130%').toBe(130);
    await expect(zoomReadout(page)).toHaveAttribute('aria-label', 'Zoom 130%, click to reset');

    // The zoom must reach the rasteriser, not just the label: a wider backing
    // store is the observable consequence of a larger scale factor.
    await expect
      .poll(async () => (await pdfCanvas(page).evaluate((el) => (el as HTMLCanvasElement).width)))
      .toBeGreaterThan(at100.width);
  });

  test('the chosen zoom survives a full page reload', async ({ page }) => {
    await openSeededPiece(page);

    const percent = await zoomIn(page, 4);
    expect(percent).toBe(140);
    const widthAt140 = await pdfCanvas(page).evaluate((el) => (el as HTMLCanvasElement).width);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForPdfRendered(page);

    await expect(zoomReadout(page)).toHaveAttribute(
      'aria-label',
      `Zoom ${percent}%, click to reset`,
    );
    await expect
      .poll(async () => (await pdfCanvas(page).evaluate((el) => (el as HTMLCanvasElement).width)))
      .toBe(widthAt140);
  });

  test('the chosen zoom survives navigating to another score and back', async ({ page }) => {
    await openSeededPiece(page);

    const percent = await zoomIn(page, 3);
    const widthAtZoom = await pdfCanvas(page).evaluate((el) => (el as HTMLCanvasElement).width);

    await navigateAwayAndBack(page);

    await expect(zoomReadout(page)).toHaveAttribute(
      'aria-label',
      `Zoom ${percent}%, click to reset`,
    );
    await expect
      .poll(async () => (await pdfCanvas(page).evaluate((el) => (el as HTMLCanvasElement).width)))
      .toBe(widthAtZoom);
  });

  test('the zoom reset control returns the view to 100%', async ({ page }) => {
    await openSeededPiece(page);
    const at100 = await waitForPdfRendered(page);

    await zoomIn(page, 3);
    await zoomReadout(page).click();

    await expect(zoomReadout(page)).toHaveAttribute('aria-label', 'Zoom 100%, click to reset');
    await expect
      .poll(async () => (await pdfCanvas(page).evaluate((el) => (el as HTMLCanvasElement).width)))
      .toBe(at100.width);
  });

  test('zoom is clamped to the supported 50%–200% range', async ({ page }) => {
    await openSeededPiece(page);

    await zoomIn(page, 12);
    await expect(zoomReadout(page)).toHaveAttribute('aria-label', 'Zoom 200%, click to reset');

    const zoomOut = standToolbar(page).getByRole('button', { name: 'Zoom out' });
    for (let i = 0; i < 20; i++) await zoomOut.click();
    await expect(zoomReadout(page)).toHaveAttribute('aria-label', 'Zoom 50%, click to reset');
  });

  test('the persisted view preferences contain no per-user or per-event data', async ({ page }) => {
    await openSeededPiece(page);
    await zoomIn(page, 2);

    const raw = await page.evaluate(
      (key) => window.localStorage.getItem(key),
      STAND_VIEW_PREF_KEY,
    );
    expect(raw, 'view preferences should have been persisted').not.toBeNull();

    // Persisting view state must never drag server-owned or user-owned data into
    // localStorage, where it would leak across sessions on a shared device.
    for (const forbidden of [
      'pieces',
      'annotations',
      'roster',
      'userContext',
      'eventId',
      'eventTitle',
      'userId',
    ]) {
      expect(raw, `persisted state must not contain "${forbidden}"`).not.toContain(`"${forbidden}"`);
    }
  });
});