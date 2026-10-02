/**
 * Composed annotation fidelity tests against the real store and real layer.
 *
 * Covers the two defects that made saved annotations untrustworthy:
 *   - points stored as raw display pixels (moved on resize/zoom/orientation)
 *   - strokes replayed at the toolbar's CURRENT width, not their saved width
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { useStandStore, Tool } from '@/store/standStore';
import { AnnotationLayer } from '../AnnotationLayer';
import { COORDINATE_SPACE_VERSION } from '@/lib/stand/annotation-geometry';

let lineWidths: number[] = [];

function installCanvasMock() {
  const ctx = {
    resetTransform: vi.fn(),
    clearRect: vi.fn(),
    setTransform: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    stroke: vi.fn(() => {
      // ctx.lineWidth is read at stroke time; capture it for assertions.
      if (typeof (ctx as unknown as { lineWidth: number }).lineWidth === 'number') {
        lineWidths.push((ctx as unknown as { lineWidth: number }).lineWidth);
      }
    }),
    fill: vi.fn(),
    arc: vi.fn(),
    closePath: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    measureText: vi.fn(() => ({ width: 10 })),
    lineWidth: 1,
  };
  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  proto.getContext = () => ctx;
  proto.setPointerCapture = vi.fn();
  proto.releasePointerCapture = vi.fn();
  return ctx;
}

const PAGE_W = 1000;
const PAGE_H = 2000;

function sizeCanvas(canvas: HTMLCanvasElement, w = PAGE_W, h = PAGE_H) {
  canvas.getBoundingClientRect = () =>
    ({
      x: 0, y: 0, top: 0, left: 0, right: w, bottom: h,
      width: w, height: h, toJSON: () => ({}),
    }) as DOMRect;
  Object.defineProperty(canvas, 'width', { value: w, writable: true, configurable: true });
  Object.defineProperty(canvas, 'height', { value: h, writable: true, configurable: true });
}

function renderLayer() {
  return render(
    <div style={{ position: 'relative', width: PAGE_W, height: PAGE_H }}>
      <AnnotationLayer />
    </div>,
  );
}

function allAnnotations() {
  const stored = useStandStore.getState().annotations;
  return Object.values(stored).flatMap((byPage) =>
    Object.values(byPage as Record<string, unknown[]>).flat(),
  );
}

beforeEach(() => {
  installCanvasMock();
  lineWidths = [];
  useStandStore.getState().reset();
  useStandStore.setState({
    pieces: [{ id: 'p1', title: 'T', composer: 'C', pdfUrl: '/a.pdf', totalPages: 4 }],
    currentPieceIndex: 0,
    _currentPage: 1,
    editMode: true,
    selectedLayer: 'PERSONAL',
    currentTool: Tool.PENCIL,
  });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  // addAnnotation POSTs to the API and stores the server's echo. Echo the
  // posted body back so the assertion sees the stroke we actually sent.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      return {
        ok: true,
        json: async () => ({
          annotation: {
            id: 'ann-1',
            musicId: body.musicId,
            page: body.page,
            layer: body.layer,
            strokeData: body.strokeData,
            sectionId: body.sectionId ?? null,
            userId: 'u1',
            createdAt: new Date().toISOString(),
          },
        }),
      };
    }),
  );
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** Draw a three-point pen stroke across the canvas. */
async function drawStroke(canvas: HTMLCanvasElement, opts?: { coalesced?: boolean }) {
  fireEvent.pointerDown(canvas, {
    pointerId: 1, pointerType: 'pen', clientX: 250, clientY: 500, pressure: 0.5,
  });
  if (opts?.coalesced) {
    // jsdom's synthetic PointerEvent has no getCoalescedEvents, so stub it on
    // the event prototype for this test to emulate a high-frequency pen.
    const proto = globalThis.PointerEvent as unknown as Record<string, unknown>;
    const original = proto.getCoalescedEvents;
    proto.getCoalescedEvents = function getCoalescedEvents() {
      return [
        { clientX: 300, clientY: 600, pressure: 0.5 },
        { clientX: 350, clientY: 700, pressure: 0.5 },
      ];
    };
    try {
      fireEvent.pointerMove(canvas, {
        pointerId: 1, pointerType: 'pen', clientX: 350, clientY: 700, pressure: 0.5,
      });
    } finally {
      if (original) proto.getCoalescedEvents = original;
      else delete proto.getCoalescedEvents;
    }
  } else {
    fireEvent.pointerMove(canvas, {
      pointerId: 1, pointerType: 'pen', clientX: 300, clientY: 600, pressure: 0.5,
    });
    fireEvent.pointerMove(canvas, {
      pointerId: 1, pointerType: 'pen', clientX: 350, clientY: 700, pressure: 0.5,
    });
  }
  await act(async () => {
    fireEvent.pointerUp(canvas, {
      pointerId: 1, pointerType: 'pen', clientX: 350, clientY: 700,
    });
    await new Promise((r) => setTimeout(r, 10));
  });
}

