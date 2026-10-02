/**
 * The two-page spread must actually display two pages.
 *
 * The pre-existing behaviour rendered the neighbouring pages at `opacity-0` as
 * preload targets only: the store advanced two pages at a time while
 * StandCanvas showed one of them, so a musician stepping 1 -> 3 -> 5 never saw
 * pages 2, 4 or 6. These tests assert the visible result, not the store math.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import React from 'react';
import { useStandStore } from '@/store/standStore';
import { StandCanvas } from '../StandCanvas';

// pdf.js is not available in jsdom; renderPageInto is the seam the spread uses
// to draw its second page, so mocking it proves the wiring without a real PDF.
const renderPageInto = vi.fn().mockResolvedValue(undefined);
//
// `numPages` must be derived from the store's piece rather than hardcoded.
// StandCanvas now treats PDF.js's page count as the authority and pushes it into
// the store (the DB column is NULL for real pieces, which previously left page
// navigation permanently disabled). A fixed `numPages: 8` therefore overwrote
// whatever page count a test set up, so a test asserting "an odd-length 5-page
// piece shows no phantom second page" had the store rewritten to 8 underneath it
// and the assertion became untestable. Reading the store keeps the mock and the
// component in agreement, exactly as a real loaded PDF would be.
vi.mock('../usePdf', () => ({
  usePdf: () => {
    const piece = useStandStore.getState().pieces[0];
    return {
      isLoading: false,
      error: null,
      numPages: piece?.totalPages ?? 0,
      cropRect: null,
      prevPageCanvas: null,
      nextPageCanvas: null,
      renderCurrentPage: vi.fn().mockResolvedValue(undefined),
      renderPageInto,
      canvasRef: { current: null },
      containerRef: { current: null },
    };
  },
}));

vi.mock('../AnnotationLayer', () => ({
  AnnotationLayer: () => null,
}));

const PIECE = {
  id: 'p1',
  title: 'Lincolnshire Posy',
  composer: 'Karlins',
  pdfUrl: '/score.pdf',
  totalPages: 8,
};

beforeEach(() => {
  renderPageInto.mockClear();
  // jsdom does not implement matchMedia; StandCanvas reads the reduced-motion
  // preference on mount.
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
  useStandStore.getState().reset();
  useStandStore.setState({
    pieces: [PIECE],
    currentPieceIndex: 0,
    _currentPage: 1,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('two-page spread rendering', () => {
  it('shows only one page when spread mode is off', () => {
    const { queryByTestId } = render(<StandCanvas />);
    expect(queryByTestId('stand-spread-right-page')).toBeNull();
  });

  it('renders a visible second page when spread mode is on', () => {
    useStandStore.getState().setTwoPageMode(true);

    const { queryByTestId, getAllByRole } = render(<StandCanvas />);
    const right = queryByTestId('stand-spread-right-page');

    expect(right).not.toBeNull();
    // Genuinely visible: not one of the hidden preload canvases.
    expect(right?.className).not.toContain('opacity-0');
    expect(right?.getAttribute('aria-hidden')).toBeNull();
    // Two images are exposed to assistive tech, one per page of the spread.
    expect(getAllByRole('img').length).toBeGreaterThanOrEqual(2);
  });

  it('draws the correct second page for the current spread', async () => {
    useStandStore.getState().setTwoPageMode(true);
    render(<StandCanvas />);

    // Spread at page 1 shows pages 1 and 2.
    await waitFor(() => expect(renderPageInto).toHaveBeenCalled());
    expect(renderPageInto.mock.calls[0][0]).toBe(2);
  });

  it('follows the spread when the musician advances', async () => {
    useStandStore.getState().setTwoPageMode(true);
    const { unmount } = render(<StandCanvas />);
    await waitFor(() => expect(renderPageInto).toHaveBeenCalledWith(2, expect.anything()));

    unmount();
    renderPageInto.mockClear();

    useStandStore.getState().nextTwoPages();
    expect(useStandStore.getState()._currentPage).toBe(3);

    render(<StandCanvas />);
    // Spread at page 3 shows pages 3 and 4 — not page 5.
    await waitFor(() => expect(renderPageInto).toHaveBeenCalled());
    expect(renderPageInto.mock.calls[0][0]).toBe(4);
  });

  it('does not render a phantom second page for an odd-length final spread', () => {
    useStandStore.setState({
      pieces: [{ ...PIECE, totalPages: 5 }],
    });
    useStandStore.getState().setTwoPageMode(true);
    useStandStore.setState({ _currentPage: 5 });

    const { queryByTestId } = render(<StandCanvas />);
    // Page 5 is the last of an odd-length piece: shown alone, centred.
    expect(queryByTestId('stand-spread-right-page')).toBeNull();
  });

  it('refuses spread mode for a one-page piece', () => {
    useStandStore.setState({ pieces: [{ ...PIECE, totalPages: 1 }] });
    useStandStore.getState().setTwoPageMode(true);
    expect(useStandStore.getState().twoPageMode).toBe(false);

    const { queryByTestId } = render(<StandCanvas />);
    expect(queryByTestId('stand-spread-right-page')).toBeNull();
  });

  it('announces both page numbers to a screen reader', () => {
    useStandStore.getState().setTwoPageMode(true);
    const { getByLabelText } = render(<StandCanvas />);
    expect(getByLabelText(/Pages 1 and 2 of 8/)).toBeInTheDocument();
  });
});
