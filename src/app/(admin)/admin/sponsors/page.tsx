import { SponsorLevel } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { CMS_VIEW_ALL } from '@/lib/auth/permission-constants';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { createSponsor, deleteSponsor, updateSponsor } from './actions';

const levels = Object.values(SponsorLevel);

export default async function AdminSponsorsPage() {
  await requirePermission(CMS_VIEW_ALL);

  const sponsors = await prisma.sponsor.findMany({
    orderBy: [{ level: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Sponsors</h1>
        <p className="text-muted-foreground">
          Manage sponsor listings shown on the public sponsors page.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add sponsor</CardTitle>
          <CardDescription>
            New sponsors remain hidden until you mark them active.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SponsorForm action={createSponsor} submitLabel="Create sponsor" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Current sponsors</CardTitle>
          <CardDescription>{sponsors.length} sponsor records</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {sponsors.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              No sponsors have been added yet. Create the first sponsor above to populate the public page.
            </div>
          ) : (
            sponsors.map((sponsor) => (
              <div key={sponsor.id} className="rounded-lg border p-4">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="font-semibold">{sponsor.name}</h2>
                    <div className="mt-1 flex flex-wrap gap-2">
                      <Badge variant="outline">{sponsor.level.replace('_', ' ')}</Badge>
                      <Badge variant={sponsor.isActive ? 'default' : 'secondary'}>
                        {sponsor.isActive ? 'Public' : 'Hidden'}
                      </Badge>
                    </div>
                  </div>
                  <form action={deleteSponsor}>
                    <input type="hidden" name="id" value={sponsor.id} />
                    <Button type="submit" variant="destructive" size="sm">Delete</Button>
                  </form>
                </div>
                <SponsorForm
                  action={updateSponsor}
                  submitLabel="Save sponsor"
                  sponsor={{
                    id: sponsor.id,
                    name: sponsor.name,
                    level: sponsor.level,
                    description: sponsor.description ?? '',
                    websiteUrl: sponsor.websiteUrl ?? '',
                    logoUrl: sponsor.logoUrl ?? '',
                    sortOrder: sponsor.sortOrder,
                    isActive: sponsor.isActive,
                  }}
                />
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SponsorForm({
  action,
  submitLabel,
  sponsor,
}: {
  action: (formData: FormData) => Promise<void>;
  submitLabel: string;
  sponsor?: {
    id: string;
    name: string;
    level: SponsorLevel;
    description: string;
    websiteUrl: string;
    logoUrl: string;
    sortOrder: number;
    isActive: boolean;
  };
}) {
  return (
    <form action={action} className="grid gap-4 md:grid-cols-2">
      {sponsor?.id && <input type="hidden" name="id" value={sponsor.id} />}
      <div className="space-y-2">
        <Label htmlFor={`name-${sponsor?.id ?? 'new'}`}>Name</Label>
        <Input id={`name-${sponsor?.id ?? 'new'}`} name="name" defaultValue={sponsor?.name} required />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`level-${sponsor?.id ?? 'new'}`}>Level</Label>
        <select
          id={`level-${sponsor?.id ?? 'new'}`}
          name="level"
          defaultValue={sponsor?.level ?? SponsorLevel.BRONZE}
          className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          {levels.map((level) => (
            <option key={level} value={level}>{level.replace('_', ' ')}</option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`website-${sponsor?.id ?? 'new'}`}>Website URL</Label>
        <Input id={`website-${sponsor?.id ?? 'new'}`} name="websiteUrl" type="url" defaultValue={sponsor?.websiteUrl} />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`logo-${sponsor?.id ?? 'new'}`}>Logo URL</Label>
        <Input id={`logo-${sponsor?.id ?? 'new'}`} name="logoUrl" type="url" defaultValue={sponsor?.logoUrl} />
      </div>
      <div className="space-y-2 md:col-span-2">
        <Label htmlFor={`description-${sponsor?.id ?? 'new'}`}>Description</Label>
        <Textarea id={`description-${sponsor?.id ?? 'new'}`} name="description" defaultValue={sponsor?.description} rows={3} />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`sort-${sponsor?.id ?? 'new'}`}>Sort order</Label>
        <Input id={`sort-${sponsor?.id ?? 'new'}`} name="sortOrder" type="number" min="0" defaultValue={sponsor?.sortOrder ?? 0} />
      </div>
      <label className="flex items-center gap-2 pt-8 text-sm font-medium">
        <input name="isActive" type="checkbox" defaultChecked={sponsor?.isActive ?? false} />
        Show publicly
      </label>
      <div className="md:col-span-2">
        <Button type="submit">{submitLabel}</Button>
      </div>
    </form>
  );
}
