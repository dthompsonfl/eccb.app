import { describe, expect, it } from 'vitest';
import {
  alignToRecto,
  clampPage,
  getSpreadPages,
  isSpreadable,
  isCropActive,
  nextSpreadPage,
  normalizeCropRect,
  prevSpreadPage,
  safeTotalPages,
  scrollOffsetToHalf,
  halfToScrollOffset,
  stepHalfPage,
  stepSpread,
  type HalfPageState,
} from '../navigation';

describe('clampPage / safeTotalPages', () => {
  it('clamps into [1, totalPages]', () => {
    expect(clampPage(0, 10)).toBe(1);
    expect(clampPage(-5, 10)).toBe(1);
    expect(clampPage(11, 10)).toBe(10);
    expect(clampPage(5, 10)).toBe(5);
  });

  it('degrades a nonsense total to a single page', () => {
    expect(safeTotalPages(0)).toBe(1);
    expect(safeTotalPages(-3)).toBe(1);
    expect(safeTotalPages(Number.NaN)).toBe(1);
    expect(clampPage(4, 0)).toBe(1);
  });
});

describe('alignToRecto', () => {
  it('snaps an even page back to the odd page before it', () => {
    expect(alignToRecto(1)).toBe(1);
    expect(alignToRecto(2)).toBe(1);
    expect(alignToRecto(3)).toBe(3);
    expect(alignToRecto(4)).toBe(3);
    expect(alignToRecto(7)).toBe(7);
  });

  it('never drops below page 1', () => {
    expect(alignToRecto(0)).toBe(1);
    expect(alignToRecto(1)).toBe(1);
  });
});

describe('getSpreadPages', () => {
  it('pairs pages 1 and 2', () => {
    expect(getSpreadPages(1, 8)).toEqual({ left: 1, right: 2 });
  });

  it('aligns an even page back so the spread never starts mid-system', () => {
    expect(getSpreadPages(2, 8)).toEqual({ left: 1, right: 2 });
    expect(getSpreadPages(4, 8)).toEqual({ left: 3, right: 4 });
  });

  it('leaves a lone final page for an odd-length piece', () => {
    // 5 pages: spreads are (1,2) (3,4) and then page 5 alone.
    expect(getSpreadPages(5, 5)).toEqual({ left: 5, right: null });
  });

  it('handles a single-page piece', () => {
    expect(getSpreadPages(1, 1)).toEqual({ left: 1, right: null });
    expect(isSpreadable(1)).toBe(false);
  });

  it('reports spreadability', () => {
    expect(isSpreadable(2)).toBe(true);
    expect(isSpreadable(0)).toBe(false);
  });
});

describe('spread stepping', () => {
  it('walks spreads 1 -> 3 -> 5 for an even-length piece', () => {
    let page = 1;
    const seen: number[] = [page];
    for (let i = 0; i < 2; i++) {
      page = nextSpreadPage(page, 8);
      seen.push(page);
    }
    expect(seen).toEqual([1, 3, 5]);
  });

  it('never strands the user on an even page', () => {
    for (const start of [1, 2, 3, 4, 5, 6, 7]) {
      const next = nextSpreadPage(start, 8);
      expect(next % 2, `from ${start}`).toBe(1);
    }
  });

  it('stays put once the last page is on screen', () => {
    // Page 8 is the right half of the (7,8) spread, so "next" has nowhere to go
    // and must not move the user onto an even page they cannot see the start of.
    expect(nextSpreadPage(7, 8)).toBe(7);
    expect(nextSpreadPage(8, 8)).toBe(7);
  });

  it('every page reachable by next-spread is a recto', () => {
    let page = 1;
    const visited = new Set<number>();
    for (let i = 0; i < 10; i++) {
      const next = nextSpreadPage(page, 8);
      if (next === page) break;
      page = next;
      visited.add(page);
    }
    // 1,3,5,7 - every stop is odd, and page 8 is seen as the right half of 7.
    expect([...visited].sort((a, b) => a - b)).toEqual([3, 5, 7]);
    for (const p of visited) expect(p % 2).toBe(1);
  });

  it('stays put on the final lone page of an odd piece', () => {
    expect(nextSpreadPage(5, 5)).toBe(5);
  });

  it('retreats 5 -> 3 -> 1 and stops at 1', () => {
    expect(prevSpreadPage(5, 8)).toBe(3);
    expect(prevSpreadPage(3, 8)).toBe(1);
    expect(prevSpreadPage(1, 8)).toBe(1);
    expect(prevSpreadPage(2, 8)).toBe(1);
  });

  it('round-trips: next then prev returns to the same spread', () => {
    for (const start of [1, 3, 5]) {
      expect(prevSpreadPage(nextSpreadPage(start, 8), 8)).toBe(start);
    }
  });

  it('stepSpread dispatches on direction', () => {
    expect(stepSpread(1, 8, 1)).toBe(3);
    expect(stepSpread(3, 8, -1)).toBe(1);
  });

  it('handles a single-page piece without moving', () => {
    expect(nextSpreadPage(1, 1)).toBe(1);
    expect(prevSpreadPage(1, 1)).toBe(1);
  });
});

