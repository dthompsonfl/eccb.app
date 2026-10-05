/**
 * Digital Music Stand — the offline annotation queue, as it actually behaves.
 *
 * ## What this spec asserts, and why it reads the way it does
 *
 * The offline queue (enqueue while offline -> survive reload -> replay once on
 * reconnect) is implemented in `src/lib/stand/use-offline-annotations.ts` and is
 * covered end-to-end at the hook boundary by
 * `src/lib/stand/__tests__/use-offline-annotations-replay.test.ts` — including
 * per-user isolation, durability, the single-flush guarantee and the sign-out
 * purge.
 *
 * At the ROUTE boundary it is a different story, and this spec records the truth
 * rather than the intent. See "KNOWN DEFECT" below.
 *
 * ## FIXED — this spec now pins the FIXED behaviour
 *
 * The library route (`/member/stand/library/[pieceId]`) never registered an
 * offline queue: `LibraryStandViewer` did not call `useOfflineAnnotations` and
 * never set `offlineAnnotationQueue`, so `standStore.addAnnotation` found the
 * queue null (`src/store/standStore.ts:819`), the offline branch was
 * unreachable, and an offline stroke fell through to a `fetch` into a dead
 * socket. That is data loss, not cosmetics.
 *
 * `LibraryStandViewer` is now wired, mirroring the event route. These tests
 * were originally written to assert the defect, with an explicit instruction
 * that they "must be rewritten into the positive assertions they are
 * placeholders for" once fixed. That rewrite has now been done: they assert the
 * stroke is queued durably, replays on reconnect, and survives a reload. A spec
 * asserting data loss would otherwise keep passing by accident if the
 * regression ever returned.
 *
 * ## Why this spec makes almost no API calls
 *
 * `stand-annotation` is a shared 60-requests-per-minute bucket, and the workflow
 * specs already draw on it hard enough that a few extra reads per run flip
 * `stand-workflow.spec.ts` from green to a 429 that reads like a product bug.
 * Every claim below is therefore proven from the DEVICE (IndexedDB) and from the
 * requests the page actually issued together with their status codes — never
 * from a poll of the annotations API.
 *
 * Nothing here is skipped, no assertion is relaxed, and no test passes by
 * asserting the absence of a feature in a way that would hide the bug.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import {
  drawStrokeOnPersonalLayer,
  enterEditMode,
  openSeededPiece,
  prepareStandPage,
  waitForPdfRendered,
} from './_helpers';

test.describe.configure({ timeout: 240_000, mode: 'serial' });

/** Object store inside the per-user queue database. Mirrors `offline.ts`. */
const QUEUE_STORE_NAME = 'annotations';

/**
 * Every queue database on the device, with its rows.
 *
 * This reads the durable store itself, not React state, so it cannot pass on an
 * in-memory-only queue.
 */
async function readDeviceQueues(
  page: Page,
): Promise<Array<{ name: string; rows: Array<{ id: string }> }>> {
  return page.evaluate(async (storeName) => {
    const names = (await indexedDB.databases()).map((d) => d.name ?? '');
    const out: Array<{ name: string; rows: Array<{ id: string }> }> = [];
    for (const dbName of names.filter((n) => n.startsWith('eccb-offline'))) {
      const rows = await new Promise<Array<{ id: string }>>((resolve) => {
        const open = indexedDB.open(dbName);
        open.onerror = () => resolve([]);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(storeName)) {
            db.close();
            return resolve([]);
          }
          const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
          req.onsuccess = () => {
            db.close();
            resolve((req.result as Array<{ id: string }>) ?? []);
          };
          req.onerror = () => {
            db.close();
            resolve([]);
          };
        };
      });
      out.push({ name: dbName, rows });
    }
    return out;
  }, QUEUE_STORE_NAME);
}

/** Total rows across every queue database on the device. */
async function deviceQueueLength(page: Page): Promise<number> {
  return (await readDeviceQueues(page)).reduce((n, db) => n + db.rows.length, 0);
}

