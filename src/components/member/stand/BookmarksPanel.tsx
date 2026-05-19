'use client';

/**
 * BookmarksPanel — lists, reorders, and removes piece bookmarks.
 * Used by StandViewer and the Stand Hub page.
 *
 * Features:
 *   - List bookmarks ordered by sortOrder
 *   - Remove a bookmark
 *   - Navigate to the bookmarked piece in the viewer (via onSelect callback)
 *   - Loading and empty states
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  BookmarkIcon,
  BookmarkXIcon,
  ArrowRight,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export interface Bookmark {
  id: string;
  pieceId: string;
  title: string;
  composer: string | null;
  sortOrder: number;
  createdAt: string;
}

export interface BookmarksPanelProps {
  className?: string;
  /** Called when user clicks "Open" on a bookmark */
  onSelect?: (pieceId: string) => void;
  /** If provided, shows an "Add bookmark" button for the current piece */
  currentPieceId?: string;
}

export function BookmarksPanel({ className, onSelect, currentPieceId }: BookmarksPanelProps) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [addingBookmark, setAddingBookmark] = useState(false);

  const currentIsBookmarked = bookmarks.some((b) => b.pieceId === currentPieceId);

  const fetchBookmarks = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/stand/bookmarks');
      if (!res.ok) throw new Error(`Failed to load bookmarks: ${res.status}`);
      const data = await res.json();
      setBookmarks(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load bookmarks');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchBookmarks();
  }, [fetchBookmarks]);

  const handleRemove = async (bookmark: Bookmark) => {
    setRemovingId(bookmark.id);
    setError(null);
    try {
      const res = await fetch(
        `/api/stand/bookmarks?pieceId=${encodeURIComponent(bookmark.pieceId)}`,
        { method: 'DELETE' }
      );
      if (!res.ok) throw new Error('Failed to remove bookmark');
      setBookmarks((prev) => prev.filter((b) => b.id !== bookmark.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to remove bookmark';
      console.error('Remove bookmark failed:', err);
      setError(message);
    } finally {
      setRemovingId(null);
    }
  };

  const handleAddCurrent = async () => {
    if (!currentPieceId || currentIsBookmarked) return;
    setAddingBookmark(true);
    setError(null);
    try {
      const res = await fetch('/api/stand/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pieceId: currentPieceId }),
      });
      if (!res.ok) throw new Error('Failed to add bookmark');
      await fetchBookmarks();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add bookmark';
      console.error('Add bookmark failed:', err);
      setError(message);
    } finally {
      setAddingBookmark(false);
    }
  };

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          <BookmarkIcon className="h-4 w-4" />
          Bookmarks
          {bookmarks.length > 0 && (
            <Badge variant="secondary" className="ml-1">{bookmarks.length}</Badge>
          )}
        </h3>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void fetchBookmarks()}
          disabled={isLoading}
          aria-label="Refresh bookmarks"
          title="Refresh bookmarks"
          className="h-7 w-7"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
        </Button>
      </div>

      {/* Add current piece button */}
      {currentPieceId && (
        <Button
          variant={currentIsBookmarked ? 'outline' : 'default'}
          size="sm"
          onClick={() => void handleAddCurrent()}
          disabled={addingBookmark || currentIsBookmarked}
          className="w-full"
          aria-label={currentIsBookmarked ? 'Already bookmarked' : 'Bookmark current piece'}
        >
          {addingBookmark ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <BookmarkIcon className="h-3.5 w-3.5 mr-1.5" />
          )}
          {currentIsBookmarked ? 'Bookmarked' : 'Bookmark this piece'}
        </Button>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center py-6 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          Loading…
        </div>
      )}

      {/* Error state */}
      {error && !isLoading && (
        <p className="text-xs text-destructive py-2">{error}</p>
      )}

      {/* Empty state */}
      {!isLoading && !error && bookmarks.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-4">
          No bookmarks yet. Bookmark pieces you want to revisit quickly.
        </p>
      )}

      {/* Bookmark list */}
      {!isLoading && bookmarks.length > 0 && (
        <ul className="space-y-1" aria-label="Bookmarked pieces">
          {bookmarks.map((bookmark) => (
            <li
              key={bookmark.id}
              className="flex items-center gap-2 p-2 rounded-md border bg-card hover:bg-muted/50 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{bookmark.title}</p>
                {bookmark.composer && (
                  <p className="text-xs text-muted-foreground truncate">{bookmark.composer}</p>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {onSelect && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => onSelect(bookmark.pieceId)}
                    aria-label={`Open ${bookmark.title}`}
                    title={`Open ${bookmark.title}`}
                  >
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  onClick={() => void handleRemove(bookmark)}
                  disabled={removingId === bookmark.id}
                  aria-label={`Remove bookmark for ${bookmark.title}`}
                  title="Remove bookmark"
                >
                  {removingId === bookmark.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <BookmarkXIcon className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
