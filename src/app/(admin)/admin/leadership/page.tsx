import { LeadershipProfileType } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { CMS_VIEW_ALL } from '@/lib/auth/permission-constants';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { createLeadershipProfile, deleteLeadershipProfile, updateLeadershipProfile } from './actions';

const profileTypes = Object.values(LeadershipProfileType);

export default async function AdminLeadershipPage() {
  await requirePermission(CMS_VIEW_ALL);

  const profiles = await prisma.leadershipProfile.findMany({
    orderBy: [{ profileType: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Leadership</h1>
        <p className="text-muted-foreground">
          Manage directors, board members, staff, and public leadership bios.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add leadership profile</CardTitle>
          <CardDescription>Profiles appear publicly only after publishing.</CardDescription>
        </CardHeader>
        <CardContent>
          <LeadershipForm action={createLeadershipProfile} submitLabel="Create profile" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Current profiles</CardTitle>
          <CardDescription>{profiles.length} leadership records</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {profiles.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              No leadership profiles have been created yet. Add directors and board members above.
            </div>
          ) : (
            profiles.map((profile) => (
              <div key={profile.id} className="rounded-lg border p-4">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="font-semibold">{profile.name}</h2>
                    <p className="text-sm text-muted-foreground">{profile.role}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Badge variant="outline">{profile.profileType}</Badge>
                      <Badge variant={profile.isPublished ? 'default' : 'secondary'}>
                        {profile.isPublished ? 'Published' : 'Draft'}
                      </Badge>
                    </div>
                  </div>
                  <form action={deleteLeadershipProfile}>
                    <input type="hidden" name="id" value={profile.id} />
                    <Button type="submit" variant="destructive" size="sm">Delete</Button>
                  </form>
                </div>
                <LeadershipForm
                  action={updateLeadershipProfile}
                  submitLabel="Save profile"
                  profile={{
                    id: profile.id,
                    name: profile.name,
                    role: profile.role,
                    profileType: profile.profileType,
                    bio: profile.bio ?? '',
                    photoUrl: profile.photoUrl ?? '',
                    email: profile.email ?? '',
                    sortOrder: profile.sortOrder,
                    isPublished: profile.isPublished,
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

function LeadershipForm({
  action,
  submitLabel,
  profile,
}: {
  action: (formData: FormData) => Promise<void>;
  submitLabel: string;
  profile?: {
    id: string;
    name: string;
    role: string;
    profileType: LeadershipProfileType;
    bio: string;
    photoUrl: string;
    email: string;
    sortOrder: number;
    isPublished: boolean;
  };
}) {
  return (
    <form action={action} className="grid gap-4 md:grid-cols-2">
      {profile?.id && <input type="hidden" name="id" value={profile.id} />}
      <div className="space-y-2">
        <Label htmlFor={`name-${profile?.id ?? 'new'}`}>Name</Label>
        <Input id={`name-${profile?.id ?? 'new'}`} name="name" defaultValue={profile?.name} required />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`role-${profile?.id ?? 'new'}`}>Role/title</Label>
        <Input id={`role-${profile?.id ?? 'new'}`} name="role" defaultValue={profile?.role} required />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`type-${profile?.id ?? 'new'}`}>Profile type</Label>
        <select
          id={`type-${profile?.id ?? 'new'}`}
          name="profileType"
          defaultValue={profile?.profileType ?? LeadershipProfileType.VOLUNTEER}
          className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          {profileTypes.map((type) => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`email-${profile?.id ?? 'new'}`}>Public email</Label>
        <Input id={`email-${profile?.id ?? 'new'}`} name="email" type="email" defaultValue={profile?.email} />
      </div>
      <div className="space-y-2 md:col-span-2">
        <Label htmlFor={`photo-${profile?.id ?? 'new'}`}>Photo URL</Label>
        <Input id={`photo-${profile?.id ?? 'new'}`} name="photoUrl" type="url" defaultValue={profile?.photoUrl} />
      </div>
      <div className="space-y-2 md:col-span-2">
        <Label htmlFor={`bio-${profile?.id ?? 'new'}`}>Bio</Label>
        <Textarea id={`bio-${profile?.id ?? 'new'}`} name="bio" defaultValue={profile?.bio} rows={4} />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`sort-${profile?.id ?? 'new'}`}>Sort order</Label>
        <Input id={`sort-${profile?.id ?? 'new'}`} name="sortOrder" type="number" min="0" defaultValue={profile?.sortOrder ?? 0} />
      </div>
      <label className="flex items-center gap-2 pt-8 text-sm font-medium">
        <input name="isPublished" type="checkbox" defaultChecked={profile?.isPublished ?? false} />
        Publish profile
      </label>
      <div className="md:col-span-2">
        <Button type="submit">{submitLabel}</Button>
      </div>
    </form>
  );
}
