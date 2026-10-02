'use client';
import type React from 'react';
import {
  useCallback,
  useEffect,
  useState,
  useRef,
  useMemo,
  type RefObject,
} from 'react';
import {
  useStandStore,
  Tool,
  Annotation,
  StrokePoint,
  StrokeData,
} from '@/store/standStore';
import { useShallow } from 'zustand/react/shallow';
import { STAMPS, loadStampImage } from '@/lib/stamps';
import { arbitratePointer } from '@/lib/stand/input-arbitration';
import {
  COORDINATE_SPACE_VERSION,
  coalescedSamples,
  strokePointsToPixels,
  strokeSegmentWidth,
  stylusAttributes,
  toNormalized,
  type PageGeometry,
} from '@/lib/stand/annotation-geometry';

function generateId(): string {
  return crypto.randomUUID();
}

function scheduleRender(callback: () => void): () => void {
  let cancelled = false;
  let frameId: number | null = null;

  frameId = requestAnimationFrame(() => {
    if (!cancelled) {
      callback();
    }
  });

  return () => {
    cancelled = true;
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
    }
  };
}

export function AnnotationLayer() {
  const {
    annotations,
    currentPage,
    selectedLayer,
    editMode,
    currentTool,
    toolColor,
    strokeWidth,
    pressureScale,
    addAnnotation,
    deleteAnnotation,
    selectedStampId,
    setSelectedStampId,
    setCurrentTool,
  } = useStandStore(
    // useShallow is REQUIRED here. Zustand v5 compares the selector's return
    // value by reference in useSyncExternalStore. Returning a fresh object
    // literal on every call made getSnapshot() produce a new value each time,
    // so React saw a "changed" store on every notification and re-rendered
    // forever ("Maximum update depth exceeded"). This crashed the Digital Music
    // Stand's annotation canvas, which is the component that draws every
    // personal/section/director annotation.
    useShallow((state) => ({
      annotations: state.annotations,
      currentPage: state._currentPage,
      selectedLayer: state.selectedLayer,
      editMode: state.editMode,
      currentTool: state.currentTool,
      toolColor: state.toolColor,
      strokeWidth: state.strokeWidth,
      pressureScale: state.pressureScale,
      addAnnotation: state.addAnnotation,
      deleteAnnotation: state.deleteAnnotation,
      selectedStampId: state.selectedStampId,
      setSelectedStampId: state.setSelectedStampId,
      setCurrentTool: state.setCurrentTool,
    })),
  );

  const pieceId = useStandStore((s) => s.pieces[s.currentPieceIndex]?.id);

  const personalRef = useRef<HTMLCanvasElement>(null);
  const sectionRef = useRef<HTMLCanvasElement>(null);
  const directorRef = useRef<HTMLCanvasElement>(null);

  const isDrawingRef = useRef(false);
  /** Live touch contacts, used to tell a fingertip from a resting hand. */
  const activeTouchesRef = useRef<Set<number>>(new Set());
  /** pointerId owning the in-progress stroke, so a stray cancel cannot end it. */
  const strokePointerIdRef = useRef<number | null>(null);
  const currentPointsRef = useRef<StrokePoint[]>([]);
  const currentStrokeRef = useRef<StrokeData | null>(null);

  const renderCancelRef = useRef<(() => void) | null>(null);
  const scheduleCanvasRenderRef = useRef<(() => void) | null>(null);
  const stampCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());

  const [showStampPalette, setShowStampPalette] = useState(false);
  const [textInput, setTextInput] = useState<{
    visible: boolean;
    x: number;
    y: number;
    value: string;
  }>({ visible: false, x: 0, y: 0, value: '' });

  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const dprRef = useRef<number>(
    typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  );

  const undoStackRef = useRef<Annotation[]>([]);
  const redoStackRef = useRef<Annotation[]>([]);

  const key = useMemo(() => `${pieceId}-${currentPage}`, [pieceId, currentPage]);

  /**
   * CSS-pixel geometry of a layer canvas. Normalization is expressed against
   * this, so it is deliberately DPR-independent: changing device pixel ratio
   * must not move an annotation.
   */
  const pageGeometry = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return { width: rect.width, height: rect.height };
      }
      // Fall back to the backing store divided by DPR.
      const dpr = dprRef.current || 1;
      return { width: canvas.width / dpr, height: canvas.height / dpr };
    },
    [],
  );

  const layerMap: Record<string, RefObject<HTMLCanvasElement | null>> = useMemo(
    () => ({
      PERSONAL: personalRef,
      SECTION: sectionRef,
      DIRECTOR: directorRef,
    }),
    []
  );

  const getCurrentCanvasRef = useCallback((): HTMLCanvasElement | null => {
    return layerMap[selectedLayer]?.current || null;
  }, [selectedLayer, layerMap]);

  const drawStroke = useCallback(
    (ctx: CanvasRenderingContext2D, stroke: StrokeData, geometry?: PageGeometry) => {
      const { type, color, opacity } = stroke;
      // Replay in the CURRENT page geometry. Legacy strokes (raw pixels) pass
      // through unchanged; current strokes are normalized page fractions.
      const points = strokePointsToPixels(
        stroke as unknown as Parameters<typeof strokePointsToPixels>[0],
        geometry ?? null,
      ) as unknown as StrokePoint[];

      if (type === Tool.TEXT && stroke.text && points.length > 0) {
        const anchor = points[0];
        const fontSize = stroke.fontSize ?? 16;
        const lineHeight = fontSize * 1.25;

        ctx.save();
        ctx.globalAlpha = opacity ?? 1;
        ctx.fillStyle = color;
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textBaseline = 'top';
        stroke.text.split(/\n/).forEach((line, index) => {
          ctx.fillText(line, anchor.x, anchor.y + index * lineHeight);
        });
        ctx.restore();
        return;
      }

      if (type === Tool.STAMP && stroke.stampId && points.length > 0) {
        const pt = points[0];
        const size = (stroke.width ?? strokeWidth * 10) || 48;
        const cached = stampCacheRef.current.get(stroke.stampId);
        if (cached) {
          ctx.save();
          ctx.globalAlpha = opacity ?? 1;
          const halfWidth = size / 2;
          if (stroke.rotation) {
            ctx.translate(pt.x, pt.y);
            ctx.rotate((stroke.rotation * Math.PI) / 180);
            ctx.drawImage(cached, -halfWidth, -halfWidth, size, size);
          } else {
            ctx.drawImage(cached, pt.x - halfWidth, pt.y - halfWidth, size, size);
          }
          ctx.restore();
        } else {
          loadStampImage(stroke.stampId)
            .then((img) => {
              stampCacheRef.current.set(stroke.stampId!, img);
              scheduleCanvasRenderRef.current?.();
            })
            .catch(console.error);
        }
        return;
      }

      if (points.length < 2) return;

      ctx.save();

      if (type === Tool.HIGHLIGHTER) {
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = 0.4;
      } else if (type === Tool.ERASER) {
        ctx.globalCompositeOperation = 'destination-out';
      } else if (type === Tool.WHITEOUT) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
      } else {
        ctx.globalAlpha = opacity || 1;
      }

      ctx.strokeStyle = type === Tool.WHITEOUT ? '#ffffff' : color;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      ctx.beginPath();
      const firstPoint = points[0];
      ctx.moveTo(firstPoint.x, firstPoint.y);

      for (let i = 1; i < points.length; i++) {
        const point = points[i];
        const prevPoint = points[i - 1];
        // Use the width this stroke was SAVED with. The previous code closed
        // over the live toolbar strokeWidth, so switching pens silently changed
        // the thickness of every previously saved marking.
        const width = strokeSegmentWidth({
          baseWidth: stroke.baseWidth,
          pressure: point.pressure,
          pressureScale: (stroke as { pressureScale?: number }).pressureScale,
          liveStrokeWidth: strokeWidth,
        });

        ctx.lineWidth = width;
        const midX = (prevPoint.x + point.x) / 2;
        const midY = (prevPoint.y + point.y) / 2;
        ctx.quadraticCurveTo(prevPoint.x, prevPoint.y, midX, midY);
      }

      const lastPoint = points[points.length - 1];
      ctx.lineTo(lastPoint.x, lastPoint.y);
      ctx.stroke();

      ctx.restore();
    },
    [strokeWidth]
  );

  const scheduleCanvasRender = useCallback(() => {
    if (renderCancelRef.current) {
      renderCancelRef.current();
    }

    renderCancelRef.current = scheduleRender(() => {
      if (!pieceId) return;

      ['PERSONAL', 'SECTION', 'DIRECTOR'].forEach((layer) => {
        const ref = layerMap[layer];
        const ctx = ref.current?.getContext('2d');
        if (!ctx || !ref.current) return;

        const dpr = dprRef.current;
        ctx.resetTransform();
        ctx.clearRect(0, 0, ref.current.width, ref.current.height);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const layerAnnotations =
          annotations[layer.toLowerCase() as keyof typeof annotations]?.[key] || [];

        const geometry = pageGeometry(layerMap[layer]?.current ?? null);
        layerAnnotations.forEach((annotation) => {
          if ('strokeData' in annotation && annotation.strokeData) {
            const strokeData = annotation.strokeData as unknown as StrokeData;
            if (strokeData && typeof strokeData === 'object') {
              drawStroke(ctx, strokeData, geometry ?? undefined);
            }
          }
        });
      });
    });
  }, [annotations, drawStroke, key, layerMap, pieceId, pageGeometry]);

  useEffect(() => {
    scheduleCanvasRenderRef.current = scheduleCanvasRender;
    return () => {
      if (scheduleCanvasRenderRef.current === scheduleCanvasRender) {
        scheduleCanvasRenderRef.current = null;
      }
    };
  }, [scheduleCanvasRender]);

  useEffect(() => {
    scheduleCanvasRender();

    return () => {
      if (renderCancelRef.current) {
        renderCancelRef.current();
      }
    };
  }, [annotations, pieceId, currentPage, scheduleCanvasRender]);

  useEffect(() => {
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      dprRef.current = dpr;
      [personalRef, sectionRef, directorRef].forEach((ref) => {
        if (ref.current && ref.current.parentElement) {
          const logicalWidth = ref.current.parentElement.clientWidth;
          const logicalHeight = ref.current.parentElement.clientHeight;
          ref.current.width = logicalWidth * dpr;
          ref.current.height = logicalHeight * dpr;
          ref.current.style.width = `${logicalWidth}px`;
          ref.current.style.height = `${logicalHeight}px`;
          const ctx = ref.current.getContext('2d');
          if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
      });
      scheduleCanvasRender();
    };

    resize();
    window.addEventListener('resize', resize, { passive: true });
    return () => window.removeEventListener('resize', resize);
  }, [scheduleCanvasRender]);

  useEffect(() => {
    undoStackRef.current = [];
    redoStackRef.current = [];
  }, [key]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!editMode) return;
      const isUndo =
        (event.ctrlKey || event.metaKey) &&
        event.key === 'z' &&
        !event.shiftKey;
      const isRedo =
        ((event.ctrlKey || event.metaKey) && event.key === 'y') ||
        ((event.ctrlKey || event.metaKey) &&
          event.key === 'z' &&
          event.shiftKey);

      if (isUndo) {
        event.preventDefault();
        const annotation = undoStackRef.current.pop();
        if (annotation) {
          redoStackRef.current.push(annotation);
          deleteAnnotation?.(annotation.id).catch(console.error);
        }
      } else if (isRedo) {
        event.preventDefault();
        const annotation = redoStackRef.current.pop();
        if (annotation) {
          undoStackRef.current.push(annotation);
          addAnnotation?.(annotation).catch(console.error);
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [addAnnotation, deleteAnnotation, editMode]);

  /** Build a persisted point from a raw pointer sample, in normalized space. */
  const sampleToPoint = useCallback(
    (canvas: HTMLCanvasElement, sample: {
      clientX: number;
      clientY: number;
      pressure?: number;
      tiltX?: number;
      tiltY?: number;
      twist?: number;
    }): StrokePoint => {
      const rect = canvas.getBoundingClientRect();
      const geometry = pageGeometry(canvas);
      const normalized = toNormalized(
        { x: sample.clientX - rect.left, y: sample.clientY - rect.top },
        geometry,
      );
      return {
        x: normalized.x,
        y: normalized.y,
        pressure: sample.pressure || 0.5,
        timestamp: Date.now(),
        ...stylusAttributes(sample),
      } as StrokePoint;
    },
    [pageGeometry],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!editMode) return;

      // Same policy the gesture overlay uses. Touch belongs to page navigation
      // (the hand turns the page); only pen and mouse create ink.
      const decision = arbitratePointer({
        editMode,
        pointerType: event.pointerType,
        activeTouchPoints:
          event.pointerType === 'touch' ? activeTouchesRef.current.size + 1 : undefined,
      });
      if (decision.consumer !== 'annotation') return;

      const canvas = event.currentTarget;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const geometry = pageGeometry(canvas);
      const rect = canvas.getBoundingClientRect();
      const firstNormalized = toNormalized(
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        geometry,
      );
      // Stamps and text anchors are positioned in normalized space too.
      const x = firstNormalized.x;
      const y = firstNormalized.y;

      if (currentTool === Tool.STAMP) {
        const stroke: StrokeData = {
          id: generateId(),
          type: Tool.STAMP,
          points: [{ x, y, pressure: 1, timestamp: Date.now() }],
          color: toolColor,
          baseWidth: strokeWidth,
          opacity: 1,
          stampId: selectedStampId,
          width: strokeWidth * 12,
        };
        drawStroke(ctx, stroke);
        const annotation: Annotation = {
          id: stroke.id,
          pieceId: pieceId || '',
          pageNumber: currentPage,
          layer: selectedLayer,
          strokeData: stroke,
          createdAt: new Date().toISOString(),
        };
        addAnnotation?.(annotation);
        return;
      }

      if (currentTool === Tool.TEXT) {
        setTextInput({
          visible: true,
          x,
          y,
          value: '',
        });
        return;
      }

      isDrawingRef.current = true;
      currentPointsRef.current = [
        {
          ...firstNormalized,
          pressure: event.pressure || 0.5,
          timestamp: Date.now(),
          ...stylusAttributes(event),
        } as StrokePoint,
      ];

      currentStrokeRef.current = {
        id: generateId(),
        type: currentTool,
        points: currentPointsRef.current,
        color: toolColor,
        // Persisted so the stroke replays at the width it was DRAWN with,
        // not the width currently selected in the toolbar.
        baseWidth: strokeWidth,
        pressureScale,
        // Marks the points as normalized page fractions.
        coordinateSpace: COORDINATE_SPACE_VERSION,
        opacity: currentTool === Tool.HIGHLIGHTER ? 0.4 : 1,
      } as StrokeData;

      strokePointerIdRef.current = event.pointerId;
      canvas.setPointerCapture(event.pointerId);
    },
    [
      addAnnotation,
      currentPage,
      currentTool,
      drawStroke,
      editMode,
      pageGeometry,
      pieceId,
      pressureScale,
      selectedLayer,
      selectedStampId,
      strokeWidth,
      toolColor,
    ]
  );

  const handlePointerEnter = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (event.pointerType === 'touch') {
        activeTouchesRef.current.add(event.pointerId);
      }
    },
    []
  );

  const handlePointerOut = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      activeTouchesRef.current.delete(event.pointerId);
    },
    []
  );

  /**
   * The browser took the pointer away mid-stroke (palm rejection, a system
   * gesture, the pen leaving range). Discard the partial stroke and repaint the
   * layer so no half-finished mark is left behind and nothing is persisted.
   */
  const handlePointerCancel = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      activeTouchesRef.current.delete(event.pointerId);

      if (strokePointerIdRef.current !== null && event.pointerId !== strokePointerIdRef.current) {
        return;
      }

      const hadStroke = isDrawingRef.current || currentStrokeRef.current !== null;
      isDrawingRef.current = false;
      currentStrokeRef.current = null;
      currentPointsRef.current = [];
      strokePointerIdRef.current = null;
      if (renderCancelRef.current) renderCancelRef.current();

      if (!hadStroke) return;

      // Repaint from persisted annotations only, discarding the partial stroke.
      const canvas = event.currentTarget;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = dprRef.current;
      ctx.resetTransform();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const geometry = pageGeometry(event.currentTarget);
      const layerAnnotations =
        annotations[selectedLayer.toLowerCase() as keyof typeof annotations]?.[key] || [];
      for (const annotation of layerAnnotations) {
        if ('strokeData' in annotation && annotation.strokeData) {
          const strokeData = annotation.strokeData as unknown as StrokeData;
          if (strokeData && typeof strokeData === 'object') {
            drawStroke(ctx, strokeData, geometry ?? undefined);
          }
        }
      }
    },
    [annotations, drawStroke, key, selectedLayer, pageGeometry]
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDrawingRef.current || !currentStrokeRef.current) return;

      const canvas = event.currentTarget;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Use the browser's coalesced samples so a fast pen stroke records its
      // true shape instead of a coarse polygon.
      for (const sample of coalescedSamples(
        event as unknown as { getCoalescedEvents?: () => ArrayLike<typeof event> },
        event,
      )) {
        currentPointsRef.current.push(sampleToPoint(canvas, sample));
      }
      currentStrokeRef.current.points = currentPointsRef.current;

      if (renderCancelRef.current) {
        renderCancelRef.current();
      }

      renderCancelRef.current = scheduleRender(() => {
        const dpr = dprRef.current;
        ctx.resetTransform();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const currentAnnotations =
          annotations[selectedLayer.toLowerCase() as keyof typeof annotations]?.[
            key
          ] || [];

        const geometry = pageGeometry(canvas) ?? undefined;
        currentAnnotations.forEach((annotation) => {
          if ('strokeData' in annotation && annotation.strokeData) {
            const strokeData = annotation.strokeData as unknown as StrokeData;
            if (strokeData && typeof strokeData === 'object') {
              drawStroke(ctx, strokeData, geometry);
            }
          }
        });

        if (currentStrokeRef.current) {
          drawStroke(ctx, currentStrokeRef.current, geometry);
        }
      });
    },
    [annotations, drawStroke, key, selectedLayer, pageGeometry, sampleToPoint]
  );

  const handlePointerUp = useCallback(
    async (event: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = event.currentTarget;
      if (!isDrawingRef.current || !currentStrokeRef.current || !addAnnotation) {
        return;
      }

      canvas.releasePointerCapture(event.pointerId);
      const stroke = currentStrokeRef.current;
      const annotation: Annotation = {
        id: stroke.id,
        pieceId: pieceId || '',
        pageNumber: currentPage,
        layer: selectedLayer,
        strokeData: stroke,
        createdAt: new Date().toISOString(),
      };

      await addAnnotation(annotation);
      undoStackRef.current.push(annotation);
      redoStackRef.current = [];

      isDrawingRef.current = false;
      currentPointsRef.current = [];
      currentStrokeRef.current = null;
      scheduleCanvasRender();
    },
    [addAnnotation, currentPage, pieceId, scheduleCanvasRender, selectedLayer]
  );

  const handleTextSubmit = useCallback(async () => {
    if (!textInput.value.trim() || !pieceId) {
      setTextInput({ visible: false, x: 0, y: 0, value: '' });
      return;
    }

    const canvas = getCurrentCanvasRef();
    if (!canvas) {
      setTextInput({ visible: false, x: 0, y: 0, value: '' });
      return;
    }

    const stroke: StrokeData = {
      id: generateId(),
      type: Tool.TEXT,
      points: [
        { x: textInput.x, y: textInput.y, pressure: 0, timestamp: Date.now() },
      ],
      color: toolColor,
      baseWidth: strokeWidth,
      opacity: 1,
      text: textInput.value,
      fontSize: 16,
    };

    const ctx = canvas.getContext('2d');
    if (ctx) {
      drawStroke(ctx, stroke);
    }

    const annotation: Annotation = {
      id: stroke.id,
      pieceId,
      pageNumber: currentPage,
      layer: selectedLayer,
      strokeData: stroke,
      createdAt: new Date().toISOString(),
    };

    await addAnnotation(annotation);
    undoStackRef.current.push(annotation);
    redoStackRef.current = [];
    setTextInput({ visible: false, x: 0, y: 0, value: '' });
    scheduleCanvasRender();
  }, [
    addAnnotation,
    currentPage,
    drawStroke,
    getCurrentCanvasRef,
    pieceId,
    selectedLayer,
    strokeWidth,
    textInput,
    toolColor,
    scheduleCanvasRender,
  ]);

  useEffect(() => {
    if (textInput.visible && textInputRef.current) {
      const focusTimeout = setTimeout(() => {
        textInputRef.current?.focus();
      }, 0);
      return () => clearTimeout(focusTimeout);
    }
  }, [textInput.visible]);

  const handleTextInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        handleTextSubmit();
      }
      if (event.key === 'Escape') {
        setTextInput({ visible: false, x: 0, y: 0, value: '' });
      }
    },
    [handleTextSubmit]
  );

  return (
    <div className="absolute inset-0" role="group" aria-label="Annotation layers">
      {(['PERSONAL', 'SECTION', 'DIRECTOR'] as const).map((layer, index) => (
        <canvas
          key={layer}
          ref={layerMap[layer]}
          className="absolute inset-0"
          style={{
            zIndex: index,
            pointerEvents: editMode && selectedLayer === layer ? 'auto' : 'none',
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onPointerEnter={handlePointerEnter}
          onPointerOut={handlePointerOut}
          aria-label={
            `${layer.toLowerCase()} annotation layer` +
            (editMode && selectedLayer === layer ? ' - active' : '')
          }
          aria-hidden={!editMode || selectedLayer !== layer}
        />
      ))}

      {textInput.visible && (
        <textarea
          ref={textInputRef}
          value={textInput.value}
          onChange={(event) =>
            setTextInput((prev) => ({ ...prev, value: event.target.value }))
          }
          onBlur={handleTextSubmit}
          onKeyDown={handleTextInputKeyDown}
          style={{
            position: 'absolute',
            left: textInput.x,
            top: textInput.y,
            background: 'rgba(255, 255, 255, 0.9)',
            border: `2px solid ${toolColor}`,
            borderRadius: '4px',
            padding: '4px 8px',
            fontSize: '16px',
            minWidth: '150px',
            minHeight: '40px',
            resize: 'both',
            zIndex: 100,
          }}
          placeholder="Type text and press Enter..."
          aria-label="Text annotation input"
          aria-describedby="text-annotation-help"
        />
      )}
      <div id="text-annotation-help" className="sr-only">
        Press Enter to save text annotation, Escape to cancel
      </div>

      {editMode && currentTool === Tool.STAMP && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-50">
          <button
            onClick={() => setShowStampPalette((v) => !v)}
            className="px-3 py-1 bg-card border rounded shadow text-xs font-medium hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            title="Select stamp"
            aria-expanded={showStampPalette}
            aria-haspopup="true"
          >
            Stamp: {STAMPS.find((s) => s.id === selectedStampId)?.label ?? selectedStampId}
          </button>
          {showStampPalette && (
            <div className="absolute bottom-8 left-1/2 -translate-x-1/2 bg-card border rounded shadow-lg p-2 grid grid-cols-4 gap-1 w-64">
              {STAMPS.map((stamp) => (
                <button
                  key={stamp.id}
                  onClick={() => {
                    setSelectedStampId(stamp.id);
                    setCurrentTool(Tool.STAMP);
                    setShowStampPalette(false);
                  }}
                  className={`px-1 py-1 text-xs border rounded hover:bg-primary/10 transition-colors truncate focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                    selectedStampId === stamp.id
                      ? 'border-primary bg-primary/10 font-semibold'
                      : ''
                  }`}
                  title={stamp.label}
                  aria-label={`Select ${stamp.label} stamp`}
                >
                  {stamp.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

AnnotationLayer.displayName = 'AnnotationLayer';