describe('annotation geometry is device independent', () => {
  it('stores points as page fractions, not display pixels', async () => {
    const { container } = renderLayer();
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    sizeCanvas(canvas);

    await drawStroke(canvas);

    const saved = allAnnotations()[0] as { strokeData: { points: Array<{ x: number; y: number }>; coordinateSpace: number } };
    expect(saved).toBeDefined();
    // 250/1000 and 500/2000 -> the point is 25% across, 25% down.
    expect(saved.strokeData.points[0].x).toBeCloseTo(0.25, 5);
    expect(saved.strokeData.points[0].y).toBeCloseTo(0.25, 5);
    expect(saved.strokeData.coordinateSpace).toBe(COORDINATE_SPACE_VERSION);
  });

  it('the same musical location normalizes identically on a different device', async () => {
    // Tablet: 250/1000 across. Laptop: 120/480 across. Same musical spot.
    const { container, unmount } = renderLayer();
    let canvas = container.querySelector('canvas') as HTMLCanvasElement;
    sizeCanvas(canvas, 1000, 2000);
    await drawStroke(canvas);
    const tablet = (allAnnotations()[0] as { strokeData: { points: Array<{ x: number; y: number }> } })
      .strokeData.points[0];

    unmount();
    useStandStore.getState().reset();
    useStandStore.setState({
      pieces: [{ id: 'p1', title: 'T', composer: 'C', pdfUrl: '/a.pdf', totalPages: 4 }],
      currentPieceIndex: 0, _currentPage: 1, editMode: true,
      selectedLayer: 'PERSONAL', currentTool: Tool.PENCIL,
    });

    const second = renderLayer();
    canvas = second.container.querySelector('canvas') as HTMLCanvasElement;
    sizeCanvas(canvas, 480, 960);
    // Same 25% across, 25% down on a smaller page.
    fireEvent.pointerDown(canvas, {
      pointerId: 1, pointerType: 'pen', clientX: 120, clientY: 240, pressure: 0.5,
    });
    fireEvent.pointerMove(canvas, {
      pointerId: 1, pointerType: 'pen', clientX: 150, clientY: 300, pressure: 0.5,
    });
    fireEvent.pointerMove(canvas, {
      pointerId: 1, pointerType: 'pen', clientX: 180, clientY: 360, pressure: 0.5,
    });
    await act(async () => {
      fireEvent.pointerUp(canvas, { pointerId: 1, pointerType: 'pen', clientX: 180, clientY: 360 });
      await new Promise((r) => setTimeout(r, 10));
    });

    const laptop = (allAnnotations()[0] as { strokeData: { points: Array<{ x: number; y: number }> } })
      .strokeData.points[0];
    expect(laptop.x).toBeCloseTo(tablet.x, 5);
    expect(laptop.y).toBeCloseTo(tablet.y, 5);
  });

  it('records every pointer sample it receives, not a decimated subset', async () => {
    // The pure coalescing policy is covered exhaustively in
    // annotation-geometry.test.ts; here we assert the layer actually stores each
    // sample it is handed rather than only the last one per event.
    const { container } = renderLayer();
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    sizeCanvas(canvas);

    await drawStroke(canvas);

    const saved = allAnnotations()[0] as { strokeData: { points: Array<{ x: number }> } };
    // down + 2 moves, all retained, in order.
    expect(saved.strokeData.points.length).toBe(3);
    expect(saved.strokeData.points.map((p) => Math.round(p.x * 1000))).toEqual([250, 300, 350]);
  });

  it('captures stylus tilt when the browser reports it', async () => {
    const { container } = renderLayer();
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    sizeCanvas(canvas);

    fireEvent.pointerDown(canvas, {
      pointerId: 1, pointerType: 'pen', clientX: 250, clientY: 500,
      pressure: 0.5, tiltX: 24, tiltY: -8, twist: 120,
    });
    fireEvent.pointerMove(canvas, {
      pointerId: 1, pointerType: 'pen', clientX: 300, clientY: 600, pressure: 0.5,
    });
    fireEvent.pointerMove(canvas, {
      pointerId: 1, pointerType: 'pen', clientX: 350, clientY: 700, pressure: 0.5,
    });
    await act(async () => {
      fireEvent.pointerUp(canvas, { pointerId: 1, pointerType: 'pen', clientX: 350, clientY: 700 });
      await new Promise((r) => setTimeout(r, 10));
    });

    const saved = allAnnotations()[0] as { strokeData: { points: Array<Record<string, number>> } };
    expect(saved.strokeData.points[0].tiltX).toBe(24);
    expect(saved.strokeData.points[0].twist).toBe(120);
  });
});

describe('saved strokes replay at their original width', () => {
  it('replays a saved stroke at its saved width after the pen changes', async () => {
    // Draw with the pen set to 8 (set before render so the layer sees it).
    useStandStore.setState({ strokeWidth: 8 });
    const { container } = renderLayer();
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    sizeCanvas(canvas);

    await drawStroke(canvas);
    const widthsWhileDrawing = [...lineWidths];
    expect(widthsWhileDrawing.length).toBeGreaterThan(0);

    // The musician switches to a thin pen.
    lineWidths = [];
    useStandStore.setState({ strokeWidth: 2 });

    // Re-render the stored stroke: it must NOT be redrawn at width 2.
    await act(async () => {
      useStandStore.setState({ _currentPage: 2 });
      await new Promise((r) => setTimeout(r, 10));
    });
    await act(async () => {
      useStandStore.setState({ _currentPage: 1 });
      await new Promise((r) => setTimeout(r, 10));
    });

    // Any width observed while replaying must not be derived from 2.
    const thinWidths = lineWidths.filter((w) => w < 8);
    expect(thinWidths).toEqual([]);
  });

  it('persists the width and pressure scale on the stroke', async () => {
    useStandStore.setState({ strokeWidth: 8, pressureScale: 0 });
    const { container } = renderLayer();
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    sizeCanvas(canvas);

    await drawStroke(canvas);

    const saved = allAnnotations()[0] as { strokeData: { baseWidth: number; pressureScale: number } };
    expect(saved.strokeData.baseWidth).toBe(8);
    expect(saved.strokeData.pressureScale).toBe(0);
  });
});
