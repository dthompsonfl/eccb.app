'use client';

/**
 * SetlistsPanel — CRUD for event setlists.
 * Lists setlists the user has access to, allows creating a new one,
 * adding/removing pieces, and deleting a setlist they own.
 *
 * Directors can create setlists; members can view linked setlists.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  ListMusicIcon,
  PlusIcon,
  Trash2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2,
  RefreshCw,
  XIcon,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export interface SetlistPiece {
  id: string;
  title: string;
  composer: string | null;
  sortOrder: number;
}

export interface Setlist {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  ownerId: string;
  pieces: SetlistPiece[];
  createdAt: string;
}

export interface SetlistsPanelProps {
  className?: string;
  eventId?: string;
  /** User role for permission gating */
  canManage?: boolean;
}

export function SetlistsPanel({ className, eventId: _eventId, canManage = false }: SetlistsPanelProps) {
  const [setlists, setSetlists] = useState<Setlist[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newName, setNewName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const fetchSetlists = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/stand/setlists');
      if (!res.ok) throw new Error(`Failed to load setlists: ${res.status}`);
      const data = await res.json();
      setSetlists(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load setlists');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSetlists();
  }, [fetchSetlists]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setIsCreating(true);
    setCreateError(null);
    try {
      const res = await fetch('/api/stand/setlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Status ${res.status}`);
      }
      setNewName('');
      setShowCreateDialog(false);
      await fetchSetlists();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create setlist');
    } finally {
      setIsCreating(false);
    }
  };

  const handleDelete = async (setlistId: string) => {
    setDeletingId(setlistId);
    setError(null);
    try {
      const res = await fetch('/api/stand/setlists', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: setlistId }),
      });
      if (!res.ok) throw new Error('Failed to delete setlist');
      setSetlists((prev) => prev.filter((s) => s.id !== setlistId));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete setlist';
      console.error('Delete setlist failed:', err);
      setError(message);
    } finally {
      setDeletingId(null);
    }
  };

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          <ListMusicIcon className="h-4 w-4" />
          Setlists
          {setlists.length > 0 && (
            <Badge variant="secondary" className="ml-1">{setlists.length}</Badge>
          )}
        </h3>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void fetchSetlists()}
            disabled={isLoading}
            aria-label="Refresh setlists"
            title="Refresh setlists"
            className="h-7 w-7"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
          </Button>
          {canManage && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowCreateDialog(true)}
              aria-label="Create new setlist"
              title="Create setlist"
              className="h-7 w-7"
            >
              <PlusIcon className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-6 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          Loading…
        </div>
      )}

      {/* Error */}
      {error && !isLoading && (
        <p className="text-xs text-destructive py-2">{error}</p>
      )}

      {/* Empty */}
      {!isLoading && !error && setlists.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-4">
          {canManage
            ? 'No setlists yet. Create one using the + button above.'
            : 'No setlists for this event.'}
        </p>
      )}

      {/* Setlist list */}
      {!isLoading && setlists.length > 0 && (
        <ul className="space-y-1" aria-label="Setlists">
          {setlists.map((setlist) => (
            <li
              key={setlist.id}
              className="rounded-md border bg-card overflow-hidden"
            >
              <div className="flex items-center gap-2 p-2">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  onClick={() => toggleExpand(setlist.id)}
                  aria-expanded={expandedId === setlist.id}
                  aria-label={expandedId === setlist.id ? 'Collapse' : 'Expand'}
                >
                  {expandedId === setlist.id ? (
                    <ChevronDownIcon className="h-3 w-3" />
                  ) : (
                    <ChevronRightIcon className="h-3 w-3" />
                  )}
                </Button>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{setlist.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {setlist.pieces.length} piece{setlist.pieces.length !== 1 ? 's' : ''}
                  </p>
                </div>
                {canManage && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
                    onClick={() => void handleDelete(setlist.id)}
                    disabled={deletingId === setlist.id}
                    aria-label={`Delete ${setlist.name}`}
                    title="Delete setlist"
                  >
                    {deletingId === setlist.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2Icon className="h-3.5 w-3.5" />
                    )}
                  </Button>
                )}
              </div>

              {/* Expanded pieces */}
              {expandedId === setlist.id && setlist.pieces.length > 0 && (
                <ol
                  className="border-t divide-y"
                  aria-label={`Pieces in ${setlist.name}`}
                >
                  {setlist.pieces
                    .slice()
                    .sort((a, b) => a.sortOrder - b.sortOrder)
                    .map((piece, idx) => (
                      <li key={piece.id} className="flex items-center gap-2 px-3 py-1.5 bg-muted/30">
                        <span className="text-xs text-muted-foreground w-5 shrink-0">{idx + 1}.</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium truncate">{piece.title}</p>
                          {piece.composer && (
                            <p className="text-xs text-muted-foreground truncate">{piece.composer}</p>
                          )}
                        </div>
                      </li>
                    ))}
                </ol>
              )}
              {expandedId === setlist.id && setlist.pieces.length === 0 && (
                <p className="text-xs text-muted-foreground px-4 py-2 border-t">No pieces in this setlist.</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Create dialog */}
      <Dialog open={showCreateDialog} onOpenChange={(open) => { setShowCreateDialog(open); if (!open) { setNewName(''); setCreateError(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Setlist</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="setlist-name">Name</Label>
              <Input
                id="setlist-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Spring Concert 2026"
                autoFocus
                maxLength={100}
              />
            </div>
            {createError && (
              <p className="text-xs text-destructive">{createError}</p>
            )}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  <XIcon className="h-3.5 w-3.5 mr-1.5" />
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={isCreating || !newName.trim()}>
                {isCreating && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
