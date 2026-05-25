'use client';

import type { CropRect, PdfPage } from './pdf';

const DEFAULT_MARGIN = 10;
const WHITE_PIXEL_THRESHOLD = 250;
const MIN_CONTENT_HEIGHT = 20;

/**
 * Calculate crop rectangle for a PDF page by analyzing pixel content
 * This heuristic detects staff lines and other content by scanning for dark pixels
 * @param page - PDF page object
 * @param scale - Scale factor for rendering (higher = more precision)
 * @param margin - Additional margin to add around detected content
 * @returns Promise resolving to crop rectangle
 */
export async function calculateAutoCrop(
  page: PdfPage,
  scale: number = 0.5,
  margin: number = DEFAULT_MARGIN
): Promise<CropRect> {
  // Get viewport at the render scale
  const viewport = page.getViewport({ scale });

  // Create an offscreen canvas
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);

  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('Failed to get canvas context for auto-crop');
  }

  // Render the page to the canvas
  const renderTask = page.render({
    canvas,
    canvasContext: context,
    viewport,
  });

  await renderTask.promise;

  // Get image data to analyze pixels
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  // Find bounds of non-white content
  let minX = canvas.width;
  let minY = canvas.height;
  let maxX = 0;
  let maxY = 0;

  // Scan rows for content (find top and bottom bounds)
  for (let y = 0; y < canvas.height; y++) {
    let hasContent = false;

    for (let x = 0; x < canvas.width; x++) {
      const index = (y * canvas.width + x) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];

      // Check if pixel is not white/light
      if (r < WHITE_PIXEL_THRESHOLD || g < WHITE_PIXEL_THRESHOLD || b < WHITE_PIXEL_THRESHOLD) {
        hasContent = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }

    if (hasContent) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  // If no content found, return full page
  if (minX >= maxX || minY >= maxY) {
    return {
      x: 0,
      y: 0,
      width: canvas.width,
      height: canvas.height,
    };
  }

  // Add margin and clamp to canvas bounds
  minX = Math.max(0, minX - margin);
  minY = Math.max(0, minY - margin);
  maxX = Math.min(canvas.width, maxX + margin);
  maxY = Math.min(canvas.height, maxY + margin);

  const cropWidth = maxX - minX;
  const cropHeight = maxY - minY;

  // If cropped height is too small, return full page (might be just noise)
  if (cropHeight < MIN_CONTENT_HEIGHT) {
    return {
      x: 0,
      y: 0,
      width: canvas.width,
      height: canvas.height,
    };
  }

  return {
    x: minX / scale,
    y: minY / scale,
    width: cropWidth / scale,
    height: cropHeight / scale,
  };
}

/**
 * Calculate crop rectangle using text content from PDF
 * This uses PDF text positions to determine content bounds
 * @param page - PDF page object
 * @param margin - Additional margin to add
 * @returns Promise resolving to crop rectangle
 */
export async function calculateTextCrop(
  page: PdfPage,
  margin: number = DEFAULT_MARGIN
): Promise<CropRect> {
  const viewport = page.getViewport({ scale: 1 });

  try {
    const textContent = await page.getTextContent();

    if (textContent.items.length === 0) {
      return {
        x: 0,
        y: 0,
        width: viewport.width,
        height: viewport.height,
      };
    }

    let minX = viewport.width;
    let minY = viewport.height;
    let maxX = 0;
    let maxY = 0;

    for (const item of textContent.items) {
      // Transform matrix: [scaleX, skewY, skewX, scaleY, translateX, translateY]
      const transform = item.transform;
      const x = transform[4];
      const y = transform[5];
      const width = item.width || 0;
      const height = item.height || 10; // Default height if not specified

      // PDF coordinates have origin at bottom-left (y increases upwards)
      // Web coordinates have origin at top-left (y increases downwards)
      const itemMinX = x;
      const itemMaxX = x + width;
      const itemMinY = viewport.height - (y + height);
      const itemMaxY = viewport.height - y;

      if (itemMinX < minX) minX = itemMinX;
      if (itemMinY < minY) minY = itemMinY;
      if (itemMaxX > maxX) maxX = itemMaxX;
      if (itemMaxY > maxY) maxY = itemMaxY;
    }

    // Add margin
    minX = Math.max(0, minX - margin);
    minY = Math.max(0, minY - margin);
    maxX = Math.min(viewport.width, maxX + margin);
    maxY = Math.min(viewport.height, maxY + margin);

    return {
      x: minX,
      y: minY,
      width: Math.max(0, maxX - minX),
      height: Math.max(0, maxY - minY),
    };
  } catch {
    // If text extraction fails, return full page
    return {
      x: 0,
      y: 0,
      width: viewport.width,
      height: viewport.height,
    };
  }
}

/**
 * Get a cropped viewport for rendering
 * @param page - PDF page object
 * @param crop - Crop rectangle
 * @param scale - Scale factor
 * @returns Cropped viewport
 */
export function getCroppedViewport(
  page: PdfPage,
  crop: CropRect,
  scale: number
) {
  const fullViewport = page.getViewport({ scale });

  return fullViewport.clone({
    offsetX: -crop.x * scale,
    offsetY: -crop.y * scale,
    width: crop.width * scale,
    height: crop.height * scale,
  });
}
