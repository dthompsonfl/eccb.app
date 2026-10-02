import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  getSpreadPages,
  isSpreadable,
  nextSpreadPage,
  prevSpreadPage,
  safeTotalPages,
  scrollOffsetToHalf,
  halfToScrollOffset,
  stepHalfPage,
  type HalfPage,
  type NormalizedCropRect,
  type SpreadPages,
} from '@/lib/stand/navigation';

// Roster member type used for presence overlay
export interface StandRosterMember {
  userId: string;
  name: string;
  section?: string;
  joinedAt: string;
}

export interface Annotation {
  id: string;
  pieceId: string;
  pageNumber: number;
  layer: 'PERSONAL' | 'SECTION' | 'DIRECTOR';
  strokeData: StrokeData | Record<string, unknown>;
  sectionId?: string | null;
  userId?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface NavigationLink {
  id: string;
  fromPieceId: string;
  fromPage: number;
  /** Hotspot rect left edge, 0-1 normalised to page width */
  fromX: number;
  /** Hotspot rect top edge, 0-1 normalised to page height */
  fromY: number;
  toPieceId: string;
  toPage: number;
  /** Hotspot rect right edge, 0-1 normalised */
  toX: number;
  /** Hotspot rect bottom edge, 0-1 normalised */
  toY: number;
  label: string;
  /** Cross-piece navigation target (null = same piece) */
  toMusicId: string | null;
  createdAt?: string;
}

export interface StandSettings {
  autoTurnPage: boolean;
  turnPageDelay: number;
  defaultZoom: number;
  showPageNumbers: boolean;
  showPageTransitions: boolean;
  hapticFeedback: boolean;
  swipeGesture: boolean;
}

export interface StandPiece {
  id: string;
  title: string;
  composer: string;
  pdfUrl: string | null;
  totalPages: number;
}

export interface StandState {
  // Navigation state
  currentPieceIndex: number;
  _currentPage: number;
  pieces: StandPiece[];
  scrollOffset: number; // For half-page scrolling in portrait mode

  // Setlist state
  atEnd: boolean; // Flag indicating end of setlist has been reached

  // UI state
  isFullscreen: boolean;
  showControls: boolean;
  gigMode: boolean;
  nightMode: boolean;
  zoom: number;

  // Annotations split by layer and keyed by `${pieceId}-${pageNumber}`
  annotations: {
    personal: Record<string, Annotation[]>;
    section: Record<string, Annotation[]>;
    director: Record<string, Annotation[]>;
  };
  selectedLayer: 'PERSONAL' | 'SECTION' | 'DIRECTOR';

  // Tool state
  currentTool: Tool;
  toolColor: string;
  strokeWidth: number;
  pressureScale: number;
  /** Currently selected stamp id for Tool.STAMP (must match a StampDefinition.id) */
  selectedStampId: string;

  // Navigation links (smart nav)
  navigationLinks: NavigationLink[];

  // Settings
  settings: StandSettings;

  // Event info
  eventId: string | null;
  eventTitle: string | null;
  // Roster entries for presence overlay
  roster: StandRosterMember[];
  // Edit mode for annotations
  editMode: boolean;

  // Actions
  setCurrentPieceIndex: (index: number) => void;
  setCurrentPage: (page: number) => void;
  nextPiece: () => void;
  prevPiece: () => void;
  nextPage: () => void;
  prevPage: () => void;
  goToNextPage: () => void;
  goToPreviousPage: () => void;
  // Setlist advance actions - automatically advance to next piece at end of current piece
  nextPageOrPiece: () => void;
  prevPageOrPiece: () => void;
  /**
   * Step half a page. Pass -1 to scroll back; the default of 1 scrolls forward.
   * A no-op at either end of the piece.
   */
  scrollHalfPage: (direction?: 1 | -1) => void;
  nextTwoPages: () => void;
  prevTwoPages: () => void;
  /** Directional spread advance, for callers that already know the sign. */
  stepTwoPages: (direction: 1 | -1) => void;

