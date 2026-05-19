'use client';

import React, { useRef, useState, useCallback, useEffect } from 'react';
import { useStandStore } from '@/store/standStore';
import type { NavigationLink } from '@/store/standStore';

interface DrawRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface PendingLink {
  rect: DrawRect;
}

interface NavigationLinkResponse {
  id: string;
  fromPage: number;
  fromX: number;
  fromY: number;
  toPage: number;
  toMusicId: string | null;
  toX: number;
  toY: number;
  label: string | null;
  musicId: string;
}

/**
 * SmartNavEditor
 *
 * Renders an overlay over the current page for two purposes:
 *  1. **View mode**: clickable hotspot rectangles that jump to the destination page.
 *  2. **Edit mode**: draw new hotspot rectangles, then set a label + destination page.
 *
 * Toggle edit mode with the pencil button in the bottom-right corner.
 */
export function SmartNavEditor() {
  const {
    navigationLinks,
    addNavigationLink,
    removeNavigationLink,
    _currentPage: currentPage,
    pieces,
    currentPieceIndex,
    setCurrentPage,
    setCurrentPieceIndex,
    userContext,
  } = useStandStore();

  const currentPiece = pieces[currentPieceIndex];

  // Local state
  const [editMode, setEditMode] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [drawRect, setDrawRect] = useState<DrawRect | null>(null);
  const [pendingLink, setPendingLink] = useState<PendingLink | null>(null);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formLabel, setFormLabel] = useState('');
  const [formDestPage, setFormDestPage] = useState(1);
  const [formDestPieceIdx, setFormDestPieceIdx] = useState(currentPieceIndex);
  const [saving, setSaving] = useState(false);

  // Directors and librarians can edit navigation links
  const canEdit =
    userContext?.isDirector === true ||
    userContext?.roles.includes('LIBRARIAN') === true;

  const overlayRef = useRef<HTMLDivElement>(null);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);

  // ── Links visible on the current page ──────────────────────────────────────
  const visibleLinks = navigationLinks.filter(
    (l) => l.fromPieceId === currentPiece?.id && l.fromPage === currentPage
  );

  // ── Coordinate helpers ─────────────────────────────────────────────────────
  const getRelativePos = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): { x: number; y: number } | null => {
      const el = overlayRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) / rect.width,
        y: (e.clientY - rect.top) / rect.height,
      };
    },
    []
  );

  // ── Drawing handlers ───────────────────────────────────────────────────────
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!editMode) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const pos = getRelativePos(e);
      if (!pos) return;
      startPosRef.current = pos;
      setDrawing(true);
      setDrawRect({ x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y });
    },
    [editMode, getRelativePos]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!drawing || !startPosRef.current) return;
      const pos = getRelativePos(e);
      if (!pos) return;
      setDrawRect({
        x1: startPosRef.current.x,
        y1: startPosRef.current.y,
        x2: pos.x,
        y2: pos.y,
      });
    },
    [drawing, getRelativePos]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!drawing || !drawRect) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      setDrawing(false);

      // Ignore tiny accidental clicks
      const width = Math.abs(drawRect.x2 - drawRect.x1);
      const height = Math.abs(drawRect.y2 - drawRect.y1);
      if (width < 0.01 || height < 0.01) {
        setDrawRect(null);
        return;
      }

      // Open the configuration dialog
      setPendingLink({ rect: drawRect });
      setFormLabel('');
      setFormDestPage(currentPage + 1 > (currentPiece?.totalPages ?? 999) ? currentPage : currentPage + 1);
      setFormDestPieceIdx(currentPieceIndex);
      setDialogOpen(true);
    },
    [drawing, drawRect, currentPage, currentPiece?.totalPages, currentPieceIndex]
  );

  // ── Save handler ───────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!pendingLink || !currentPiece) return;

    const { rect } = pendingLink;
    const destPiece = pieces[formDestPieceIdx];
    if (!destPiece) return;

    const x1 = Math.min(rect.x1, rect.x2);
    const y1 = Math.min(rect.y1, rect.y2);
    const x2 = Math.max(rect.x1, rect.x2);
    const y2 = Math.max(rect.y1, rect.y2);

    setSaving(true);
    try {
      const res = await fetch('/api/stand/navigation-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          musicId: currentPiece.id,
          fromPage: currentPage,
          fromX: x1,
          fromY: y1,
          toPage: formDestPage,
          toMusicId: destPiece.id !== currentPiece.id ? destPiece.id : null,
          toX: x2,
          toY: y2,
          label: formLabel || undefined,
        }),
      });
      if (!res.ok) throw new Error(`Save failed: ${res.status}`);
      const payload = (await res.json()) as {
        navigationLink?: NavigationLinkResponse;
        link?: NavigationLinkResponse;
      };
      const link = payload.navigationLink ?? payload.link;
      if (!link) throw new Error('Save failed: missing navigation link payload');

      const navLink: NavigationLink = {
        id: link.id,
        fromPieceId: link.musicId,
        fromPage: link.fromPage,
        fromX: link.fromX,
        fromY: link.fromY,
        toPieceId: link.toMusicId ?? destPiece.id,
        toPage: link.toPage,
        toX: link.toX,
        toY: link.toY,
        label: link.label ?? '',
        toMusicId: link.toMusicId ?? null,
      };
      addNavigationLink(navLink);
    } catch (err) {
      console.error('Failed to save navigation link:', err);
    } finally {
      setSaving(false);
      setDialogOpen(false);
      setPendingLink(null);
      setDrawRect(null);
    }
  }, [pendingLink, currentPiece, pieces, formDestPieceIdx, formDestPage, formLabel, currentPage, addNavigationLink]);

  // ── Delete handler ─────────────────────────────────────────────────────────
  const handleDelete = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/stand/navigation-links/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
        removeNavigationLink(id);
      } catch (err) {
        console.error('Failed to delete nav link:', err);
      }
    },
    [removeNavigationLink]
  );

  // ── Navigate on hotspot click ──────────────────────────────────────────────
  const handleHotspotClick = useCallback(
    (link: NavigationLink) => {
      if (editMode) return; // in edit mode, don't navigate
      const destIdx = pieces.findIndex((p) => p.id === link.toPieceId);
      if (destIdx >= 0) setCurrentPieceIndex(destIdx);
      setCurrentPage(link.toPage);
    },
    [editMode, pieces, setCurrentPieceIndex, setCurrentPage]
  );

  // Close dialog on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDialogOpen(false);
        setPendingLink(null);
        setDrawRect(null);
        setDrawing(false);
      }
    };
    if (dialogOpen) document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dialogOpen]);

  // Normalise a 0-1 rect to percentage CSS properties
  function rectToStyle(r: DrawRect) {
    const left = Math.min(r.x1, r.x2) * 100;
    const top = Math.min(r.y1, r.y2) * 100;
    const width = Math.abs(r.x2 - r.x1) * 100;
    const height = Math.abs(r.y2 - r.y1) * 100;
    return { left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` };
  }

  return (
    <>
      {/* Transparent overlay for capturing pointer events */}
      <div
        ref={overlayRef}
        className="absolute inset-0 z-20"
        style={{ cursor: editMode ? 'crosshair' : 'default', pointerEvents: editMode ? 'auto' : 'none' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {/* In-progress draw rectangle */}
        {drawing && drawRect && (
          <div
            className="absolute border-2 border-dashed border-primary bg-primary/10 pointer-events-none"
            style={rectToStyle(drawRect)}
          />
        )}
      </div>

      {/* Existing hotspot overlays — always visible */}
      <div className="absolute inset-0 z-21 pointer-events-none">
        {visibleLinks.map((link) => (
          <div
            key={link.id}
            className="absolute border-2 border-amber-400/70 bg-amber-400/10 hover:bg-amber-400/20 transition-colors rounded group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            style={{ ...rectToStyle({ x1: link.fromX, y1: link.fromY, x2: link.toX, y2: link.toY }), pointerEvents: 'auto' }}
            onClick={() => handleHotspotClick(link)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleHotspotClick(link);
              }
            }}
            role="button"
            tabIndex={0}
            aria-label={`Navigation hotspot: ${link.label || `page ${link.toPage}`}`}
          >
            {/* Label tooltip */}
            <span
              className="absolute -top-6 left-0 bg-amber-600 text-white text-xs px-1 py-0.5 rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ pointerEvents: 'none' }}
            >
              {link.label || `→ p.${link.toPage}`}
            </span>
            {/* Delete button (only in edit mode) */}
            {editMode && (
              <button
                className="absolute -top-2 -right-2 w-4 h-4 bg-destructive text-destructive-foreground text-xs rounded-full flex items-center justify-center leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                onClick={(e) => { e.stopPropagation(); void handleDelete(link.id); }}
                style={{ pointerEvents: 'auto' }}
                title="Delete hotspot"
                aria-label="Delete hotspot"
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Edit mode toggle button — directors only */}
      {canEdit && (
        <button
          className={`absolute bottom-12 right-2 z-30 px-2 py-1 text-xs rounded shadow border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${
            editMode
              ? 'bg-primary text-primary-foreground border-primary'
              : 'bg-card text-foreground border-border hover:bg-muted'
          }`}
          onClick={() => {
            setEditMode((v) => !v);
            setDrawRect(null);
            setDrawing(false);
          }}
          title={editMode ? 'Exit nav editor' : 'Edit navigation hotspots'}
          aria-label={editMode ? 'Exit nav editor' : 'Edit navigation hotspots'}
        >
          {editMode ? 'Done' : '🔗 Nav'}
        </button>
      )}

      {/* Configuration dialog */}
      {dialogOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={(e) => { if (e.target === e.currentTarget) { setDialogOpen(false); setPendingLink(null); setDrawRect(null); } }}
        >
          <div className="bg-card rounded-lg shadow-xl p-6 w-80 space-y-4">
            <h2 className="text-base font-semibold">Configure navigation hotspot</h2>

            <label className="block space-y-1 text-sm">
              <span>Label (optional)</span>
              <input
                autoFocus
                type="text"
                value={formLabel}
                onChange={(e) => setFormLabel(e.target.value)}
                placeholder="e.g. D.C. al Fine"
                className="w-full border rounded px-2 py-1 bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>

            <label className="block space-y-1 text-sm">
              <span>Destination piece</span>
              <select
                value={formDestPieceIdx}
                onChange={(e) => setFormDestPieceIdx(Number(e.target.value))}
                className="w-full border rounded px-2 py-1 bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {pieces.map((p, i) => (
                  <option key={p.id} value={i}>
                    {i + 1}. {p.title}
                  </option>
                ))}
              </select>
            </label>

            <label className="block space-y-1 text-sm">
              <span>Destination page</span>
              <input
                type="number"
                min={1}
                value={formDestPage}
                onChange={(e) => setFormDestPage(Math.max(1, Number(e.target.value)))}
                className="w-full border rounded px-2 py-1 bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>

            <div className="flex gap-2 justify-end pt-2">
              <button
                onClick={() => { setDialogOpen(false); setPendingLink(null); setDrawRect(null); }}
                className="px-3 py-1.5 text-sm border rounded hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                aria-label="Cancel"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleSave()}
                disabled={saving}
                className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                aria-label="Save hotspot"
              >
                {saving ? 'Saving…' : 'Save hotspot'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

SmartNavEditor.displayName = 'SmartNavEditor';
