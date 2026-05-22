import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth/guards';
import { checkUserPermission } from '@/lib/auth/permissions';
import { uploadFile, validateFileMagicBytes } from '@/lib/services/storage';
import { applyRateLimit } from '@/lib/rate-limit';
import { validateCSRF } from '@/lib/csrf';
import { logger } from '@/lib/logger';
import { env } from '@/lib/env';
import { z } from 'zod';
import { virusScanner } from '@/lib/services/virus-scanner';

import { CMS_EDIT } from '@/lib/auth/permission-constants';
// =============================================================================
// Constants
// =============================================================================

// Allowed MIME types for CMS assets (images and documents)
const ALLOWED_MIME_TYPES = [
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

// Maximum file size (from env, default 50MB)
const MAX_FILE_SIZE = env.MAX_FILE_SIZE;

// =============================================================================
// Validation Schemas
// =============================================================================

const uploadSchema = z.object({
  title: z.string().max(255).optional(),
  altText: z.string().max(500).optional(),
  caption: z.string().max(1000).optional(),
  tags: z.string().optional(), // JSON array as string
});

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Validate file content using magic bytes.
 */
function validateFileContent(buffer: Buffer, declaredMimeType: string): { valid: boolean; detectedType?: string } {
  // JPEG validation (starts with 0xFF 0xD8 0xFF)
  if (declaredMimeType === 'image/jpeg') {
    const isJpeg = buffer.length >= 3 &&
      buffer[0] === 0xFF &&
      buffer[1] === 0xD8 &&
      buffer[2] === 0xFF;
    if (!isJpeg) {
      return { valid: false };
    }
    return { valid: true, detectedType: 'image/jpeg' };
  }

  // PNG validation
  if (declaredMimeType === 'image/png') {
    const isPng = buffer.length >= 8 &&
      buffer[0] === 0x89 && buffer[1] === 0x50 && // .P
      buffer[2] === 0x4E && buffer[3] === 0x47 && // NG
      buffer[4] === 0x0D && buffer[5] === 0x0A &&
      buffer[6] === 0x1A && buffer[7] === 0x0A;
    if (!isPng) {
      return { valid: false };
    }
    return { valid: true, detectedType: 'image/png' };
  }

  // GIF validation
  if (declaredMimeType === 'image/gif') {
    const isGif = buffer.length >= 6 &&
      buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && // GIF
      buffer[3] === 0x38 && // 8
      (buffer[4] === 0x37 || buffer[4] === 0x39) && // 7 or 9
      buffer[5] === 0x61; // a
    if (!isGif) {
      return { valid: false };
    }
    return { valid: true, detectedType: 'image/gif' };
  }

  // WebP validation
  if (declaredMimeType === 'image/webp') {
    const isWebP = buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && // RI
      buffer[2] === 0x46 && buffer[3] === 0x46 && // FF
      buffer[8] === 0x57 && buffer[9] === 0x45 && // WE
      buffer[10] === 0x42 && buffer[11] === 0x50; // BP
    if (!isWebP) {
      return { valid: false };
    }
    return { valid: true, detectedType: 'image/webp' };
  }

  // PDF validation
  if (declaredMimeType === 'application/pdf') {
    const isPdf = validateFileMagicBytes(buffer, 'application/pdf');
    if (!isPdf) {
      return { valid: false };
    }
    return { valid: true, detectedType: 'application/pdf' };
  }

  // SVG validation (text-based, check for SVG tag)
  if (declaredMimeType === 'image/svg+xml') {
    const content = buffer.toString('utf-8', 0, Math.min(1000, buffer.length));
    const isSvg = content.includes('<svg') || content.includes('<?xml');
    if (!isSvg) {
      return { valid: false };
    }
    return { valid: true, detectedType: 'image/svg+xml' };
  }

  // MS Office (DOC/XLS) validation
  if (declaredMimeType === 'application/msword' || declaredMimeType === 'application/vnd.ms-excel') {
    // Check for OLE2 signature: D0 CF 11 E0 A1 B1 1A E1
    const isOle2 = buffer.length >= 8 &&
      buffer[0] === 0xD0 && buffer[1] === 0xCF &&
      buffer[2] === 0x11 && buffer[3] === 0xE0 &&
      buffer[4] === 0xA1 && buffer[5] === 0xB1 &&
      buffer[6] === 0x1A && buffer[7] === 0xE1;
    if (!isOle2) {
      return { valid: false };
    }
    return { valid: true, detectedType: declaredMimeType };
  }

  // Office Open XML (DOCX/XLSX) validation
  if (
    declaredMimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    declaredMimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    // Check for ZIP signature: 50 4B 03 04
    const isZip = buffer.length >= 4 &&
      buffer[0] === 0x50 && buffer[1] === 0x4B &&
      buffer[2] === 0x03 && buffer[3] === 0x04;
    if (!isZip) {
      return { valid: false };
    }
    return { valid: true, detectedType: declaredMimeType };
  }

  // For other documents, accept as-is
  return { valid: true, detectedType: declaredMimeType };
}

/**
 * Generate a storage key for a CMS asset.
 */
function generateStorageKey(assetId: string, extension: string): string {
  return `assets/${assetId}${extension}`;
}

/**
 * Get file extension from filename.
 */
function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) return '';
  return filename.slice(lastDot).toLowerCase();
}

