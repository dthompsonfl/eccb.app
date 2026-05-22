import { ContactSubmissionStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { CMS_VIEW_ALL } from '@/lib/auth/permission-constants';
import { formatDate } from '@/lib/date';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { markContactSubmissionRead, updateContactSubmission } from './actions';

const statusValues = Object.values(ContactSubmissionStatus);

const statusVariant: Record<ContactSubmissionStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  NEW: 'destructive',
  READ: 'secondary',
  REPLIED: 'default',
  RESOLVED: 'outline',
  ARCHIVED: 'outline',
};

export default async function AdminContactSubmissionsPage() {
  await requirePermission(CMS_VIEW_ALL);

  const [submissions, stats] = await Promise.all([
    prisma.contactSubmission.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.contactSubmission.groupBy({
      by: ['status'],
      _count: true,
    }),
  ]);

  const statusCounts = stats.reduce((acc, item) => {
    acc[item.status] = item._count;
    return acc;
  }, {} as Record<ContactSubmissionStatus, number>);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Contact Submissions</h1>
        <p className="text-muted-foreground">
          Review, triage, and resolve messages submitted from the public contact form.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-5">
        {statusValues.map((status) => (
          <Card key={status}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">{status}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{statusCounts[status] ?? 0}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Latest submissions</CardTitle>
          <CardDescription>Showing the 100 newest contact messages.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {submissions.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              No contact submissions have been received yet.
            </div>
          ) : (
            submissions.map((submission) => (
              <article key={submission.id} className="rounded-lg border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold">{submission.subject}</h2>
                      <Badge variant={statusVariant[submission.status]}>{submission.status}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      From <a className="text-primary hover:underline" href={`mailto:${submission.email}`}>{submission.name}</a> on {formatDate(submission.createdAt)}
                    </p>
                  </div>
                  {submission.status === ContactSubmissionStatus.NEW && (
                    <form action={markContactSubmissionRead}>
                      <input type="hidden" name="id" value={submission.id} />
                      <Button type="submit" variant="outline" size="sm">Mark read</Button>
                    </form>
                  )}
                </div>

                <div className="mt-4 whitespace-pre-wrap rounded-md bg-muted p-4 text-sm">
                  {submission.message}
                </div>

                <form action={updateContactSubmission} className="mt-4 grid gap-4 md:grid-cols-[220px_1fr_auto] md:items-end">
                  <input type="hidden" name="id" value={submission.id} />
                  <div className="space-y-2">
                    <Label htmlFor={`status-${submission.id}`}>Status</Label>
                    <select
                      id={`status-${submission.id}`}
                      name="status"
                      defaultValue={submission.status}
                      className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    >
                      {statusValues.map((status) => (
                        <option key={status} value={status}>{status}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`notes-${submission.id}`}>Internal notes</Label>
                    <Textarea
                      id={`notes-${submission.id}`}
                      name="responseNotes"
                      defaultValue={submission.responseNotes ?? ''}
                      rows={2}
                      placeholder="Record follow-up, owner, or resolution details"
                    />
                  </div>
                  <Button type="submit">Save</Button>
                </form>
              </article>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
