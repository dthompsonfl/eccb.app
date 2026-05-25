'use client';
import type React from 'react';
import { useCallback, useEffect, useState, useRef, useMemo, type RefObject } from 'react';
import { useStandStore, Tool, Annotation, StrokePoint, StrokeData } from '@/store/standStore';
import { STAMPS, loadStampImage } from '@/lib/stamps';

// Generate unique ID for strokes
function generateId(): string {
  return crypto.randomUUID();
}

// Render scheduler using requestAnimationFrame for performance
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
    currentPieceIndex: _currentPieceIndex,
    _currentPage: currentPage,
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
  } = useStandStore();

  const pieceId = useStandStore((s) => s.pieces[s.currentPieceIndex]?.id);

  // refs for three canvases
  const personalRef = useRef<HTMLCanvasElement>(null);
  const sectionRef = useRef<HTMLCanvasElement>(null);
  const directorRef = useRef<HTMLCanvasElement>(null);

  // current drawing state
  const isDrawingRef = useRef(false);
  const currentPointsRef = useRef<StrokePoint[]>([]);
  const currentStrokeRef = useRef<StrokeData | null>(null);

  // Track if we need to render (for RAF scheduling)
  const needsRenderRef = useRef(false);
  const renderCancelRef = useRef<(() => void) | null>(null);

  // Cache of loaded HTMLImageElement instances for stamps, keyed by stampId
  const stampCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());

  // Stamp palette visibility
  const [showStampPalette, setShowStampPalette] = useState(false);

  // text input overlay state
  const [textInput, setTextInput] = useState<{
    visible: boolean;
    x: number;
    y: number;
    value: string;
  }>({ visible: false, x: 0, y: 0, value: '' });

  const textInputRef = useRef<HTMLTextAreaElement>(null);

  // Device pixel ratio for crisp canvas rendering on HiDPI displays
  const dprRef = useRef<number>(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);

  // Undo/redo stacks (session-local; clear on piece/page change)
  const undoStackRef = useRef<Annotation[]>([]);
  const redoStackRef = useRef<Annotation[]>([]);

  // helper to key map - memoized
  const key = useMemo(() => `${pieceId}-${currentPage}`, [pieceId, currentPage]);

  const layerMap: Record<string, RefObject<HTMLCanvasElement | null>> = useMemo(() => ({
    PERSONAL: personalRef,
    SECTION: sectionRef,
    DIRECTOR: directorRef,
  }), []);

  // Get current layer canvas ref
  const getCurrentCanvasRef = useCallback((): HTMLCanvasElement | null => {
    return layerMap[selectedLayer]?.current || null;
  }, [selectedLayer, layerMap]);

  // Compute stroke width with pressure - memoized
  const computeWidth = useCallback(
    (pressure: number): number => {
      const effectivePressure = pressure === 0 ? 0.5 : pressure;
      return strokeWidth + effectivePressure * pressureScale;
    },
    [strokeWidth, pressureScale]
  );

  // Draw a single stroke on canvas - stable callback
  const drawStroke = useCallback(
    (ctx: CanvasRenderingContext2D, stroke: StrokeData) => {
      const { type, points, color, baseWidth: _baseWidth, opacity } = stroke;

      // ── Stamp tool ────────────────────────────────────────────────────────
      if (type === Tool.STAMP && stroke.stampId && points.length > 0) {
        const pt = points[0];
        const size = (stroke.width ?? strokeWidth * 10) || 48;
        const cached = stampCacheRef.current.get(stroke.stampId);
        if (cached) {
          ctx.save();
          ctx.globalAlpha = opacity ?? 1;
          // Apply colour filter using CSS composite trick: tint to toolColor
          ctx.fillStyle = color;
          const hw = size / 2;
          if (stroke.rotation) {
            ctx.translate(pt.x, pt.y);
            ctx.rotate((stroke.rotation * Math.PI) / 180);
            ctx.drawImage(cached, -hw, -hw, size, size);
          } else {
            ctx.drawImage(cached, pt.x - hw, pt.y - hw, size, size);
          }
          ctx.restore();
        } else {
          // Load and cache; re-render after load
          loadStampImage(stroke.stampId)
            .then((img) => {
              stampCacheRef.current.set(stroke.stampId!, img);
              // Force a re-render
              needsRenderRef.current = true;
            })
            .catch(console.error);
        }
        return;
      }

      if (points.length < 2) return;

      ctx.save();

      // Set composite operation based on tool type
      if (type === Tool.HIGHLIGHTER) {
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = 0.4;
      } else if (type === Tool.ERASER) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.globalAlpha = 1;
      } else if (type === Tool.WHITEOUT) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
      } else {
        ctx.globalAlpha = opacity || 1;
      }

      ctx.strokeStyle = type === Tool.WHITEOUT ? '#ffffff' : color;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // Draw the stroke with variable width based on pressure
      ctx.beginPath();
      const firstPoint = points[0];
      ctx.moveTo(firstPoint.x, firstPoint.y);

      // Use quadratic curves for smooth lines with pressure-sensitive width
      for (let i = 1; i < points.length; i++) {
        const point = points[i];
        const prevPoint = points[i - 1];
        const width = computeWidth(point.pressure);

        ctx.lineWidth = width;
        // Use quadratic curve for smoother lines - creates bezier curves between points
        const midX = (prevPoint.x + point.x) / 2;
        const midY = (prevPoint.y + point.y) / 2;
        ctx.quadraticCurveTo(prevPoint.x, prevPoint.y, midX, midY);
      }

      // Draw to the last point to complete the stroke
      const lastPoint = points[points.length - 1];
      ctx.lineTo(lastPoint.x, lastPoint.y);
      ctx.stroke();

      ctx.restore();
    },
    [computeWidth, strokeWidth]
  );

  // RAF-based render function for performance
  const scheduleCanvasRender = useCallback(() => {
    if (renderCancelRef.current) {
      renderCancelRef.current();
    }

    renderCancelRef.current = scheduleRender(() => {
      if (!pieceId) return;

      // Render each layer separately to maintain layer isolation
      ['PERSONAL', 'SECTION', 'DIRECTOR'].forEach((layer) => {
        const ref = layerMap[layer];
        const ctx = ref.current?.getContext('2d');
        if (!ctx || !ref.current) return;

        // Clear canvas before redrawing (reset transform first to clear device pixels)
        const dpr = dprRef.current;
        ctx.resetTransform();
        ctx.clearRect(0, 0, ref.current.width, ref.current.height);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // Get annotations for current piece and page
        const anns =
          annotations[layer.toLowerCase() as keyof typeof annotations]?.[key] || [];

        // Draw existing annotations as strokes
        anns.forEach((a) => {
          // Check if it's a stroke-based annotation (has strokeData)
          if ('strokeData' in a && a.strokeData) {
            const strokeData = a.strokeData as unknown as StrokeData;
            if (strokeData.points && Array.isArray(strokeData.points)) {
              drawStroke(ctx, strokeData);
              return;
            }
          }
        });
      });
    });
  }, [pieceId, layerMap, annotations, key, drawStroke]);

  // Render all annotations on canvas - uses RAF scheduler
  useEffect(() => {
    scheduleCanvasRender();

    return () => {
      if (renderCancelRef.current) {
        renderCancelRef.current();
      }
    };
  }, [annotations, pieceId, currentPage, scheduleCanvasRender]);

  // Sync canvas size with container — DPR-aware
  useEffect(() => {
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      dprRef.current = dpr;
      [personalRef, sectionRef, directorRef].forEach((ref) => {
        if (ref.current && ref.current.parentElement) {
          const logicalW = ref.current.parentElement.clientWidth;
          const logicalH = ref.current.parentElement.clientHeight;
          ref.current.width = logicalW * dpr;
          ref.current.height = logicalH * dpr;
          ref.current.style.width = `${logicalW}px`;
          ref.current.style.height = `${logicalH}px`;
          // Apply DPR transform so all draw calls use logical (CSS) coordinates
          const ctx = ref.current.getContext('2d');
          if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
      });
      needsRenderRef.current = true;
      scheduleCanvasRender();
    };
    resize();
    window.addEventListener('resize', resize, { passive: true });
    return () => window.removeEventListener('resize', resize);
  }, [scheduleCanvasRender]);

  // Clear undo/redo stacks when page or piece changes
  useEffect(() => {
    undoStackRef.current = [];
    redoStackRef.current = [];
  }, [key]);

  // Keyboard undo (Ctrl+Z) / redo (Ctrl+Y or Ctrl+Shift+Z)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!editMode) return;
      const isUndo = (e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey;
      const isRedo =
        ((e.ctrlKey || e.metaKey) && e.key === 'y') ||
        ((e.ctrlKey || e.metaKey) && e.key === 'z' && e.shiftKey);
      if (isUndo) {
        e.preventDefault();
        const ann = undoStackRef.current.pop();
        if (ann) {
          redoStackRef.current.push(ann);
          deleteAnnotation?.(ann.id).catch(console.error);
        }
      } else if (isRedo) {
        e.preventDefault();
        const ann = redoStackRef.current.pop();
        if (ann) {
          undoStackRef.current.push(ann);
          addAnnotation?.(ann).catch(console.error);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editMode, deleteAnnotation, addAnnotation]);

  // Handle pointer down - start drawing
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!editMode) return;

      const canvas = e.currentTarget;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Handle stamp tool: single-click place stamp (no dragging)
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

      // Handle text tool separately
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
          x,
          y,
          pressure: e.pressure || 0.5,
          timestamp: Date.now(),
        },
      ];

      currentStrokeRef.current = {
        id: generateId(),
        type: currentTool,
        points: currentPointsRef.current,
        color: currentTool === Tool.WHITEOUT ? '#ffffff' : toolColor,
        baseWidth: strokeWidth,
        opacity: currentTool === Tool.HIGHLIGHTER ? 0.4 : 1,
      };

      // Capture pointer for smooth drawing
      canvas.setPointerCapture(e.pointerId);
    },
    [editMode, currentTool, toolColor, strokeWidth, selectedStampId, drawStroke, pieceId, currentPage, selectedLayer, addAnnotation]
  );

  // Handle pointer move - continue drawing with RAF
  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDrawingRef.current || !currentStrokeRef.current) return;

      const canvas = e.currentTarget;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const newPoint: StrokePoint = {
        x,
        y,
        pressure: e.pressure || 0.5,
        timestamp: Date.now(),
      };

      currentPointsRef.current.push(newPoint);
      currentStrokeRef.current.points = currentPointsRef.current;

      // Use RAF for smooth rendering during draw
      if (renderCancelRef.current) {
        renderCancelRef.current();
      }

      renderCancelRef.current = scheduleRender(() => {
        // Clear and redraw with new point (DPR-aware)
        const dpr = dprRef.current;
        ctx.resetTransform();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // Redraw all existing strokes
        const anns =
          annotations[selectedLayer.toLowerCase() as keyof typeof annotations]?.[
            key
          ] || [];

        anns.forEach((a) => {
          if ('strokeData' in a && a.strokeData) {
            const strokeData = a.strokeData as unknown as StrokeData;
            if (strokeData.points && Array.isArray(strokeData.points)) {
              drawStroke(ctx, strokeData);
            }
          }
        });

        // Draw current stroke
        if (currentStrokeRef.current) {
          drawStroke(ctx, currentStrokeRef.current);
        }
      });
    },
    [annotations, selectedLayer, key, drawStroke]
  );

  // Handle pointer up - finish drawing and persist
  const handlePointerUp = useCallback(
    async (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = e.currentTarget;
      if (!isDrawingRef.current || !currentStrokeRef.current || !addAnnotation)
        return;

      canvas.releasePointerCapture(e.pointerId);

      // Save the completed stroke
      const stroke = currentStrokeRef.current;

      // Convert to annotation format for persistence
      const annotation: Annotation = {
        id: stroke.id,
        pieceId: pieceId || '',
        pageNumber: currentPage,
        layer: selectedLayer,
        strokeData: stroke,
        createdAt: new Date().toISOString(),
      };

      await addAnnotation(annotation);

      // Push to undo stack so Ctrl+Z can remove it
      undoStackRef.current.push(annotation);
      redoStackRef.current = [];

      // Reset drawing state
      isDrawingRef.current = false;
      currentPointsRef.current = [];
      currentStrokeRef.current = null;
    },
    [pieceId, currentPage, selectedLayer, addAnnotation]
  );

  // Handle text input submit
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

    // Create text annotation
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

    // Render text to canvas
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.font = `${16}px sans-serif`;
      ctx.fillStyle = toolColor;
      ctx.fillText(textInput.value, textInput.x, textInput.y);
    }

    // Persist annotation
    const annotation: Annotation = {
      id: stroke.id,
      pieceId: pieceId,
      pageNumber: currentPage,
      layer: selectedLayer,
      strokeData: stroke,
      createdAt: new Date().toISOString(),
    };

    await addAnnotation(annotation);

    setTextInput({ visible: false, x: 0, y: 0, value: '' });
  }, [textInput, pieceId, currentPage, selectedLayer, toolColor, strokeWidth, getCurrentCanvasRef, addAnnotation]);

  // Focus text input when visible - focus management for accessibility
  useEffect(() => {
    if (textInput.visible && textInputRef.current) {
      // Small delay to ensure DOM is ready
      const focusTimeout = setTimeout(() => {
        textInputRef.current?.focus();
      }, 0);
      return () => clearTimeout(focusTimeout);
    }
  }, [textInput.visible]);

  // Handle escape key to close text input
  const handleTextInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleTextSubmit();
      }
      if (e.key === 'Escape') {
        setTextInput({ visible: false, x: 0, y: 0, value: '' });
      }
    },
    [handleTextSubmit]
  );

  return (
    <div
      className="absolute inset-0"
      role="group"
      aria-label="Annotation layers"
    >
      {(['PERSONAL', 'SECTION', 'DIRECTOR'] as const).map((layer, idx) => (
        <canvas
          key={layer}
          ref={layerMap[layer]}
          className="absolute inset-0"
          style={{
            zIndex: idx,
            pointerEvents: editMode && selectedLayer === layer ? 'auto' : 'none',
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          aria-label={
            `${layer.toLowerCase()} annotation layer` +
            (editMode && selectedLayer === layer ? ' - active' : '')
          }
          aria-hidden={!editMode || selectedLayer !== layer}
        />
      ))}

      {/* Text input overlay with proper ARIA */}
      {textInput.visible && (
        <textarea
          ref={textInputRef}
          value={textInput.value}
          onChange={(e) =>
            setTextInput((prev) => ({ ...prev, value: e.target.value }))
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
      {/* Screen reader help text */}
      <div id="text-annotation-help" className="sr-only">
        Press Enter to save text annotation, Escape to cancel
      </div>

      {/* Stamp palette — shown when STAMP tool is active and editMode is on */}
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
                    selectedStampId === stamp.id ? 'border-primary bg-primary/10 font-semibold' : ''
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
