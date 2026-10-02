'use client';

import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useStandStore } from '@/store/standStore';
import { StandCanvas } from './StandCanvas';
import { Toolbar } from './Toolbar';
import { GestureHandler } from './GestureHandler';
import { KeyboardHandler } from './KeyboardHandler';
import { MidiHandler } from './MidiHandler';
import { BluetoothHandler } from './BluetoothHandler';
import { Metronome } from './Metronome';
import { Tuner } from './Tuner';
import { AudioPlayer } from './AudioPlayer';
import { PitchPipe } from './PitchPipe';

interface LibraryFile {
  id: string;
  storageKey: string;
  storageUrl: string | null;
  pageCount: number;
  partLabel: string | null;
  instrumentName: string | null;
}

interface LibraryPart {
  id: string;
  partName: string;
  instrumentId: string;
  instrumentName: string;
  storageKey: string | null;
  pageCount: number | null;
}

interface LibraryPiece {
  id: string;
  title: string;
  composer: string | null;
  files: LibraryFile[];
  parts: LibraryPart[];
}

interface LibraryStandViewerProps {
  piece: LibraryPiece;
  userId: string;
  /** Storage keys whose backing files could not be found in storage. */
  missingStorageKeys?: string[];
}

/**
 * Full-featured stand viewer for library / practice mode.
 * Hydrates the Zustand stand store with the library piece so that all
 * annotation tools, rehearsal utilities, keyboard/gesture/MIDI handlers,
 * and PDF rendering work identically to the event-mode stand.
 *
 * Fix: PDF URL now includes the required ?pieceId= scope parameter so the
 * authenticated file proxy does not return 404.
 */
export function LibraryStandViewer({ piece, userId, missingStorageKeys = [] }: LibraryStandViewerProps) {
  const missingKeys = new Set(missingStorageKeys);
  const {
    setPieces,
    setEventInfo,
    setUserContext,
    setAnnotations,
    nightMode,
    gigMode,
    isFullscreen,
    showControls,
    _currentPage: currentPage,
    nextPage,
    prevPage,
    setCurrentPage,
  } = useStandStore();

  // Build the list of available views (must come before the selectedPartId state
  // so the initial value calculation can reference partOptions)
  const fullScorePdf = piece.files[0] ?? null;

  const partOptions = [
    ...(fullScorePdf
      ? [
          {
            id: '__full__',
            label: fullScorePdf.partLabel ?? fullScorePdf.instrumentName ?? 'Full Score',
            storageKey: fullScorePdf.storageKey,
            pageCount: fullScorePdf.pageCount,
            unavailable: missingKeys.has(fullScorePdf.storageKey),
          },
        ]
      : []),
    ...piece.parts
      .filter((p) => p.storageKey)
      .map((p) => ({
        id: p.id,
        label: p.partName || p.instrumentName,
        storageKey: p.storageKey!,
        pageCount: p.pageCount ?? 1,
        unavailable: missingKeys.has(p.storageKey!),
      })),
  ];

  // First available (non-missing) part to safely initialise the selector
  const firstAvailable = partOptions.find((p) => !p.unavailable);

  // Default to first available part; if the full score is unavailable, skip to
  // the first part that exists so we don't immediately show an error on mount.
  const [selectedPartId, setSelectedPartId] = useState<string>(
    () => (partOptions[0]?.unavailable ? (firstAvailable?.id ?? '__full__') : '__full__')
  );

  const selectedPart = partOptions.find((p) => p.id === selectedPartId) ?? partOptions[0];
  const totalPages = selectedPart?.pageCount ?? 1;

  // Hydrate stand store whenever the selected part changes.
  // IMPORTANT: ?pieceId=<id> is required by the file proxy access-control check.
  useEffect(() => {
    if (!selectedPart) return;
    const pdfUrl =
      `/api/stand/files/${encodeURIComponent(selectedPart.storageKey)}` +
      `?pieceId=${encodeURIComponent(piece.id)}`;

    setPieces([
      {
        id: piece.id,
        title: piece.title,
        composer: piece.composer ?? '',
        pdfUrl,
        totalPages: selectedPart.pageCount,
      },
    ]);
    setEventInfo(`library-${piece.id}`, piece.title);
    // Reset to page 1 when part changes
    setCurrentPage(1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPart?.storageKey, piece.id]);

  // Set user context and load annotations once on mount.
  useEffect(() => {
    setUserContext({
      userId,
      roles: [],
      isDirector: false,
      isSectionLeader: false,
      userSectionIds: [],
    });

    // Fetch all personal/section/director annotations for this piece
    fetch(`/api/stand/annotations?musicId=${encodeURIComponent(piece.id)}`)
      .then((r) => (r.ok ? r.json() : { annotations: [] }))
      .then((data) => {
        if (Array.isArray(data.annotations) && data.annotations.length > 0) {
          setAnnotations(
             
            data.annotations.map((a: any) => ({
              id: a.id,
              pieceId: a.musicId,
              pageNumber: a.page,
              layer: a.layer,
              strokeData: a.strokeData ?? {},
              userId: a.userId,
              sectionId: a.sectionId ?? null,
              createdAt: a.createdAt,
              updatedAt: a.updatedAt,
            }))
          );
        }
      })
      .catch(() => {
        // Annotations are non-critical; silently ignore fetch failures
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [piece.id, userId]);

  return (
    <div
      className={cn(
        'flex flex-col flex-1 overflow-hidden',
        nightMode && 'bg-zinc-900 text-zinc-100'
      )}
    >
      {/* Controls bar – hidden in gig mode or fullscreen-without-controls */}
      <div
        className={cn(
          'flex items-center gap-3 px-4 py-2 border-b shrink-0',
          nightMode ? 'bg-zinc-800 border-zinc-700' : 'bg-card',
          gigMode || (!showControls && isFullscreen) ? 'hidden' : ''
        )}
      >
        {/* Part / score selector */}
        {partOptions.length > 1 && (
          <Select
            value={selectedPartId}
            onValueChange={(v) => {
              setSelectedPartId(v);
            }}
          >
            <SelectTrigger className="w-48 h-8 text-xs">
              <SelectValue placeholder="Select part" />
            </SelectTrigger>
            <SelectContent>
              {partOptions.map((p) => (
                <SelectItem
                  key={p.id}
                  value={p.id}
                  className="text-xs"
                  disabled={p.unavailable}
                >
                  {p.label}{p.unavailable ? ' (Unavailable)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Page navigation */}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={prevPage}
            disabled={currentPage <= 1}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>

          <span className={cn('text-xs tabular-nums', nightMode && 'text-zinc-300')}>
            {currentPage} / {totalPages}
          </span>

          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={nextPage}
            disabled={currentPage >= totalPages}
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        {/* Full annotation + utility toolbar (includes night-mode, tools, metronome, tuner…) */}
        <div className="ml-auto">
          <Toolbar />
        </div>
      </div>

      {/* Input handlers (renderless) */}
      <KeyboardHandler />
      <MidiHandler />
      <BluetoothHandler />

      {/* Viewer area */}
      <div
        className={cn(
          'flex-1 relative overflow-hidden',
          nightMode ? 'bg-zinc-900' : 'bg-muted/20'
        )}
      >
        {selectedPart ? (
          <>
            <GestureHandler />
            <StandCanvas />
            <Metronome />
            <Tuner />
            <AudioPlayer />
            <PitchPipe />
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            No PDF available for this piece.
          </div>
        )}
      </div>
    </div>
  );
}

LibraryStandViewer.displayName = 'LibraryStandViewer';
