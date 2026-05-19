'use client';

import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useEffect,
  useState,
  useCallback,
} from 'react';
import { useStandStore, StandPiece } from '@/store/standStore';
import { useStandSync } from '@/hooks/use-stand-sync';
import { useAudioTracker } from '@/hooks/useAudioTracker';
import { NavigationControls } from './NavigationControls';
import { Toolbar } from './Toolbar';
import { StandCanvas } from './StandCanvas';
import { GestureHandler } from './GestureHandler';
import { KeyboardHandler } from './KeyboardHandler';
import { MidiHandler } from './MidiHandler';
import { RosterOverlay } from './RosterOverlay';
import { Metronome } from './Metronome';
import { Tuner } from './Tuner';
import { AudioPlayer } from './AudioPlayer';
import { PitchPipe } from './PitchPipe';
import { AudioTrackerSettings } from './AudioTrackerSettings';
import { SmartNavEditor } from './SmartNavEditor';
import { SetlistManager } from './SetlistManager';
import { BookmarksPanel } from './BookmarksPanel';
import { SetlistsPanel } from './SetlistsPanel';
import { PracticeTimer } from './PracticeTimer';
import { AudioLinkEditor } from './AudioLinkEditor';
import { PartSelector } from './PartSelector';

interface SerializedMusicFile {
  id: string;
  mimeType: string;
  storageKey: string;
  storageUrl: string | null;
  pageCount: number | null;
  partLabel?: string | null;
  instrumentName?: string | null;
  section?: string | null;
  partNumber?: number | null;
}

interface SerializedMusicPart {
  id: string;
  partName: string;
  partLabel: string | null;
  instrumentId: string;
  instrumentName: string;
  storageKey: string | null;
  storageUrl?: string | null;
  pageCount?: number | null;
}

interface SerializedMusicAssignment {
  id: string;
  piece: {
    id: string;
    title: string;
    composer: string | null;
    files: SerializedMusicFile[];
    parts: SerializedMusicPart[];
  };
}

