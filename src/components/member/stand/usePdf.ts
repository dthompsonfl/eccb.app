'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  loadPdfDocument,
  type PdfDocument,
  type PdfPage,
  type CropRect,
  renderPageToCanvas,
  createOffscreenCanvas,
} from '@/lib/pdf';
import { calculateAutoCrop } from '@/lib/autoCrop';
import { normalizedCropToPixels, type NormalizedCropRect } from '@/lib/stand/navigation';

export interface UsePdfOptions {
  url: string | null;
  pageNumber: number;
  scale: number;
  enablePreload?: boolean;
  enableAutoCrop?: boolean;
  /**
   * A crop the user has already chosen (e.g. persisted per-user). When set it
   * takes precedence over the auto-computed crop, so a musician's deliberate
   * framing survives reloads and re-renders.
   */
  cropRect?: NormalizedCropRect | null;
}

export interface UsePdfResult {
  document: PdfDocument | null;
  /** The caller-supplied crop in normalised (0..1) space, for persistence. */
  normalizedCropRect: NormalizedCropRect | null;
  /**
   * Render an arbitrary page into a caller-supplied canvas. Used by the
   * two-page spread, which needs the second visible page drawn into its own
   * canvas rather than into the main one.
   */
  renderPageInto: (pageNumber: number, target: HTMLCanvasElement) => Promise<void>;
  currentPage: PdfPage | null;
  isLoading: boolean;
  error: Error | null;
  numPages: number;
  cropRect: CropRect | null;
  prevPageCanvas: HTMLCanvasElement | null;
  nextPageCanvas: HTMLCanvasElement | null;
  renderCurrentPage: () => Promise<void>;
  preloadAdjacentPages: () => Promise<void>;
}