  // ── Spread / half-page / crop ───────────────────────────────────────────
  /** True when two pages are shown side by side. */
  twoPageMode: boolean;
  setTwoPageMode: (on: boolean) => void;
  /** Toggle two-page spread. */
  toggleTwoPageMode: () => void;
  /** The two pages currently displayed in spread mode. */
  visibleSpreadPages: () => SpreadPages;
  /** Which vertical half of the current page is in view. */
  currentHalf: () => HalfPage;
  /** Per-user crop rect in normalised page space, or null when uncropped. */
  cropRect: NormalizedCropRect | null;
  setCropRect: (rect: NormalizedCropRect | null) => void;
  /** Clear the crop and return to the full page. */
  resetCropRect: () => void;
  setScrollOffset: (offset: number) => void;
  setPieces: (pieces: StandPiece[]) => void;
  setIsFullscreen: (isFullscreen: boolean) => void;
  setShowControls: (show: boolean) => void;
  toggleGigMode: () => void;
  toggleNightMode: () => void;
  setZoom: (zoom: number) => void;

  // annotation actions
  loadAnnotations: (pieceId: string, pageNumber: number) => Promise<void>;
  setAnnotations: (annotations: Annotation[]) => void;
  addAnnotation: (annotation: Annotation) => Promise<void>;
  updateAnnotation: (annotation: Annotation) => Promise<void>;
  deleteAnnotation: (id: string) => Promise<void>;
  setLayer: (layer: 'PERSONAL' | 'SECTION' | 'DIRECTOR') => void;
  setCurrentTool: (tool: Tool) => void;
  setToolColor: (color: string) => void;
  setStrokeWidth: (width: number) => void;
  setPressureScale: (scale: number) => void;
  setSelectedStampId: (id: string) => void;

  addNavigationLink: (link: NavigationLink) => void;
  setNavigationLinks: (links: NavigationLink[]) => void;
  removeNavigationLink: (id: string) => void;
  updateNavigationLink: (link: NavigationLink) => void;
  updateSettings: (settings: Partial<StandSettings>) => void;
  setEventInfo: (eventId: string, eventTitle: string) => void;
  // User context for role-based features
  userContext: UserContext | null;
  setUserContext: (ctx: UserContext) => void;
  // Update totalPages after PDF load
  updatePieceTotalPages: (pieceId: string, totalPages: number) => void;
  // Override the pdfUrl for a piece (e.g., after a part is selected)
  updatePiecePdfUrl: (pieceId: string, pdfUrl: string | null) => void;
  // roster actions
  setRoster: (entries: StandRosterMember[]) => void;
  addRosterEntry: (entry: StandRosterMember) => void;
  removeRosterEntry: (userId: string) => void;
  setEditMode: (edit: boolean) => void;
  toggleEditMode: () => void;

  // Audio links for current piece
  audioLinks: StandAudioLink[];
  selectedAudioLinkId: string | null;
  audioLoopStart: number | null;
  audioLoopEnd: number | null;
  audioPlaying: boolean;

  // Rehearsal utilities visibility
  showMetronome: boolean;
  showTuner: boolean;
  showAudioPlayer: boolean;
  showPitchPipe: boolean;

  // Utility settings (persisted in user preferences)
  metronomeSettings: {
    bpm: number;
    numerator: number;
    denominator: number;
    subdivision: number;
  };
  tunerSettings: {
    mute: boolean;
  };
  pitchPipeSettings: {
    instrument: 'sine' | 'square' | 'triangle' | 'sawtooth';
  };

  // Audio tracker settings (AI/automation feature)
  audioTrackerSettings: {
    enabled: boolean;
    sensitivity: number;
    cooldownMs: number;
  };

  // MIDI mappings for hardware integration
  midiMappings: Record<string, string>;

  setAudioLinks: (links: StandAudioLink[]) => void;
  selectAudioLink: (id: string | null) => void;
  setAudioLoopPoints: (start: number | null, end: number | null) => void;
  setAudioPlaying: (playing: boolean) => void;

  // Audio tracker actions
  updateAudioTrackerSettings: (settings: Partial<StandState['audioTrackerSettings']>) => void;
  toggleAudioTracker: () => void;

  toggleMetronome: () => void;
  toggleTuner: () => void;
  toggleAudioPlayer: () => void;
  togglePitchPipe: () => void;

  updateMetronomeSettings: (settings: Partial<StandState['metronomeSettings']>) => void;
  updateTunerSettings: (settings: Partial<StandState['tunerSettings']>) => void;
  updatePitchPipeSettings: (settings: Partial<StandState['pitchPipeSettings']>) => void;

