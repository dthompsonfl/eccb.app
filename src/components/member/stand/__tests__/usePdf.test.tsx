/**
 * `usePdf` — the two failure modes this hook's fixes address.
 *
 * Both were severe and both were invisible to the existing suite, because
 * `spread-rendering.test.tsx` mocks this hook out entirely:
 *
 * 1. THE INFINITE RENDER LOOP. The page-render effect used to list
 *    `currentPage` as a dependency while the effect itself called
 *    `setCurrentPage`. Every completed render therefore re-entered the effect,
 *    fetched a fresh PdfPage, and re-rendered — hundreds of canvas renders a
 *    second, starving the main thread so completely that real user input (clicks,
 *    page turns) never completed. `currentPage` is deliberately NOT a dependency
 *    now; the crop comes from the page the effect just fetched.
 *
 * 2. SPREAD RENDER CANCELLATION. PDF.js refuses to render the same canvas twice
 *    concurrently ("Cannot use the same canvas during multiple render()
 *    operations"). The two-page spread re-renders its right-hand page whenever
 *    `renderPageInto` changes identity, and without retiring the superseded render
 *    the new one collided with the old and the page stayed blank after a reload.
 *    `spreadRendersRef` now cancels any prior render for the same canvas, ignores
 *    cancel-shaped rejections, and releases in-flight renders on unmount.
 *
 * pdf.js cannot rasterise in jsdom, so `@/lib/pdf` is mocked at its boundary.
 * That is the seam the hook talks to, and it is where both defects lived.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, waitFor } from '@testing-library/react';

import type { PdfDocument, PdfPage } from '@/lib/pdf';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const loadPdfDocument = vi.fn();
const renderPageToCanvas = vi.fn();
const createOffscreenCanvas = vi.fn();

vi.mock('@/lib/pdf', () => ({
  loadPdfDocument: (...args: unknown[]) => loadPdfDocument(...args),
  renderPageToCanvas: (...args: unknown[]) => renderPageToCanvas(...args),
  createOffscreenCanvas: (...args: unknown[]) => createOffscreenCanvas(...args),
}));

// calculateAutoCrop rasterises, so it is only reached with enableAutoCrop —
// stubbed anyway so an accidental call is visible rather than a jsdom crash.
vi.mock('@/lib/autoCrop', () => ({
  calculateAutoCrop: vi.fn().mockResolvedValue(null),
}));

const { usePdf } = await import('../usePdf');

// ── Fakes ─────────────────────────────────────────────────────────────────────

/** A cancel handle that records whether it was cancelled. */
interface FakeHandle {
  cancel: ReturnType<typeof vi.fn>;
}

function fakeHandle(): FakeHandle {
  return { cancel: vi.fn() };
}

function fakeViewport(width = 612, height = 792) {
  return { width, height, scale: 1, offsetX: 0, offsetY: 0, transform: [1, 0, 0, 1, 0, 0], clone: () => fakeViewport(width, height) };
}

/**
 * A PdfPage whose `getViewport` returns a NEW object each call.
 *
 * That matters: it mirrors PDF.js, which hands back a fresh viewport object per
 * call, and it is what makes an identity comparison on the page object meaningful
 * when hunting the render loop.
 */
function fakePage(label: string): PdfPage {
  return {
    getViewport: () => fakeViewport(),
    render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
    getTextContent: async () => ({ items: [] }),
    // Exposed for assertions only.
    ...({ label } as Record<string, unknown>),
  } as unknown as PdfPage;
}

/**
 * After this many `getPage` calls, hand back the SAME page object every time.
 *
 * This is a circuit breaker for the render-loop defect, and it does not weaken the
 * assertion. With `currentPage` wrongly in the effect's dependencies, React bails
 * out of the update when the new state is identical to the old — so the loop stops
 * at exactly this many iterations and the test can report the real number
 * ("expected <= 3, got 50"). Without the breaker the loop never yields: it starves
 * React's flush and the test dies as an opaque 30s timeout that says nothing about
 * what went wrong.
 */
const LOOP_BREAKER_LIMIT = 50;

function fakeDocument(numPages: number): PdfDocument {
  const breakerPage = fakePage('breaker');
  let calls = 0;
  return {
    numPages,
    getPage: vi.fn(async (n: number) => {
      calls += 1;
      return calls <= LOOP_BREAKER_LIMIT ? fakePage(`page-${n}`) : breakerPage;
    }),
  };
}

/**
 * Mount usePdf behind a real <canvas>, the way StandCanvas does.
 *
 * The hook only renders when `canvasRef.current` is set, and React attaches refs
 * during commit — before effects run — so a callback ref is the only arrangement
 * that reproduces production timing. Assigning the ref after mount (as a
 * `renderHook` caller is tempted to) happens after the document has loaded and
 * would silently skip the whole render path.
 */