describe('half-page state machine', () => {
  const s = (page: number, half: HalfPageState['half']): HalfPageState => ({ page, half });

  it('forward walks top -> bottom -> next top', () => {
    let st = s(1, 'top');
    const fwd = stepHalfPage(st, 1, 10);
    expect(fwd).toMatchObject({ page: 1, half: 'bottom', crossedPage: false });

    st = s(fwd.page, fwd.half);
    const fwd2 = stepHalfPage(st, 1, 10);
    expect(fwd2).toMatchObject({ page: 2, half: 'top', crossedPage: true });
  });

  it('backward is the exact inverse of forward', () => {
    // top(1) -fwd-> bottom(1) -fwd-> top(2) -bwd-> bottom(1) -bwd-> top(1)
    let st = s(1, 'top');
    const forward: HalfPageState[] = [];
    for (let i = 0; i < 4; i++) {
      const r = stepHalfPage(st, 1, 10);
      st = { page: r.page, half: r.half };
      forward.push(st);
    }
    expect(forward.map((f) => `${f.page}:${f.half}`)).toEqual([
      '1:bottom',
      '2:top',
      '2:bottom',
      '3:top',
    ]);

    // Walk back and land exactly where we started.
    for (let i = forward.length - 1; i >= 0; i--) {
      const r = stepHalfPage({ page: forward[i].page, half: forward[i].half }, -1, 10);
      st = { page: r.page, half: r.half };
    }
    expect(st).toEqual({ page: 1, half: 'top' });
  });

  it('backward from the top of page 1 is a no-op, not a dead end', () => {
    const r = stepHalfPage(s(1, 'top'), -1, 10);
    expect(r).toMatchObject({ page: 1, half: 'top', moved: false });
  });

  it('forward from the bottom of the last page is a no-op, not a wrap', () => {
    const r = stepHalfPage(s(10, 'bottom'), 1, 10);
    expect(r).toMatchObject({ page: 10, half: 'bottom', moved: false });
  });

  it('every forward step on a 3-page piece is well-formed', () => {
    let st = s(1, 'top');
    const path: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = stepHalfPage(st, 1, 3);
      path.push(`${r.page}:${r.half}${r.moved ? '' : '(stopped)'}`);
      if (!r.moved) break;
      st = { page: r.page, half: r.half };
    }
    expect(path).toEqual([
      '1:bottom',
      '2:top',
      '2:bottom',
      '3:top',
      '3:bottom',
      '3:bottom(stopped)',
    ]);
  });

  it('reaches the final bottom half and stops there', () => {
    let st = s(1, 'top');
    let last: HalfPageState = st;
    for (let i = 0; i < 20; i++) {
      const r = stepHalfPage(st, 1, 2);
      if (!r.moved) break;
      last = { page: r.page, half: r.half };
      st = last;
    }
    expect(last).toEqual({ page: 2, half: 'bottom' });
  });

  it('degrades safely on a single-page piece', () => {
    expect(stepHalfPage(s(1, 'top'), 1, 1)).toMatchObject({ page: 1, half: 'bottom' });
    expect(stepHalfPage(s(1, 'bottom'), 1, 1)).toMatchObject({ moved: false });
    expect(stepHalfPage(s(1, 'top'), -1, 1)).toMatchObject({ moved: false });
  });
});

describe('legacy scroll offset bridging', () => {
  it('maps halves to the old numeric offsets', () => {
    expect(halfToScrollOffset('top')).toBe(0);
    expect(halfToScrollOffset('bottom')).toBe(0.5);
  });

  it('maps the old numeric offsets back to halves', () => {
    expect(scrollOffsetToHalf(0)).toBe('top');
    expect(scrollOffsetToHalf(0.5)).toBe('bottom');
  });
});

describe('crop', () => {
  it('returns null for no crop', () => {
    expect(normalizeCropRect(null)).toBeNull();
    expect(normalizeCropRect(undefined)).toBeNull();
    expect(isCropActive(null)).toBe(false);
  });

  it('clamps a crop into the unit square', () => {
    const r = normalizeCropRect({ top: -0.5, left: -0.2, width: 2, height: 2 });
    expect(r).toEqual({ top: 0, left: 0, width: 1, height: 1 });
  });

  it('rejects a crop too small to be useful', () => {
    expect(normalizeCropRect({ top: 0, left: 0, width: 0.05, height: 0.9 })).toBeNull();
  });

  it('shifts a crop that would overflow the page edge', () => {
    const r = normalizeCropRect({ top: 0.9, left: 0.9, width: 0.5, height: 0.5 });
    expect(r).not.toBeNull();
    expect(r!.top + r!.height).toBeLessThanOrEqual(1.0001);
    expect(r!.left + r!.width).toBeLessThanOrEqual(1.0001);
  });

  it('detects whether a crop actually changes the view', () => {
    expect(isCropActive({ top: 0, left: 0, width: 1, height: 1 })).toBe(false);
    expect(isCropActive({ top: 0.1, left: 0, width: 1, height: 0.9 })).toBe(true);
  });
});
