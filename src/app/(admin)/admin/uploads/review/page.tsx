'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import _Link from 'next/link';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  ExternalLink,
  FileText,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
  Play,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ConfidenceIndicator, ConfidenceWarningBanner } from '@/components/smart-upload/confidence-indicator';
import type { ParsedPartRecord, ParseStatus, SecondPassStatus, CuttingInstruction } from '@/types/smart-upload';

// =============================================================================
// Types
// =============================================================================

interface ExtractedMetadata {
  title: string;
  composer?: string;
  publisher?: string;
  instrument?: string;
  partNumber?: string;
  confidenceScore: number;
  fileType?: 'FULL_SCORE' | 'CONDUCTOR_SCORE' | 'PART' | 'CONDENSED_SCORE';
  isMultiPart?: boolean;
  parts?: Array<{
    instrument: string;
    partName: string;
  }>;
  ensembleType?: string;
  keySignature?: string;
  timeSignature?: string;
  tempo?: string;
  cuttingInstructions?: CuttingInstruction[];
  cuttingInstructionsSource?: 'ocr' | 'llm' | 'hybrid' | 'none';
  enforceOcrSplitting?: boolean;
  verificationConfidence?: number;
  corrections?: string | null;
}

interface SmartUploadSession {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  storageKey: string;
  confidenceScore: number | null;
  status: 'PROCESSING' | 'AUTO_COMMITTING' | 'AUTO_COMMITTED' | 'REQUIRES_REVIEW' | 'MANUALLY_APPROVED' | 'REJECTED' | 'FAILED' | 'PENDING_REVIEW' | 'APPROVED';
  uploadedBy: string;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  extractedMetadata: ExtractedMetadata | null;
  parsedParts: ParsedPartRecord[] | null;
  parseStatus: ParseStatus | null;
  secondPassStatus: SecondPassStatus | null;
  autoApproved: boolean;
  cuttingInstructions: CuttingInstruction[] | null;
  exceptionQueue?: {
    kind: string;
    summary: string;
    original: {
      fileName: string;
      storageKey: string;
      links: {
        previewPath: string;
        openPath: string;
        downloadPath: string;
      };
    };
    parts: Array<ParsedPartRecord & {
      links: {
        previewPath: string;
        openPath: string;
        downloadPath: string;
      };
    }>;
    provenance: {
      sourceSha256?: string | null;
      rawOcrTextAvailable?: boolean;
      ocrEngineUsed?: string | null;
      ocrTextChars?: number | null;
      llmFallbackReasons?: string[];
      strategyHistoryCount?: number;
    };
  };
}

interface Stats {
  pending: number;
  approved: number;
  rejected: number;
}