export interface UsePdfReturn extends UsePdfResult {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Custom hook for loading and rendering PDF pages
 * Handles document loading, page rendering, and preloading
 */
export function usePdf(options: UsePdfOptions): UsePdfReturn {
  const {
    url,
    pageNumber,
    scale,
    enablePreload = true,
    enableAutoCrop = false,
    cropRect: externalCrop = null,
  } = options;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const documentRef = useRef<PdfDocument | null>(null);

  const [document, setDocument] = useState<PdfDocument | null>(null);
  const [currentPage, setCurrentPage] = useState<PdfPage | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [computedCropRect, setComputedCropRect] = useState<CropRect | null>(null);
  // An explicit user crop always wins over the auto-computed one.
  // The resolved crop is reported in pixel space from pixelCrop() below.
  const [prevPageCanvas, setPrevPageCanvas] = useState<HTMLCanvasElement | null>(null);
  const [nextPageCanvas, setNextPageCanvas] = useState<HTMLCanvasElement | null>(null);

  const renderRef = useRef<{ cancel: () => void } | null>(null);
  /**
   * The active crop in PIXEL space for a given page.
   *
   * `computedCropRect` is already in pixels (calculateAutoCrop measures the
   * rendered viewport); a user-persisted crop is NORMALISED so it survives a
   * different device, and is converted against this page's viewport here.
   */
  const pixelCrop = useCallback(
    (page: PdfPage | null): CropRect | null => {
      if (!page) return null;
      if (externalCrop) {
        const vp = page.getViewport({ scale });
        return normalizedCropToPixels(externalCrop, vp.width, vp.height);
      }
      return computedCropRect;
    },
    [externalCrop, computedCropRect, scale],
  );

  // Load PDF document when URL changes
  useEffect(() => {
    if (!url) {
      setDocument(null);
      setCurrentPage(null);
      setNumPages(0);
      setError(null);
      return;
    }

    let cancelled = false;

    async function loadDocument() {
      if (!url) return;
      setIsLoading(true);
      setError(null);

      try {
        const pdfDoc = await loadPdfDocument(url);

        if (cancelled) return;

        documentRef.current = pdfDoc;
        setDocument(pdfDoc);
        setNumPages(pdfDoc.numPages);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error('Failed to load PDF'));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    loadDocument();

    return () => {
      cancelled = true;
    };
  }, [url]);

  // Load and render current page when document or page number changes
  useEffect(() => {
    if (!document || pageNumber < 1 || pageNumber > numPages) {
      setCurrentPage(null);
      return;
    }

    let cancelled = false;

    // Cancel any ongoing render before starting a new one
    if (renderRef.current) {
      renderRef.current.cancel();
      renderRef.current = null;
    }

    async function loadAndRenderPage() {
      const doc = document;
      if (!doc) return;

      try {
        const page = await doc.getPage(pageNumber);

        if (cancelled) return;

        setCurrentPage(page);

        // Calculate auto-crop if enabled
        if (enableAutoCrop) {
          const crop = await calculateAutoCrop(page);
          if (!cancelled) {
            setComputedCropRect(crop);
          }
        }

        // Render to canvas if available
        if (canvasRef.current) {
          const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
          try {
            const handle = await renderPageToCanvas(
            page,
            canvasRef.current,
            scale,
            dpr,
            pixelCrop(page),
          );
            if (!cancelled) {
              renderRef.current = handle;
            } else {
              handle.cancel();
            }
          } catch (renderErr) {
            // Cancelled renders throw — ignore if we triggered it
            if (!cancelled) {
              console.error('Error rendering page:', renderErr);
            }
          }
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Error rendering page:', err);
        }
      }
    }

    loadAndRenderPage();

    return () => {
      cancelled = true;
      if (renderRef.current) {
        renderRef.current.cancel();
        renderRef.current = null;
      }
    };
    // `currentPage` is deliberately NOT a dependency. It is the state this
    // effect itself sets (setCurrentPage above), so including it re-entered
    // this effect on every completed render: the PDF re-rendered, produced a
    // new PdfPage object, which changed `currentPage`, which re-ran the effect
    // again. That was an unbounded render loop pegging the main thread at
    // ~800 canvas renders/second, which starved the event loop so completely
    // that real user input (clicks, taps, page turns) never completed. The
    // crop for the page being rendered is derived from the local `page` this
    // effect just fetched, not from the previous render's state.
  }, [document, pageNumber, scale, numPages, enableAutoCrop, pixelCrop]);

  // Preload adjacent pages
  useEffect(() => {
    if (!enablePreload || !document || numPages === 0) return;

    let cancelled = false;

    async function preloadPages() {
      const doc = document;
      if (!doc) return;

      // Preload previous page
      if (pageNumber > 1) {
        try {
          const prevPage = await doc.getPage(pageNumber - 1);
          const canvas = createOffscreenCanvas(
            Math.floor(prevPage.getViewport({ scale }).width),
            Math.floor(prevPage.getViewport({ scale }).height)
          );
          await renderPageToCanvas(prevPage, canvas, scale);

          if (!cancelled) {
            setPrevPageCanvas(canvas);
          }
        } catch (err) {
          console.error('Error preloading previous page:', err);
        }
      } else {
        setPrevPageCanvas(null);
      }

      // Preload next page
      if (pageNumber < numPages) {
        try {
          const nextPage = await document.getPage(pageNumber + 1);
          const canvas = createOffscreenCanvas(
            Math.floor(nextPage.getViewport({ scale }).width),
            Math.floor(nextPage.getViewport({ scale }).height)
          );
          await renderPageToCanvas(nextPage, canvas, scale);

          if (!cancelled) {
            setNextPageCanvas(canvas);
          }
        } catch (err) {
          console.error('Error preloading next page:', err);
        }
      } else {
        setNextPageCanvas(null);
      }
    }

    preloadPages();

    return () => {
      cancelled = true;
    };
  }, [document, pageNumber, numPages, scale, enablePreload]);

  const renderCurrentPage = useCallback(async () => {
    if (!currentPage || !canvasRef.current) return;

    try {
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      if (renderRef.current) {
        renderRef.current.cancel();
        renderRef.current = null;
      }
      const handle = await renderPageToCanvas(
        currentPage,
        canvasRef.current,
        scale,
        dpr,
        pixelCrop(currentPage),
      );
      renderRef.current = handle;
    } catch (err) {
      console.error('Error re-rendering page:', err);
    }
  }, [currentPage, scale, pixelCrop]);

  /**
   * Renders still in flight, keyed by the canvas being drawn into.
   *
   * PDF.js refuses to render the same canvas twice concurrently ("Cannot use the
   * same canvas during multiple render() operations"). The spread's right-hand
   * page re-renders whenever `renderPageInto` changes identity — which happens on
   * every page-count update, zoom change and crop change — and React re-runs the
   * effect without the previous render having finished. The new render then
   * collided with the old one, the whole call rejected, and the spread page
   * silently stayed blank (after a reload, forever). Cancelling the superseded
   * render before starting a new one is what makes the second page appear.
   */
  const spreadRendersRef = useRef(new Map<HTMLCanvasElement, { cancel: () => void }>());

  /**
   * Render any page of the loaded document into a caller-supplied canvas.
   * The two-page spread uses this to draw its right-hand page for real instead
   * of advancing the current page and displaying only one of them.
   */
  const renderPageInto = useCallback(
    async (targetPageNumber: number, target: HTMLCanvasElement) => {
      if (!document) return;
      if (targetPageNumber < 1 || targetPageNumber > numPages) return;

      // Retire any render still targeting this canvas before starting another.
      const previous = spreadRendersRef.current.get(target);
      if (previous) {
        spreadRendersRef.current.delete(target);
        previous.cancel();
      }

      try {
        const page = await document.getPage(targetPageNumber);
        // The document may have been swapped out while the page was loading.
        if (!documentRef.current) return;
        const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
        const handle = await renderPageToCanvas(page, target, scale, dpr, pixelCrop(page));
        spreadRendersRef.current.set(target, handle);
      } catch (err) {
        // A cancelled render throws by design. That is a normal outcome here, not
        // a failure worth reporting.
        if (err instanceof Error && /cancel/i.test(err.message)) return;
        console.error(`Error rendering spread page ${targetPageNumber}:`, err);
      }
    },
    [document, numPages, scale, pixelCrop],
  );

  const preloadAdjacentPages = useCallback(async () => {
    if (!document || !enablePreload) return;

    // Force preload regardless of current state
    if (pageNumber > 1) {
      const prevPage = await document.getPage(pageNumber - 1);
      const canvas = createOffscreenCanvas(
        Math.floor(prevPage.getViewport({ scale }).width),
        Math.floor(prevPage.getViewport({ scale }).height)
      );
      await renderPageToCanvas(prevPage, canvas, scale);
      setPrevPageCanvas(canvas);
    }

    if (pageNumber < numPages) {
      const nextPage = await document.getPage(pageNumber + 1);
      const canvas = createOffscreenCanvas(
        Math.floor(nextPage.getViewport({ scale }).width),
        Math.floor(nextPage.getViewport({ scale }).height)
      );
      await renderPageToCanvas(nextPage, canvas, scale);
      setNextPageCanvas(canvas);
    }
  }, [document, pageNumber, numPages, scale, enablePreload]);

  // Release any in-flight spread render when the viewer goes away, so a
  // cancelled task cannot later write into a detached canvas.
  useEffect(() => {
    const inFlight = spreadRendersRef.current;
    return () => {
      for (const handle of inFlight.values()) handle.cancel();
      inFlight.clear();
    };
  }, []);

  return {
    document,
    normalizedCropRect: externalCrop,
    currentPage,
    isLoading,
    error,
    numPages,
    // Always PIXEL space, regardless of whether the active crop was computed
    // here or supplied by the caller in normalised form.
    cropRect: pixelCrop(currentPage),
    prevPageCanvas,
    nextPageCanvas,
    renderCurrentPage,
    renderPageInto,
    preloadAdjacentPages,
    canvasRef: canvasRef as React.RefObject<HTMLCanvasElement | null>,
    containerRef: containerRef as React.RefObject<HTMLDivElement | null>,
  };
}

export type { CropRect };
