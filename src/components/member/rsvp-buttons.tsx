'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { CheckCircle2, XCircle, HelpCircle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface RSVPButtonsProps {
  eventId: string;
  memberId: string;
  currentStatus: string | null;
}

export function RSVPButtons({ eventId, memberId, currentStatus }: RSVPButtonsProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState<string | null>(null);

  async function handleRSVP(status: 'YES' | 'NO' | 'MAYBE') {
    setIsLoading(status);
    try {
      const response = await fetch('/api/events/rsvp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          eventId,
          memberId,
          status,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to update RSVP');
      }

      toast.success('Thank you — the band office can see your answer now.');
      router.refresh();
    } catch (error) {
      console.error('Error updating RSVP:', error);
      toast.error('We could not save your answer. Please check your connection and try again.');
    } finally {
      setIsLoading(null);
    }
  }

  return (
    <div className="space-y-3">
      {/* Lead with the action, not the acronym. "RSVP" means nothing to someone
          who has never been to one of these things. */}
      <p className="text-sm font-medium">Let us know if you can come</p>
      <div className="flex flex-wrap gap-2">
      <Button
        variant={currentStatus === 'YES' ? 'default' : 'outline'}
        className={cn(
          'flex-1',
          currentStatus === 'YES' && 'bg-green-600 hover:bg-green-700'
        )}
        onClick={() => handleRSVP('YES')}
        disabled={isLoading !== null}
      >
        {isLoading === 'YES' ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <CheckCircle2 className="mr-2 h-4 w-4" />
        )}
        Yes, I can come
      </Button>
      <Button
        variant={currentStatus === 'MAYBE' ? 'default' : 'outline'}
        className={cn(
          'flex-1',
          currentStatus === 'MAYBE' && 'bg-amber-600 hover:bg-amber-700'
        )}
        onClick={() => handleRSVP('MAYBE')}
        disabled={isLoading !== null}
      >
        {isLoading === 'MAYBE' ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <HelpCircle className="mr-2 h-4 w-4" />
        )}
        Not sure yet
      </Button>
      <Button
        variant={currentStatus === 'NO' ? 'default' : 'outline'}
        className={cn(
          'flex-1',
          currentStatus === 'NO' && 'bg-red-600 hover:bg-red-700'
        )}
        onClick={() => handleRSVP('NO')}
        disabled={isLoading !== null}
      >
        {isLoading === 'NO' ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <XCircle className="mr-2 h-4 w-4" />
        )}
        No, I cannot come
      </Button>
      </div>
    </div>
  );
}
