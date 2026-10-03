'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ArrowUp,
  ArrowDown,
  Printer,
  FileDown,
  Eye,
  Users,
  Clock,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import { UNKNOWN_DURATION_LABEL } from '@/lib/events/program';
import {
  assignProgramPerformer,
  unassignProgramPerformer,
  reorderEventProgram,
  regenerateEventProgramOrder,
} from '@/app/(admin)/admin/events/program-actions';

export interface ProgramBuilderItem {
  id: string;
  position: number;
  pieceId: string;
  title: string;
  composer: string | null;
  durationLabel: string;
  durationKnown: boolean;
  performers: Array<{
    memberId: string;
    name: string;
    partName: string | null;
    sectionNames: string[];
  }>;
}

export interface ProgramBuilderRuntime {
  label: string;
  isLowerBound: boolean;
  unknownCount: number;
  pieceCount: number;
}

export interface ProgramMemberOption {
  id: string;
  name: string;
  sectionNames: string[];
}

interface ProgramBuilderProps {
  eventId: string;
  initialItems: ProgramBuilderItem[];
  runtime: ProgramBuilderRuntime;
  members: ProgramMemberOption[];
  isPublished: boolean;
}

export function ProgramBuilder({
  eventId,
  initialItems,
  runtime,
  members,
  isPublished,
}: ProgramBuilderProps) {
  const [items, setItems] = useState<ProgramBuilderItem[]>(initialItems);
  const [isPending, startTransition] = useTransition();
  const [assigningPieceId, setAssigningPieceId] = useState<string | null>(null);
  const [selectedMemberId, setSelectedMemberId] = useState('');
  const [partName, setPartName] = useState('');

  function persistOrder(next: ProgramBuilderItem[]): void {
    setItems(next.map((item, index) => ({ ...item, position: index + 1 })));
    startTransition(async () => {
      const result = await reorderEventProgram(
        eventId,
        next.map((item) => item.id)
      );
      if (!result.success) {
        toast.error(result.error ?? 'Failed to save the new order');
      }
    });
  }

  function move(fromIndex: number, toIndex: number): void {
    if (toIndex < 0 || toIndex >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    persistOrder(next);
  }

  function startAssign(pieceId: string): void {
    setAssigningPieceId(assigningPieceId === pieceId ? null : pieceId);
    setSelectedMemberId('');
    setPartName('');
  }

  function submitAssignment(pieceId: string): void {
    if (!selectedMemberId) {
      toast.error('Pick a performer first');
      return;
    }
    const member = members.find((m) => m.id === selectedMemberId);
    if (!member) return;

    startTransition(async () => {
      const result = await assignProgramPerformer({
        eventId,
        pieceId,
        memberId: selectedMemberId,
        partName: partName.trim() || undefined,
      });
      if (result.success) {
        setItems((prev) =>
          prev.map((item) =>
            item.pieceId === pieceId
              ? {
                  ...item,
                  performers: [
                    ...item.performers.filter((p) => p.memberId !== member.id),
                    {
                      memberId: member.id,
                      name: member.name,
                      partName: partName.trim() || null,
                      sectionNames: member.sectionNames,
                    },
                  ].sort((a, b) => a.name.localeCompare(b.name)),
                }
              : item
          )
        );
        setAssigningPieceId(null);
        setSelectedMemberId('');
        setPartName('');
        toast.success(`Assigned ${member.name}`);
      } else {
        toast.error(result.error ?? 'Failed to assign performer');
      }
    });
  }

  function removePerformer(pieceId: string, memberId: string): void {
    startTransition(async () => {
      const result = await unassignProgramPerformer({ eventId, pieceId, memberId });
      if (result.success) {
        setItems((prev) =>
          prev.map((item) =>
            item.pieceId === pieceId
              ? { ...item, performers: item.performers.filter((p) => p.memberId !== memberId) }
              : item
          )
        );
        toast.success('Performer removed');
      } else {
        toast.error(result.error ?? 'Failed to remove performer');
      }
    });
  }

  const selectedMember = members.find((m) => m.id === selectedMemberId) ?? null;

  return (
    <div className="space-y-6">
      {/* Runtime summary */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3">
        <Clock className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium">Total running time: {runtime.label}</span>
        {runtime.isLowerBound && (
          <Badge
            variant="outline"
            className="border-amber-400 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <AlertTriangle className="mr-1 h-3 w-3" />
            {runtime.unknownCount} of {runtime.pieceCount} unknown — minimum only
          </Badge>
        )}
      </div>

      {/* Output links */}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" asChild>
          <a href={`/events/${eventId}/program`} target="_blank" rel="noreferrer">
            <Eye className="mr-2 h-4 w-4" />
            Public program
          </a>
        </Button>
        <Button variant="outline" size="sm" asChild>
          <a href={`/events/${eventId}/program/print`} target="_blank" rel="noreferrer">
            <Printer className="mr-2 h-4 w-4" />
            Print view
          </a>
        </Button>
        <Button variant="outline" size="sm" asChild>
          <a href={`/api/events/${eventId}/program.pdf`} target="_blank" rel="noreferrer">
            <FileDown className="mr-2 h-4 w-4" />
            PDF
          </a>
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={isPending}
          onClick={() => {
            startTransition(async () => {
              const result = await regenerateEventProgramOrder(eventId);
              if (result.success) {
                toast.success('Program order updated. The public program and PDF now match.');
              } else {
                toast.error(result.error ?? 'Failed to update the program order');
              }
            });
          }}
        >
          <RefreshCw className={`mr-2 h-4 w-4${isPending ? ' animate-spin' : ''}`} />
          Update program order
        </Button>
        {!isPublished && (
          <span className="self-center text-xs text-amber-700 dark:text-amber-300">
            This event is not published — the public program and PDF return 404 until it is.
          </span>
        )}
      </div>

      {/* Ordered program */}
      {items.length === 0 ? (
        <div className="rounded-lg border-2 border-dashed p-8 text-center text-muted-foreground">
          <p className="text-sm">No pieces in this program yet.</p>
          <p className="mt-1 text-xs">Add music from the Manage Program page first.</p>
        </div>
      ) : (
        <ol className="space-y-2">
          {items.map((item, index) => (
            <li key={item.id} className="rounded-lg border bg-card px-3 py-2">
              <div className="flex items-center gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.title}</p>
                  {item.composer && (
                    <p className="truncate text-xs text-muted-foreground">{item.composer}</p>
                  )}
                </div>

                {item.durationKnown ? (
                  <span className="shrink-0 text-xs font-medium text-primary">
                    {item.durationLabel}
                  </span>
                ) : (
                  <Badge
                    variant="outline"
                    className="shrink-0 border-amber-400 bg-amber-50 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
                  >
                    {UNKNOWN_DURATION_LABEL}
                  </Badge>
                )}

                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    disabled={index === 0 || isPending}
                    onClick={() => move(index, index - 1)}
                    aria-label={`Move ${item.title} up`}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    disabled={index === items.length - 1 || isPending}
                    onClick={() => move(index, index + 1)}
                    aria-label={`Move ${item.title} down`}
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              {/* Performers */}
              <div className="mt-2 pl-9">
                {item.performers.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No performers assigned.</p>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {item.performers.map((performer) => (
                      <li key={performer.memberId}>
                        <Badge variant="secondary" className="gap-1 text-xs">
                          <Users className="h-3 w-3" />
                          {performer.name}
                          {performer.partName ? ` — ${performer.partName}` : ''}
                          {performer.sectionNames.length > 0
                            ? ` (${performer.sectionNames.join(', ')})`
                            : ''}
                          <button
                            type="button"
                            className="ml-1 underline"
                            disabled={isPending}
                            onClick={() => removePerformer(item.pieceId, performer.memberId)}
                            aria-label={`Remove ${performer.name} from ${item.title}`}
                          >
                            remove
                          </button>
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}

                {assigningPieceId === item.pieceId ? (
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <label className="text-xs">
                      <span className="mb-1 block font-medium">Performer</span>
                      <select
                        className="h-8 rounded-md border bg-background px-2 text-sm"
                        value={selectedMemberId}
                        onChange={(e) => setSelectedMemberId(e.target.value)}
                        aria-label={`Performer for ${item.title}`}
                      >
                        <option value="">Select a member…</option>
                        {members
                          .filter(
                            (m) => !item.performers.some((p) => p.memberId === m.id)
                          )
                          .map((member) => (
                            <option key={member.id} value={member.id}>
                              {member.name}
                              {member.sectionNames.length > 0
                                ? ` — ${member.sectionNames.join(', ')}`
                                : ''}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label className="text-xs">
                      <span className="mb-1 block font-medium">Part</span>
                      <input
                        className="h-8 w-32 rounded-md border bg-background px-2 text-sm"
                        value={partName}
                        onChange={(e) => setPartName(e.target.value)}
                        placeholder={selectedMember?.sectionNames[0] ?? 'e.g. 1st Trumpet'}
                        aria-label={`Part for ${item.title}`}
                      />
                    </label>
                    <Button
                      size="sm"
                      onClick={() => submitAssignment(item.pieceId)}
                      disabled={isPending}
                    >
                      Assign
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setAssigningPieceId(null)}
                      disabled={isPending}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    onClick={() => startAssign(item.pieceId)}
                    disabled={isPending}
                  >
                    <Users className="mr-1 h-3.5 w-3.5" />
                    Assign performer
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

ProgramBuilder.displayName = 'ProgramBuilder';
