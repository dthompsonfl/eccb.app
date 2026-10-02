'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { authClient } from '@/lib/auth/client';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { Loader2, User, Shield, Bell, BellRing, Lock } from 'lucide-react';
import { PushNotificationSettings } from '@/components/push/push-notification-settings';
import { updateNotificationPreferences } from '@/app/(member)/member/settings/actions';
import type {
  NotificationPreferences,
  NotificationPreferenceKey,
} from '@/lib/notifications/preferences';

const profileSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
  confirmPassword: z.string(),
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: "Passwords don't match",
  path: ['confirmPassword'],
});

type ProfileFormValues = z.infer<typeof profileSchema>;
type PasswordFormValues = z.infer<typeof passwordSchema>;

interface MemberSettingsFormProps {
  user: {
    id: string;
    name: string | null;
    email: string;
    emailVerified: boolean;
    twoFactorEnabled?: boolean;
  };
  initialNotificationPreferences: NotificationPreferences;
}

export function MemberSettingsForm({
  user,
  initialNotificationPreferences,
}: MemberSettingsFormProps) {
  const router = useRouter();
  const [isUpdatingProfile, setIsUpdatingProfile] = useState(false);
  const [isUpdatingPassword, setIsUpdatingPassword] = useState(false);
  const [isSendingVerification, setIsSendingVerification] = useState(false);
  const [savingPreference, setSavingPreference] =
    useState<NotificationPreferenceKey | null>(null);
  const [notificationPreferences, setNotificationPreferences] = useState(
    initialNotificationPreferences,
  );

  const profileForm = useForm<ProfileFormValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      name: user.name ?? '',
    },
  });

  const passwordForm = useForm<PasswordFormValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: {
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
    },
  });

  async function onProfileSubmit(values: ProfileFormValues) {
    setIsUpdatingProfile(true);
    try {
      await authClient.updateUser({
        name: values.name,
      });
      toast.success('Profile updated successfully');
      router.refresh();
    } catch (error) {
      console.error('Error updating profile:', error);
      toast.error('Failed to update profile');
    } finally {
      setIsUpdatingProfile(false);
    }
  }

  async function onPasswordSubmit(values: PasswordFormValues) {
    setIsUpdatingPassword(true);
    try {
      await authClient.changePassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      toast.success('Password updated successfully');
      passwordForm.reset();
    } catch (error) {
      console.error('Error updating password:', error);
      toast.error('Failed to update password. Please check your current password.');
    } finally {
      setIsUpdatingPassword(false);
    }
  }

  async function resendVerificationEmail() {
    setIsSendingVerification(true);
    try {
      const result = await authClient.sendVerificationEmail({
        email: user.email,
        callbackURL: '/member/settings',
      });
      if (result.error) throw new Error(result.error.message);
      toast.success('Verification email sent');
    } catch (error) {
      console.error('Failed to resend verification email:', error);
      toast.error('Failed to send verification email');
    } finally {
      setIsSendingVerification(false);
    }
  }

  async function setPreference(
    key: NotificationPreferenceKey,
    checked: boolean,
  ) {
    const previous = notificationPreferences;
    const next = { ...notificationPreferences, [key]: checked };
    setNotificationPreferences(next);
    setSavingPreference(key);

    try {
      const result = await updateNotificationPreferences(next);
      if (!result.success) throw new Error(result.error);
      toast.success('Notification preferences saved');
    } catch (error) {
      console.error('Failed to update notification preference:', error);
      setNotificationPreferences(previous);
      toast.error('Failed to save notification preference');
    } finally {
      setSavingPreference(null);
    }
  }

  const preferenceRows: Array<{
    key: NotificationPreferenceKey;
    label: string;
    description: string;
  }> = [
    {
      key: 'eventReminders',
      label: 'Event Reminders',
      description: 'Receive reminders before rehearsals and concerts',
    },
    {
      key: 'musicAssignments',
      label: 'New Music Assignments',
      description: 'Get notified when new music is assigned to you',
    },
    {
      key: 'announcements',
      label: 'Band Announcements',
      description: 'Receive important announcements from band leadership',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Profile Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <User className="h-5 w-5" />
            <CardTitle>Profile</CardTitle>
          </div>
          <CardDescription>
            Update your personal information
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...profileForm}>
            <form onSubmit={profileForm.handleSubmit(onProfileSubmit)} className="space-y-4">
              <FormField
                control={profileForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Display Name</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="space-y-2">
                <FormLabel>Email</FormLabel>
                <Input value={user.email} disabled />
                <FormDescription>
                  Contact an administrator to change your email address
                </FormDescription>
              </div>

              <Button type="submit" disabled={isUpdatingProfile}>
                {isUpdatingProfile && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Changes
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>

      {/* Password Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Lock className="h-5 w-5" />
            <CardTitle>Password</CardTitle>
          </div>
          <CardDescription>
            Change your password
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...passwordForm}>
            <form onSubmit={passwordForm.handleSubmit(onPasswordSubmit)} className="space-y-4">
              <FormField
                control={passwordForm.control}
                name="currentPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Current Password</FormLabel>
                    <FormControl>
                      <Input type="password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={passwordForm.control}
                name="newPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>New Password</FormLabel>
                    <FormControl>
                      <Input type="password" {...field} />
                    </FormControl>
                    <FormDescription>
                      Must be at least 8 characters long
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={passwordForm.control}
                name="confirmPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Confirm New Password</FormLabel>
                    <FormControl>
                      <Input type="password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Button type="submit" disabled={isUpdatingPassword}>
                {isUpdatingPassword && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Update Password
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>

      {/* Security Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            <CardTitle>Security</CardTitle>
          </div>
          <CardDescription>
            Manage your account security settings
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <p className="font-medium">Email Verified</p>
            <p className="text-sm text-muted-foreground">
              {user.emailVerified
                ? 'Your email address has been verified.'
                : 'Your email address has not been verified. Please check your inbox for a verification link.'}
            </p>
            {!user.emailVerified && (
              <Button
                variant="outline"
                size="sm"
                onClick={resendVerificationEmail}
                disabled={isSendingVerification}
              >
                {isSendingVerification ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Resend Verification Email
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Notification Preferences */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Bell className="h-5 w-5" />
            <CardTitle>Notifications</CardTitle>
          </div>
          <CardDescription>
            Manage your notification preferences
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {preferenceRows.map((row, index) => (
            <div key={row.key}>
              {index > 0 ? <Separator className="mb-4" /> : null}
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <span className="font-medium">{row.label}</span>
                  <p className="text-sm text-muted-foreground">{row.description}</p>
                </div>
                <div className="flex items-center gap-2">
                  {savingPreference === row.key ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : null}
                  <Switch
                    checked={notificationPreferences[row.key]}
                    onCheckedChange={(checked) => setPreference(row.key, checked)}
                    disabled={savingPreference !== null}
                    aria-label={row.label}
                  />
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Web push — strictly opt-in, per device */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <BellRing className="h-5 w-5" />
            <CardTitle>Device Notifications</CardTitle>
          </div>
          <CardDescription>
            Receive alerts on this device. Off until you turn them on.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PushNotificationSettings />
        </CardContent>
      </Card>
    </div>
  );
}
