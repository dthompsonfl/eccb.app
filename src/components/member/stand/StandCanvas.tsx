'use client';

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import { useStandStore } from '@/store/standStore';
import { usePdf } from './usePdf';
import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';
import { AnnotationLayer } from './AnnotationLayer';


/**
 * The right-hand page of a two-page spread.
 *
 * Rendered as a real, visible canvas — not an opacity-0 preload target — so the
 * spread shows both pages the navigation math says are on screen. The page is
 * drawn by the parent's `usePdf` document via `renderPageInto`, so both halves
 * of the spread come from one loaded PDF.
 */
const SpreadPageCanvas = React.memo(function SpreadPageCanvas({
  pageNumber,
  totalPages,
  title,
  renderPageInto,
  nightModeStyles,
  onPageClick,
}: {
  pageNumber: number;
  totalPages: number;
  title: string;
  renderPageInto: (pageNumber: number, target: HTMLCanvasElement) => Promise<void>;
  nightModeStyles?: React.CSSProperties;
  onPageClick?: (page: number, x: number, y: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    void renderPageInto(pageNumber, canvas).then(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
  }, [renderPageInto, pageNumber]);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!onPageClick) return;
      const rect = e.currentTarget.getBoundingClientRect();
      onPageClick(pageNumber, e.clientX - rect.left, e.clientY - rect.top);
    },
    [onPageClick, pageNumber],
  );

  return (
    <canvas
      ref={canvasRef}
      data-testid="stand-spread-right-page"
      className="block shadow-lg"
      onClick={handleClick}
      style={{
        maxWidth: '50%',
        height: 'auto',
        ...nightModeStyles,
      }}
      aria-label={`Page ${pageNumber} of ${totalPages} of ${title}`}
      role="img"
    />
  );
});

export interface StandCanvasProps {
  className?: string;
  enableAutoCrop?: boolean;
  enablePreload?: boolean;
  onPageClick?: (pageNumber: number, x: number, y: number) => void;
  onCropChange?: (cropRect: { x: number; y: number; width: number; height: number } | null) => void;
}

export interface StandCanvasRef {
  renderPage: (pageNumber: number) => Promise<void>;
  getCropRect: () => { x: number; y: number; width: number; height: number } | null;
  getCanvasDataUrl: () => string | null;
  requestRender: () => void;
}

// Check for reduced motion preference
function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = React.useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(mediaQuery.matches);

    const handleChange = (e: MediaQueryListEvent) => {
      setPrefersReducedMotion(e.matches);
    };

    mediaQuery.addEventListener('change', handleChange, { passive: true });
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return prefersReducedMotion;
}

/**
 * Canvas-based PDF renderer for the digital music stand
 * Supports zoom, auto-crop, preloading, and annotation overlays
 * Night mode applies CSS inversion for dark environment reading
 * 
 * Accessibility features:
 * - ARIA labels for screen readers
 * - Keyboard navigation support
 * - Reduced motion support
 * - Skip links for major sections
 */
