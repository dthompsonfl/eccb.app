/**
 * Store-level navigation behaviour: the real zustand store driving the pure
 * navigation module. The pure-module tests prove the math; these prove the store
 * actually applies it to state a musician would see.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStandStore } from '../standStore';

const PIECES = [
  { id: 'p1', title: 'Work', composer: 'C', pdfUrl: '/a.pdf', totalPages: 8 },
];

function setup(totalPages = 8) {
  useStandStore.getState().reset();
  useStandStore.setState({
    pieces: [{ ...PIECES[0], totalPages }],
    currentPieceIndex: 0,
    _currentPage: 1,
  });
}

const st = () => useStandStore.getState();

beforeEach(() => {
  setup();
});

describe('spread navigation in the store', () => {
  it('advances a spread at a time and lands on a visible recto', () => {
    st().nextTwoPages();
    expect(st()._currentPage).toBe(3);
    // The spread actually shows the two pages around the stored page.
    expect(st().visibleSpreadPages()).toEqual({ left: 3, right: 4 });

    st().nextTwoPages();
    expect(st()._currentPage).toBe(5);
  });

  it('reverses exactly', () => {
    st().nextTwoPages();
    st().nextTwoPages();
    st().prevTwoPages();
    expect(st()._currentPage).toBe(3);
  });

  it('does not skip pages: every page is reachable across a walk', () => {
    const seen = new Set<number>();
    // Seed with the spread currently on screen before advancing.
    const initial = st().visibleSpreadPages();
    seen.add(initial.left);
    if (initial.right != null) seen.add(initial.right);

    for (let i = 0; i < 10; i++) {
      const before = st()._currentPage;
      st().nextTwoPages();
      if (st()._currentPage === before) break;
      const { left, right } = st().visibleSpreadPages();
      seen.add(left);
      if (right != null) seen.add(right);
    }
    // The old bug walked 1 -> 3 -> 5 -> 7 while displaying one page, so the even
    // pages were never shown. A spread walk must cover all of them.
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('stops at the end instead of running past the last page', () => {
    for (let i = 0; i < 10; i++) st().nextTwoPages();
    expect(st()._currentPage).toBeLessThanOrEqual(8);
    expect(st()._currentPage % 2).toBe(1);
  });

  it('clamps at page 1 going back', () => {
    st().prevTwoPages();
    st().prevTwoPages();
    expect(st()._currentPage).toBe(1);
  });

  it('aligns to a recto when spread mode is switched on mid-piece', () => {
    useStandStore.setState({ _currentPage: 4 });
    st().setTwoPageMode(true);
    expect(st().twoPageMode).toBe(true);
    expect(st()._currentPage).toBe(3);
  });

  it('refuses spread mode for a one-page piece', () => {
    setup(1);
    st().setTwoPageMode(true);
    expect(st().twoPageMode).toBe(false);
  });

  it('toggles spread mode off again', () => {
    st().setTwoPageMode(true);
    expect(st().twoPageMode).toBe(true);
    st().toggleTwoPageMode();
    expect(st().twoPageMode).toBe(false);
  });

  it('reports a lone final page for an odd-length piece', () => {
    setup(5);
    st().setTwoPageMode(true);
    st().nextTwoPages();
    st().nextTwoPages();
    expect(st().visibleSpreadPages()).toEqual({ left: 5, right: null });
  });
});

describe('half-page navigation in the store', () => {
  it('scrolls forward through both halves then the next page', () => {
    st().scrollHalfPage(1);
    expect(st()._currentPage).toBe(1);
    expect(st().scrollOffset).toBe(0.5);
    expect(st().currentHalf()).toBe('bottom');

    st().scrollHalfPage(1);
    expect(st()._currentPage).toBe(2);
    expect(st().scrollOffset).toBe(0);
  });

  it('scrolls backward through both halves then the previous page', () => {
    // Get to the bottom of page 2 first.
    st().scrollHalfPage(1);
    st().scrollHalfPage(1);
    expect(st()._currentPage).toBe(2);
    expect(st().currentHalf()).toBe('top');

    st().scrollHalfPage(-1);
    expect(st()._currentPage).toBe(1);
    expect(st().currentHalf()).toBe('bottom');
  });

  it('is directional — the opposite direction does something different', () => {
    st().scrollHalfPage(1);
    const afterForward = { page: st()._currentPage, offset: st().scrollOffset };

    st().scrollHalfPage(-1);
    const afterBackward = { page: st()._currentPage, offset: st().scrollOffset };

    // The old toggle made both directions identical.
    expect(afterForward).not.toEqual(afterBackward);
  });

  it('does not move backward past the top of page 1', () => {
    st().scrollHalfPage(-1);
    expect(st()._currentPage).toBe(1);
    expect(st().scrollOffset).toBe(0);
  });

  it('does not move forward past the bottom of the last page', () => {
    useStandStore.setState({ _currentPage: 8, scrollOffset: 0.5 });
    st().scrollHalfPage(1);
    expect(st()._currentPage).toBe(8);
    expect(st().scrollOffset).toBe(0.5);
  });

  it('reaches the true end of the piece by half-page scrolling', () => {
    let steps = 0;
    while (steps < 50) {
      const before = { p: st()._currentPage, o: st().scrollOffset };
      st().scrollHalfPage(1);
      const after = { p: st()._currentPage, o: st().scrollOffset };
      if (before.p === after.p && before.o === after.o) break;
      steps++;
    }
    // 8 pages -> top(1) plus 15 more half steps.
    expect(st()._currentPage).toBe(8);
    expect(st().currentHalf()).toBe('bottom');
  });

  it('defaults to scrolling forward when no direction is given', () => {
    st().scrollHalfPage();
    expect(st().currentHalf()).toBe('bottom');
  });
});

describe('crop state in the store', () => {
  it('starts uncropped', () => {
    expect(st().cropRect).toBeNull();
  });

  it('stores and clears a crop rect', () => {
    const rect = { top: 0.1, left: 0, width: 1, height: 0.9 };
    st().setCropRect(rect);
    expect(st().cropRect).toEqual(rect);
    st().resetCropRect();
    expect(st().cropRect).toBeNull();
  });
});