  reset: () => void;
  // PREFERENCE HELPERS
  loadPreferences: (prefs: Partial<{ midiMappings: Record<string, string> }>) => void;
  savePreferences: () => Promise<void>;
  setMidiMappings: (mappings: Record<string, string>) => void;
  updateMidiMapping: (key: string, action: string) => void;
}

// Tool types for annotation layer
export enum Tool {
  PENCIL = 'PENCIL',
  HIGHLIGHTER = 'HIGHLIGHTER',
  ERASER = 'ERASER',
  WHITEOUT = 'WHITEOUT',
  TEXT = 'TEXT',
  STAMP = 'STAMP',
}

// Stroke point with pressure
export interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
  timestamp: number;
}

// Complete stroke data for persistence
export interface StrokeData {
  id: string;
  type: Tool;
  points: StrokePoint[];
  color: string;
  baseWidth: number;
  opacity: number;
  // For text annotations
  text?: string;
  fontSize?: number;
  // For stamp annotations
  stampId?: string;
  svgContent?: string;
  width?: number;
  height?: number;
  rotation?: number;
}

export interface UserContext {
  userId: string;
  roles: string[];
  isDirector: boolean;
  isSectionLeader: boolean;
  userSectionIds: string[];
}

const DEFAULT_SETTINGS: StandSettings = {
  autoTurnPage: false,
  turnPageDelay: 3000,
  defaultZoom: 100,
  showPageNumbers: true,
  showPageTransitions: true,
  hapticFeedback: false,
  swipeGesture: true,
};

const initialState = {
  currentPieceIndex: 0,
  _currentPage: 1,
  pieces: [],
  scrollOffset: 0,
  twoPageMode: false,
  cropRect: null as NormalizedCropRect | null,
  atEnd: false,
  isFullscreen: false,
  showControls: true,
  gigMode: false,
  nightMode: false,
  zoom: 100,
  annotations: { personal: {}, section: {}, director: {} },
  selectedLayer: 'PERSONAL' as const,
  currentTool: Tool.PENCIL,
  toolColor: '#ff0000',
  strokeWidth: 3,
  pressureScale: 5,
  selectedStampId: 'forte',

  navigationLinks: [],
  settings: DEFAULT_SETTINGS,
  eventId: null,
  eventTitle: null,
  roster: [],
  editMode: false,
  userContext: null,

  // audio
  audioLinks: [],
  selectedAudioLinkId: null,
  audioLoopStart: null,
  audioLoopEnd: null,
  audioPlaying: false,

  // utilities
  showMetronome: false,
  showTuner: false,
  showAudioPlayer: false,
  showPitchPipe: false,

  metronomeSettings: {
    bpm: 120,
    numerator: 4,
    denominator: 4,
    subdivision: 1,
  },
  tunerSettings: {
    mute: true,
  },
  pitchPipeSettings: {
    instrument: 'sine' as 'sine' | 'square' | 'triangle' | 'sawtooth',
  },
  // Audio tracker settings (AI/automation)
  audioTrackerSettings: {
    enabled: false,
    sensitivity: 0.5,
    cooldownMs: 3000,
  },
  // MIDI mappings: key string -> action name
  midiMappings: {} as Record<string, string>,
};

// helper to ensure fetch receives an absolute URL when running under Node
function apiFetch(input: RequestInfo, init?: RequestInit) {
  let url = input;
  if (typeof url === 'string' && !/^https?:\/\//.test(url)) {
    const prefix = typeof window !== 'undefined' ? '' : 'http://localhost';
    url = prefix + url;
  }
  return fetch(url, init);
}

// Helper to build annotation key
function annotationKey(pieceId: string, pageNumber: number): string {
  return `${pieceId}-${pageNumber}`;
}

/**
 * View preferences that must survive a page reload.
 *
 * A musician who enlarges the music to read a difficult bar, or switches on
 * night mode for a dark rehearsal room, expects that to still be true the next
 * time they open the stand. Without this the store reset to its defaults on
 * every navigation and reload, so the setting silently did nothing.
 *
 * Only genuinely durable view state is persisted. Deliberately NOT persisted:
 * `pieces`, `annotations`, `roster`, `userContext` and `eventId`, which are
 * per-session data loaded from the server for a specific user and event —
 * persisting those would show one musician another musician's annotations.
 */
