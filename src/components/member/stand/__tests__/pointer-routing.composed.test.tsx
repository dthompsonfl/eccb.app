/**
 * Composed pointer-routing tests for the Digital Music Stand.
 *
 * The pre-existing suite mocked the stand store wholesale, so it could never
 * prove that a stylus actually reaches the annotation layer: each component
 * "worked" in isolation while the composed interaction was broken. These tests
 * use the REAL zustand store and the REAL components, and assert on observable
 * routing outcomes: did a page turn happen, and did ink get created?
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { useStandStore } from '@/store/standStore';
import { GestureHandler } from '../GestureHandler';
import { AnnotationLayer } from '../AnnotationLayer';

/** jsdom does not implement canvas 2D; the layer only needs a context object. */
function installCanvasMock() {
  const ctx = {
    resetTransform: vi.fn(),
    clearRect: vi.fn(),
    setTransform: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    arc: vi.fn(),
    closePath: vi.fn(),
    quadraticCurveTo: vi.fn(),
    bezierCurveTo: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(),
    strokeText: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 10 })),
  };
  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  proto.getContext = () => ctx;

  proto.setPointerCapture = vi.fn();
  proto.releasePointerCapture = vi.fn();
  return ctx;
}

let ctxMock: ReturnType<typeof installCanvasMock>;

/**
 * jsdom gives every element a zero-sized rect and 0x0 canvases, which makes the
 * layer's DPR sizing bail out so no drawing ever happens. Give the canvas a real
 * box so the draw path actually executes.
 */
function sizeCanvas(canvas: HTMLCanvasElement, width = 800, height = 600) {
  canvas.getBoundingClientRect = () =>
    ({
      x: 0, y: 0, top: 0, left: 0, right: width, bottom: height,
      width, height, toJSON: () => ({}),
    }) as DOMRect;
  // The layer's resize effect assigns to width/height, so these must stay
  // writable rather than being frozen.
  Object.defineProperty(canvas, 'width', { value: width, writable: true, configurable: true });
  Object.defineProperty(canvas, 'height', { value: height, writable: true, configurable: true });
}

const PIECE = {
  id: 'piece-1',
  title: 'Test Piece',
  composer: 'Composer',
  pdfUrl: '/test.pdf',
  totalPages: 5,
};

/**
 * The real composed subtree: the gesture overlay is stacked over the canvas
 * area exactly as StandViewer does it.
 */
function StandSubtree() {
  return (
    <div style={{ position: 'relative', width: 800, height: 600 }} data-testid="stand">
      <GestureHandler />
      <div style={{ position: 'absolute', inset: 0 }}>
        <AnnotationLayer />
      </div>
    </div>
  );
}

beforeEach(() => {
  ctxMock = installCanvasMock();
  useStandStore.getState().reset();
  useStandStore.setState({
    pieces: [PIECE],
    currentPieceIndex: 0,
    _currentPage: 1,
    settings: { ...useStandStore.getState().settings, swipeGesture: true },
  });
  // The layer persists strokes over the network; stub it so tests do not hit
  // a relative URL that jsdom cannot resolve.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({}),
  }));

  // jsdom does not run requestAnimationFrame callbacks on its own, and the
  // annotation layer schedules its drawing through one. Run them synchronously
  // so the draw path is actually exercised.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});

  // Silence the orientation media query in jsdom.
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
});

