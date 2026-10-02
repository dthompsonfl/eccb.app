/**
 * Digital Music Stand — single page vs two-page spread.
 *
 * A spread is how a musician reads a conductor score or a two-page turn, so the
 * toggle has to do three things, all asserted here: actually change the layout,
 * move the visible pages as a spread rather than by one, and survive a reload.
 */
import { expect, test } from '@playwright/test';

import { openSeededPiece, prepareStandPage, waitForPdfRendered } from './_helpers';

function spreadToggle(page: import('@playwright/test').Page) {
  return page
    .getByRole('toolbar', { name: 'Music stand controls' })
    .getByRole('button', { name: /Toggle two-page spread view/ });
}

/** The main page canvas plus the spread's right-hand canvas, when present. */
function visiblePageCanvases(page: import('@playwright/test').Page) {
  return page.locator('[aria-label="PDF viewer"] canvas[role="img"]');
}

function pageStatus(page: import('@playwright/test').Page) {
  return page.getByRole('status', { name: /^Page \d+ of \d+/ });
}

/** Read the on-canvas page indicator, e.g. "1 / 27". */
async function readStatus(page: import('@playwright/test').Page): Promise<number> {
  const text = await pageStatus(page).innerText();
  const current = Number(/^(\d+)\s*\//.exec(text.trim())?.[1]);
  expect(Number.isNaN(current), `unreadable page indicator: ${text}`).toBe(false);
  return current;
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

test.describe('two-page spread vs single page', () => {
  test('the layout toggle is offered and starts in single-page mode', async ({ page }) => {
    await openSeededPiece(page);

    const toggle = spreadToggle(page);
    await expect(toggle).toBeVisible();
    // The seeded score is 27 pages, so the spread is available.
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    // Single page: only the main page canvas.
    await expect(visiblePageCanvases(page)).toHaveCount(1);
  });

  test('turning on the spread shows a second, genuinely rendered page', async ({ page }) => {
    await openSeededPiece(page);

    await spreadToggle(page).click();
    await expect(spreadToggle(page)).toHaveAttribute('aria-pressed', 'true');

    // The right-hand page is a real canvas with its own raster, not a hidden
    // preload target — that was the original defect in this feature.
    const right = page.getByTestId('stand-spread-right-page');
    await expect(right).toBeVisible();
    await expect(visiblePageCanvases(page)).toHaveCount(2);

    // Its accessible name reports the real second page of the document.
    await expect(right).toHaveAttribute('aria-label', /^Page 2 of \d+ of Avengers$/);

    // And it is actually painted, at a plausible page size.
    await expect
      .poll(async () =>
        right.evaluate((el) => {
          const c = el as HTMLCanvasElement;
          const ctx = c.getContext('2d');
          if (!ctx || c.width === 0) return 0;
          const { data } = ctx.getImageData(0, 0, c.width, c.height);
          let n = 0;
          for (let i = 3; i < data.length; i += 4) {
            if (data[i] !== 0) n++;
          }
          return n;
        }),
      )
      .toBeGreaterThan(1000);

    const size = await right.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      return { width: c.width, height: c.height };
    });
    expect(size.width, 'the spread page should be a full page wide').toBeGreaterThan(400);
    expect(size.height, 'the spread page should be a full page tall').toBeGreaterThan(400);
  });

  test('turning the spread off returns to a single page', async ({ page }) => {
    await openSeededPiece(page);

    await spreadToggle(page).click();
    await expect(page.getByTestId('stand-spread-right-page')).toBeVisible();

    await spreadToggle(page).click();
    await expect(spreadToggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('stand-spread-right-page')).toHaveCount(0);
    await expect(visiblePageCanvases(page)).toHaveCount(1);
  });

  test('the spread aligns to a recto and advances two pages at a time', async ({ page }) => {
    await openSeededPiece(page);

    // Turn the spread on part-way through the piece: the store re-aligns to the
    // left (recto) page of a spread rather than stranding the musician mid-system.
    const next = page
      .getByRole('toolbar', { name: 'Music stand controls' })
      .getByRole('button', { name: 'Next page' });
    await next.click();
    await next.click();
    await expect.poll(() => readStatus(page)).toBe(3);

    await spreadToggle(page).click();
    await expect(page.getByTestId('stand-spread-right-page')).toBeVisible();

    // Leaving the spread is its own transition rather than a page-by-page step.
    const leftPage = await readStatus(page);
    await next.click();
    await expect.poll(() => readStatus(page)).toBe(leftPage + 2);
    await expect(page.getByTestId('stand-spread-right-page')).toHaveAttribute(
      'aria-label',
      new RegExp(`^Page ${leftPage + 3} of \\d+ of Avengers$`),
    );
  });

  test('the chosen layout survives a reload', async ({ page }) => {
    await openSeededPiece(page);

    await spreadToggle(page).click();
    await expect(spreadToggle(page)).toHaveAttribute('aria-pressed', 'true');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForPdfRendered(page);

    await expect(spreadToggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('stand-spread-right-page')).toBeVisible();
    await expect(visiblePageCanvases(page)).toHaveCount(2);
  });
});