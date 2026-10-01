'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
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
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { updateSettings } from '@/app/(admin)/admin/settings/actions';

// ---------------------------------------------------------------------------
// Schema — all keys use the "stand." prefix consumed by lib/stand/settings.ts
// ---------------------------------------------------------------------------
const formSchema = z.object({
  // Kill switch
  'stand.enabled': z.boolean(),

  // Connectivity
  'stand.realtimeMode': z.enum(['polling', 'websocket']),
  'stand.websocketEnabled': z.boolean(),
  'stand.websocketPort': z.coerce.number().int().min(1024).max(65535),
  'stand.pollingIntervalMs': z.coerce.number().int().min(1000).max(60_000),

  // Offline / sync
  'stand.offlineEnabled': z.boolean(),
  'stand.allowOfflineSync': z.boolean(),

  // Annotation limits
  'stand.maxAnnotationsPerPage': z.coerce.number().int().min(1).max(1000),
  'stand.maxStrokeDataBytes': z.coerce.number().int().min(1024).max(10_000_000),

  // File limits
  'stand.maxPdfSizeBytes': z.coerce.number().int().min(1024),
  'stand.maxFileSizeMb': z.coerce.number().int().min(1).max(500),

  // Feature flags
  'stand.practiceTrackingEnabled': z.boolean(),
  'stand.audioSyncEnabled': z.boolean(),

  // Navigation
  'stand.defaultAutoTurnDelay': z.coerce.number().int().min(0).max(30_000),

  // Access policy
  'stand.accessPolicy': z.enum(['any_member', 'rsvp_only']),

  // Maintenance
  'stand.maintenanceMessage': z.string().max(500).nullable(),
});

type FormValues = z.infer<typeof formSchema>;

interface MusicStandSettingsFormProps {
  /** Raw key→value map from the SystemSetting table. Keys use stand.* prefix. */
  settings: Record<string, string>;
}

function boolVal(settings: Record<string, string>, key: string, def = true): boolean {
  const v = settings[key];
  if (v === undefined) return def;
  return v !== 'false' && v !== '0';
}

function numVal(settings: Record<string, string>, key: string, def: number): number {
  const v = Number(settings[key]);
  return Number.isFinite(v) ? v : def;
}

