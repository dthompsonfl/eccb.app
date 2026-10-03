/**
 * Large-print for the SCORE, not just the app chrome.
 *
 * The rest of the app scales by changing the root font size, which reaches
 * everything laid out in `rem`. The music stand's score is rasterised by PDF.js
 * into a canvas at an explicit scale, so the root-font-size trick cannot reach
 * it — it is applied separately in `getScoreRenderScale()`.
 *
 * This spec proves the two are actually wired together in the real viewer: it
 * measures the rendered canvas backing store at each text-size preference. A
 * member who cannot read the part at 100% must get a bigger page, and this is
 * the only place that claim can be checked.
 *
 * Runs in the authenticated `stand` project (see playwright.config.ts).
 */
import { expect, test } from '@playwright/test';

import {
  ONBOARDING_SEEN_KEY,
  STAND_VIEW_PREF_KEY,
  gotoLibraryTab,
  openSeededPiece,
  pdfCanvas,
  pieceViewerPath,
  resolveSeededPieceId,
  waitForPdfRendered,
} from './_helpers';

/** The four offered preferences, in the order the control lists them. */
const SCALES = ['small', 'medium', 'large', 'xlarge'] as const;

test.describe('score large-print', () => {
  test('a larger text-size preference renders a larger score', async ({ page }) => {
    /**
     * Render the score at one text-size preference and measure its canvas.
     *
     * The preference is set in localStorage BEFORE any app script runs, exactly
     * as the real pre-paint script does, because reading it after hydration
     * would measure the default instead of the chosen value.
     */
    async function canvasWidthAt(preference: string): Promise<number> {
      await page.addInitScript(
        ([onboardingKey, prefKey, pref]) => {
          window.localStorage.setItem(onboardingKey, '1');
          window.localStorage.setItem('eccb:text-scale', pref);
          // Drop any persisted stand view state so the measurement is not
          // contaminated by a zoom set on an earlier navigation in this tab.
          window.localStorage.removeItem(prefKey);
        },
        [ONBOARDING_SEEN_KEY, STAND_VIEW_PREF_KEY, preference] as const,
      );

      await gotoLibraryTab(page);
      await openSeededPiece(page);

      const canvas = pdfCanvas(page);
      await expect(canvas).toBeVisible();

      // The backing store is what PDF.js actually rasterises into, so it is the
      // honest measure of "how big is the printed page" — not the CSS box, which
      // layout may constrain independently of the render scale.
      return canvas.evaluate((el) => (el as HTMLCanvasElement).width);
    }

    const widths: Record<string, number> = {};
    for (const preference of SCALES) {
      widths[preference] = await canvasWidthAt(preference);
    }

    // Every preference must produce a real, non-zero canvas.
    for (const preference of SCALES) {
      expect(
        widths[preference],
        `score canvas should have a real backing store at "${preference}"`,
      ).toBeGreaterThan(0);
    }

    // Monotonically non-decreasing: a bigger text preference never shrinks the score.
    expect(
      widths.large,
      'large print should be at least as wide as medium',
    ).toBeGreaterThanOrEqual(widths.medium);
    expect(
      widths.xlarge,
      'extra-large print should be at least as wide as large',
    ).toBeGreaterThanOrEqual(widths.large);

    // And the feature must actually DO something: "Extra large" has to be
    // visibly bigger than "Medium", otherwise this ships as a no-op.
    expect(
      widths.xlarge,
      'extra-large print should be meaningfully bigger than medium',
    ).toBeGreaterThan(widths.medium * 1.15);
  });

  test('the stand still renders a score when no text-size preference has been stored', async ({
    page,
  }) => {
    // Regression guard for the optional-context hook: the viewer must never
    // crash because a text-size preference is unavailable.
    await page.addInitScript(
      ([onboardingKey, prefKey]) => {
        window.localStorage.setItem(onboardingKey, '1');
        window.localStorage.removeItem(prefKey);
        window.localStorage.removeItem('eccb:text-scale');
      },
      [ONBOARDING_SEEN_KEY, STAND_VIEW_PREF_KEY] as const,
    );

    await gotoLibraryTab(page);
    const pieceId = await resolveSeededPieceId(page);
    const response = await page.goto(pieceViewerPath(pieceId), {
      waitUntil: 'domcontentloaded',
    });

    expect(response, 'the score route should return a response').not.toBeNull();
    expect(response!.status(), 'the score route should not error').toBeLessThan(500);

    const size = await waitForPdfRendered(page);
    expect(size.width).toBeGreaterThan(0);
    await expect(pdfCanvas(page)).toBeVisible();
  });
});