interface SerializedAnnotation {
  id: string;
  pieceId: string;
  page: number;
  layer: 'PERSONAL' | 'SECTION' | 'DIRECTOR';
  strokeData: unknown;
  userId: string;
  sectionId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SerializedNavigationLink {
  id: string;
  musicId: string;
  fromPage: number;
  fromX: number;
  fromY: number;
  toPage: number;
  toMusicId: string | null;
  toX: number;
  toY: number;
  label: string;
  createdAt: string;
}

interface SerializedAudioLink {
  id: string;
  pieceId: string;
  fileKey: string;
  url: string | null;
  description: string | null;
  createdAt: string;
}

interface StandConfig {
  enabled: boolean;
  realtimeMode: string;
  websocketEnabled: boolean;
  pollingIntervalMs: number;
  practiceTrackingEnabled: boolean;
  audioSyncEnabled: boolean;
}

interface SerializedPreferences {
  nightMode: boolean;
  metronomeSettings?: Record<string, unknown>;
  midiMappings?: Record<string, unknown>;
  tunerSettings?: Record<string, unknown>;
  pitchPipeSettings?: Record<string, unknown>;
  audioTrackerSettings?: Record<string, unknown>;
}

interface SerializedRosterEntry {
  id: string;
  eventId: string;
  userId: string;
  name: string;
  section: string | null;
  lastSeenAt: string;
}

export interface StandLoaderData {
  eventId: string;
  userId: string;
  eventTitle: string;
  roles: string[];
  isDirector: boolean;
  isSectionLeader: boolean;
  userSectionIds: string[];
  music: SerializedMusicAssignment[];
  annotations: SerializedAnnotation[];
  navigationLinks: SerializedNavigationLink[];
  audioLinks: SerializedAudioLink[];
  preferences: SerializedPreferences | null;
  roster: SerializedRosterEntry[];
}

interface StandViewerProps {
  data: StandLoaderData;
}

interface StandErrorBoundaryProps {
  children: ReactNode;
}

interface StandErrorBoundaryState {
  hasError: boolean;
  errorMessage: string | null;
}

class StandErrorBoundary extends Component<
  StandErrorBoundaryProps,
  StandErrorBoundaryState
> {
  state: StandErrorBoundaryState = {
    hasError: false,
    errorMessage: null,
  };

  static getDerivedStateFromError(error: Error): StandErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error.message,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[StandViewer ErrorBoundary]', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full min-h-[24rem] flex-col items-center justify-center gap-4 px-6 text-center">
          <div className="space-y-2">
            <h2 className="text-xl font-semibold">Music stand unavailable</h2>
            <p className="text-sm text-muted-foreground">
              {this.state.errorMessage ??
                'The music stand hit an unexpected problem while loading.'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Reload stand
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * Build StandPiece[] from serialized music assignments.
 * Uses piece.id (MusicPiece PK) as the identity – NOT EventMusic.id.
 * PDF URLs go through the authenticated file proxy with eventId scope.
 */
function buildStandPieces(
  music: SerializedMusicAssignment[],
  eventId: string
): StandPiece[] {
  return music.map((m) => {
    const pdf = m.piece.files.find((f) => f.mimeType === 'application/pdf');
    const proxyBase = `/api/stand/files/${encodeURIComponent(
      pdf?.storageKey ?? ''
    )}?eventId=${encodeURIComponent(eventId)}`;
    return {
      id: m.piece.id,
      title: m.piece.title ?? 'Untitled',
      composer: m.piece.composer ?? '',
      pdfUrl: pdf ? proxyBase : null,
      totalPages: pdf?.pageCount ?? 1,
    };
  });
}

function StandViewerContent({ data }: StandViewerProps) {
  const {
    setPieces,
    setEventInfo,
    isFullscreen,
    showControls,
    gigMode,
    setAnnotations,
    setNavigationLinks,
    toggleNightMode,
    setRoster,
    addRosterEntry,
    removeRosterEntry,
    setAudioLinks,
    updateMetronomeSettings,
    updateTunerSettings,
    updatePitchPipeSettings,
    updateAudioTrackerSettings,
    setUserContext,
    updatePiecePdfUrl,
    pieces,
    currentPieceIndex,
  } = useStandStore();

  const {
    eventId,
    userId,
    eventTitle,
    roles,
    isDirector,
    isSectionLeader,
    userSectionIds,
    music,
    annotations,
    navigationLinks,
    audioLinks,
    preferences,
    roster,
  } = data;

  const isLibrarian = roles.includes('LIBRARIAN');

  const [standConfig, setStandConfig] = useState<StandConfig | null>(null);
  type PanelName = 'bookmarks' | 'setlists' | 'practice' | 'audio';
  const [activePanel, setActivePanel] = useState<PanelName | null>(null);
  const [activePiecePartId, setActivePiecePartId] = useState<Record<string, string>>(
    {}
  );

  useAudioTracker();

  useEffect(() => {
    fetch('/api/stand/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg: StandConfig | null) => {
        if (cfg) setStandConfig(cfg);
      })
      .catch(() => {
        /* config fetch is best-effort */
      });
  }, []);

  const handlePartSelect = useCallback(
    (pieceId: string, option: { id: string; url: string; pageCount: number }) => {
      setActivePiecePartId((prev) => ({ ...prev, [pieceId]: option.id }));
      updatePiecePdfUrl(pieceId, option.url);
      fetch('/api/stand/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          otherSettings: {
            selectedParts: {
              [pieceId]: option.id,
            },
          },
        }),
      }).catch(() => {});
    },
    [updatePiecePdfUrl]
  );

  const togglePanel = useCallback(
    (name: 'bookmarks' | 'setlists' | 'practice' | 'audio') =>
      setActivePanel((prev) => (prev === name ? null : name)),
    []
  );

  useEffect(() => {
    setUserContext({
      userId,
      roles,
      isDirector,
      isSectionLeader,
      userSectionIds,
    });

    if (music.length > 0) {
      setPieces(buildStandPieces(music, eventId));
      setEventInfo(eventId, eventTitle);
    }

    if (annotations.length > 0) {
      const mappedAnnotations = annotations.map((a) => ({
        id: a.id,
        pieceId: a.pieceId,
        pageNumber: a.page,
        layer: a.layer,
        strokeData: (a.strokeData || {}) as Record<string, unknown>,
        userId: a.userId,
        sectionId: a.sectionId,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      }));
      setAnnotations(mappedAnnotations);
    }

    if (navigationLinks.length > 0) {
      const mappedLinks = navigationLinks.map((nl) => ({
        id: nl.id,
        fromPieceId: nl.musicId,
        fromPage: nl.fromPage,
        fromX: nl.fromX,
        fromY: nl.fromY,
        toPieceId: nl.toMusicId || nl.musicId,
        toPage: nl.toPage,
        toX: nl.toX,
        toY: nl.toY,
        label: nl.label,
        createdAt: nl.createdAt,
        toMusicId: nl.toMusicId,
      }));
      setNavigationLinks(mappedLinks);
    }

    if (audioLinks.length > 0) {
      setAudioLinks(audioLinks);
    }

    if (roster.length > 0) {
      setRoster(
        roster.map((r) => ({
          userId: r.userId,
          name: r.name || r.userId.slice(0, 8),
          section: r.section ?? undefined,
          joinedAt: r.lastSeenAt,
        }))
      );
    }

    if (preferences) {
      if (preferences.nightMode) toggleNightMode();
      if (preferences.metronomeSettings) {
        updateMetronomeSettings(preferences.metronomeSettings as any);
      }
      if (preferences.tunerSettings) {
        updateTunerSettings(preferences.tunerSettings as any);
      }
      if (preferences.pitchPipeSettings) {
        updatePitchPipeSettings(preferences.pitchPipeSettings as any);
      }
      if (preferences.midiMappings) {
        useStandStore.getState().setMidiMappings(preferences.midiMappings as any);
      }
      if (preferences.audioTrackerSettings) {
        updateAudioTrackerSettings(preferences.audioTrackerSettings as any);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useStandSync({
    eventId,
    userId,
    realtimeEnabled:
      standConfig?.websocketEnabled === true &&
      standConfig?.realtimeMode === 'websocket',
    pollingInterval: standConfig?.pollingIntervalMs ?? 5000,
    onRosterChange: (members) => setRoster(members),
    onPresenceChange: (presence) => {
      if (presence.status === 'joined') {
        addRosterEntry({
          userId: presence.userId,
          name: presence.name,
          section: presence.section,
          joinedAt: new Date().toISOString(),
        });
      } else {
        removeRosterEntry(presence.userId);
      }
    },
  });

  const currentPiece = pieces[currentPieceIndex] ?? null;
  const currentMusicEntry = music[currentPieceIndex] ?? null;

  const partOptions = (() => {
    if (!currentMusicEntry) return { fullScore: null, parts: [], activeId: null };
    const { piece } = currentMusicEntry;
    const proxyBase = (key: string) =>
      `/api/stand/files/${encodeURIComponent(key)}?eventId=${encodeURIComponent(
        eventId
      )}`;

    const fullScoreFile = piece.files.find(
      (f) => f.mimeType === 'application/pdf' && !f.partLabel
    );
    const fullScore = fullScoreFile
      ? {
          id: fullScoreFile.id,
          label:
            fullScoreFile.partLabel ??
            fullScoreFile.instrumentName ??
            'Full Score',
          url: proxyBase(fullScoreFile.storageKey),
          pageCount: fullScoreFile.pageCount ?? 1,
        }
      : null;

    const parts = piece.parts
      .filter((p) => p.storageKey)
      .map((p) => ({
        id: p.id,
        label: p.partLabel ?? p.partName ?? p.instrumentName,
        url: proxyBase(p.storageKey!),
        pageCount: p.pageCount ?? 1,
      }));

    const activeId =
      activePiecePartId[piece.id] ?? fullScore?.id ?? parts[0]?.id ?? null;
    return { fullScore, parts, activeId };
  })();

  if (!music || music.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        No music scheduled for this event.
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col h-[calc(100vh-4rem)] ${
        isFullscreen ? 'fixed inset-0 z-50 bg-background h-screen' : ''
      }`}
    >
      <div
        className={`p-4 border-b flex items-center justify-between bg-card ${
          gigMode || (!showControls && isFullscreen) ? 'hidden' : ''
        }`}
      >
        <NavigationControls />
        <div className="flex items-center gap-2">
          <PartSelector
            fullScore={partOptions.fullScore}
            parts={partOptions.parts}
            activeId={partOptions.activeId}
            onChange={(opt) => handlePartSelect(currentPiece?.id ?? '', opt)}
          />
          <Toolbar
            onToggleBookmarks={() => togglePanel('bookmarks')}
            onToggleSetlists={() => togglePanel('setlists')}
            onTogglePractice={
              standConfig?.practiceTrackingEnabled
                ? () => togglePanel('practice')
                : undefined
            }
            onToggleAudio={
              standConfig?.audioSyncEnabled
                ? () => togglePanel('audio')
                : undefined
            }
            activePanel={activePanel ?? undefined}
          />
        </div>
      </div>

      <KeyboardHandler />
      <MidiHandler />

      <div className="flex-1 bg-muted/20 relative overflow-hidden flex">
        <SetlistManager />

        <div className="flex-1 relative overflow-hidden">
          <GestureHandler />
          <StandCanvas />
          <RosterOverlay />
          <SmartNavEditor />
          <Metronome />
          <Tuner />
          <AudioPlayer />
          <PitchPipe />
          <AudioTrackerSettings />
        </div>

        {activePanel && (
          <div className="w-80 border-l bg-card flex-shrink-0 overflow-y-auto">
            {activePanel === 'bookmarks' && (
              <BookmarksPanel
                currentPieceId={currentPiece?.id ?? null}
                onSelect={(pieceId) => {
                  const idx = pieces.findIndex((p) => p.id === pieceId);
                  if (idx >= 0) useStandStore.getState().setCurrentPieceIndex(idx);
                  setActivePanel(null);
                }}
              />
            )}
            {activePanel === 'setlists' && (
              <SetlistsPanel eventId={eventId} canManage={isDirector} />
            )}
            {activePanel === 'practice' && currentPiece && (
              <PracticeTimer
                pieceId={currentPiece.id}
                pieceTitle={currentPiece.title}
              />
            )}
            {activePanel === 'audio' && currentPiece && (
              <AudioLinkEditor
                pieceId={currentPiece.id}
                canManage={isDirector || isLibrarian}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function StandViewer({ data }: StandViewerProps) {
  return (
    <StandErrorBoundary>
      <StandViewerContent data={data} />
    </StandErrorBoundary>
  );
}
