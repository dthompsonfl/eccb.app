'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { createCarpoolEntry, deleteCarpoolEntry } from '@/app/actions/carpool';
import { Trash2 } from 'lucide-react';
import { useFormStatus } from 'react-dom';
import { ConfirmActionButton } from '@/components/member/shared/confirm-action-button';

interface CarpoolEntry {
  id: string;
  type: 'OFFER' | 'REQUEST';
  seats: number | null;
  location: string | null;
  notes: string | null;
  memberId: string;
  member: {
    firstName: string;
    lastName: string;
  };
}

interface CarpoolBoardProps {
  eventId: string;
  entries: CarpoolEntry[];
  currentMemberId: string;
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Posting...' : 'Post'}
    </Button>
  );
}

export function CarpoolBoard({ eventId, entries, currentMemberId }: CarpoolBoardProps) {
  const [type, setType] = useState<'OFFER' | 'REQUEST'>('OFFER');

  const offers = entries.filter(e => e.type === 'OFFER');
  const requests = entries.filter(e => e.type === 'REQUEST');

  return (
    <div className="space-y-6">
      <div className="grid md:grid-cols-2 gap-6">
        <div>
           <h3 className="text-lg font-semibold mb-3">Offers ({offers.length})</h3>
           <div className="space-y-3">
             {offers.map(entry => (
                <Card key={entry.id}>
                  <CardContent className="p-4 relative">
                     <div className="font-medium">{entry.member.firstName} {entry.member.lastName}</div>
                     <div className="text-sm text-muted-foreground mb-1">
                        Offering {entry.seats} seat(s) from {entry.location || 'Unknown location'}
                     </div>
                     {entry.notes && <div className="text-sm italic">"{entry.notes}"</div>}

                     {entry.memberId === currentMemberId && (
                         <ConfirmActionButton
                           itemName="this carpool post"
                           confirmTitle="Take this off the carpool board?"
                           confirmDescription={
                             entry.type === 'OFFER'
                               ? `Your offer of ${entry.seats ?? 1} seat${(entry.seats ?? 1) === 1 ? '' : 's'} from ${entry.location || 'your area'} will be removed.`
                               : `Your request for a ride from ${entry.location || 'your area'} will be removed.`
                           }
                           onConfirm={() => deleteCarpoolEntry(entry.id, eventId)}
                           successMessage="Taken off the carpool board."
                           className="absolute top-2 right-2 text-destructive"
                           aria-label="Take this carpool post off the board"
                         >
                           <Trash2 className="h-5 w-5" />
                         </ConfirmActionButton>
                     )}
                  </CardContent>
                </Card>
             ))}
             {offers.length === 0 && <p className="text-muted-foreground text-sm">No rides offered yet.</p>}
           </div>
        </div>

        <div>
           <h3 className="text-lg font-semibold mb-3">Requests ({requests.length})</h3>
           <div className="space-y-3">
             {requests.map(entry => (
                <Card key={entry.id}>
                  <CardContent className="p-4 relative">
                     <div className="font-medium">{entry.member.firstName} {entry.member.lastName}</div>
                     <div className="text-sm text-muted-foreground mb-1">
                        Needs ride from {entry.location || 'Unknown location'}
                     </div>
                     {entry.notes && <div className="text-sm italic">"{entry.notes}"</div>}

                     {entry.memberId === currentMemberId && (
                         <ConfirmActionButton
                           itemName="this carpool post"
                           confirmTitle="Take this off the carpool board?"
                           confirmDescription={
                             entry.type === 'OFFER'
                               ? `Your offer of ${entry.seats ?? 1} seat${(entry.seats ?? 1) === 1 ? '' : 's'} from ${entry.location || 'your area'} will be removed.`
                               : `Your request for a ride from ${entry.location || 'your area'} will be removed.`
                           }
                           onConfirm={() => deleteCarpoolEntry(entry.id, eventId)}
                           successMessage="Taken off the carpool board."
                           className="absolute top-2 right-2 text-destructive"
                           aria-label="Take this carpool post off the board"
                         >
                           <Trash2 className="h-5 w-5" />
                         </ConfirmActionButton>
                     )}
                  </CardContent>
                </Card>
             ))}
             {requests.length === 0 && <p className="text-muted-foreground text-sm">No rides requested yet.</p>}
           </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Post to Carpool Board</CardTitle>
          <CardDescription>Offer a ride or ask for one.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={createCarpoolEntry} className="space-y-4">
             <input type="hidden" name="eventId" value={eventId} />

             <RadioGroup defaultValue="OFFER" name="type" onValueChange={(v) => setType(v as 'OFFER' | 'REQUEST')} className="flex gap-4">
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="OFFER" id="offer" />
                  <Label htmlFor="offer">I can offer a ride</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="REQUEST" id="request" />
                  <Label htmlFor="request">I need a ride</Label>
                </div>
             </RadioGroup>

             <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                   <Label>Location / Area</Label>
                   <Input name="location" placeholder="e.g. Downtown, North Side" required />
                </div>
                {type === 'OFFER' && (
                  <div className="space-y-2">
                    <Label>Available Seats</Label>
                    <Input name="seats" type="number" min="1" defaultValue="1" required />
                  </div>
                )}
             </div>

             <div className="space-y-2">
                <Label>Notes</Label>
                <Textarea name="notes" placeholder="Any details..." />
             </div>

             <div className="flex justify-end">
               <SubmitButton />
             </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