// =============================================================================
// Helper Functions
// =============================================================================

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatDate(date: Date | string): string {
  const d = new Date(date);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getParseStatusBadge(parseStatus: ParseStatus | null): React.ReactNode {
  switch (parseStatus) {
    case 'PARSED':
      return <Badge className="bg-green-100 text-green-700">Parts Split</Badge>;
    case 'PARSE_FAILED':
      return <Badge className="bg-red-100 text-red-700">Split Failed</Badge>;
    case 'PARSING':
      return <Badge className="bg-blue-100 text-blue-700 animate-pulse">Parsing...</Badge>;
    default:
      return <Badge className="bg-yellow-100 text-yellow-700">Not Parsed</Badge>;
  }
}

function getSecondPassStatusBadge(secondPassStatus: SecondPassStatus | null): React.ReactNode {
  switch (secondPassStatus) {
    case 'QUEUED':
      return (
        <Badge className="bg-blue-100 text-blue-700 animate-pulse">
          <RefreshCw className="mr-1 h-3 w-3 animate-spin" />
          2nd Pass Queued
        </Badge>
      );
    case 'IN_PROGRESS':
      return (
        <Badge className="bg-blue-100 text-blue-700 animate-pulse">
          <RefreshCw className="mr-1 h-3 w-3 animate-spin" />
          2nd Pass Running
        </Badge>
      );
    case 'COMPLETE':
      return (
        <Badge className="bg-green-100 text-green-700">
          <Check className="mr-1 h-3 w-3" />
          2nd Pass ✓
        </Badge>
      );
    case 'FAILED':
      return (
        <Badge className="bg-red-100 text-red-700">
          <X className="mr-1 h-3 w-3" />
          2nd Pass ✗
        </Badge>
      );
    default:
      return null;
  }
}

function formatExceptionKind(kind: string | undefined): string {
  switch (kind) {
    case 'parse_failure':
      return 'Parse Failure';
    case 'second_pass_failure':
      return '2nd Pass Failure';
    case 'human_review_required':
      return 'Human Review';
    case 'low_confidence':
      return 'Low Confidence';
    default:
      return 'Review Pending';
  }
}

/**
 * Sanitize display values from LLM extraction to prevent garbage text in UI.
 * Removes control characters, normalizes Unicode, truncates excessive length.
 */
function sanitizeDisplayValue(value: string | undefined | null): string {
  if (!value) return '-';
  
  // Remove control characters (except common whitespace)
  // eslint-disable-next-line no-control-regex
  let cleaned = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  
  // Normalize Unicode to prevent display issues
  cleaned = cleaned.normalize('NFKC');
  
  // Trim whitespace
  cleaned = cleaned.trim();
  
  // Truncate excessive length (likely garbage)
  if (cleaned.length > 100) {
    cleaned = cleaned.slice(0, 100) + '...';
  }
  
  // Return placeholder if empty after cleaning
  return cleaned || '-';
}

/**
 * Check if a value contains likely garbage (excessive non-alphanumeric chars).
 */
function isLikelyGarbage(value: string | undefined | null): boolean {
  if (!value || value.length < 3) return false;
  
  const alphanumericCount = (value.match(/[a-zA-Z0-9]/g) || []).length;
  const ratio = alphanumericCount / value.length;
  
  // If less than 30% alphanumeric, likely garbage
  return ratio < 0.3;
}

const _ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/**
 * Format a 0-based [start, end] page range for human display (1-based).
 * If either bound is 0 the range is treated as 0-based and +1 is applied.
 * Otherwise displayed as-is (already 1-based).
 */
function formatHumanRange(range: [number, number]): string {
  if (range[0] === 0 || range[1] === 0) {
    return `${range[0] + 1}–${range[1] + 1}`;
  }
  return `${range[0]}–${range[1]}`;
}

// =============================================================================
// Client Component
// =============================================================================

function UploadReviewClient({
  initialSessions,
  initialStats,
}: {
  initialSessions: SmartUploadSession[];
  initialStats: Stats;
}) {
  const [sessions, setSessions] = useState<SmartUploadSession[]>(initialSessions);
  const [stats, setStats] = useState<Stats>(initialStats);
  const [loading, setLoading] = useState(false);
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());
  const [editingSession, setEditingSession] = useState<SmartUploadSession | null>(null);
  const [editedMetadata, setEditedMetadata] = useState<Partial<ExtractedMetadata>>({});
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectSessionId, setRejectSessionId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [bulkRejectDialogOpen, setBulkRejectDialogOpen] = useState(false);
  const [bulkRejectReason, setBulkRejectReason] = useState('');
  // State for PDF preview images keyed by session id
  const [previewImages, setPreviewImages] = useState<Record<string, { imageBase64: string; totalPages: number; mimeType: string } | null>>({});
  const [originalPreviewLoading, setOriginalPreviewLoading] = useState(false);
  const [partPreviewLoading, setPartPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [partPreviewError, setPartPreviewError] = useState<string | null>(null);
  // Preview quality format: persisted in localStorage
  const [previewFormat, setPreviewFormat] = useState<'png' | 'jpeg'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('eccb_preview_format');
      if (saved === 'jpeg') return 'jpeg';
    }
    return 'png';
  });
  // AbortController refs for in-flight preview requests
  const originalPreviewAbortRef = useRef<AbortController | null>(null);
  const partPreviewAbortRef = useRef<AbortController | null>(null);
  // Debounce timer refs
  const originalPreviewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const partPreviewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // PDF preview pagination and zoom state
  const [currentPage, setCurrentPage] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Part preview state
  const [selectedPart, setSelectedPart] = useState<ParsedPartRecord | null>(null);
  const [partPreviewImages, setPartPreviewImages] = useState<Record<string, { imageBase64: string; totalPages: number; mimeType: string } | null>>({});
  const [partCurrentPage, setPartCurrentPage] = useState(0);
  const [partTotalPages, setPartTotalPages] = useState(0);
  const [partZoomLevel, setPartZoomLevel] = useState(1);
  const [isPartFullscreen, setIsPartFullscreen] = useState(false);
  const [triggeringSecondPass, setTriggeringSecondPass] = useState<Set<string>>(new Set());
  const [savingDraft, setSavingDraft] = useState(false);
  const [focusedSessionId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('sessionId');
  });
  const [sseConnected, setSseConnected] = useState(false);

  // Fetch sessions from API
  const fetchSessions = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (focusedSessionId) {
        params.set('sessionId', focusedSessionId);
      } else {
        params.set('status', 'REQUIRES_REVIEW');
      }

      const response = await fetch(`/api/admin/uploads/review?${params.toString()}`, {
        cache: 'no-store',
      });

      if (!response.ok) {
        return;
      }

      const data = await response.json();

      if (data.sessions) {
        setSessions(data.sessions);
        setStats(data.stats);
      } else if (data.error) {
        console.error('[REVIEW] API returned error:', data.error);
      }
    } catch {
      // no-op
    } finally {
      setLoading(false);
    }
  }, [focusedSessionId]);

  // Auto-fetch sessions when the component mounts
  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  // Fallback poll only when SSE is disconnected
  useEffect(() => {
    if (sseConnected) return;
    const POLL_INTERVAL = 15000;
    const id = setInterval(() => { void fetchSessions(); }, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [fetchSessions, sseConnected]);

  // SSE is the primary refresh path for queue/session updates
  useEffect(() => {
    const es = new EventSource('/api/admin/uploads/events');
    es.onopen = () => setSseConnected(true);
    let sseRefreshTimer: ReturnType<typeof setTimeout> | null = null;

    es.onmessage = (e) => {
      try {
        const parsed = JSON.parse(e.data as string) as { type?: string };
        if (parsed.type === 'progress' || parsed.type === 'completed' || parsed.type === 'failed') {
          if (sseRefreshTimer) clearTimeout(sseRefreshTimer);
          sseRefreshTimer = setTimeout(() => {
            void fetchSessions();
          }, 500);
        }
      } catch {
        // ignore malformed events
      }
    };

    es.onerror = () => {
      setSseConnected(false);
      es.close();
    };

    return () => {
      if (sseRefreshTimer) clearTimeout(sseRefreshTimer);
      setSseConnected(false);
      es.close();
    };
  }, [fetchSessions]);

  // Handle select all
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedSessions(new Set(sessions.map((s) => s.id)));
    } else {
      setSelectedSessions(new Set());
    }
  };

  // Handle select single
  const handleSelect = (sessionId: string, checked: boolean) => {
    const newSelected = new Set(selectedSessions);
    if (checked) {
      newSelected.add(sessionId);
    } else {
      newSelected.delete(sessionId);
    }
    setSelectedSessions(newSelected);
  };

  // Handle approve
  const handleApprove = async (session: SmartUploadSession) => {
    setLoading(true);
    try {
      const metadata = {
        ...(session.extractedMetadata || {}),
        ...editedMetadata,
      };

      const response = await fetch(`/api/admin/uploads/review/${session.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: metadata.title || session.fileName,
          composer: metadata.composer,
          publisher: metadata.publisher,
          instrument: metadata.instrument,
          partNumber: metadata.partNumber,
          ensembleType: metadata.ensembleType,
          keySignature: metadata.keySignature,
          timeSignature: metadata.timeSignature,
          tempo: metadata.tempo,
        }),
      });

      if (response.ok) {
        await fetchSessions();
        setEditingSession(null);
        setEditedMetadata({});
      }
    } catch (error) {
      console.error('Failed to approve:', error);
    } finally {
      setLoading(false);
    }
  };

  // Handle save draft
  const handleSaveDraft = async () => {
    if (!editingSession) return;
    setSavingDraft(true);
    try {
      const metadata = {
        ...(editingSession.extractedMetadata || {}),
        ...editedMetadata,
      };
      const response = await fetch(`/api/admin/uploads/review/${editingSession.id}/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata }),
      });
      if (response.ok) {
        await fetchSessions();
      }
    } catch (error) {
      console.error('Failed to save draft:', error);
    } finally {
      setSavingDraft(false);
    }
  };

  // Handle reject
  const handleReject = async () => {
    if (!rejectSessionId) return;

    setLoading(true);
    try {
      const response = await fetch(`/api/admin/uploads/review/${rejectSessionId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: rejectReason }),
      });

      if (response.ok) {
        await fetchSessions();
        setRejectDialogOpen(false);
        setRejectSessionId(null);
        setRejectReason('');
      }
    } catch (error) {
      console.error('Failed to reject:', error);
    } finally {
      setLoading(false);
    }
  };

  // Handle bulk approve
  const handleBulkApprove = async () => {
    if (selectedSessions.size === 0) return;

    setLoading(true);
    try {
      const response = await fetch('/api/admin/uploads/review/bulk-approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: Array.from(selectedSessions) }),
      });

      if (response.ok) {
        await fetchSessions();
        setSelectedSessions(new Set());
      }
    } catch (error) {
      console.error('Failed to bulk approve:', error);
    } finally {
      setLoading(false);
    }
  };

  // Handle bulk reject
  const handleBulkReject = async () => {
    if (selectedSessions.size === 0) return;

    setLoading(true);
    try {
      const response = await fetch('/api/admin/uploads/review/bulk-reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionIds: Array.from(selectedSessions),
          reason: bulkRejectReason || undefined,
        }),
      });

      if (response.ok) {
        await fetchSessions();
        setSelectedSessions(new Set());
        setBulkRejectDialogOpen(false);
        setBulkRejectReason('');
      }
    } catch (error) {
      console.error('Failed to bulk reject:', error);
    } finally {
      setLoading(false);
    }
  };

  // Handle trigger second pass
  const handleTriggerSecondPass = async (sessionId: string) => {
    setTriggeringSecondPass((prev) => new Set(prev).add(sessionId));
    try {
      const response = await fetch('/api/admin/uploads/second-pass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });

      if (response.ok) {
        await fetchSessions();
      }
    } catch (error) {
      console.error('Failed to trigger second pass:', error);
    } finally {
      setTriggeringSecondPass((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  };

  // Load PDF preview image for a session (PNG by default for lossless quality)
  const loadPreviewImage = useCallback(async (sessionId: string, page: number = 0, fmt?: 'png' | 'jpeg') => {
    // Cancel any pending debounce
    if (originalPreviewDebounceRef.current) {
      clearTimeout(originalPreviewDebounceRef.current);
    }
    // Abort any in-flight request
    if (originalPreviewAbortRef.current) {
      originalPreviewAbortRef.current.abort();
    }

    const format = fmt ?? previewFormat;
    const qualityParam = format === 'jpeg' ? '&quality=92' : '';

    originalPreviewDebounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      originalPreviewAbortRef.current = controller;
      setOriginalPreviewLoading(true);
      setPreviewError(null);
      try {
        const res = await fetch(
          `/api/admin/uploads/review/${sessionId}/preview?page=${page}&scale=3&maxWidth=2000&format=${format}${qualityParam}`,
          { signal: controller.signal }
        );
        if (res.ok) {
          const data = await res.json() as { imageBase64?: string; totalPages?: number; mimeType?: string };
          setPreviewImages((prev) => ({
            ...prev,
            [sessionId]: data.imageBase64 && data.totalPages
              ? { imageBase64: data.imageBase64, totalPages: data.totalPages, mimeType: data.mimeType ?? 'image/png' }
              : null,
          }));
          if (data.totalPages) {
            setTotalPages(data.totalPages);
          }
        } else {
          setPreviewImages((prev) => ({ ...prev, [sessionId]: null }));
          setPreviewError(`Preview failed (HTTP ${res.status})`);
        }
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        setPreviewImages((prev) => ({ ...prev, [sessionId]: null }));
        setPreviewError('Preview fetch failed');
      } finally {
        setOriginalPreviewLoading(false);
      }
    }, 150);
  }, [previewFormat]);

  // Load part preview image (PNG by default for lossless quality)
  const loadPartPreviewImage = useCallback(async (
    sessionId: string,
    partStorageKey: string,
    page: number = 0,
    fmt?: 'png' | 'jpeg'
  ) => {
    // Cancel any pending debounce
    if (partPreviewDebounceRef.current) {
      clearTimeout(partPreviewDebounceRef.current);
    }
    // Abort any in-flight request
    if (partPreviewAbortRef.current) {
      partPreviewAbortRef.current.abort();
    }

    const format = fmt ?? previewFormat;
    const qualityParam = format === 'jpeg' ? '&quality=92' : '';

    partPreviewDebounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      partPreviewAbortRef.current = controller;
      setPartPreviewLoading(true);
      setPartPreviewError(null);
      try {
        const encodedKey = encodeURIComponent(partStorageKey);
        const res = await fetch(
          `/api/admin/uploads/review/${sessionId}/part-preview?partStorageKey=${encodedKey}&page=${page}&scale=3&maxWidth=2000&format=${format}${qualityParam}`,
          { signal: controller.signal }
        );
        if (res.ok) {
          const data = await res.json() as { imageBase64?: string; totalPages?: number; mimeType?: string };
          setPartPreviewImages((prev) => ({
            ...prev,
            [partStorageKey]: data.imageBase64 && data.totalPages
              ? { imageBase64: data.imageBase64, totalPages: data.totalPages, mimeType: data.mimeType ?? 'image/png' }
              : null,
          }));
          if (data.totalPages) {
            setPartTotalPages(data.totalPages);
          }
        } else {
          setPartPreviewImages((prev) => ({ ...prev, [partStorageKey]: null }));
          setPartPreviewError(`Preview failed (HTTP ${res.status})`);
        }
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        setPartPreviewImages((prev) => ({ ...prev, [partStorageKey]: null }));
        setPartPreviewError('Preview fetch failed');
      } finally {
        setPartPreviewLoading(false);
      }
    }, 150);
  }, [previewFormat]);

  // Open edit dialog
  const openEditDialog = (session: SmartUploadSession) => {
    setEditingSession(session);
    setEditedMetadata(session.extractedMetadata || {});
    setSelectedPart(null);
    setCurrentPage(0);
    setTotalPages(0);
    setZoomLevel(1);
    setIsFullscreen(false);
    setPartCurrentPage(0);
    setPartTotalPages(0);
    setPartZoomLevel(1);
    setIsPartFullscreen(false);
    // Reset error states
    setPreviewError(null);
    setPartPreviewError(null);
    // Kick off preview image load asynchronously
    loadPreviewImage(session.id, 0);
  };

  // Close edit dialog
  const closeEditDialog = () => {
    setEditingSession(null);
    setEditedMetadata({});
    setSelectedPart(null);
  };

  // Open reject dialog
  const openRejectDialog = (sessionId: string) => {
    setRejectSessionId(sessionId);
    setRejectDialogOpen(true);
  };

  // Handle page change for original PDF
  const handlePageChange = (newPage: number) => {
    if (editingSession && newPage >= 0 && newPage < totalPages) {
      setCurrentPage(newPage);
      loadPreviewImage(editingSession.id, newPage);
    }
  };

  // Handle format toggle — saves to localStorage and re-fetches the active preview
  const handleFormatChange = (fmt: 'png' | 'jpeg') => {
    setPreviewFormat(fmt);
    if (typeof window !== 'undefined') {
      localStorage.setItem('eccb_preview_format', fmt);
    }
    if (editingSession) {
      loadPreviewImage(editingSession.id, currentPage, fmt);
    }
  };

  // Handle zoom change — CSS transform only, no server re-fetch
  const handleZoomChange = (newZoom: number) => {
    if (newZoom >= 0.5 && newZoom <= 3) {
      setZoomLevel(newZoom);
    }
  };

  // Handle part selection
  const handlePartSelect = (part: ParsedPartRecord) => {
    setSelectedPart(part);
    setPartCurrentPage(0);
    setPartZoomLevel(1);
    if (editingSession) {
      loadPartPreviewImage(editingSession.id, part.storageKey, 0);
    }
  };

  // Handle part page change
  const handlePartPageChange = (newPage: number) => {
    if (selectedPart && newPage >= 0 && newPage < partTotalPages) {
      setPartCurrentPage(newPage);
      if (editingSession) {
        loadPartPreviewImage(editingSession.id, selectedPart.storageKey, newPage);
      }
    }
  };

  // Handle part zoom change — CSS transform only, no server re-fetch
  const handlePartZoomChange = (newZoom: number) => {
    if (newZoom >= 0.5 && newZoom <= 3) {
      setPartZoomLevel(newZoom);
    }
  };

  const canTriggerSecondPass = (session: SmartUploadSession) => {
    return (
      session.secondPassStatus === null ||
      session.secondPassStatus === 'NOT_NEEDED' ||
      session.secondPassStatus === 'FAILED' ||
      session.secondPassStatus === 'COMPLETE'
    );
  };

  const currentEditedTitle = (editedMetadata.title || '').trim();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Smart Upload Review</h1>
          <p className="text-muted-foreground">
            Review and approve AI-extracted metadata from uploaded music files.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={fetchSessions}
            disabled={loading}
          >
            <RefreshCw className={cn('mr-2 h-4 w-4', loading && 'animate-spin')} />
            Refresh
          </Button>
          {selectedSessions.size > 0 && (
            <>
              <Button
                variant="default"
                onClick={handleBulkApprove}
                disabled={loading}
                className="bg-primary hover:bg-primary/90"
              >
                <Check className="mr-2 h-4 w-4" />
                Approve Selected ({selectedSessions.size})
              </Button>
              <Button
                variant="outline"
                onClick={() => setBulkRejectDialogOpen(true)}
                disabled={loading}
                className="text-red-500 hover:text-red-600 hover:bg-red-50"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Reject Selected ({selectedSessions.size})
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Clock className="h-4 w-4 text-yellow-500" />
              Pending Review
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.pending}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Check className="h-4 w-4 text-green-500" />
              Approved
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.approved}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <X className="h-4 w-4 text-red-500" />
              Rejected
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.rejected}</div>
          </CardContent>
        </Card>
      </div>

      {/* Sessions Table */}
      <Card>
        <CardHeader>
          <CardTitle>{focusedSessionId ? 'Focused Upload Session' : 'Pending Uploads'}</CardTitle>
          <CardDescription>
            {focusedSessionId
              ? 'Review the upload session opened from Smart Upload. Refresh to see processing updates.'
              : 'Review extracted metadata and approve or reject uploads.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <div className="text-center py-12">
              <FileText className="mx-auto h-12 w-12 text-muted-foreground" />
              <h3 className="mt-4 text-lg font-semibold">No pending uploads</h3>
              <p className="text-muted-foreground">
                All uploads have been reviewed or there are no uploads yet.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[50px]">
                    <Checkbox
                      checked={selectedSessions.size === sessions.length && sessions.length > 0}
                      onCheckedChange={handleSelectAll}
                    />
                  </TableHead>
                  <TableHead>File</TableHead>
                  <TableHead>Extracted Metadata</TableHead>
                  <TableHead>Confidence</TableHead>
                  <TableHead>Processing Status</TableHead>
                  <TableHead>Uploaded</TableHead>
                  <TableHead className="w-[200px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell>
                      <Checkbox
                        checked={selectedSessions.has(session.id)}
                        onCheckedChange={(checked) =>
                          handleSelect(session.id, checked as boolean)
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <div>
                          <div className="font-medium">{session.fileName}</div>
                          <div className="text-xs text-muted-foreground">
                            {formatFileSize(session.fileSize)}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>
                        <div className="font-medium">
                          {session.extractedMetadata?.title || 'Untitled'}
                        </div>
                        {session.extractedMetadata?.composer && (
                          <div className="text-sm text-muted-foreground">
                            {session.extractedMetadata.composer}
                          </div>
                        )}
                        {session.extractedMetadata?.instrument && (
                          <div className="text-xs text-muted-foreground">
                            {session.extractedMetadata.instrument}
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <ConfidenceIndicator
                        score={session.confidenceScore}
                        threshold={70}
                        autoApproveThreshold={90}
                        showIcon={true}
                      />
                    </TableCell>
                     <TableCell>
                       <div className="flex flex-col gap-1">
                          {getParseStatusBadge(session.parseStatus)}
                          {getSecondPassStatusBadge(session.secondPassStatus)}
                          {session.exceptionQueue && (
                            <Badge className="bg-slate-100 text-slate-700 text-xs">
                              {formatExceptionKind(session.exceptionQueue.kind)}
                            </Badge>
                          )}
                          {session.autoApproved && (
                            <Badge className="bg-green-50 text-green-600 text-xs">
                              <Check className="mr-1 h-3 w-3" />
                              Auto ✓
                            </Badge>
                          )}
                          {session.exceptionQueue?.summary && (
                            <p className="max-w-xs text-xs text-muted-foreground">
                              {session.exceptionQueue.summary}
                            </p>
                          )}
                        </div>
                      </TableCell>
                    <TableCell>
                      <div className="text-sm text-muted-foreground">
                        {formatDate(session.createdAt)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openEditDialog(session)}
                        >
                          <FileText className="mr-1 h-3 w-3" />
                          Review
                        </Button>
                        {canTriggerSecondPass(session) && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleTriggerSecondPass(session.id)}
                            disabled={triggeringSecondPass.has(session.id)}
                            className="text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                          >
                            {triggeringSecondPass.has(session.id) ? (
                              <RefreshCw className="h-3 w-3 animate-spin" />
                            ) : (
                              <Play className="h-3 w-3" />
                            )}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openRejectDialog(session.id)}
                          className="text-red-500 hover:text-red-600 hover:bg-red-50"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Edit/Approve Dialog */}
      <Dialog open={!!editingSession} onOpenChange={(open) => !open && closeEditDialog()}>
        <DialogContent className={cn('max-w-4xl max-h-[90vh] flex flex-col', isFullscreen && 'max-w-none h-screen m-0 rounded-none')}>
          <DialogHeader className="shrink-0">
            <DialogTitle>Review Extracted Metadata</DialogTitle>
            <DialogDescription>
              Verify and edit the extracted metadata before approving.
            </DialogDescription>
          </DialogHeader>

          {editingSession && (
            <div className="space-y-6 flex-1 overflow-y-auto pr-1">
              {/* File Info */}
              <div className="bg-muted p-4 rounded-lg">
                <div className="flex items-center gap-2 mb-2">
                  <FileText className="h-5 w-5 text-muted-foreground" />
                  <span className="font-medium">{editingSession.fileName}</span>
                </div>
                <div className="text-sm text-muted-foreground">
                  Size: {formatFileSize(editingSession.fileSize)} | Uploaded:{' '}
                  {formatDate(editingSession.createdAt)}
                </div>
              </div>

              {/* PDF Preview with Tabs */}
              <Tabs defaultValue="original" className="w-full">
                <TabsList>
                  <TabsTrigger value="original">Original PDF</TabsTrigger>
                  {editingSession.parsedParts && editingSession.parsedParts.length > 0 && (
                    <TabsTrigger value="parts">
                      Parts Preview ({editingSession.parsedParts.length})
                    </TabsTrigger>
                  )}
                </TabsList>

                {/* Original PDF Tab */}
                <TabsContent value="original" className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-semibold">PDF Preview</h4>
                    <div className="flex items-center gap-2">
                      {editingSession.exceptionQueue?.original && (
                        <>
                          <Button variant="outline" size="sm" asChild>
                            <a href={editingSession.exceptionQueue.original.links.openPath} target="_blank" rel="noreferrer">
                              <ExternalLink className="mr-1 h-4 w-4" />
                              Open Original
                            </a>
                          </Button>
                          <Button variant="outline" size="sm" asChild>
                            <a href={editingSession.exceptionQueue.original.links.downloadPath}>
                              <Download className="mr-1 h-4 w-4" />
                              Download Original
                            </a>
                          </Button>
                        </>
                      )}
                      {/* Page Navigation */}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handlePageChange(currentPage - 1)}
                        disabled={currentPage === 0 || totalPages === 0}
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      <span className="text-sm">
                        Page {totalPages > 0 ? currentPage + 1 : 0} / {totalPages}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handlePageChange(currentPage + 1)}
                        disabled={currentPage >= totalPages - 1 || totalPages === 0}
                      >
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                      {/* Zoom Controls */}
                      <div className="flex items-center gap-1 ml-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleZoomChange(zoomLevel - 0.25)}
                          disabled={zoomLevel <= 0.5}
                        >
                          <Minus className="h-4 w-4" />
                        </Button>
                        <span className="text-sm w-12 text-center">{zoomLevel}×</span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleZoomChange(zoomLevel + 0.25)}
                          disabled={zoomLevel >= 3}
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                      </div>
                      {/* Format Toggle */}
                      <div className="flex items-center gap-1 ml-2 rounded-md border overflow-hidden">
                        <button
                          className={cn('px-2 py-1 text-xs font-mono', previewFormat === 'png' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:bg-muted')}
                          onClick={() => handleFormatChange('png')}
                        >PNG</button>
                        <button
                          className={cn('px-2 py-1 text-xs font-mono', previewFormat === 'jpeg' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:bg-muted')}
                          onClick={() => handleFormatChange('jpeg')}
                        >JPEG</button>
                      </div>
                      {/* Fullscreen Toggle */}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setIsFullscreen(!isFullscreen)}
                        className="ml-2"
                      >
                        {isFullscreen ? (
                          <Minimize2 className="h-4 w-4" />
                        ) : (
                          <Maximize2 className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                  {originalPreviewLoading || previewImages[editingSession.id] === undefined ? (
                    <div className="w-full h-64 bg-muted rounded-lg flex items-center justify-center">
                      <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : previewImages[editingSession.id] ? (
                    <div
                      className={cn(
                        'overflow-auto bg-gray-100 rounded-lg',
                        isFullscreen ? 'h-[calc(100vh-300px)]' : 'h-64'
                      )}
                    >
                      <img
                        src={`data:${previewImages[editingSession.id]?.mimeType ?? 'image/png'};base64,${previewImages[editingSession.id]?.imageBase64}`}
                        alt={`PDF page ${currentPage + 1}`}
                        className="max-w-none block"
                        style={{ transform: `scale(${zoomLevel})`, transformOrigin: 'top left' }}
                      />
                    </div>
                  ) : (
                    <div className="w-full h-20 bg-muted rounded-lg flex flex-col items-center justify-center gap-2 border border-dashed">
                      {previewError && <span className="text-xs text-red-500">{previewError}</span>}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => editingSession && loadPreviewImage(editingSession.id, currentPage)}
                      >
                        Retry
                      </Button>
                    </div>
                  )}
                </TabsContent>

                {/* Parts Preview Tab */}
                {editingSession.parsedParts && editingSession.parsedParts.length > 0 && (
                  <TabsContent value="parts" className="space-y-2">
                    {/* Parts Grid */}
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 mb-4">
                      {editingSession.parsedParts.map((part, index) => (
                        <Button
                          key={index}
                          variant={selectedPart === part ? 'default' : 'outline'}
                          size="sm"
                          onClick={() => handlePartSelect(part)}
                          className="h-auto py-2 flex flex-col items-start"
                        >
                          <span className="font-medium text-xs" title={isLikelyGarbage(part.partName) ? 'This value appears corrupted' : undefined}>
                            {sanitizeDisplayValue(part.partName)}
                            {isLikelyGarbage(part.partName) && (
                              <span className="ml-1 text-amber-500">⚠️</span>
                            )}
                          </span>
                          <span className="text-xs opacity-70">{sanitizeDisplayValue(part.instrument)}</span>
                          <span className="text-xs opacity-50">
                            {formatHumanRange(part.pageRange as [number, number])} ({part.pageCount} pages)
                          </span>
                        </Button>
                      ))}
                    </div>

                    {/* Selected Part Preview */}
                    {selectedPart && (
                      <>
                        <div className="flex items-center justify-between">
                          <h4 className="text-sm font-semibold">
                            Part: {selectedPart.partName} ({selectedPart.instrument})
                          </h4>
                          <div className="flex items-center gap-2">
                            {editingSession.exceptionQueue?.parts && (
                              (() => {
                                const selectedPartLinks = editingSession.exceptionQueue?.parts.find(
                                  (part) => part.storageKey === selectedPart.storageKey
                                )?.links;
                                return selectedPartLinks ? (
                                  <>
                                    <Button variant="outline" size="sm" asChild>
                                      <a href={selectedPartLinks.openPath} target="_blank" rel="noreferrer">
                                        <ExternalLink className="mr-1 h-4 w-4" />
                                        Open Part
                                      </a>
                                    </Button>
                                    <Button variant="outline" size="sm" asChild>
                                      <a href={selectedPartLinks.downloadPath}>
                                        <Download className="mr-1 h-4 w-4" />
                                        Download Part
                                      </a>
                                    </Button>
                                  </>
                                ) : null;
                              })()
                            )}
                            {/* Page Navigation */}
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handlePartPageChange(partCurrentPage - 1)}
                              disabled={partCurrentPage === 0 || partTotalPages === 0}
                            >
                              <ChevronLeft className="h-4 w-4" />
                            </Button>
                            <span className="text-sm">
                              Page {partTotalPages > 0 ? partCurrentPage + 1 : 0} / {partTotalPages}
                            </span>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handlePartPageChange(partCurrentPage + 1)}
                              disabled={partCurrentPage >= partTotalPages - 1 || partTotalPages === 0}
                            >
                              <ChevronRight className="h-4 w-4" />
                            </Button>
                            {/* Zoom Controls */}
                            <div className="flex items-center gap-1 ml-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handlePartZoomChange(partZoomLevel - 0.25)}
                                disabled={partZoomLevel <= 0.5}
                              >
                                <Minus className="h-4 w-4" />
                              </Button>
                              <span className="text-sm w-12 text-center">{partZoomLevel}×</span>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handlePartZoomChange(partZoomLevel + 0.25)}
                                disabled={partZoomLevel >= 3}
                              >
                                <Plus className="h-4 w-4" />
                              </Button>
                            </div>
                            {/* Fullscreen Toggle */}
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setIsPartFullscreen(!isPartFullscreen)}
                              className="ml-2"
                            >
                              {isPartFullscreen ? (
                                <Minimize2 className="h-4 w-4" />
                              ) : (
                                <Maximize2 className="h-4 w-4" />
                              )}
                            </Button>
                          </div>
                        </div>
                        {partPreviewLoading || partPreviewImages[selectedPart.storageKey] === undefined ? (
                          <div className="w-full h-64 bg-muted rounded-lg flex items-center justify-center">
                            <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
                          </div>
                        ) : partPreviewImages[selectedPart.storageKey] ? (
                          <div
                            className={cn(
                              'overflow-auto bg-gray-100 rounded-lg',
                              isPartFullscreen ? 'h-[calc(100vh-400px)]' : 'h-64'
                            )}
                          >
                            <img
                              src={`data:${partPreviewImages[selectedPart.storageKey]?.mimeType ?? 'image/png'};base64,${partPreviewImages[selectedPart.storageKey]?.imageBase64}`}
                              alt={`Part ${selectedPart.partName} page ${partCurrentPage + 1}`}
                              className="max-w-none block"
                              style={{ transform: `scale(${partZoomLevel})`, transformOrigin: 'top left' }}
                            />
                          </div>
                        ) : (
                          <div className="w-full h-20 bg-muted rounded-lg flex flex-col items-center justify-center gap-2 border border-dashed">
                            {partPreviewError && <span className="text-xs text-red-500">{partPreviewError}</span>}
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => editingSession && selectedPart && loadPartPreviewImage(editingSession.id, selectedPart.storageKey, partCurrentPage)}
                            >
                              Retry
                            </Button>
                          </div>
                        )}
                      </>
                    )}
                  </TabsContent>
                )}
              </Tabs>

              {/* Confidence Score with Warning */}
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-4">
                  <span className="text-sm font-medium">Confidence Score:</span>
                  <ConfidenceIndicator
                    score={editingSession.confidenceScore}
                    threshold={70}
                    autoApproveThreshold={90}
                    showIcon={true}
                    detailed={true}
                  />
                  <span className="text-xs text-muted-foreground">
                    Enforce OCR splitting:
                    {' '}
                    {editingSession.extractedMetadata?.enforceOcrSplitting ? 'Yes' : 'No'}
                  </span>
                </div>
                {editingSession.confidenceScore !== null && editingSession.confidenceScore < 70 && (
                  <ConfidenceWarningBanner
                    score={editingSession.confidenceScore}
                    threshold={70}
                    provenance={editingSession.exceptionQueue?.provenance}
                  />
                )}
              </div>

              {editingSession.exceptionQueue && (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-lg border bg-muted/30 p-4">
                    <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                      <AlertCircle className="h-4 w-4 text-amber-600" />
                      Exception Queue
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {editingSession.exceptionQueue.summary}
                    </p>
                    <div className="mt-3 text-xs text-muted-foreground">
                      Type: {formatExceptionKind(editingSession.exceptionQueue.kind)}
                    </div>
                  </div>
                  <div className="rounded-lg border bg-muted/30 p-4">
                    <div className="mb-2 text-sm font-medium">Provenance</div>
                    <div className="space-y-1 text-xs text-muted-foreground">
                      <div>OCR engine: {editingSession.exceptionQueue.provenance.ocrEngineUsed || 'none recorded'}</div>
                      <div>OCR chars: {editingSession.exceptionQueue.provenance.ocrTextChars ?? 0}</div>
                      <div>Raw OCR text: {editingSession.exceptionQueue.provenance.rawOcrTextAvailable ? 'available' : 'not stored'}</div>
                      <div>
                        Split source:{' '}
                        {editingSession.extractedMetadata?.cuttingInstructionsSource ?? 'unknown'}
                      </div>
                      <div>Strategy attempts: {editingSession.exceptionQueue.provenance.strategyHistoryCount ?? 0}</div>
                      {editingSession.exceptionQueue.provenance.llmFallbackReasons && editingSession.exceptionQueue.provenance.llmFallbackReasons.length > 0 && (
                        <div>
                          LLM fallback: {editingSession.exceptionQueue.provenance.llmFallbackReasons.join('; ')}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Gap Warning */}
              {editingSession.cuttingInstructions?.some(inst => (inst.partNumber ?? 0) >= 9900) && (
                <div className="flex items-start gap-3 rounded-md border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-800">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-yellow-600" />
                  <div>
                    <p className="font-medium">Uncovered page gaps detected</p>
                    <p className="text-xs mt-0.5">
                      The following page ranges were not assigned to any part:
                      {' '}
                      {editingSession.cuttingInstructions
                        .filter(inst => (inst.partNumber ?? 0) >= 9900)
                        .map(inst => `pages ${formatHumanRange(inst.pageRange as [number, number])}`)
                        .join(', ')}
                      . Review the cutting instructions or re-run AI analysis.
                    </p>
                  </div>
                </div>
              )}

              {/* Metadata Form */}
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="title">Title *</Label>
                  <Input
                    id="title"
                    value={editedMetadata.title || ''}
                    onChange={(e) =>
                      setEditedMetadata({ ...editedMetadata, title: e.target.value })
                    }
                    placeholder="Enter title"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="composer">Composer</Label>
                  <Input
                    id="composer"
                    value={editedMetadata.composer || ''}
                    onChange={(e) =>
                      setEditedMetadata({ ...editedMetadata, composer: e.target.value })
                    }
                    placeholder="Enter composer name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="publisher">Publisher</Label>
                  <Input
                    id="publisher"
                    value={editedMetadata.publisher || ''}
                    onChange={(e) =>
                      setEditedMetadata({ ...editedMetadata, publisher: e.target.value })
                    }
                    placeholder="Enter publisher name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="instrument">Instrument</Label>
                  <Input
                    id="instrument"
                    value={editedMetadata.instrument || ''}
                    onChange={(e) =>
                      setEditedMetadata({ ...editedMetadata, instrument: e.target.value })
                    }
                    placeholder="Enter instrument/ensemble"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="partNumber">Part Number</Label>
                  <Input
                    id="partNumber"
                    value={editedMetadata.partNumber || ''}
                    onChange={(e) =>
                      setEditedMetadata({ ...editedMetadata, partNumber: e.target.value })
                    }
                    placeholder="Enter part number"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="fileType">File Type</Label>
                  <Input
                    id="fileType"
                    value={editedMetadata.fileType || ''}
                    onChange={(e) =>
                      setEditedMetadata({
                        ...editedMetadata,
                        fileType: e.target.value as ExtractedMetadata['fileType'],
                      })
                    }
                    placeholder="e.g., FULL_SCORE, PART"
                    disabled
                  />
                </div>
              </div>

              {/* New Metadata Fields */}
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="ensembleType">Ensemble Type</Label>
                  <Input
                    id="ensembleType"
                    value={editedMetadata.ensembleType || ''}
                    onChange={(e) =>
                      setEditedMetadata({ ...editedMetadata, ensembleType: e.target.value })
                    }
                    placeholder="e.g., Concert Band, Jazz Band"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="keySignature">Key Signature</Label>
                  <Input
                    id="keySignature"
                    value={editedMetadata.keySignature || ''}
                    onChange={(e) =>
                      setEditedMetadata({ ...editedMetadata, keySignature: e.target.value })
                    }
                    placeholder="e.g., C Major, Bb Major"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="timeSignature">Time Signature</Label>
                  <Input
                    id="timeSignature"
                    value={editedMetadata.timeSignature || ''}
                    onChange={(e) =>
                      setEditedMetadata({ ...editedMetadata, timeSignature: e.target.value })
                    }
                    placeholder="e.g., 4/4, 3/4"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tempo">Tempo</Label>
                  <Input
                    id="tempo"
                    value={editedMetadata.tempo || ''}
                    onChange={(e) =>
                      setEditedMetadata({ ...editedMetadata, tempo: e.target.value })
                    }
                    placeholder="e.g., 120 BPM, Andante"
                  />
                </div>
              </div>

              {/* Multi-part info */}
              {editingSession.extractedMetadata?.isMultiPart &&
                editingSession.extractedMetadata.parts && (
                  <div className="space-y-2">
                    <Label>Parts Detected</Label>
                    <div className="bg-muted p-3 rounded-lg max-h-56 overflow-y-auto">
                      {editingSession.extractedMetadata.parts.map((part, index) => (
                        <div key={index} className="text-sm">
                          <span className="font-medium">{sanitizeDisplayValue(part.instrument)}</span>
                          {part.partName && <span> - {sanitizeDisplayValue(part.partName)}</span>}
                          {isLikelyGarbage(part.partName || '') && (
                            <span className="ml-1 text-amber-500 text-xs">⚠️</span>
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="space-y-2">
                      <Label>ParsedParts</Label>
                      {editingSession.parsedParts && editingSession.parsedParts.length > 0 ? (
                        <div className="overflow-x-auto">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Part Name</TableHead>
                                <TableHead>Instrument</TableHead>
                                <TableHead>Section</TableHead>
                                <TableHead>Transposition</TableHead>
                                <TableHead>Pages</TableHead>
                                <TableHead>Page Range</TableHead>
                                <TableHead>Size</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {editingSession.parsedParts.map((part, index) => (
                                <TableRow key={index}>
                                  <TableCell>
                                    {sanitizeDisplayValue(part.partName)}
                                    {isLikelyGarbage(part.partName) && (
                                      <span className="ml-1 text-amber-500">⚠️</span>
                                    )}
                                  </TableCell>
                                  <TableCell>{sanitizeDisplayValue(part.instrument)}</TableCell>
                                  <TableCell>{part.section}</TableCell>
                                  <TableCell>{part.transposition || '-'}</TableCell>
                                  <TableCell>{part.pageCount}</TableCell>
                                  <TableCell>
                                    {part.pageRange[0]} - {part.pageRange[1]}
                                  </TableCell>
                                  <TableCell>{formatFileSize(part.fileSize)}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      ) : (
                        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                          <div className="flex items-start gap-2">
                            <AlertCircle className="inline h-4 w-4 text-yellow-600 mt-0.5" />
                            <div>
                              <p className="text-sm font-medium text-yellow-800">
                                No parts were automatically split from this PDF.
                              </p>
                              <p className="text-sm text-yellow-700 mt-1">
                                On approval, the original PDF will be stored as a single file. You can
                                manually trigger splitting after running the second-pass analysis.
                              </p>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

              {/* Parsed Parts Section — only shown when NOT inside the isMultiPart block above */}
              {!(editingSession.extractedMetadata?.isMultiPart && editingSession.extractedMetadata.parts) && (
                <div className="space-y-2">
                  <Label>Parsed Parts</Label>
                  {editingSession.parsedParts && editingSession.parsedParts.length > 0 ? (
                    <div className="overflow-x-auto max-h-64 overflow-y-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Part Name</TableHead>
                            <TableHead>Instrument</TableHead>
                            <TableHead>Section</TableHead>
                            <TableHead>Transposition</TableHead>
                            <TableHead>Pages</TableHead>
                            <TableHead>Page Range</TableHead>
                            <TableHead>Size</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {editingSession.parsedParts.map((part, index) => (
                            <TableRow key={index}>
                              <TableCell>
                                {sanitizeDisplayValue(part.partName)}
                                {isLikelyGarbage(part.partName) && (
                                  <span className="ml-1 text-amber-500">⚠️</span>
                                )}
                              </TableCell>
                              <TableCell>{sanitizeDisplayValue(part.instrument)}</TableCell>
                              <TableCell>{part.section}</TableCell>
                              <TableCell>{part.transposition || '-'}</TableCell>
                              <TableCell>{part.pageCount}</TableCell>
                              <TableCell>
                                {part.pageRange[0]} - {part.pageRange[1]}
                              </TableCell>
                              <TableCell>{formatFileSize(part.fileSize)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ) : (
                    <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                      <div className="flex items-start gap-2">
                        <AlertCircle className="h-5 w-5 text-yellow-600 mt-0.5" />
                        <div>
                          <p className="text-sm font-medium text-yellow-800">
                            No parts were automatically split from this PDF.
                          </p>
                          <p className="text-sm text-yellow-700 mt-1">
                            On approval, the original PDF will be stored as a single file. You can
                            manually trigger splitting after running the second-pass analysis.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <DialogFooter className="shrink-0">
            <div className="flex items-center gap-2 mr-auto">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (editingSession) {
                    window.open(
                      `/api/admin/uploads/review/${editingSession.id}/original`,
                      '_blank',
                      'noopener,noreferrer'
                    );
                  }
                }}
              >
                <ExternalLink className="mr-2 h-4 w-4" />
                Open PDF
              </Button>
              <Button
                variant="outline"
                size="sm"
                asChild
              >
                <a
                  href={editingSession ? `/api/admin/uploads/review/${editingSession.id}/original?disposition=attachment` : '#'}
                  download
                >
                  <Download className="mr-2 h-4 w-4" />
                  Download
                </a>
              </Button>
            </div>
            <Button
              variant="outline"
              onClick={handleSaveDraft}
              disabled={savingDraft}
            >
              <Save className="mr-2 h-4 w-4" />
              {savingDraft ? 'Saving...' : 'Save Draft'}
            </Button>
            <Button variant="outline" onClick={closeEditDialog}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (editingSession) {
                  openRejectDialog(editingSession.id);
                  closeEditDialog();
                }
              }}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Reject
            </Button>
            <Button
              onClick={() => editingSession && handleApprove(editingSession)}
              disabled={!currentEditedTitle}
              className="bg-primary hover:bg-primary/90"
            >
              <Check className="mr-2 h-4 w-4" />
              Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject Confirmation Dialog */}
      <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Upload</DialogTitle>
            <DialogDescription>
              Are you sure you want to reject this upload? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="rejectReason">Reason (optional)</Label>
            <Input
              id="rejectReason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Enter reason for rejection"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleReject} disabled={loading}>
              <Trash2 className="mr-2 h-4 w-4" />
              Reject Upload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Reject Confirmation Dialog */}
      <Dialog open={bulkRejectDialogOpen} onOpenChange={setBulkRejectDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject {selectedSessions.size} Upload(s)</DialogTitle>
            <DialogDescription>
              Are you sure you want to reject {selectedSessions.size} selected upload(s)? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="bulkRejectReason">Reason (optional)</Label>
            <Input
              id="bulkRejectReason"
              value={bulkRejectReason}
              onChange={(e) => setBulkRejectReason(e.target.value)}
              placeholder="Enter reason for rejection (applies to all selected)"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkRejectDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleBulkReject} disabled={loading}>
              <Trash2 className="mr-2 h-4 w-4" />
              Reject {selectedSessions.size} Upload(s)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// =============================================================================
// Server Component (Page)
// =============================================================================

// Note: This page uses client-side fetching for sessions to ensure
// proper authentication state. The initial data is empty and the
// client fetches from the API on mount.

export default function UploadReviewPage() {
  return (
    <UploadReviewClient initialSessions={[]} initialStats={{ pending: 0, approved: 0, rejected: 0 }} />
  );
}
