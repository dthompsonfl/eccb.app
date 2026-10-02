'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { EventCalendar, type CalendarEvent, type ViewMode } from './event-calendar';
import { EventFilter, useEventFilters } from './event-filter';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Calendar, Music, Users, ArrowLeft } from 'lucide-react';

interface MemberCalendarClientProps {
  events: CalendarEvent[];
  stats: {
    total: number;
    rehearsals: number;
    concerts: number;
  };
}

export function MemberCalendarClient({ events, stats }: MemberCalendarClientProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  
  // Get initial view from URL
  const initialView = (searchParams.get('view') as ViewMode) || 'month';
  const [viewMode, setViewMode] = React.useState<ViewMode>(initialView);
  
  // Filter state
  const { filters, setFilters, hasActiveFilters } = useEventFilters({
    status: 'upcoming',
  });

  // Filter events based on current filters
  const filteredEvents = React.useMemo(() => {
    let result = [...events];

    // Filter by type
    if (filters.types.length > 0) {
      result = result.filter((event) => filters.types.includes(event.type));
    }

    // Filter by status
    const now = new Date();
    if (filters.status === 'upcoming') {
      result = result.filter((event) => new Date(event.startTime) >= now);
    } else if (filters.status === 'past') {
      result = result.filter((event) => new Date(event.startTime) < now);
    }

    // Filter by date range
    if (filters.dateRange.start) {
      result = result.filter(
        (event) => new Date(event.startTime) >= filters.dateRange.start!
      );
    }
    if (filters.dateRange.end) {
      const endOfDay = new Date(filters.dateRange.end);
      endOfDay.setHours(23, 59, 59, 999);
      result = result.filter(
        (event) => new Date(event.startTime) <= endOfDay
      );
    }

    return result;
  }, [events, filters]);

  // Update URL when view changes
  const handleViewModeChange = (mode: ViewMode) => {
    setViewMode(mode);
    const params = new URLSearchParams(searchParams.toString());
    params.set('view', mode);
    router.push(`?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="space-y-6">
      {/* Back button */}
      <Button asChild variant="ghost" size="sm">
        <Link href="/member/events">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Link>
      </Button>

      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Dates &amp; Times</h1>
        <p className="text-muted-foreground">
          Every rehearsal and concert on the band calendar.
        </p>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="p-2 bg-primary/10 rounded-lg">
                <Calendar className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-2xl font-bold">{stats.total}</p>
                <p className="text-sm text-muted-foreground">
                  {filters.status === 'upcoming'
                    ? 'still to come'
                    : filters.status === 'past'
                      ? 'already happened'
                      : 'in total'}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="p-2 bg-blue-500/10 rounded-lg">
                <Music className="h-5 w-5 text-blue-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{stats.rehearsals}</p>
                <p className="text-sm text-muted-foreground">rehearsals</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="p-2 bg-amber-500/10 rounded-lg">
                <Users className="h-5 w-5 text-amber-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{stats.concerts}</p>
                <p className="text-sm text-muted-foreground">concerts</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <EventFilter
            filters={filters}
            onFiltersChange={setFilters}
            showStatusFilter={true}
          />
        </CardContent>
      </Card>

      {/* Calendar */}
      <EventCalendar
        events={filteredEvents}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
        eventHref={(event) =>
          (event.musicCount ?? 0) > 0
            ? `/member/stand/${event.id}`
            : `/member/events/${event.id}`
        }
        showViewToggle={true}
      />

      {/* Results count */}
      {hasActiveFilters && (
        <p className="text-sm text-muted-foreground text-center">
          Showing {filteredEvents.length} of {events.length} events
        </p>
      )}
    </div>
  );
}

export default MemberCalendarClient;