export function MusicStandSettingsForm({ settings }: MusicStandSettingsFormProps) {
  const [isLoading, setIsLoading] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      'stand.enabled': boolVal(settings, 'stand.enabled', true),
      'stand.realtimeMode': (settings['stand.realtimeMode'] as 'polling' | 'websocket') ?? 'polling',
      'stand.websocketEnabled': boolVal(settings, 'stand.websocketEnabled', false),
      'stand.websocketPort': numVal(settings, 'stand.websocketPort', 3226),
      'stand.pollingIntervalMs': numVal(settings, 'stand.pollingIntervalMs', 5000),
      'stand.offlineEnabled': boolVal(settings, 'stand.offlineEnabled', false),
      'stand.allowOfflineSync': boolVal(settings, 'stand.allowOfflineSync', false),
      'stand.maxAnnotationsPerPage': numVal(settings, 'stand.maxAnnotationsPerPage', 100),
      'stand.maxStrokeDataBytes': numVal(settings, 'stand.maxStrokeDataBytes', 512000),
      'stand.maxPdfSizeBytes': numVal(settings, 'stand.maxPdfSizeBytes', 50_000_000),
      'stand.maxFileSizeMb': numVal(settings, 'stand.maxFileSizeMb', 50),
      'stand.practiceTrackingEnabled': boolVal(settings, 'stand.practiceTrackingEnabled', true),
      'stand.audioSyncEnabled': boolVal(settings, 'stand.audioSyncEnabled', false),
      'stand.defaultAutoTurnDelay': numVal(settings, 'stand.defaultAutoTurnDelay', 3000),
      'stand.accessPolicy': (settings['stand.accessPolicy'] as 'any_member' | 'rsvp_only') ?? 'any_member',
      'stand.maintenanceMessage': settings['stand.maintenanceMessage'] ?? null,
    },
  });

  async function onSubmit(values: FormValues) {
    setIsLoading(true);
    try {
      const record: Record<string, string> = {};
      for (const [key, val] of Object.entries(values)) {
        record[key] = val === null ? '' : String(val);
      }
      const result = await updateSettings(record);
      if (result.success) {
        toast.success('Music Stand settings saved');
      } else {
        toast.error(result.error ?? 'Failed to save settings');
      }
    } catch {
      toast.error('An unexpected error occurred');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">

        {/* ── Kill Switch ─────────────────────────────────────── */}
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-4">Status</h3>
          <FormField
            control={form.control}
            name="stand.enabled"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-4">
                <div className="space-y-0.5">
                  <FormLabel className="text-base">Music Stand Enabled</FormLabel>
                  <FormDescription>
                    Master kill-switch. Disabled = all stand pages return 404.
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />
        </div>

        <Separator />

        {/* ── Connectivity ────────────────────────────────────── */}
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-4">
            Connectivity &amp; Sync
          </h3>
          <div className="space-y-4">
            <FormField
              control={form.control}
              name="stand.realtimeMode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Realtime Mode</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="polling">Polling (safe default)</SelectItem>
                      <SelectItem value="websocket">WebSocket (requires socket server)</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Polling works out-of-the-box. WebSocket requires the standalone
                    Node server (<code>npm run start:server</code>).
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="stand.websocketEnabled"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">WebSocket Enabled</FormLabel>
                    <FormDescription>
                      Allow clients to upgrade from polling to WebSocket when available.
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="stand.websocketPort"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>WebSocket Port</FormLabel>
                  <FormControl>
                    <Input type="number" min={1024} max={65535} {...field} />
                  </FormControl>
                  <FormDescription>
                    Port for the standalone socket server. Default: 3005. Changes require restarting the WebSocket worker.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="stand.pollingIntervalMs"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Polling Interval (ms)</FormLabel>
                  <FormControl>
                    <Input type="number" min={1000} max={60000} step={500} {...field} />
                  </FormControl>
                  <FormDescription>How often clients poll for state changes. Default: 5000 ms.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        <Separator />

        {/* ── Offline ─────────────────────────────────────────── */}
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-4">Offline Mode</h3>
          <div className="space-y-4">
            <FormField
              control={form.control}
              name="stand.offlineEnabled"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">Offline Mode</FormLabel>
                    <FormDescription>Allow members to cache music for offline use via service worker.</FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="stand.allowOfflineSync"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">Sync Annotations Offline</FormLabel>
                    <FormDescription>Queue annotations made offline and sync when reconnected.</FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />
          </div>
        </div>

        <Separator />

        {/* ── Features ────────────────────────────────────────── */}
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-4">Features</h3>
          <div className="space-y-4">
            <FormField
              control={form.control}
              name="stand.practiceTrackingEnabled"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">Practice Tracking</FormLabel>
                    <FormDescription>Show the practice timer and log in the stand sidebar.</FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="stand.audioSyncEnabled"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">Audio Link Editor</FormLabel>
                    <FormDescription>
                      Allow librarians to attach audio files and links to pieces.
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="stand.defaultAutoTurnDelay"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Auto-Turn Delay (ms)</FormLabel>
                  <FormControl>
                    <Input type="number" min={0} max={30000} step={500} {...field} />
                  </FormControl>
                  <FormDescription>Delay before auto-advancing to the next page (0 = disabled).</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        <Separator />

        {/* ── Limits ──────────────────────────────────────────── */}
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-4">Limits</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="stand.maxAnnotationsPerPage"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Max Annotations per Page</FormLabel>
                  <FormControl>
                    <Input type="number" min={1} max={1000} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="stand.maxStrokeDataBytes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Max Stroke Data (bytes)</FormLabel>
                  <FormControl>
                    <Input type="number" min={1024} max={10_000_000} step={1024} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="stand.maxPdfSizeBytes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Max PDF Size (bytes)</FormLabel>
                  <FormControl>
                    <Input type="number" min={1024} step={1_000_000} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="stand.maxFileSizeMb"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Max Upload File Size (MB)</FormLabel>
                  <FormControl>
                    <Input type="number" min={1} max={500} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        <Separator />

        {/* ── Access ──────────────────────────────────────────── */}
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-4">Access Policy</h3>
          <FormField
            control={form.control}
            name="stand.accessPolicy"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Member Access Policy</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="any_member">Any Active Member</SelectItem>
                    <SelectItem value="rsvp_only">RSVP&apos;d Members Only</SelectItem>
                  </SelectContent>
                </Select>
                <FormDescription>
                  Controls who can open the stand for a given event.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <Separator />

        {/* ── Maintenance ─────────────────────────────────────── */}
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-4">Maintenance</h3>
          <FormField
            control={form.control}
            name="stand.maintenanceMessage"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Maintenance Message</FormLabel>
                <FormControl>
                  <Textarea
                    rows={3}
                    placeholder="The Music Stand is temporarily unavailable…"
                    {...field}
                    value={field.value ?? ''}
                    onChange={(e) => field.onChange(e.target.value || null)}
                  />
                </FormControl>
                <FormDescription>
                  Shown to members when the stand is disabled. Leave blank for the default message.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <Button type="submit" disabled={isLoading}>
          {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save Music Stand Settings
        </Button>
      </form>
    </Form>
  );
}

MusicStandSettingsForm.displayName = 'MusicStandSettingsForm';

