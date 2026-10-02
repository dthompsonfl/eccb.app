/**
 * Push settings — DB-backed VAPID key management via the SystemSetting table.
 *
 * Follows the repo's established pattern (src/lib/stand/settings.ts,
 * src/lib/cms/public-settings.ts): namespaced SystemSetting keys, an explicit
 * key allowlist, env used only as a fallback, nothing hardcoded.
 *
 * The VAPID private key is a CREDENTIAL. It is:
 *   - never returned by getPublicVapidConfig() (the client-facing getter)
 *   - never written to the client bundle
 *   - never logged
 * getPushSettings() is a server-only function for that reason.
 *
 * Key generation is lazy and idempotent: the first caller that finds no keys
 * generates a pair and persists it. Subsequent calls read the stored pair, so
 * subscriptions made with the old public key stay valid across restarts and
 * across multiple app instances.
 */

import webpush from 'web-push';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

const KEY_PREFIX = 'push.';
const CACHE_TTL_SECONDS = 300;

export const PUSH_SETTING_KEYS = [
  'vapidPublicKey',
  'vapidPrivateKey',
  'vapidSubject',
] as const;

export type PushSettingKey = (typeof PUSH_SETTING_KEYS)[number];

export interface PushSettings {
  /** Base64url VAPID public key. Null when the pair has not been generated yet. */
  vapidPublicKey: string | null;
  /** Base64url VAPID private key. SERVER ONLY. */
  vapidPrivateKey: string | null;
  /**
   * VAPID `sub` claim. Push services require a contact URI (mailto: or https:)
   * so a failing push service operator can reach the sender.
   */
  vapidSubject: string;
}

/** Admin master switch. Push is off platform-wide unless an admin turns it on. */
export const PUSH_ENABLED_KEY = 'push.enabled';

export interface PushPublicConfig {
  /** False when no keys exist or the admin kill switch is off. */
  enabled: boolean;
  /** Public key for `applicationServerKey`, or null when push is unavailable. */
  publicKey: string | null;
  subject: string;
}

function toSystemKey(field: string): string {
  return `${KEY_PREFIX}${field}`;
}

function defaultSubject(): string {
  return `mailto:${env.SUPER_ADMIN_EMAIL}`;
}

/**
 * In-process memo. Deliberately not Redis: the key pair is stable once
 * generated, so an extra network round-trip per push send buys nothing, and
 * keeping it out of Redis means the credential is not written to a second
 * store that would need its own rotation story.
 */
let memo: PushSettings | null = null;

function resetMemoForTests(): void {
  memo = null;
}

/**
 * Read the push settings, generating a VAPID key pair on first use.
 *
 * Generation races between concurrent first-callers are benign: both pairs are
 * valid, one write wins the upsert, and the loser reads back the winner's pair
 * on the next call because the stored value is the source of truth.
 */
export async function getPushSettings(): Promise<PushSettings> {
  if (memo) return memo;

  let rows: Array<{ key: string; value: string }> = [];
  try {
    rows = await prisma.systemSetting.findMany({
      where: { key: { startsWith: KEY_PREFIX } },
      select: { key: true, value: true },
    });
  } catch {
    // Settings table unavailable — behave as "push not configured" rather than
    // throwing into a send path. Callers treat null keys as disabled.
    return {
      vapidPublicKey: null,
      vapidPrivateKey: null,
      vapidSubject: defaultSubject(),
    };
  }

  const map = new Map(rows.map((r) => [r.key, r.value]));
  let publicKey = map.get(toSystemKey('vapidPublicKey')) || null;
  let privateKey = map.get(toSystemKey('vapidPrivateKey')) || null;
  const subject = map.get(toSystemKey('vapidSubject')) || defaultSubject();

  if (!publicKey || !privateKey) {
    const generated = webpush.generateVAPIDKeys();
    await persistPair(generated.publicKey, generated.privateKey);
    publicKey = generated.publicKey;
    privateKey = generated.privateKey;
  }

  memo = { vapidPublicKey: publicKey, vapidPrivateKey: privateKey, vapidSubject: subject };
  return memo;
}

async function persistPair(publicKey: string, privateKey: string): Promise<void> {
  const entries: Array<[string, string]> = [
    [toSystemKey('vapidPublicKey'), publicKey],
    [toSystemKey('vapidPrivateKey'), privateKey],
  ];
  try {
    await prisma.systemSetting.createMany({
      data: entries.map(([key, value]) => ({
        key,
        value,
        description: `Push — ${key.slice(KEY_PREFIX.length)}`,
      })),
      skipDuplicates: true,
    });
  } catch {
    // Non-fatal: the generated pair is still usable for this process lifetime.
  }
}

/** True when an admin has enabled push platform-wide. Defaults to OFF. */
export async function isPushEnabled(): Promise<boolean> {
  try {
    const row = await prisma.systemSetting.findUnique({
      where: { key: PUSH_ENABLED_KEY },
      select: { value: true },
    });
    // Absent setting means nobody has opted the platform in. Default OFF.
    return row?.value === 'true';
  } catch {
    return false;
  }
}

/** Admin setter for the master switch. */
export async function setPushEnabled(enabled: boolean, updatedBy?: string): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key: PUSH_ENABLED_KEY },
    create: {
      key: PUSH_ENABLED_KEY,
      value: String(enabled),
      description: 'Push — platform master switch',
      updatedBy: updatedBy ?? null,
    },
    update: { value: String(enabled), updatedBy: updatedBy ?? null },
  });
}

/**
 * The ONLY shape safe to hand to the browser.
 *
 * Note what is absent: `vapidPrivateKey`. A getter that returned it, even
 * unused by the client, would make a single accidental spread of this object
 * into a response a full credential disclosure.
 */
export async function getPublicVapidConfig(): Promise<PushPublicConfig> {
  const [enabled, settings] = await Promise.all([isPushEnabled(), getPushSettings()]);

  const usable = enabled && !!settings.vapidPublicKey && !!settings.vapidPrivateKey;
  return {
    enabled: usable,
    publicKey: usable ? settings.vapidPublicKey : null,
    subject: settings.vapidSubject,
  };
}

export const PUSH_CACHE_TTL_SECONDS = CACHE_TTL_SECONDS;
export { resetMemoForTests as __resetPushSettingsMemoForTests };