export const StandCanvas = forwardRef<StandCanvasRef, StandCanvasProps>(
  (
    {
      className,
      enableAutoCrop = false,
      enablePreload = true,
      onPageClick,
      onCropChange,
    },
    ref
  ) => {
    const canvasContainerRef = useRef<HTMLDivElement>(null);
    const renderFrameRef = useRef<number | null>(null);

    const {
      currentPieceIndex,
      _currentPage: currentPage,
      pieces,
      zoom,
      setCurrentPage,
      scrollOffset,
      nightMode,
      twoPageMode,
      visibleSpreadPages,
      cropRect: persistedCrop,
      setCropRect,
      updatePieceTotalPages,
    } = useStandStore();

    const prefersReducedMotion = usePrefersReducedMotion();
    const currentPiece = pieces[currentPieceIndex];
    const currentPieceId = currentPiece?.id;
    // The spread decision needs the piece's page count, and `visibleSpreadPages`
    // reads it from the store. Keyed on it so the memo re-evaluates when the real
    // count arrives after the document loads — otherwise it returns a stale
    // single-page result and the spread's right-hand canvas never renders, which
    // is what happened on every reload into spread mode.
    const storeTotalPages = currentPiece?.totalPages;

    /**
     * In spread mode two pages are shown side by side. The right page is null
     * for an odd-length piece's final page, which is centred rather than padded.
     */
    // Depends on the store's totalPages as well as the page and mode, because
    // `visibleSpreadPages()` reads the piece's page count from the store. When
    // the document finishes loading and the real page count lands,
    // `visibleSpreadPages` and `currentPage` are both referentially unchanged, so
    // a memo keyed only on those returned its stale single-page result and the
    // spread's right-hand canvas was never rendered — exactly what happened on
    // every reload into spread mode.
    //
    // `numPages` (PDF.js) is the authority on page count, but it is not
    // destructured until below this memo, so it cannot be a dependency here
    // without a temporal-dead-zone crash. The store is kept in sync with
    // PDF.js by the `updatePieceTotalPages` effect further down.
    const spread = useMemo(
      () => (twoPageMode ? visibleSpreadPages() : { left: currentPage, right: null }),
      [twoPageMode, visibleSpreadPages, currentPage, storeTotalPages],
    );

    const scale = useMemo(() => zoom / 100, [zoom]);

    const {
      isLoading,
      error,
      numPages,
      cropRect,
      prevPageCanvas,
      nextPageCanvas,
      renderCurrentPage,
      renderPageInto,
      canvasRef,
    } = usePdf({
      url: currentPiece?.pdfUrl ?? null,
      pageNumber: currentPage,
      scale,
      enablePreload,
      enableAutoCrop,
      cropRect: persistedCrop,
    });

    // Notify parent of crop changes
    useEffect(() => {
      if (onCropChange) {
        onCropChange(cropRect);
      }
    }, [cropRect, onCropChange]);

    // Feed the real page count from the loaded document back into the store.
    //
    // The database's `pageCount` is nullable and is left NULL by the upload
    // path, so the store was seeded with `pageCount ?? 1`. Every consumer that
    // trusts the store — the page counter, the Next/Previous buttons, and
    // `isSpreadable()` for two-page spread — therefore believed the score was a
    // single page, which left page navigation permanently disabled on a 27-page
    // score. PDF.js is the authority on how many pages a document has, so its
    // count is what must win.
    useEffect(() => {
      if (!currentPieceId || numPages <= 0) return;
      if (currentPiece?.totalPages === numPages) return;
      updatePieceTotalPages(currentPieceId, numPages);
    }, [currentPieceId, currentPiece?.totalPages, numPages, updatePieceTotalPages]);

    // Expose methods via ref
    useImperativeHandle(
      ref,
      () => ({
        renderPage: async (pageNumber: number) => {
          if (pageNumber >= 1 && pageNumber <= numPages) {
            setCurrentPage(pageNumber);
            await renderCurrentPage();
          }
        },
        getCropRect: () => cropRect,
        getCanvasDataUrl: () => {
          if (canvasRef.current) {
            return canvasRef.current.toDataURL('image/png');
          }
          return null;
        },
        requestRender: () => renderCurrentPage(),
      }),
      [canvasRef, numPages, cropRect, renderCurrentPage, setCurrentPage]
    );

    // Handle canvas click with RAF for performance
    const handleCanvasClick = useCallback(
      (event: React.MouseEvent<HTMLCanvasElement>) => {
        if (!canvasRef.current || !onPageClick) return;
        
        // Use RAF to ensure we're not blocking main thread
        if (renderFrameRef.current) {
          cancelAnimationFrame(renderFrameRef.current);
        }
        
        renderFrameRef.current = requestAnimationFrame(() => {
          if (!canvasRef.current || !onPageClick) return;
          const rect = canvasRef.current.getBoundingClientRect();
          const x = (event.clientX - rect.left) / rect.width;
          const y = (event.clientY - rect.top) / rect.height;
          onPageClick(currentPage, x, y);
        });
      },
      [canvasRef, currentPage, onPageClick]
    );

    // Keyboard navigation for canvas
    useEffect(() => {
      const handleKeyDown = (event: KeyboardEvent) => {
        // Don't capture if focus is in an input
        if (document.activeElement?.tagName === 'INPUT' || 
            document.activeElement?.tagName === 'TEXTAREA') {
          return;
        }

        switch (event.key) {
          case 'ArrowLeft':
          case 'ArrowUp':
            if (currentPage > 1) setCurrentPage(currentPage - 1);
            break;
          case 'ArrowRight':
          case 'ArrowDown':
            if (currentPage < numPages) setCurrentPage(currentPage + 1);
            break;
          case 'Home':
            setCurrentPage(1);
            break;
          case 'End':
            setCurrentPage(numPages);
            break;
        }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => {
        window.removeEventListener('keydown', handleKeyDown);
        if (renderFrameRef.current) {
          cancelAnimationFrame(renderFrameRef.current);
        }
      };
    }, [currentPage, numPages, setCurrentPage]);

    // Cleanup RAF on unmount
    useEffect(() => {
      return () => {
        if (renderFrameRef.current) {
          cancelAnimationFrame(renderFrameRef.current);
        }
      };
    }, []);

    if (!currentPiece) {
      return (
        <div
          className={cn(
            'flex items-center justify-center h-full text-muted-foreground',
            className
          )}
          role="status"
          aria-live="polite"
        >
          No piece selected.
        </div>
      );
    }

    if (!currentPiece.pdfUrl) {
      return (
        <div
          className={cn(
            'flex items-center justify-center h-full text-muted-foreground',
            className
          )}
          role="status"
          aria-live="polite"
        >
          No PDF available for this piece.
        </div>
      );
    }

    if (error) {
      const is404 =
        error.message.includes('404') ||
        error.message.toLowerCase().includes('server response') ||
        error.message.toLowerCase().includes('not found');
      return (
        <div
          className={cn(
            'flex items-center justify-center h-full text-destructive',
            className
          )}
          role="alert"
          aria-live="assertive"
        >
          <div className="text-center">
            <p className="font-semibold">Error loading PDF</p>
            <p className="text-sm text-muted-foreground">
              {is404
                ? 'Sheet music file is unavailable. Please ask a director to re-upload this piece.'
                : error.message}
            </p>
          </div>
        </div>
      );
    }

    const nightModeContainerStyles = nightMode
      ? { backgroundColor: '#000000' }
      : {};

    const nightModeCanvasStyles = nightMode
      ? { filter: 'invert(1) hue-rotate(180deg)' }
      : {};

    // Determine transition duration based on motion preference
    const transitionDuration = prefersReducedMotion ? '0ms' : '200ms';

    return (
      <div
        ref={canvasContainerRef}
        className={cn(
          'relative w-full h-full overflow-auto',
          'flex items-start justify-center',
          'bg-neutral-100 dark:bg-neutral-900',
          className
        )}
        style={{
          ...nightModeContainerStyles,
          transitionDuration,
        }}
        data-night-mode={nightMode}
        role="region"
        aria-label="PDF viewer"
        aria-busy={isLoading}
      >
        {/* Skip links for keyboard users */}
        <a
          href="#stand-canvas-main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:px-4 focus:py-2 focus:bg-primary focus:text-primary-foreground focus:rounded-md"
        >
          Skip to main content
        </a>
        <a
          href="#stand-toolbar"
          className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:px-4 focus:py-2 focus:bg-primary focus:text-primary-foreground focus:rounded-md"
        >
          Skip to toolbar
        </a>

        {isLoading && (
          <div 
            className="absolute inset-0 flex items-center justify-center bg-background/50 z-10"
            role="status"
            aria-live="polite"
            aria-label="Loading PDF page"
          >
            <Loader2 className="w-8 h-8 animate-spin text-primary" aria-hidden="true" />
            <span className="sr-only">Loading page {currentPage}...</span>
          </div>
        )}
        <div
          id="stand-canvas-main"
          className={cn('relative', twoPageMode && 'flex items-start gap-4 justify-center')}
          style={{
            marginTop: scrollOffset > 0 ? `-${scrollOffset * 100}%` : undefined,
          }}
          tabIndex={-1}
        >
          <canvas
            ref={canvasRef}
            className="block shadow-lg"
            onClick={handleCanvasClick}
            style={{
              maxWidth: twoPageMode ? '50%' : '100%',
              height: 'auto',
              ...nightModeCanvasStyles,
            }}
            aria-label={
              twoPageMode && spread.right != null
                ? `Pages ${spread.left} and ${spread.right} of ${numPages} of ${currentPiece.title}`
                : `Page ${currentPage} of ${numPages} of ${currentPiece.title}`
            }
            role="img"
          />
          {/*
            The second page of a spread. Previously both neighbours were rendered
            at opacity-0 purely as preload targets, so "two page" mode advanced
            two pages at a time while displaying one of them.
          */}
          {twoPageMode && spread.right != null && (
            <SpreadPageCanvas
              pageNumber={spread.right}
              totalPages={numPages}
              title={currentPiece.title}
              renderPageInto={renderPageInto}
              nightModeStyles={nightModeCanvasStyles}
              onPageClick={onPageClick}
            />
          )}
          {prevPageCanvas && (
            <canvas
              ref={(el) => {
                if (el && prevPageCanvas) {
                  const ctx = el.getContext('2d');
                  if (ctx) {
                    el.width = prevPageCanvas.width;
                    el.height = prevPageCanvas.height;
                    ctx.drawImage(prevPageCanvas, 0, 0);
                  }
                }
              }}
              className="absolute inset-0 pointer-events-none opacity-0"
              aria-hidden="true"
            />
          )}
          {nextPageCanvas && (
            <canvas
              ref={(el) => {
                if (el && nextPageCanvas) {
                  const ctx = el.getContext('2d');
                  if (ctx) {
                    el.width = nextPageCanvas.width;
                    el.height = nextPageCanvas.height;
                    ctx.drawImage(nextPageCanvas, 0, 0);
                  }
                }
              }}
              className="absolute inset-0 pointer-events-none opacity-0"
              aria-hidden="true"
            />
          )}
          <AnnotationLayer />
          {/*
            Crop controls. The crop is functional: it is applied to the PDF
            render itself (see renderPageToCanvas), stored in normalised space
            so it survives reloads on a different device, and can be reset.
          */}
          <div
            className="absolute top-2 right-2 flex items-center gap-1"
            role="group"
            aria-label="Page crop"
          >
            <button
              type="button"
              onClick={() => {
                if (persistedCrop) {
                  setCropRect(null);
                } else {
                  // A conservative default that trims typical blank margins.
                  setCropRect({ top: 0.05, left: 0.05, width: 0.9, height: 0.9 });
                }
              }}
              aria-pressed={Boolean(persistedCrop)}
              className={cn(
                'px-2 py-1 rounded text-xs border',
                persistedCrop
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-background/80 text-muted-foreground',
              )}
            >
              {persistedCrop ? 'Cropped' : 'Crop page'}
            </button>
            {persistedCrop && (
              <button
                type="button"
                onClick={() => setCropRect(null)}
                className="px-2 py-1 rounded text-xs bg-background/80 text-muted-foreground border"
                aria-label="Reset page crop"
              >
                Reset
              </button>
            )}
          </div>
          <div
            className={cn(
              'absolute bottom-2 right-2 px-2 py-1 rounded text-xs',
              nightMode
                ? 'bg-black/80 text-white border border-white/20'
                : 'bg-background/80 text-muted-foreground'
            )}
            role="status"
            aria-live="polite"
            aria-label={`Page ${currentPage} of ${numPages}`}
          >
            {currentPage} / {numPages}
          </div>
        </div>
      </div>
    );
  }
);

StandCanvas.displayName = 'StandCanvas';

export default StandCanvas;