/**
 * Get image dimensions from buffer (basic implementation).
 * Returns null for non-images or if detection fails.
 */
function getImageDimensions(buffer: Buffer, mimeType: string): { width: number; height: number } | null {
  try {
    if (mimeType === 'image/png') {
      // PNG dimensions are at bytes 16-24 (width) and 20-24 (height)
      if (buffer.length >= 24) {
        const width = buffer.readUInt32BE(16);
        const height = buffer.readUInt32BE(20);
        return { width, height };
      }
    }

    if (mimeType === 'image/jpeg') {
      // JPEG is more complex - need to parse markers
      let offset = 2;
      while (offset < buffer.length) {
        if (buffer[offset] !== 0xFF) break;
        const marker = buffer[offset + 1];
        
        // SOF markers (Start of Frame)
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          return { width, height };
        }
        
        // Skip to next marker
        const length = buffer.readUInt16BE(offset + 2);
        offset += 2 + length;
      }
    }

    if (mimeType === 'image/gif') {
      // GIF dimensions are at bytes 6-8 (width) and 8-10 (height)
      if (buffer.length >= 10) {
        const width = buffer.readUInt16LE(6);
        const height = buffer.readUInt16LE(8);
        return { width, height };
      }
    }

    if (mimeType === 'image/webp') {
      // WebP dimensions depend on format (VP8, VP8L, VP8X)
      if (buffer.length >= 30) {
        const chunkType = buffer.slice(12, 16).toString('ascii');
        if (chunkType === 'VP8 ') {
          const width = buffer.readUInt16LE(26) & 0x3FFF;
          const height = buffer.readUInt16LE(28) & 0x3FFF;
          return { width, height };
        }
        if (chunkType === 'VP8L') {
          const bits = buffer.readUInt32LE(21);
          const width = (bits & 0x3FFF) + 1;
          const height = ((bits >> 14) & 0x3FFF) + 1;
          return { width, height };
        }
        if (chunkType === 'VP8X') {
          const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
          const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
          return { width, height };
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to get image dimensions', { error, mimeType });
  }

  return null;
}

// =============================================================================
// Route Handler
// =============================================================================

export async function POST(request: NextRequest) {
  // Apply rate limiting
  const rateLimitResponse = await applyRateLimit(request, 'upload');
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  // Validate CSRF
  const csrfResult = validateCSRF(request);
  if (!csrfResult.valid) {
    return NextResponse.json(
      { error: 'CSRF validation failed', reason: csrfResult.reason },
      { status: 403 }
    );
  }

  // Check authentication
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Check CMS edit permission
  const hasPermission = await checkUserPermission(session.user.id, CMS_EDIT);
  if (!hasPermission) {
    logger.warn('Asset upload denied: missing permission', { userId: session.user.id });
    return NextResponse.json({ error: 'Forbidden: CMS edit permission required' }, { status: 403 });
  }

  try {
    // Parse multipart form data
    const formData = await request.formData();

    const file = formData.get('file') as File | null;
    const title = formData.get('title') as string | null;
    const altText = formData.get('altText') as string | null;
    const caption = formData.get('caption') as string | null;
    const tags = formData.get('tags') as string | null;

    // Validate required fields
    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    // Validate form data
    const validationResult = uploadSchema.safeParse({
      title: title || undefined,
      altText: altText || undefined,
      caption: caption || undefined,
      tags: tags || undefined,
    });

    if (!validationResult.success) {
      return NextResponse.json(
        { error: 'Invalid form data', details: validationResult.error.flatten() },
        { status: 400 }
      );
    }

    const validData = validationResult.data;

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File too large. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024)}MB` },
        { status: 400 }
      );
    }

    // Validate MIME type
    if (!ALLOWED_MIME_TYPES.includes(file.type as typeof ALLOWED_MIME_TYPES[number])) {
      return NextResponse.json(
        { error: `Invalid file type. Allowed types: images (JPEG, PNG, GIF, WebP, SVG) and documents (PDF, Word, Excel)` },
        { status: 400 }
      );
    }

    // Read file content
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Validate file content using magic bytes
    const contentValidation = validateFileContent(buffer, file.type);
    if (!contentValidation.valid) {
      logger.warn('Asset upload rejected: content validation failed', {
        userId: session.user.id,
        filename: file.name,
        declaredType: file.type,
      });
      return NextResponse.json(
        { error: 'File content does not match declared type' },
        { status: 400 }
      );
    }

    // Virus scan (if enabled)
    const virusScan = await virusScanner.scan(buffer);
    if (!virusScan.clean) {
      logger.warn('Asset upload rejected: virus detected', {
        userId: session.user.id,
        filename: file.name,
        message: virusScan.message,
      });
      return NextResponse.json(
        { error: 'File failed security scan' },
        { status: 400 }
      );
    }

    // Generate asset ID and storage key
    const assetId = crypto.randomUUID();
    const extension = getExtension(file.name);
    const storageKey = generateStorageKey(assetId, extension);

    // Get image dimensions if applicable
    const dimensions = getImageDimensions(buffer, contentValidation.detectedType || file.type);

    // Upload to storage
    await uploadFile(storageKey, buffer, {
      contentType: contentValidation.detectedType || file.type,
      metadata: {
        originalFilename: file.name,
        uploadedBy: session.user.id,
      },
    });

    // Parse tags if provided
    let parsedTags: string[] | undefined;
    if (validData.tags) {
      try {
        const parsed = JSON.parse(validData.tags);
        if (Array.isArray(parsed)) {
          parsedTags = parsed;
        }
      } catch {
        // Invalid JSON, ignore tags
      }
    }

    // Create database record
    const asset = await prisma.mediaAsset.create({
      data: {
        id: assetId,
        fileName: file.name,
        fileSize: file.size,
        mimeType: contentValidation.detectedType || file.type,
        storageKey,
        title: validData.title,
        altText: validData.altText,
        caption: validData.caption,
        ...(parsedTags ? { tags: JSON.stringify(parsedTags) } : {}),
        width: dimensions?.width,
        height: dimensions?.height,
        uploadedBy: session.user.id,
      },
    });

    logger.info('Asset uploaded successfully', {
      userId: session.user.id,
      assetId: asset.id,
      filename: file.name,
      size: file.size,
      mimeType: asset.mimeType,
    });

    return NextResponse.json({
      success: true,
      asset: {
        id: asset.id,
        fileName: asset.fileName,
        fileSize: asset.fileSize,
        mimeType: asset.mimeType,
        title: asset.title,
        altText: asset.altText,
        caption: asset.caption,
        tags: asset.tags,
        width: asset.width,
        height: asset.height,
        uploadedAt: asset.uploadedAt,
        url: `/api/assets/${asset.id}`,
      },
    });
  } catch (error) {
    logger.error('Asset upload failed', { error, userId: session.user.id });

    return NextResponse.json(
      { error: 'Upload failed' },
      { status: 500 }
    );
  }
}

// =============================================================================
// OPTIONS handler for CORS
// =============================================================================

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}