/**
 * Resolve a usable Storage for the persisted slice.
 *
 * The store is imported by unit tests running under jsdom and by server
 * rendering, where `localStorage` can be missing or throw on access (Safari
 * private mode, disabled storage, SSR). Persistence is a convenience here, so
 * an unusable Storage degrades to an in-memory no-op rather than taking the
 * whole stand down with it.
 */
function resolveViewPrefStorage(): Storage {
  try {
    if (typeof localStorage !== 'undefined') {
      const probe = '__eccb_stand_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return localStorage;
    }
  } catch {
    /* fall through to the in-memory fallback */
  }

  const memory = new Map<string, string>();
  return {
    get length() {
      return memory.size;
    },
    clear: () => memory.clear(),
    getItem: (k: string) => memory.get(k) ?? null,
    key: (i: number) => [...memory.keys()][i] ?? null,
    removeItem: (k: string) => void memory.delete(k),
    setItem: (k: string, v: string) => void memory.set(k, v),
  } satisfies Storage;
}

const PERSISTED_VIEW_KEYS = [
  'zoom',
  'nightMode',
  'twoPageMode',
  'cropRect',
  'selectedLayer',
  'currentTool',
  'toolColor',
  'strokeWidth',
  'pressureScale',
  'selectedStampId',
] as const;

