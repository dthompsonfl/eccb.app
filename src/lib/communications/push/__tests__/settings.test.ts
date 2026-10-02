/**
 * VAPID key management tests.
 *
 * The property that matters most: the private key never leaves the server. The
 * client-facing getter's returned object is asserted not to carry it, because a
 * single accidental spread of that object into a JSON response would otherwise
 * be a silent full-credential disclosure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGenerateVAPIDKeys = vi.hoisted(() => vi.fn());
const mockSystemSettingFindMany = vi.hoisted(() => vi.fn());
const mockSystemSettingFindUnique = vi.hoisted(() => vi.fn());
const mockSystemSettingCreateMany = vi.hoisted(() => vi.fn());
const mockSystemSettingUpsert = vi.hoisted(() => vi.fn());

vi.mock('web-push', () => ({
  default: {
    generateVAPIDKeys: mockGenerateVAPIDKeys,
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(),
  },
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    systemSetting: {
      findMany: mockSystemSettingFindMany,
      findUnique: mockSystemSettingFindUnique,
      createMany: mockSystemSettingCreateMany,
      upsert: mockSystemSettingUpsert,
    },
  },
}));

import {
  getPushSettings,
  getPublicVapidConfig,
  isPushEnabled,
  setPushEnabled,
  __resetPushSettingsMemoForTests,
} from '../settings';

const GENERATED = { publicKey: 'generated-public', privateKey: 'generated-private' };

describe('push VAPID settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetPushSettingsMemoForTests();
    mockGenerateVAPIDKeys.mockReturnValue(GENERATED);
    mockSystemSettingCreateMany.mockResolvedValue({ count: 2 });
    mockSystemSettingUpsert.mockResolvedValue({});
  });

  describe('key generation and storage', () => {
    it('generates and persists a pair when none is stored', async () => {
      mockSystemSettingFindMany.mockResolvedValue([]);

      const settings = await getPushSettings();

      expect(settings.vapidPublicKey).toBe('generated-public');
      expect(settings.vapidPrivateKey).toBe('generated-private');
      expect(mockGenerateVAPIDKeys).toHaveBeenCalledTimes(1);
      expect(mockSystemSettingCreateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skipDuplicates: true,
          data: expect.arrayContaining([
            expect.objectContaining({ key: 'push.vapidPublicKey', value: 'generated-public' }),
            expect.objectContaining({ key: 'push.vapidPrivateKey', value: 'generated-private' }),
          ]),
        }),
      );
    });

    it('stores the pair under namespaced push.* SystemSetting keys, not hardcoded values', async () => {
      mockSystemSettingFindMany.mockResolvedValue([]);

      await getPushSettings();

      const written = mockSystemSettingCreateMany.mock.calls[0][0].data as Array<{ key: string }>;
      expect(written.every((row) => row.key.startsWith('push.'))).toBe(true);
    });

    it('reuses the stored pair instead of regenerating', async () => {
      // Regenerating on every boot would invalidate every existing browser
      // subscription, since the subscription is bound to the application
      // server key.
      mockSystemSettingFindMany.mockResolvedValue([
        { key: 'push.vapidPublicKey', value: 'stored-public' },
        { key: 'push.vapidPrivateKey', value: 'stored-private' },
      ]);

      const settings = await getPushSettings();

      expect(settings.vapidPublicKey).toBe('stored-public');
      expect(mockGenerateVAPIDKeys).not.toHaveBeenCalled();
    });

    it('only reads SystemSetting keys in the push namespace', async () => {
      mockSystemSettingFindMany.mockResolvedValue([]);

      await getPushSettings();

      expect(mockSystemSettingFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { key: { startsWith: 'push.' } } }),
      );
    });

    it('falls back to a safe disabled state when the settings table is unavailable', async () => {
      mockSystemSettingFindMany.mockRejectedValue(new Error('DB down'));

      const settings = await getPushSettings();

      // Not a throw: a settings outage must not break a send path.
      expect(settings.vapidPublicKey).toBeNull();
      expect(settings.vapidPrivateKey).toBeNull();
    });
  });

  describe('admin master switch', () => {
    it('defaults to OFF when no setting row exists', async () => {
      mockSystemSettingFindUnique.mockResolvedValue(null);

      // Push must never be on because nobody decided yet.
      expect(await isPushEnabled()).toBe(false);
    });

    it('is OFF unless the stored value is exactly "true"', async () => {
      mockSystemSettingFindUnique.mockResolvedValue({ value: 'false' });
      expect(await isPushEnabled()).toBe(false);

      __resetPushSettingsMemoForTests();
      mockSystemSettingFindUnique.mockResolvedValue({ value: '1' });
      expect(await isPushEnabled()).toBe(false);

      __resetPushSettingsMemoForTests();
      mockSystemSettingFindUnique.mockResolvedValue({ value: 'true' });
      expect(await isPushEnabled()).toBe(true);
    });

    it('persists the switch through an upsert on push.enabled', async () => {
      await setPushEnabled(true, 'admin-1');

      expect(mockSystemSettingUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { key: 'push.enabled' },
          create: expect.objectContaining({ key: 'push.enabled', value: 'true' }),
        }),
      );
    });
  });

  describe('client-facing config', () => {
    it('exposes the public key when enabled', async () => {
      mockSystemSettingFindUnique.mockResolvedValue({ value: 'true' });
      mockSystemSettingFindMany.mockResolvedValue([
        { key: 'push.vapidPublicKey', value: 'stored-public' },
        { key: 'push.vapidPrivateKey', value: 'stored-private' },
      ]);

      const config = await getPublicVapidConfig();

      expect(config.enabled).toBe(true);
      expect(config.publicKey).toBe('stored-public');
    });

    it('NEVER includes the private key', async () => {
      mockSystemSettingFindUnique.mockResolvedValue({ value: 'true' });
      mockSystemSettingFindMany.mockResolvedValue([
        { key: 'push.vapidPublicKey', value: 'stored-public' },
        { key: 'push.vapidPrivateKey', value: 'super-secret-private' },
      ]);

      const config = await getPublicVapidConfig();

      expect(Object.keys(config)).not.toContain('vapidPrivateKey');
      expect(JSON.stringify(config)).not.toContain('super-secret-private');
    });

    it('reports disabled and withholds the public key when the switch is off', async () => {
      mockSystemSettingFindUnique.mockResolvedValue({ value: 'false' });
      mockSystemSettingFindMany.mockResolvedValue([
        { key: 'push.vapidPublicKey', value: 'stored-public' },
        { key: 'push.vapidPrivateKey', value: 'stored-private' },
      ]);

      const config = await getPublicVapidConfig();

      expect(config.enabled).toBe(false);
      expect(config.publicKey).toBeNull();
    });

    it('reports disabled when no key pair exists and the switch is on', async () => {
      mockSystemSettingFindUnique.mockResolvedValue({ value: 'true' });
      mockSystemSettingFindMany.mockRejectedValue(new Error('DB down'));

      const config = await getPublicVapidConfig();

      expect(config.enabled).toBe(false);
      expect(config.publicKey).toBeNull();
    });
  });
});
