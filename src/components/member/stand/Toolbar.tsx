'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Maximize2,
  Minimize2,
  Moon,
  Sun,
  Pencil,
  Highlighter,
  Eraser,
  Square,
  Type,
  Stamp,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  BookmarkIcon,
  ListMusicIcon,
  TimerIcon,
  MusicIcon,
} from 'lucide-react';
import { useStandStore, Tool } from '@/store/standStore';
import { useFullscreen } from './useFullscreen';
import { PerformanceModeToggle } from './PerformanceModeToggle';
import { Toggle } from '@/components/ui/toggle';
import { cn } from '@/lib/utils';

export interface ToolbarProps {
  /** Optional panel toggle callbacks — if omitted, panel buttons are hidden */
  onToggleBookmarks?: () => void;
  onToggleSetlists?: () => void;
  onTogglePractice?: () => void;
  onToggleAudio?: () => void;
  /** Active panel state for button highlight */
  activePanel?: 'bookmarks' | 'setlists' | 'practice' | 'audio' | null;
}

const TOOL_ICONS: Record<Tool, React.ReactNode> = {
  [Tool.PENCIL]: <Pencil className="h-4 w-4" />,
  [Tool.HIGHLIGHTER]: <Highlighter className="h-4 w-4" />,
  [Tool.ERASER]: <Eraser className="h-4 w-4" />,
  [Tool.WHITEOUT]: <Square className="h-4 w-4" />,
  [Tool.TEXT]: <Type className="h-4 w-4" />,
  [Tool.STAMP]: <Stamp className="h-4 w-4" />,
};

const TOOL_LABELS: Record<Tool, string> = {
  [Tool.PENCIL]: 'Pencil tool',
  [Tool.HIGHLIGHTER]: 'Highlighter tool',
  [Tool.ERASER]: 'Eraser tool',
  [Tool.WHITEOUT]: 'Whiteout tool',
  [Tool.TEXT]: 'Text tool',
  [Tool.STAMP]: 'Stamp tool',
};

const COLORS = [
  { value: '#ff0000', label: 'Red' },
  { value: '#ff6600', label: 'Orange' },
  { value: '#ffff00', label: 'Yellow' },
  { value: '#00ff00', label: 'Green' },
  { value: '#0000ff', label: 'Blue' },
  { value: '#800080', label: 'Purple' },
  { value: '#000000', label: 'Black' },
  { value: '#ffffff', label: 'White' },
];