export const useStandStore = create<StandState>()(
  persist(
    (set, get) => ({
  ...initialState,

  setCurrentPieceIndex: (index: number) => {
    const { pieces } = get();
    if (index >= 0 && index < pieces.length) {
      set({ currentPieceIndex: index, _currentPage: 1, scrollOffset: 0, atEnd: false });
    }
  },

  setCurrentPage: (page: number) => {
    const { pieces, currentPieceIndex } = get();
    const currentPiece = pieces[currentPieceIndex];
    if (currentPiece && page >= 1 && page <= currentPiece.totalPages) {
      set({ _currentPage: page, scrollOffset: 0 });
    }
  },

  nextPiece: () => {
    const { pieces, currentPieceIndex } = get();
    if (currentPieceIndex < pieces.length - 1) {
      set({ currentPieceIndex: currentPieceIndex + 1, _currentPage: 1, scrollOffset: 0 });
    }
  },

  prevPiece: () => {
    const { currentPieceIndex } = get();
    if (currentPieceIndex > 0) {
      set({ currentPieceIndex: currentPieceIndex - 1, _currentPage: 1, scrollOffset: 0 });
    }
  },

  // In two-page mode the unit of navigation is the SPREAD, not the page.
  //
  // `stepTwoPages` and `nextSpreadPage` already existed for this and the gesture
  // overlay used them, but the toolbar's Next/Previous buttons and the keyboard
  // shortcuts both call nextPage/prevPage, which advanced a single page. With a
  // spread showing pages N and N+1, a one-page step slid the window by half a
  // spread: the page the musician was reading moved from the right-hand side to
  // the left, which is not what "turn the page" means for a spread. Every
  // navigation entry point now agrees on the unit.
  nextPage: () => {
    const { pieces, currentPieceIndex, _currentPage, twoPageMode } = get();
    const currentPiece = pieces[currentPieceIndex];
    if (!currentPiece) return;

    if (twoPageMode && isSpreadable(currentPiece.totalPages)) {
      get().stepTwoPages(1);
      return;
    }

    if (_currentPage < currentPiece.totalPages) {
      set({ _currentPage: _currentPage + 1, scrollOffset: 0 });
    }
  },

  prevPage: () => {
    const { pieces, currentPieceIndex, _currentPage, twoPageMode } = get();
    const currentPiece = pieces[currentPieceIndex];
    if (!currentPiece) return;

    if (twoPageMode && isSpreadable(currentPiece.totalPages)) {
      get().stepTwoPages(-1);
      return;
    }

    if (_currentPage > 1) {
      set({ _currentPage: _currentPage - 1, scrollOffset: 0 });
    }
  },

  // Action for advancing to next page (used by gesture/keyboard handlers)
  // Advances to next page (used by gesture/keyboard handlers)
  goToNextPage: () => {
    const { pieces, currentPieceIndex, _currentPage } = get();
    const currentPiece = pieces[currentPieceIndex];
    if (currentPiece && _currentPage < currentPiece.totalPages) {
      set({ _currentPage: _currentPage + 1, scrollOffset: 0 });
    }
  },

  // Action for going to previous page (used by gesture/keyboard handlers)
  // Goes to previous page (used by gesture/keyboard handlers)
  goToPreviousPage: () => {
    const { _currentPage } = get();
    if (_currentPage > 1) {
      set({ _currentPage: _currentPage - 1, scrollOffset: 0 });
    }
  },

  // Action for automatic setlist advancement
  // Advances to next page within piece, or advances to first page of next piece
  // If at last page of last piece, sets atEnd flag
  nextPageOrPiece: () => {
    const { pieces, currentPieceIndex, _currentPage, atEnd } = get();
    const currentPiece = pieces[currentPieceIndex];

    // If already at end, don't advance
    if (atEnd) {
      return;
    }

    if (!currentPiece) {
      return;
    }

    // If not on last page of current piece, just advance page
    if (_currentPage < currentPiece.totalPages) {
      set({ _currentPage: _currentPage + 1, scrollOffset: 0, atEnd: false });
      return;
    }

    // We're on the last page of the current piece
    // Try to advance to next piece
    if (currentPieceIndex < pieces.length - 1) {
      set({
        currentPieceIndex: currentPieceIndex + 1,
        _currentPage: 1,
        scrollOffset: 0,
        atEnd: false,
      });
      return;
    }

    // We're on the last page of the last piece - set atEnd flag
    set({ atEnd: true });
  },

  // Action for automatic setlist backwards
  // Goes to previous page within piece, or goes to last page of previous piece
  prevPageOrPiece: () => {
    const { pieces, currentPieceIndex, _currentPage } = get();

    // If not on first page of current piece, just go back
    if (_currentPage > 1) {
      set({ _currentPage: _currentPage - 1, scrollOffset: 0, atEnd: false });
      return;
    }

    // We're on the first page of the current piece
    // Try to go to previous piece
    if (currentPieceIndex > 0) {
      const prevPiece = pieces[currentPieceIndex - 1];
      set({
        currentPieceIndex: currentPieceIndex - 1,
        _currentPage: prevPiece?.totalPages || 1,
        scrollOffset: 0,
        atEnd: false,
      });
      return;
    }

    // We're on the first page of the first piece - no change
    set({ atEnd: false });
  },

  // Half a page, in a known direction. The previous implementation was a plain
  // 0 <-> 0.5 toggle that both gesture directions reached, so scrolling up and
  // down were indistinguishable and neither end of the piece was reachable.
  scrollHalfPage: (direction = 1) => {
    const { scrollOffset, _currentPage, pieces, currentPieceIndex } = get();
    const currentPiece = pieces[currentPieceIndex];
    if (!currentPiece) return;

    const result = stepHalfPage(
      { page: _currentPage, half: scrollOffsetToHalf(scrollOffset) },
      direction === -1 ? -1 : 1,
      currentPiece.totalPages,
    );
    if (!result.moved) return;

    set({ _currentPage: result.page, scrollOffset: halfToScrollOffset(result.half) });
  },

  // Advance one spread. The stored page is always a recto, and StandCanvas
  // renders `currentPage` and `currentPage + 1` together, so the page the
  // musician lands on is the page they can actually see.
  nextTwoPages: () => {
    const { pieces, currentPieceIndex, _currentPage } = get();
    const currentPiece = pieces[currentPieceIndex];
    if (!currentPiece) return;
    set({
      _currentPage: nextSpreadPage(_currentPage, currentPiece.totalPages),
      scrollOffset: 0,
    });
  },

  prevTwoPages: () => {
    const { pieces, currentPieceIndex, _currentPage } = get();
    const currentPiece = pieces[currentPieceIndex];
    if (!currentPiece) return;
    set({
      _currentPage: prevSpreadPage(_currentPage, currentPiece.totalPages),
      scrollOffset: 0,
    });
  },

  // Directional spread advance, for callers that already know the sign.
  stepTwoPages: (direction: 1 | -1) => {
    const { pieces, currentPieceIndex, _currentPage } = get();
    const currentPiece = pieces[currentPieceIndex];
    if (!currentPiece) return;
    const total = safeTotalPages(currentPiece.totalPages);
    set({
      _currentPage:
        direction === 1
          ? nextSpreadPage(_currentPage, total)
          : prevSpreadPage(_currentPage, total),
      scrollOffset: 0,
    });
  },

  // ── Spread mode ──────────────────────────────────────────────────────────

  setTwoPageMode: (on: boolean) => {
    const { pieces, currentPieceIndex, _currentPage } = get();
    const currentPiece = pieces[currentPieceIndex];
    // A one-page piece has nothing to spread; refuse rather than render a
    // misleading second page.
    if (on && currentPiece && !isSpreadable(currentPiece.totalPages)) {
      set({ twoPageMode: false });
      return;
    }
    // Re-align to a recto so the spread starts on a clean leaf.
    const next: Partial<StandState> = { twoPageMode: on, scrollOffset: 0 };
    if (on && currentPiece) {
      next._currentPage = getSpreadPages(_currentPage, currentPiece.totalPages).left;
    }
    set(next);
  },

  toggleTwoPageMode: () => get().setTwoPageMode(!get().twoPageMode),

  visibleSpreadPages: () => {
    const { pieces, currentPieceIndex, _currentPage } = get();
    const currentPiece = pieces[currentPieceIndex];
    return getSpreadPages(
      _currentPage,
      currentPiece ? currentPiece.totalPages : 1,
    );
  },

  currentHalf: () => scrollOffsetToHalf(get().scrollOffset),

  // ── Crop ─────────────────────────────────────────────────────────────────

  setCropRect: (rect: NormalizedCropRect | null) => set({ cropRect: rect }),

  resetCropRect: () => set({ cropRect: null }),

  setScrollOffset: (offset: number) => {
    set({ scrollOffset: Math.max(0, Math.min(1, offset)) });
  },

  setPieces: (pieces: StandPiece[]) => {
    set({ pieces, currentPieceIndex: 0, _currentPage: 1, scrollOffset: 0, atEnd: false });
  },

  setIsFullscreen: (isFullscreen: boolean) => set({ isFullscreen }),

  setShowControls: (showControls: boolean) => set({ showControls }),

  toggleGigMode: () => set((state) => ({ gigMode: !state.gigMode })),

  toggleNightMode: () => set((state) => ({ nightMode: !state.nightMode })),

  setZoom: (zoom: number) => set({ zoom: Math.max(50, Math.min(200, zoom)) }),

  setEditMode: (edit: boolean) => set({ editMode: edit }),
  toggleEditMode: () => set((state) => ({ editMode: !state.editMode })),

  loadAnnotations: async (pieceId: string, pageNumber: number) => {
    const key = annotationKey(pieceId, pageNumber);
    const layer = get().selectedLayer.toLowerCase() as 'personal' | 'section' | 'director';
    try {
      const res = await apiFetch(
        `/api/stand/annotations?musicId=${pieceId}&page=${pageNumber}&layer=${get().selectedLayer}`
      );
      if (!res.ok) throw new Error('Failed to load annotations');
      const json = await res.json();
      const anns: Annotation[] = json.annotations.map((a: any) => ({
        id: a.id,
        pieceId: a.musicId,
        pageNumber: a.page,
        layer: a.layer,
        strokeData: a.strokeData ?? {},
        sectionId: a.sectionId ?? null,
        userId: a.userId,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      }));
      set((state) => ({
        annotations: {
          ...state.annotations,
          [layer]: { ...state.annotations[layer], [key]: anns },
        },
      }));
    } catch (err) {
      console.error('loadAnnotations error', err);
    }
  },

  setAnnotations: (annotations: Annotation[]) => {
    // Group by layer + piece:page key
    const grouped: StandState['annotations'] = { personal: {}, section: {}, director: {} };
    for (const ann of annotations) {
      const layer = ann.layer.toLowerCase() as 'personal' | 'section' | 'director';
      const key = annotationKey(ann.pieceId, ann.pageNumber);
      if (!grouped[layer][key]) grouped[layer][key] = [];
      grouped[layer][key].push(ann);
    }
    set({ annotations: grouped });
  },

  addAnnotation: async (annotation: Annotation) => {
    try {
      const res = await apiFetch('/api/stand/annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          musicId: annotation.pieceId,
          page: annotation.pageNumber,
          layer: annotation.layer,
          strokeData: annotation.strokeData,
          sectionId: annotation.sectionId,
        }),
      });
      if (!res.ok) throw new Error('Failed to create annotation');
      const json = await res.json();
      const saved = json.annotation;
      const musicId = saved.musicId ?? saved.pieceId;
      const pageNum = saved.page ?? saved.pageNumber;
      const key = annotationKey(musicId, pageNum);
      const layer = saved.layer.toLowerCase() as 'personal' | 'section' | 'director';
      const ann: Annotation = {
        id: saved.id,
        pieceId: musicId,
        pageNumber: pageNum,
        layer: saved.layer,
        strokeData: saved.strokeData ?? {},
        sectionId: saved.sectionId ?? null,
        userId: saved.userId,
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
      };
      set((state) => ({
        annotations: {
          ...state.annotations,
          [layer]: {
            ...state.annotations[layer],
            [key]: [...(state.annotations[layer][key] || []), ann],
          },
        },
      }));
    } catch (err) {
      console.error('addAnnotation error', err);
    }
  },

  updateAnnotation: async (annotation: Annotation) => {
    try {
      const res = await apiFetch(`/api/stand/annotations/${annotation.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          strokeData: annotation.strokeData,
          layer: annotation.layer,
          sectionId: annotation.sectionId,
        }),
      });
      if (!res.ok) throw new Error('Failed to update annotation');
      const json = await res.json();
      const saved = json.annotation;
      const musicId = saved.musicId ?? saved.pieceId;
      const pageNum = saved.page ?? saved.pageNumber;
      const key = annotationKey(musicId, pageNum);
      const newLayer = saved.layer.toLowerCase() as 'personal' | 'section' | 'director';
      set((state) => {
        const updated = { ...state.annotations };
        // remove the annotation from all layers first (clears old location)
        (['personal', 'section', 'director'] as const).forEach((layer) => {
          Object.keys(updated[layer]).forEach((k) => {
            updated[layer][k] = updated[layer][k].filter((a) => a.id !== annotation.id);
          });
        });
        const newAnn: Annotation = {
          id: saved.id,
          pieceId: musicId,
          pageNumber: pageNum,
          layer: saved.layer,
          strokeData: saved.strokeData ?? {},
          sectionId: saved.sectionId ?? null,
          userId: saved.userId,
          createdAt: saved.createdAt,
          updatedAt: saved.updatedAt,
        };
        if (!updated[newLayer]) {
          updated[newLayer] = {} as Record<string, Annotation[]>;
        }
        updated[newLayer][key] = [...(updated[newLayer][key] || []), newAnn];
        return { annotations: updated };
      });
    } catch (err) {
      console.error('updateAnnotation error', err);
    }
  },

  deleteAnnotation: (id: string) => {
    set((state) => ({
      annotations: {
        personal: { ...state.annotations.personal },
        section: { ...state.annotations.section },
        director: { ...state.annotations.director },
      },
    }));
    return (async () => {
      try {
        const res = await apiFetch(`/api/stand/annotations/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed to delete annotation');
        set((state) => {
          const updated = { ...state.annotations };
          (['personal', 'section', 'director'] as const).forEach((layer) => {
            Object.keys(updated[layer]).forEach((key) => {
              const newEntries = updated[layer][key]!.filter((a) => a.id !== id);
              if (newEntries.length === 0) {
                delete updated[layer][key];
              } else {
                updated[layer][key] = newEntries;
              }
            });
          });
          return { annotations: updated };
        });
      } catch (err) {
        console.error('deleteAnnotation error', err);
      }
    })();
  },

  setLayer: (layer: 'PERSONAL' | 'SECTION' | 'DIRECTOR') => set({ selectedLayer: layer }),
  setCurrentTool: (tool: Tool) => set({ currentTool: tool }),
  setToolColor: (color: string) => set({ toolColor: color }),
  setStrokeWidth: (width: number) => set({ strokeWidth: Math.max(1, Math.min(50, width)) }),
  setPressureScale: (scale: number) => set({ pressureScale: Math.max(0, Math.min(20, scale)) }),
  setSelectedStampId: (id: string) => set({ selectedStampId: id }),

  addNavigationLink: (link: NavigationLink) =>
    set((state) => ({
      navigationLinks: [...state.navigationLinks, link],
    })),

  setNavigationLinks: (links: NavigationLink[]) => set({ navigationLinks: links }),

  removeNavigationLink: (id: string) =>
    set((state) => ({
      navigationLinks: state.navigationLinks.filter((l) => l.id !== id),
    })),

  updateNavigationLink: (link: NavigationLink) =>
    set((state) => ({
      navigationLinks: state.navigationLinks.map((l) =>
        l.id === link.id ? link : l
      ),
    })),

  updateSettings: (newSettings: Partial<StandSettings>) =>
    set((state) => ({
      settings: { ...state.settings, ...newSettings },
    })),

  setEventInfo: (eventId: string, eventTitle: string) =>
    set({ eventId, eventTitle }),

  setUserContext: (ctx: UserContext) => set({ userContext: ctx }),

  updatePieceTotalPages: (pieceId: string, totalPages: number) =>
    set((state) => ({
      pieces: state.pieces.map((p) =>
        p.id === pieceId ? { ...p, totalPages } : p
      ),
    })),

  updatePiecePdfUrl: (pieceId: string, pdfUrl: string | null) =>
    set((state) => ({
      pieces: state.pieces.map((p) =>
        p.id === pieceId ? { ...p, pdfUrl } : p
      ),
    })),

  setRoster: (entries: StandRosterMember[]) => set({ roster: entries }),
  addRosterEntry: (entry: StandRosterMember) =>
    set((state) => ({
      roster:
        state.roster.some((e) => e.userId === entry.userId)
          ? state.roster
          : [...state.roster, entry],
    })),
  removeRosterEntry: (userId: string) =>
    set((state) => ({
      roster: state.roster.filter((e) => e.userId !== userId),
    })),

  setAudioLinks: (links: StandAudioLink[]) => set({ audioLinks: links }),
  selectAudioLink: (id: string | null) => set({ selectedAudioLinkId: id }),
  setAudioLoopPoints: (start: number | null, end: number | null) =>
    set({ audioLoopStart: start, audioLoopEnd: end }),
  setAudioPlaying: (playing: boolean) => set({ audioPlaying: playing }),

  toggleMetronome: () =>
    set((state) => ({ showMetronome: !state.showMetronome })),
  toggleTuner: () => set((state) => ({ showTuner: !state.showTuner })),
  toggleAudioPlayer: () =>
    set((state) => ({ showAudioPlayer: !state.showAudioPlayer })),
  togglePitchPipe: () =>
    set((state) => ({ showPitchPipe: !state.showPitchPipe })),

  updateMetronomeSettings: (settings) =>
    set((state) => ({ metronomeSettings: { ...state.metronomeSettings, ...settings } })),
  updateTunerSettings: (settings) =>
    set((state) => ({ tunerSettings: { ...state.tunerSettings, ...settings } })),
  updatePitchPipeSettings: (settings) =>
    set((state) => ({ pitchPipeSettings: { ...state.pitchPipeSettings, ...settings } })),

  updateAudioTrackerSettings: (settings) =>
    set((state) => ({ audioTrackerSettings: { ...state.audioTrackerSettings, ...settings } })),
  toggleAudioTracker: () =>
    set((state) => ({
      audioTrackerSettings: {
        ...state.audioTrackerSettings,
        enabled: !state.audioTrackerSettings.enabled,
      },
    })),

  reset: () => set(initialState),
  // PREFERENCE HELPERS
  loadPreferences: (prefs: Partial<{ midiMappings: Record<string, string> }>) => {
    if (prefs.midiMappings) {
      set({ midiMappings: prefs.midiMappings });
    }
  },
  savePreferences: async () => {
    try {
      const { midiMappings } = get();
      await apiFetch('/api/stand/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ midiMappings }),
      });
    } catch (err) {
      console.error('savePreferences error', err);
    }
  },
  setMidiMappings: (mappings: Record<string, string>) => set({ midiMappings: mappings }),
  updateMidiMapping: (key: string, action: string) =>
    set((state) => ({
      midiMappings: { ...state.midiMappings, [key]: action },
    })),
    }),
    {
      name: 'stand-view-preferences',
      storage: createJSONStorage(() => resolveViewPrefStorage()),
      partialize: (state) =>
        Object.fromEntries(
          PERSISTED_VIEW_KEYS.map((key) => [key, state[key]]),
        ) as unknown as StandState,
      // Rehydrated on the client only. Reading localStorage during SSR would
      // throw and would make the server and client markup disagree.
      skipHydration: false,
    },
  ),
);

// Selector hook for more specific state selections
export const useStoreSelector = <T>(selector: (state: StandState) => T): T => {
  return useStandStore(selector);
};

export interface StandAudioLink {
  id: string;
  pieceId: string;
  fileKey: string;
  url: string | null;
  description: string | null;
  createdAt: string;
}
// ... existing code ...