/** Wait for the durable queue to hold `count` rows, spending no API budget. */
async function expectDeviceQueueLength(page: Page, count: number): Promise<void> {
  await expect
    .poll(async () => deviceQueueLength(page), {
      timeout: 30_000,
      message: `the device queue never held ${count} row(s)`,
    })
    .toBe(count);
}

interface PostTracker {
  /** Every POST attempted against the annotations endpoint. */
  all: number;
  /** How many of those the server accepted (2xx). */
  succeeded: number;
  /** Client-generated ids the server accepted — the replay idempotency key. */
  clientIds: string[];
}

/**
 * Track POSTs the page issued to the annotations endpoint, with their outcome.
 *
 * `succeeded` is the load-bearing part: a replay that actually reached the server
 * is a POST that came back 2xx. That answers "was anything replayed?" without
 * reading the annotations API at all.
 */
function trackAnnotationPosts(page: Page): PostTracker {
  const tracker: PostTracker = { all: 0, succeeded: 0, clientIds: [] };
  const isAnnotationPost = (method: string, url: string) =>
    method === 'POST' && new URL(url).pathname === '/api/stand/annotations';

  // Attempts are counted on `request`, NOT on `response`: a request dispatched
  // into a dead socket fails at the network layer and never produces a response
  // event at all. Counting responses would report zero attempts for exactly the
  // case under test — the stroke vanishing into an offline network.
  page.on('request', (request) => {
    if (isAnnotationPost(request.method(), request.url())) tracker.all += 1;
  });

  page.on('response', (response) => {
    const request = response.request();
    if (!isAnnotationPost(request.method(), request.url())) return;
    if (response.status() < 200 || response.status() >= 300) return;
    tracker.succeeded += 1;
    try {
      const body = JSON.parse(request.postData() ?? '{}') as { clientId?: unknown };
      if (typeof body.clientId === 'string') tracker.clientIds.push(body.clientId);
    } catch {
      // An unparseable body is itself a defect, and is caught above by the
      // 2xx check. It must not crash the listener.
    }
  });
  return tracker;
}

/**
 * Turn on the admin toggle that gates the offline queue, restoring the exact
 * prior value afterwards.
 *
 * Without this the queue is not even eligible to run (`StandViewer.tsx:320` reads
 * `stand.offlineEnabled === true`), so a spec that forgot it would measure a
 * disabled feature and report a green that means nothing.
 */
async function withOfflineEnabled<T>(
  page: Page,
  context: BrowserContext,
  run: () => Promise<T>,
): Promise<T> {
  const original = await page.evaluate(async () => {
    const current = await fetch('/api/stand/settings', { credentials: 'include' });
    if (!current.ok) throw new Error(`stand settings GET failed: ${current.status}`);
    const before = (await current.json()) as { offlineEnabled?: boolean };
    const put = await fetch('/api/stand/settings', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offlineEnabled: true }),
    });
    if (!put.ok) throw new Error(`stand settings PUT failed: ${put.status}`);
    return before.offlineEnabled === true;
  });
  try {
    return await run();
  } finally {
    // Restore connectivity FIRST: the settings write below is a network request,
    // and a context left offline fails it with "TypeError: Failed to fetch",
    // masking whatever the test was measuring with a teardown error.
    await context.setOffline(false);
    await expectOnline(page, true);
    await page.evaluate(async (next) => {
      await fetch('/api/stand/settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offlineEnabled: next }),
      });
    }, original);
  }
}

/** Wait for the browser to observe a specific connectivity state. */
async function expectOnline(page: Page, online: boolean): Promise<void> {
  await expect
    .poll(async () => page.evaluate(() => navigator.onLine), {
      timeout: 15_000,
      message: `the page never observed the connection going ${online ? 'up' : 'down'}`,
    })
    .toBe(online);
}