export function Toolbar({
  onToggleBookmarks,
  onToggleSetlists,
  onTogglePractice,
  onToggleAudio,
  activePanel = null,
}: ToolbarProps = {}) {
  const {
    setIsFullscreen,
    isFullscreen,
    toggleNightMode,
    nightMode,
    selectedLayer,
    setLayer,
    editMode,
    toggleEditMode,
    currentTool,
    setCurrentTool,
    toolColor,
    setToolColor,
    strokeWidth,
    setStrokeWidth,
    _currentPage: currentPage,
    zoom,
    setZoom,
    nextPage,
    prevPage,
    setCurrentPage,
  } = useStandStore();

  const userContext = useStandStore((state) => state.userContext);
  const totalPages =
    useStandStore((s) => s.pieces[s.currentPieceIndex]?.totalPages ?? 1) || 1;

  const layerPermissions: Record<'PERSONAL' | 'SECTION' | 'DIRECTOR', boolean> = {
    PERSONAL: true,
    SECTION: Boolean(userContext?.isDirector || userContext?.isSectionLeader),
    DIRECTOR: Boolean(userContext?.isDirector),
  };

  const layerDescriptions: Record<'PERSONAL' | 'SECTION' | 'DIRECTOR', string> = {
    PERSONAL: 'Personal annotation layer',
    SECTION: layerPermissions.SECTION
      ? 'Section annotation layer'
      : 'Section annotations are limited to section leaders and directors',
    DIRECTOR: layerPermissions.DIRECTOR
      ? 'Director annotation layer'
      : 'Director annotations are limited to directors',
  };

  const [isUpdating, setIsUpdating] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);

  const { toggleFullscreen } = useFullscreen({
    onChange: (fullscreen) => {
      setIsFullscreen(fullscreen);
    },
  });

  const handleFullscreenToggle = () => {
    toggleFullscreen();
  };

  const handleNightModeToggle = async () => {
    toggleNightMode();
    setIsUpdating(true);
    try {
      const response = await fetch('/api/stand/preferences', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ nightMode: !nightMode }),
      });

      if (!response.ok) {
        toggleNightMode();
        console.error('Failed to persist night mode preference');
      }
    } catch (error) {
      toggleNightMode();
      console.error('Error persisting night mode preference:', error);
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <div
      className="flex items-center gap-2"
      role="toolbar"
      aria-label="Music stand controls"
    >
      <div className="sr-only" aria-live="polite" id="toolbar-shortcuts-help">
        Keyboard shortcuts: Arrow keys or Page Up/Down to navigate pages, M for metronome, T for tuner, P for pitch pipe, A for audio player
      </div>

      <Button
        variant="ghost"
        size="icon"
        onClick={handleNightModeToggle}
        disabled={isUpdating}
        title={nightMode ? 'Switch to Day Mode' : 'Switch to Night Mode'}
        aria-label={nightMode ? 'Switch to Day Mode' : 'Switch to Night Mode'}
        aria-pressed={nightMode}
        className="min-w-[44px] min-h-[44px]"
      >
        {nightMode ? (
          <Sun className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Moon className="h-4 w-4" aria-hidden="true" />
        )}
      </Button>

      <div className="flex items-center space-x-1" role="group" aria-label="Annotation layers">
        {(['PERSONAL', 'SECTION', 'DIRECTOR'] as const).map((layer) => (
          <Button
            key={layer}
            variant={selectedLayer === layer ? 'secondary' : 'ghost'}
            size="icon"
            onClick={() => layerPermissions[layer] && setLayer(layer)}
            title={layerDescriptions[layer]}
            aria-label={layerDescriptions[layer]}
            aria-pressed={selectedLayer === layer}
            disabled={!layerPermissions[layer]}
            className="min-w-[44px] min-h-[44px]"
          >
            {layer.charAt(0)}
          </Button>
        ))}
      </div>

      <Toggle
        pressed={editMode}
        onPressedChange={toggleEditMode}
        className="ml-2 min-w-[44px] min-h-[44px]"
        aria-label="Toggle edit mode for annotations"
      >
        Edit
      </Toggle>

      {editMode && (
        <>
          <div
            className="flex items-center space-x-1 border-l pl-2 ml-2"
            role="group"
            aria-label="Annotation tools"
          >
            {Object.values(Tool).map((tool) => (
              <Button
                key={tool}
                variant={currentTool === tool ? 'secondary' : 'ghost'}
                size="icon"
                onClick={() => setCurrentTool(tool)}
                title={TOOL_LABELS[tool]}
                aria-label={TOOL_LABELS[tool]}
                aria-pressed={currentTool === tool}
                disabled={!editMode}
                className="min-w-[44px] min-h-[44px]"
              >
                {TOOL_ICONS[tool]}
              </Button>
            ))}
          </div>

          <div className="relative">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowColorPicker(!showColorPicker)}
              title="Select annotation color"
              aria-label={`Select annotation color, current: ${
                COLORS.find((c) => c.value === toolColor)?.label || 'custom'
              }`}
              aria-expanded={showColorPicker}
              aria-haspopup="listbox"
              style={{ backgroundColor: toolColor }}
              className={cn(
                'w-11 h-11 rounded-full border-2 min-w-[44px] min-h-[44px]',
                toolColor === '#ffffff' && 'border-gray-400'
              )}
            />
            {showColorPicker && (
              <div
                className="absolute top-full mt-1 p-2 bg-background border rounded-lg shadow-lg z-50 grid grid-cols-4 gap-1"
                role="listbox"
                aria-label="Color options"
              >
                {COLORS.map((color) => (
                  <button
                    key={color.value}
                    onClick={() => {
                      setToolColor(color.value);
                      setShowColorPicker(false);
                    }}
                    className={cn(
                      'w-8 h-8 rounded-full border-2 min-w-[44px] min-h-[44px] flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                      color.value === '#ffffff'
                        ? 'border-gray-400'
                        : 'border-transparent',
                      toolColor === color.value && 'ring-2 ring-primary'
                    )}
                    style={{ backgroundColor: color.value }}
                    role="option"
                    aria-label={color.label}
                    aria-selected={toolColor === color.value}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-1">
            <label htmlFor="stroke-width" className="sr-only">
              Stroke width: {strokeWidth}px
            </label>
            <input
              id="stroke-width"
              type="range"
              min="1"
              max="20"
              value={strokeWidth}
              onChange={(e) => setStrokeWidth(parseInt(e.target.value, 10))}
              className="w-20 h-8 bg-gray-200 rounded-lg appearance-none cursor-pointer"
              title={`Stroke width: ${strokeWidth}`}
              aria-valuemin={1}
              aria-valuemax={20}
              aria-valuenow={strokeWidth}
            />
            <span className="text-xs text-muted-foreground w-4" aria-hidden="true">
              {strokeWidth}
            </span>
          </div>
        </>
      )}

      <PerformanceModeToggle />

      <div className="flex items-center gap-1 border-l pl-2 ml-1" role="group" aria-label="Page navigation">
        <Button
          variant="ghost"
          size="icon"
          onClick={prevPage}
          disabled={currentPage <= 1}
          title="Previous page"
          aria-label="Previous page"
          className="min-w-[44px] min-h-[44px]"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </Button>
        <div className="flex items-center gap-1">
          <label htmlFor="tb-page-input" className="sr-only">
            Go to page
          </label>
          <input
            id="tb-page-input"
            type="number"
            min={1}
            max={totalPages}
            value={currentPage}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!isNaN(v)) setCurrentPage(v);
            }}
            className="w-12 h-8 text-center text-sm border rounded bg-background"
            aria-label={`Page ${currentPage} of ${totalPages}`}
          />
          <span className="text-xs text-muted-foreground" aria-hidden="true">
            / {totalPages}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={nextPage}
          disabled={currentPage >= totalPages}
          title="Next page"
          aria-label="Next page"
          className="min-w-[44px] min-h-[44px]"
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      <div className="flex items-center gap-1 border-l pl-2 ml-1" role="group" aria-label="Zoom controls">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setZoom(Math.max(50, zoom - 10))}
          title="Zoom out"
          aria-label="Zoom out"
          className="min-w-[44px] min-h-[44px]"
        >
          <ZoomOut className="h-4 w-4" aria-hidden="true" />
        </Button>
        <button
          className="text-xs tabular-nums w-12 text-center bg-muted rounded px-1 py-1 hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          onClick={() => setZoom(100)}
          title="Reset zoom to 100%"
          aria-label={`Zoom ${zoom}%, click to reset`}
        >
          {zoom}%
        </button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setZoom(Math.min(200, zoom + 10))}
          title="Zoom in"
          aria-label="Zoom in"
          className="min-w-[44px] min-h-[44px]"
        >
          <ZoomIn className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      {(onToggleBookmarks || onToggleSetlists || onTogglePractice || onToggleAudio) && (
        <div className="flex items-center gap-1 border-l pl-2 ml-1" role="group" aria-label="Panels">
          {onToggleBookmarks && (
            <Button
              variant={activePanel === 'bookmarks' ? 'secondary' : 'ghost'}
              size="icon"
              onClick={onToggleBookmarks}
              title="Bookmarks"
              aria-label="Toggle bookmarks panel"
              aria-pressed={activePanel === 'bookmarks'}
              className="min-w-[44px] min-h-[44px]"
            >
              <BookmarkIcon className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
          {onToggleSetlists && (
            <Button
              variant={activePanel === 'setlists' ? 'secondary' : 'ghost'}
              size="icon"
              onClick={onToggleSetlists}
              title="Setlists"
              aria-label="Toggle setlists panel"
              aria-pressed={activePanel === 'setlists'}
              className="min-w-[44px] min-h-[44px]"
            >
              <ListMusicIcon className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
          {onTogglePractice && (
            <Button
              variant={activePanel === 'practice' ? 'secondary' : 'ghost'}
              size="icon"
              onClick={onTogglePractice}
              title="Practice timer"
              aria-label="Toggle practice timer panel"
              aria-pressed={activePanel === 'practice'}
              className="min-w-[44px] min-h-[44px]"
            >
              <TimerIcon className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
          {onToggleAudio && (
            <Button
              variant={activePanel === 'audio' ? 'secondary' : 'ghost'}
              size="icon"
              onClick={onToggleAudio}
              title="Audio"
              aria-label="Toggle audio panel"
              aria-pressed={activePanel === 'audio'}
              className="min-w-[44px] min-h-[44px]"
            >
              <MusicIcon className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
        </div>
      )}

      <div className="flex items-center space-x-1" role="group" aria-label="Rehearsal utilities">
        <Button
          variant="ghost"
          size="icon"
          onClick={useStandStore.getState().toggleMetronome}
          title="Toggle metronome (M)"
          aria-label="Toggle metronome"
          className="min-w-[44px] min-h-[44px]"
        >
          M
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={useStandStore.getState().toggleTuner}
          title="Toggle tuner (T)"
          aria-label="Toggle tuner"
          className="min-w-[44px] min-h-[44px]"
        >
          T
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={useStandStore.getState().toggleAudioPlayer}
          title="Toggle audio player (A)"
          aria-label="Toggle audio player"
          className="min-w-[44px] min-h-[44px]"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
            <circle
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="2"
              fill="none"
            />
            <polygon points="10,8 16,12 10,16" fill="currentColor" />
          </svg>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={useStandStore.getState().togglePitchPipe}
          title="Toggle pitch pipe (P)"
          aria-label="Toggle pitch pipe"
          className="min-w-[44px] min-h-[44px]"
        >
          P
        </Button>
      </div>

      <Button
        variant="ghost"
        size="icon"
        onClick={handleFullscreenToggle}
        title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        className="min-w-[44px] min-h-[44px]"
      >
        {isFullscreen ? (
          <Minimize2 className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Maximize2 className="h-4 w-4" aria-hidden="true" />
        )}
      </Button>
    </div>
  );
}

Toolbar.displayName = 'Toolbar';
