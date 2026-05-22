import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/guards';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Settings, Database, Mail, Shield, Users, Globe, BookOpen } from 'lucide-react';
import { GeneralSettingsForm } from '@/components/admin/settings/general-settings-form';
import { EmailSettingsForm } from '@/components/admin/settings/email-settings-form';
import { SecuritySettingsForm } from '@/components/admin/settings/security-settings-form';
import { MusicStandSettingsForm } from '@/components/admin/settings/music-stand-settings-form';

import { SYSTEM_CONFIG } from '@/lib/auth/permission-constants';
export default async function AdminSettingsPage() {
  await requirePermission(SYSTEM_CONFIG);

  // Get current settings
  const settings = await prisma.systemSetting.findMany();
  const settingsMap = settings.reduce((acc, s) => {
    acc[s.key] = s.value;
    return acc;
  }, {} as Record<string, string>);

  // Get stats
  const [memberCount, eventCount, musicCount, userCount] = await Promise.all([
    prisma.member.count(),
    prisma.event.count(),
    prisma.musicPiece.count(),
    prisma.user.count(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          Manage your application settings
        </p>
      </div>

      {/* System Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Members</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{memberCount}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Events</CardTitle>
            <Globe className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{eventCount}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Music Pieces</CardTitle>
            <Database className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{musicCount}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Users</CardTitle>
            <Shield className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{userCount}</div>
          </CardContent>
        </Card>
      </div>

      {/* Settings Tabs */}
      <Tabs defaultValue="general" className="space-y-4">
        <TabsList>
          <TabsTrigger value="general" className="gap-2">
            <Settings className="h-4 w-4" />
            General
          </TabsTrigger>
          <TabsTrigger value="email" className="gap-2">
            <Mail className="h-4 w-4" />
            Email
          </TabsTrigger>
          <TabsTrigger value="security" className="gap-2">
            <Shield className="h-4 w-4" />
            Security
          </TabsTrigger>
          <TabsTrigger value="music-stand" className="gap-2">
            <BookOpen className="h-4 w-4" />
            Music Stand
          </TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>General Settings</CardTitle>
              <CardDescription>
                Configure your band&apos;s basic information
              </CardDescription>
            </CardHeader>
            <CardContent>
              <GeneralSettingsForm settings={settingsMap} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="email" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Email Settings</CardTitle>
              <CardDescription>
                Configure email delivery settings
              </CardDescription>
            </CardHeader>
            <CardContent>
              <EmailSettingsForm settings={settingsMap} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="security" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Security Settings</CardTitle>
              <CardDescription>
                Configure security and access settings
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SecuritySettingsForm settings={settingsMap} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="music-stand" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Music Stand Settings</CardTitle>
              <CardDescription>
                Configure the digital music stand behaviour for members
              </CardDescription>
            </CardHeader>
            <CardContent>
              <MusicStandSettingsForm settings={settingsMap} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