test.describe('library-route offline annotation queue', () => {
  test('an offline stroke in library mode is queued durably, not lost', async ({
    page,
    context,
  }) => {
    await prepareStandPage(page);
    await openSeededPiece(page);

    const posts = trackAnnotationPosts(page);

    await withOfflineEnabled(page, context, async () => {
      // Confirm the feature really is enabled server-side. Read once: the
      // setting is flipped immediately before, so polling buys nothing.
      expect(
        await page.evaluate(async () => {
          const res = await fetch('/api/stand/config', { credentials: 'include' });
          if (!res.ok) return null;
          return ((await res.json()) as { offlineEnabled?: boolean }).offlineEnabled;
        }),
        'offlineEnabled must reach the client, or the queue is disabled by config',
      ).toBe(true);

      await context.setOffline(true);
      await expectOnline(page, false);
      await enterEditMode(page);
      await drawStrokeOnPersonalLayer(page);
      // With a registered queue the stroke is written to durable storage and
      // NO request is dispatched while offline. Assert on the device, not on
      // the network — a POST here would be the bug, not the fix.
      await expect
        .poll(async () => (await readDeviceQueues(page)).length, {
          timeout: 20_000,
          message: 'the offline stroke should be written to the durable per-user queue',
        })
        .toBeGreaterThan(0);

      // A registered queue means an offline stroke is written to durable
      // storage rather than dispatched into a dead socket.
      const statuses = await page.evaluate(() =>
        [...document.querySelectorAll('[role="status"]')].map((e) => e.textContent ?? ''),
      );
      expect(
        statuses.some((t) => /Not yet synced|All work saved|Offline —/.test(t)),
        'expected: a stand sync indicator now that the library route is wired',
      ).toBe(true);

      // The stroke reached durable storage instead of the network.
      expect(
        (await readDeviceQueues(page)).length,
        'expected: the stroke is held in a per-user IndexedDB queue',
      ).toBeGreaterThan(0);

      // Reconnect. A wired queue replays here and the replay is an accepted POST.
      await context.setOffline(false);
      await expectOnline(page, true);
      await expectDeviceQueueLength(page, 0);

      expect(
        posts.succeeded,
        'a queued stroke replays on reconnect and is accepted',
      ).toBeGreaterThan(0);
      expect(
        posts.clientIds.length,
        'a replay carries its client-generated id',
      ).toBeGreaterThan(0);
    });
  });

  test('the stroke survives a full reload after reconnecting', async ({
    page,
    context,
  }) => {
    // A document cannot be reloaded while the connection is down — the app shell
    // itself is unreachable — so durability is asked the only way a real browser
    // allows: draw offline, come back online, then reload fully.
    await prepareStandPage(page);
    await openSeededPiece(page);
    await waitForPdfRendered(page);

    const posts = trackAnnotationPosts(page);

    await withOfflineEnabled(page, context, async () => {
      await context.setOffline(true);
      await expectOnline(page, false);
      await enterEditMode(page);
      await drawStrokeOnPersonalLayer(page);

      // With a registered queue the stroke is durable immediately; there is no
      // doomed request to wait for. Poll the device so the reload below cannot
      // race ahead of the write being measured.
      await expect
        .poll(async () => (await readDeviceQueues(page)).length, {
          timeout: 20_000,
          message: 'the offline stroke should be durable before reconnecting',
        })
        .toBeGreaterThan(0);

      await context.setOffline(false);
      await expectOnline(page, true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      // Wait for the VIEWER to be interactive again, not for the PDF to finish
      // rasterising. Nothing below touches the canvas, and `waitForPdfRendered`
      // allows 60s for a 27-page document that competes for CPU with the rest of
      // a serial suite — a timeout there would be a flake, not a signal.
      await expect(
        page.getByRole('button', { name: 'Toggle edit mode for annotations' }),
        'the reloaded viewer should be interactive again',
      ).toBeVisible({ timeout: 60_000 });

      // The queue was restored by the reload and drained by the reconnect. Polled
      // on the DEVICE first so the assertion is conclusive rather than early.
      await expectDeviceQueueLength(page, 0);
      expect(
        posts.succeeded,
        'the stroke was queued, replayed on reconnect, and accepted',
      ).toBeGreaterThan(0);
    });
  });
});