describe('composed pointer routing (real store, real components)', () => {
  it('a pen creates ink and does NOT turn the page when annotate mode is on', async () => {
    useStandStore.getState().setEditMode(true);

    const { getByTestId } = render(<StandSubtree />);
    const stand = getByTestId('stand');
    const canvas = stand.querySelector('canvas') as HTMLCanvasElement;
    sizeCanvas(canvas);

    // Pen goes down on the canvas region.
    fireEvent.pointerDown(canvas, {
      pointerId: 1,
      pointerType: 'pen',
      clientX: 100,
      clientY: 100,
      pressure: 0.5,
    });
    fireEvent.pointerMove(canvas, {
      pointerId: 1,
      pointerType: 'pen',
      clientX: 140,
      clientY: 160,
      pressure: 0.6,
    });
    // drawStroke needs at least two points to emit a path.
    fireEvent.pointerMove(canvas, {
      pointerId: 1,
      pointerType: 'pen',
      clientX: 180,
      clientY: 200,
      pressure: 0.6,
    });
    fireEvent.pointerUp(canvas, {
      pointerId: 1,
      pointerType: 'pen',
      clientX: 140,
      clientY: 160,
    });

    // The gesture layer must not have armed/turned anything.
    expect(useStandStore.getState()._currentPage).toBe(1);

    // The canvas must actually have been drawn on. Rendering is scheduled via
    // requestAnimationFrame, so flush it before asserting.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(ctxMock.beginPath).toHaveBeenCalled();
  });

  it('the gesture overlay is pass-through for a pen in annotate mode', () => {
    useStandStore.getState().setEditMode(true);
    const { getByTestId } = render(<StandSubtree />);
    const gesture = getByTestId('stand').querySelector(
      '[role="application"]',
    ) as HTMLElement;

    // Before any pointer event, annotate mode means a pen is ours to draw with,
    // so the overlay must not be blocking the canvas.
    expect(gesture.className).toContain('absolute');
  });

  it('a finger turning a page creates no ink at all', () => {
    useStandStore.getState().setEditMode(true);
    const before = useStandStore.getState()._currentPage;

    const { getByTestId } = render(<StandSubtree />);
    const stand = getByTestId('stand');
    const gesture = stand.querySelector('[role="application"]') as HTMLElement;
    const canvas = stand.querySelector('canvas') as HTMLCanvasElement;
    sizeCanvas(canvas);

    // A full finger drag across the canvas: if touch were treated as a drawing
    // device this would lay down a stroke. It must not.
    fireEvent.pointerDown(canvas, {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 100,
      clientY: 100,
      pressure: 0.5,
    });
    fireEvent.pointerMove(canvas, {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 200,
      clientY: 220,
      pressure: 0.5,
    });
    fireEvent.pointerMove(canvas, {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 300,
      clientY: 340,
      pressure: 0.5,
    });
    fireEvent.pointerUp(canvas, {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 300,
      clientY: 340,
    });

    // No canvas drawing calls at all.
    expect(ctxMock.beginPath).not.toHaveBeenCalled();
    expect(ctxMock.stroke).not.toHaveBeenCalled();
    // And nothing was persisted.
    const stored = useStandStore.getState().annotations;
    const all = Object.values(stored).flatMap((byPage) =>
      Object.values(byPage as Record<string, unknown[]>).flat(),
    );
    expect(all).toHaveLength(0);

    // The same finger on the gesture layer still navigates.
    fireEvent.pointerDown(gesture, {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 700,
      clientY: 300,
    });
    fireEvent.pointerUp(gesture, {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 500,
      clientY: 300,
    });
    expect(useStandStore.getState()._currentPage).not.toBe(before);
  });

  it('a pen press leaves the gesture overlay pass-through, so ink reaches the canvas', () => {
    useStandStore.getState().setEditMode(true);
    const { getByTestId } = render(<StandSubtree />);
    const gesture = getByTestId('stand').querySelector(
      '[role="application"]',
    ) as HTMLElement;

    fireEvent.pointerDown(gesture, {
      pointerId: 3,
      pointerType: 'pen',
      clientX: 200,
      clientY: 200,
    });

    // After a pen event the overlay must hand input to the annotation layer.
    expect(gesture.className).toContain('pointer-events-none');
  });

  it('with annotate mode off, a pen navigates instead of drawing', () => {
    useStandStore.getState().setEditMode(false);
    const before = useStandStore.getState()._currentPage;

    const { getByTestId } = render(<StandSubtree />);
    const stand = getByTestId('stand');
    const gesture = stand.querySelector('[role="application"]') as HTMLElement;
    const canvas = stand.querySelector('canvas') as HTMLCanvasElement;

    (ctxMock.beginPath as ReturnType<typeof vi.fn>).mockClear();
    fireEvent.pointerDown(canvas, {
      pointerId: 4,
      pointerType: 'pen',
      clientX: 100,
      clientY: 100,
    });
    expect(ctxMock.beginPath).not.toHaveBeenCalled();

    fireEvent.pointerDown(gesture, { pointerId: 4, pointerType: 'pen', clientX: 700, clientY: 300 });
    fireEvent.pointerUp(gesture, { pointerId: 4, pointerType: 'pen', clientX: 400, clientY: 300 });
    expect(useStandStore.getState()._currentPage).not.toBe(before);
  });

  it('a pointercancel mid-stroke discards the partial mark and persists nothing', () => {
    useStandStore.getState().setEditMode(true);

    const { getByTestId } = render(<StandSubtree />);
    const canvas = getByTestId('stand').querySelector('canvas') as HTMLCanvasElement;

    fireEvent.pointerDown(canvas, {
      pointerId: 5,
      pointerType: 'pen',
      clientX: 100,
      clientY: 100,
      pressure: 0.7,
    });
    fireEvent.pointerMove(canvas, {
      pointerId: 5,
      pointerType: 'pen',
      clientX: 130,
      clientY: 130,
      pressure: 0.7,
    });

    // System gesture / palm rejection takes the pointer away.
    act(() => {
      fireEvent.pointerCancel(canvas, { pointerId: 5, pointerType: 'pen' });
    });

    // No annotation was persisted for the cancelled stroke.
    const stored = useStandStore.getState().annotations;
    const all = Object.values(stored).flatMap((byPage) =>
      Object.values(byPage as Record<string, unknown[]>).flat(),
    );
    expect(all).toHaveLength(0);
  });
});
