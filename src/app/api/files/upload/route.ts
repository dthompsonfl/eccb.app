import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/auth/guards';
import { checkUserPermission } from '@/lib/auth/permissions';
import { uploadFile, validateFileMagicBytes } from '@/lib/services/storage';
import { applyRateLimit } from '@/lib/rate-limit';
import { validateCSRF } from '@/lib/csrf';
import { logger } from '@/lib/logger';
import { virusScanner } from '@/lib/services/virus-scanner';
import { env } from '@/lib/env';
import { z } from 'zod';

import { MUSIC_UPLOAD } from '@/lib/auth/permission-constants';
// =============================================================================
// Constants
// =============================================================================

// Allowed MIME types for music files
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
] as const;

// File extension to MIME type mapping
const _EXTENSION_MIME_MAP: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

// Maximum file size (from env, default 50MB)
const MAX_FILE_SIZE = env.MAX_FILE_SIZE;

// =============================================================================
// Validation Schemas
// =============================================================================

const uploadSchema = z.object({
  pieceId: z.string().cuid(),
  fileType: z.enum(['FULL_SCORE', 'CONDUCTOR_SCORE', 'PART', 'CONDENSED_SCORE', 'AUDIO', 'LICENSING', 'OTHER']),
  description: z.string().max(500).optional(),
  partId: z.string().cuid().optional(),
});

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Validate file content using magic bytes.
 */
function validateFileContent(buffer: Buffer, declaredMimeType: string): { valid: boolean; detectedType?: string } {
  // PDF validation
  if (declaredMimeType === 'application/pdf') {
    const isPdf = validateFileMagicBytes(buffer, 'application/pdf');
    if (!isPdf) {
      return { valid: false };
    }
    return { valid: true, detectedType: 'application/pdf' };
  }
  
  // MP3 validation (starts with ID3 or 0xFF 0xFB)
  if (declaredMimeType === 'audio/mpeg' || declaredMimeType === 'audio/mp3') {
    const isMp3 = buffer.length >= 2 && (
      (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) || // ID3
      (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0) // MP3 frame sync
    );
    if (!isMp3) {
      return { valid: false };
    }
    return { valid: true, detectedType: 'audio/mpeg' };
  }
  
  // WAV validation (RIFF header)
  if (declaredMimeType === 'audio/wav' || declaredMimeType === 'audio/x-wav') {
    const isWav = buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 && // RIFF
      buffer[8] === 0x57 && buffer[9] === 0x41 && buffer[10] === 0x56 && buffer[11] === 0x45; // WAVE
    if (!isWav) {
      return { valid: false };
    }
    return { valid: true, detectedType: 'audio/wav' };
  }
  
  // For other types, accept as-is
  return { valid: true, detectedType: declaredMimeType };
}

/**
 * Generate a storage key for a music file.
 */
function generateStorageKey(pieceId: string, fileId: string, extension: string): string {
  return `music/${pieceId}/${fileId}${extension}`;
}

/**
 * Get file extension from filename.
 */
function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) return '';
  return filename.slice(lastDot).toLowerCase();
}

// =============================================================================
// Virus Scanning (Optional)
// =============================================================================

/**
 * Scan file for viruses using ClamAV.
 * Only called if ENABLE_VIRUS_SCAN is true.
 */
async function scanForViruses(buffer: Buffer): Promise<{ clean: boolean; message?: string }> {
  return virusScanner.scan(buffer);
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

  // Check upload permission
  const hasPermission = await checkUserPermission(session.user.id, MUSIC_UPLOAD);
  if (!hasPermission) {
    logger.warn('Upload denied: missing permission', { userId: session.user.id });
    return NextResponse.json({ error: 'Forbidden: Upload permission required' }, { status: 403 });
  }

  try {
    // Parse multipart form data
    const formData = await request.formData();
    
    const file = formData.get('file') as File | null;
    const pieceId = formData.get('pieceId') as string;
    const fileType = formData.get('fileType') as string;
    const description = formData.get('description') as string | null;
    const partId = formData.get('partId') as string | null;
    
    // Validate required fields
    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }
    
    // Validate form data
    const validationResult = uploadSchema.safeParse({
      pieceId,
      fileType,
      description: description || undefined,
      partId: partId || undefined,
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
        { error: `Invalid file type. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}` },
        { status: 400 }
      );
    }
    
    // Read file content
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    // Validate file content using magic bytes
    const contentValidation = validateFileContent(buffer, file.type);
    if (!contentValidation.valid) {
      logger.warn('Upload rejected: content validation failed', {
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
    const virusScan = await scanForViruses(buffer);
    if (!virusScan.clean) {
      logger.warn('Upload rejected: virus detected', {
        userId: session.user.id,
        filename: file.name,
        message: virusScan.message,
      });
      return NextResponse.json(
        { error: 'File failed security scan' },
        { status: 400 }
      );
    }
    
    // Verify piece exists
    const piece = await prisma.musicPiece.findUnique({
      where: { id: validData.pieceId },
    });
    
    if (!piece) {
      return NextResponse.json({ error: 'Music piece not found' }, { status: 404 });
    }
    
    // Generate file ID and storage key
    const fileId = crypto.randomUUID();
    const extension = getExtension(file.name);
    const storageKey = generateStorageKey(validData.pieceId, fileId, extension);
    
    // Upload to storage
    await uploadFile(storageKey, buffer, {
      contentType: contentValidation.detectedType || file.type,
      metadata: {
        originalFilename: file.name,
        uploadedBy: session.user.id,
      },
    });
    
    // Create database record
    const musicFile = await prisma.musicFile.create({
      data: {
        id: fileId,
        pieceId: validData.pieceId,
        fileName: file.name,
        fileType: validData.fileType as any,
        fileSize: file.size,
        mimeType: contentValidation.detectedType || file.type,
        storageKey,
        description: validData.description,
        uploadedBy: session.user.id,
      },
    });
    
    // Link to part if specified
    if (validData.partId) {
      await prisma.musicPart.update({
        where: { id: validData.partId },
        data: { fileId: musicFile.id },
      });
    }
    
    logger.info('File uploaded successfully', {
      userId: session.user.id,
      fileId: musicFile.id,
      pieceId: validData.pieceId,
      filename: file.name,
      size: file.size,
    });
    
    return NextResponse.json({
      success: true,
      file: {
        id: musicFile.id,
        fileName: musicFile.fileName,
        fileType: musicFile.fileType,
        fileSize: musicFile.fileSize,
        mimeType: musicFile.mimeType,
        storageKey: musicFile.storageKey,
        uploadedAt: musicFile.uploadedAt,
      },
    });
  } catch (error) {
    logger.error('Upload failed', { error, userId: session.user.id });
    
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