/** A detached canvas with a plausible letter-page backing store. */
function fakeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 612;
  canvas.height = 792;
  return canvas;
}

function Harness({ pageNumber }: { pageNumber: number }) {
  const pdf = usePdf({ url: URL, pageNumber, scale: 1, enablePreload: false });
  return (
    <canvas
      data-testid="pdf-canvas"
      ref={(el) => {
        pdf.canvasRef.current = el;
      }}
    />
  );
}

const URL = '/api/stand/files/music%2Fe2e.pdf?pieceId=piece-1';

beforeEach(() => {
  loadPdfDocument.mockReset();
  renderPageToCanvas.mockReset();
  createOffscreenCanvas.mockReset();
  createOffscreenCanvas.mockImplementation((w: number, h: number) => {
    const canvas = fakeCanvas();
    canvas.width = w;
    canvas.height = h;
    return canvas;
  });
  renderPageToCanvas.mockResolvedValue(fakeHandle());
  loadPdfDocument.mockResolvedValue(fakeDocument(27));
  // Preloading would add unrelated render noise to the call counts below.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. The render loop
// ─────────────────────────────────────────────────────────────────────────────

describe('usePdf page rendering does not re-trigger itself', () => {
  /** How many renders a correct implementation may ever reach for one page. */
  const RENDER_BOUND = 3;

  /**
   * Flush effects until the render count stops rising, or until it blows past
   * `bound` — at which point the loop is unbounded and there is nothing useful to
   * wait for.
   *
   * This deliberately does NOT use `waitFor`/`setTimeout`. The defect under test
   * starves the event loop so completely that timers never fire, so a
   * timer-based wait degrades into an opaque 30s timeout instead of an assertion.
   * Polling the counter ourselves keeps the failure readable: the test reports how
   * many renders actually happened.
   */
  async function quiesce(bound = RENDER_BOUND, maxFlushes = LOOP_BREAKER_LIMIT + 20): Promise<void> {
    let last = -1;
    let stable = 0;
    for (let i = 0; i < maxFlushes; i++) {
      await act(async () => {});
      const now = renderPageToCanvas.mock.calls.length;
      if (now === last && now > 0) {
        // Two consecutive flushes with no new render: the effect has settled.
        if (++stable >= 2) return;
      } else {
        stable = 0;
      }
      last = now;
      if (now > bound) return;
    }
  }

  it('renders the current page a bounded number of times after mount', async () => {
    // A tight budget: the correct implementation settles almost immediately, and
    // an unbounded loop must fail here rather than hanging the suite.
    const { unmount } = render(<Harness pageNumber={1} />);

    // No `waitFor` anywhere in this test: a timer-based wait cannot survive the
    // starvation this test exists to detect. `quiesce` flushes effects and counts
    // renders itself.
    await quiesce();

    const doc = (await loadPdfDocument.mock.results[0]!.value) as PdfDocument;
    const getPageCalls = doc.getPage as ReturnType<typeof vi.fn>;

    // One document load, and a small, fixed number of page fetches/renders. The
    // exact number is not the point; the bound is. A re-added `currentPage`
    // dependency pushes these into the hundreds within this same window.
    expect(renderPageToCanvas.mock.calls.length).toBeGreaterThan(0);
    expect(
      getPageCalls.mock.calls.length,
      'the page was fetched repeatedly for a single page number — the render effect is re-entering itself',
    ).toBeLessThanOrEqual(RENDER_BOUND);
    expect(
      renderPageToCanvas.mock.calls.length,
      'the canvas was re-rendered unboundedly for a single page number',
    ).toBeLessThanOrEqual(RENDER_BOUND);

    // And the counts do not keep growing after the initial settle: a second drain
    // window must not add another render.
    const settledRenders = renderPageToCanvas.mock.calls.length;
    await quiesce();
    expect(
      renderPageToCanvas.mock.calls.length,
      'rendering continued after the page had settled — the effect is re-entering itself',
    ).toBe(settledRenders);

    unmount();
  });

  it('turning the page fetches and renders the new page exactly once', async () => {
    const { rerender, unmount } = render(<Harness pageNumber={1} />);
    await quiesce();
    const before = renderPageToCanvas.mock.calls.length;

    await act(async () => {
      rerender(<Harness pageNumber={2} />);
    });
    await quiesce();

    const added = renderPageToCanvas.mock.calls.length - before;
    expect(added, 'a page turn should cost one render, not a cascade').toBe(1);

    const doc = (await loadPdfDocument.mock.results[0]!.value) as PdfDocument;
    const getPage = doc.getPage as ReturnType<typeof vi.fn>;
    expect(getPage).toHaveBeenCalledWith(2);

    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Spread render cancellation
// ─────────────────────────────────────────────────────────────────────────────

describe('usePdf renderPageInto cancels superseded renders for the same canvas', () => {
  /** Mount the hook and wait until the document is available. */
  async function mountLoaded() {
    const hook = renderHook(() =>
      usePdf({ url: URL, pageNumber: 1, scale: 1, enablePreload: false }),
    );
    await waitFor(() => expect(hook.result.current.document).not.toBeNull());
    return hook;
  }

  it('cancels the previous render for the same canvas before starting another', async () => {
    const first = fakeHandle();
    const second = fakeHandle();
    let call = 0;
    renderPageToCanvas.mockImplementation(() => {
      call += 1;
      return Promise.resolve(call === 1 ? first : second);
    });

    const { result } = await mountLoaded();
    const canvas = fakeCanvas();

    await act(async () => {
      await result.current.renderPageInto(2, canvas);
    });
    expect(renderPageToCanvas).toHaveBeenCalledTimes(1);
    expect(first.cancel, 'a live render must not be cancelled by its own completion').not.toHaveBeenCalled();

    // A second render into the SAME canvas must retire the first. Without this,
    // PDF.js raises "Cannot use the same canvas during multiple render()
    // operations" and the spread page stays blank.
    await act(async () => {
      await result.current.renderPageInto(3, canvas);
    });

    expect(
      first.cancel,
      'the superseded render for this canvas was never cancelled',
    ).toHaveBeenCalledTimes(1);
    expect(second.cancel, 'the surviving render must not be cancelled').not.toHaveBeenCalled();

    // A third render retires the second, proving the map tracks the live handle
    // rather than latching onto the first one.
    const third = fakeHandle();
    renderPageToCanvas.mockResolvedValue(third);
    await act(async () => {
      await result.current.renderPageInto(4, canvas);
    });
    expect(second.cancel).toHaveBeenCalledTimes(1);
    expect(first.cancel, 'an already-retired render must not be cancelled twice').toHaveBeenCalledTimes(1);
  });

  it('does not cancel a render belonging to a different canvas', async () => {
    const first = fakeHandle();
    let call = 0;
    renderPageToCanvas.mockImplementation(() => {
      call += 1;
      return Promise.resolve(call === 1 ? first : fakeHandle());
    });

    const { result } = await mountLoaded();
    const canvasA = fakeCanvas();
    const canvasB = fakeCanvas();

    await act(async () => {
      await result.current.renderPageInto(2, canvasA);
    });
    await act(async () => {
      await result.current.renderPageInto(2, canvasB);
    });

    expect(
      first.cancel,
      'cancelling must be keyed by canvas — a render into another canvas is unrelated',
    ).not.toHaveBeenCalled();
  });

  it('treats a cancel-shaped rejection as a normal outcome, not an error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPageToCanvas.mockRejectedValue(new Error('Rendering cancelled'));

    const { result } = await mountLoaded();
    const canvas = fakeCanvas();

    await act(async () => {
      await result.current.renderPageInto(2, canvas);
    });

    expect(errorSpy, 'a cancelled render is expected, so it must not be logged as a failure').not.toHaveBeenCalled();
  });

  it('still reports a genuine render failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPageToCanvas.mockRejectedValue(new Error('canvas context is null'));

    const { result } = await mountLoaded();
    const canvas = fakeCanvas();

    await act(async () => {
      await result.current.renderPageInto(2, canvas);
    });

    expect(errorSpy).toHaveBeenCalledWith(
      'Error rendering spread page 2:',
      expect.any(Error),
    );
  });

  it('releases in-flight spread renders when the viewer unmounts', async () => {
    const handle = fakeHandle();
    renderPageToCanvas.mockResolvedValue(handle);

    const { result, unmount } = await mountLoaded();
    const canvas = fakeCanvas();

    await act(async () => {
      await result.current.renderPageInto(2, canvas);
    });
    expect(handle.cancel).not.toHaveBeenCalled();

    unmount();

    expect(
      handle.cancel,
      'an unmount must release the render so a late completion cannot write into a detached canvas',
    ).toHaveBeenCalledTimes(1);
  });

  it('ignores a spread render for a page outside the document', async () => {
    const { result } = await mountLoaded();
    const canvas = fakeCanvas();

    await act(async () => {
      await result.current.renderPageInto(0, canvas);
      await result.current.renderPageInto(28, canvas);
    });

    expect(renderPageToCanvas, 'out-of-range pages must not reach the rasteriser').not.toHaveBeenCalled();
  });
});
