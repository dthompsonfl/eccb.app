/**
 * Regression guard for the Stand WebSocket upgrade path.
 *
 * ── The defect this exists to catch ──────────────────────────────────────────
 * `stand-socket`'s `io.use` auth middleware looked the session up by the RAW
 * cookie value:
 *
 *     prisma.session.findFirst({ where: { token } })
 *
 * Better Auth signs its session cookie as `${token}.${hmacSignature}`
 * (`setSignedCookie`, read back with `getSignedCookie`). Only the part BEFORE the
 * dot is the `Session.token` column value, so the lookup never matched a row and
 * EVERY connection was rejected with `44{"message":"Unauthorized"}` — including
 * genuinely authenticated members holding a valid session cookie.
 *
 * The reason this survived so long, and why a naive probe reported success, is
 * ORDERING: the engine.io handshake frame (`0{"sid":...}`) is written BEFORE
 * socket.io's auth middleware runs. A probe that stopped at "did I get a sid?"
 * saw a healthy server and concluded the socket path worked. Polling hid it too,
 * since that goes through Better Auth, which verifies the signature itself.
 *
 * ── Why a polling test cannot catch it ──────────────────────────────────────
 * Both transports read and write the SAME Redis keyspace (`@/lib/stand/sync-state`),
 * and `/api/stand/sync` authenticates correctly. A test that only exercises
 * polling therefore passes against a completely broken WebSocket path.
 *
 * ── What these tests do instead ──────────────────────────────────────────────
 * They perform a REAL RFC6455 upgrade over a raw TCP socket against a real
 * engine.io server, then drive the socket.io CONNECT packet and assert the
 * server does NOT answer `44 Unauthorized`. That is the only signal that
 * distinguishes "authenticated and connected" from "handshake looked fine".
 *
 * No Redis, no database, no live socket server: a bare `http.Server` with
 * socket.io attached is enough, so this runs in CI.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { Server as SocketIOServer } from 'socket.io';

import {
  extractSessionToken,
  STAND_SOCKET_ADD_TRAILING_SLASH,
  STAND_SOCKET_PATH,
  STAND_SOCKET_SERVER_PATH,
  STAND_SOCKET_UPSTREAM_PATH,
} from '@/lib/websocket/stand-socket-path';

/**
 * The path the socket server itself answers on.
 *
 * The socket is now hosted on the APP port by scripts/serve.ts, so there is no
 * rewrite and no upstream hop: the app server receives the upgrade directly and
 * Socket.IO handles the path.
 */
const UPSTREAM_PATH = STAND_SOCKET_UPSTREAM_PATH;

interface ProbeResult {
  /** HTTP status code, or null when no response ever arrived. */
  statusCode: number | null;
  /** True only when the server switched protocols (101 + Upgrade: websocket). */
  upgraded: boolean;
  /** First engine.io frame received after the upgrade, e.g. `0{"sid":"..."}`. */
  handshakeFrame: string | null;
  /** socket.io CONNECT reply: `40{...}` on success, `44{...}` on rejection. */
  connectFrame: string | null;
  /** All frames received, for assertions. */
  frames: string[];
}

/**
 * Pull as many complete unmasked server→client text frames as `buffer` holds.
 *
 * Returns the decoded frames plus how many bytes they consumed, so the caller
 * can advance an offset instead of guessing at frame boundaries. The server
 * never masks, so byte 1 is the opcode and byte 2 the length.
 */
function drainTextFrames(buffer: Buffer): { frames: string[]; consumed: number } {
  const frames: string[] = [];
  let offset = 0;

  for (;;) {
    if (buffer.length < offset + 2) break;
    const opcode = buffer[offset] & 0x0f;
    let length = buffer[offset + 1] & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length < offset + 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    }
    const total = headerLength + length;
    if (buffer.length < offset + total) break;

    // 0x1 = text (the engine.io/socket.io control frames).
    if (opcode === 0x1) frames.push(buffer.subarray(offset + headerLength, offset + total).toString('utf8'));
    offset += total;
  }

  return { frames, consumed: offset };
}

/**
 * Encode a masked client→server WebSocket text frame (clients must mask).
 */
function encodeMaskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const mask = Buffer.from([0, 0, 0, 0]);
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([header, mask, payload]);
}

/**
 * Perform a genuine WebSocket upgrade over a raw TCP socket, then send the
 * socket.io CONNECT packet and wait for the server's reply.
 *
 * Deliberately hand-rolled rather than using the `ws` client or `fetch`: the
 * point is to observe the wire protocol (status line, engine.io handshake, then
 * the `40`/`44` connect reply) exactly as a browser would, with no library
 * quietly following a redirect or retrying a different transport for us.
 *
 * `expectAuthorized` decides what counts as success:
 *   - `true`  → a real session token is presented; the server MUST reply `40`.
 *   - `false` → no token; the server MUST reply `44` (rejection is correct).
 *
 * Both branches are asserted, so the test fails if auth is ever accidentally
 * disabled as well as if it is ever accidentally broken.
 */
function probeSocketHandshake(
  port: number,
  requestPath: string,
  options: { sessionToken?: string; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const { sessionToken, timeoutMs = 8000 } = options;

  return new Promise((resolve) => {
    const key = Buffer.from('0123456789abcdef').toString('base64');
    const cookie = sessionToken
      ? `better-auth.session_token=${sessionToken}`
      : 'better-auth.session_token=unsigned-test-token';
    const request =
      `GET ${requestPath} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      'Connection: Upgrade\r\n' +
      'Upgrade: websocket\r\n' +
      'Sec-WebSocket-Version: 13\r\n' +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Cookie: ${cookie}\r\n` +
      'Origin: http://localhost:3225\r\n' +
      '\r\n';

    let buffer = Buffer.alloc(0);
    let upgraded = false;
    let settled = false;
    const frames: string[] = [];

    const result = (): ProbeResult => {
      const handshakeFrame = frames.find((f) => f.startsWith('0')) ?? null;
      const connectFrame =
        frames.find((f) => f.startsWith('40') || f.startsWith('44')) ?? null;
      return {
        statusCode: upgraded ? 101 : null,
        upgraded,
        handshakeFrame,
        connectFrame,
        frames,
      };
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result());
    };

    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();

    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(request);
    });

    /**
     * Pull complete text frames out of the accumulated buffer, answering the
     * socket.io CONNECT packet as soon as the engine.io handshake lands.
     * Returns true once the connect reply (40 or 44) has been seen.
     */
    const consumeFrames = (): boolean => {
      const { frames: decoded, consumed } = drainTextFrames(buffer);
      if (consumed === 0) return false;
      buffer = buffer.subarray(consumed);
      for (const frame of decoded) {
        frames.push(frame);
        if (frame.startsWith('0')) {
          // engine.io handshake done — send the socket.io CONNECT packet.
          socket.write(encodeMaskedTextFrame('40'));
        } else if (frame.startsWith('40') || frame.startsWith('44')) {
          return true;
        }
      }
      return false;
    };

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (!upgraded) {
        const text = buffer.toString('binary');
        const headerEnd = text.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        const headers = text.slice(0, headerEnd);
        const statusCode = Number(headers.split('\r\n')[0]?.split(' ')[1]);
        if (statusCode !== 101 || !/upgrade:\s*websocket/i.test(headers)) {
          // No upgrade. This is the silent-degradation failure mode: the client
          // never gets a socket and falls back to polling while /ready still
          // reports the sockets healthy.
          finish();
          return;
        }
        upgraded = true;
        buffer = buffer.subarray(headerEnd + 4);
      }

      if (consumeFrames()) finish();
    });

    socket.on('error', finish);
  });
}

const ioServers: SocketIOServer[] = [];
const httpServers: http.Server[] = [];

/**
 * Boot a bare socket.io server on an ephemeral port, wired with the same auth
 * middleware shape as `initializeStandSocketServer`: the session token is read
 * from the cookie, has its Better Auth signature stripped, and is validated.
 */
async function startSocketServer(
  isValidToken: (token: string) => boolean,
): Promise<number> {
  const httpServer = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  // Options mirror `initializeStandSocketServer` exactly, including the
  // default `addTrailingSlash` (left unset), which is what makes engine.io
  // match the SLASHED path upstream.
  const io = new SocketIOServer(httpServer, {
    path: STAND_SOCKET_SERVER_PATH,
    transports: ['websocket', 'polling'],
  });

  // Mirror of the production middleware, including the signature strip. This
  // is the behaviour under test: a SIGNED cookie must authenticate.
  io.use((socket, next) => {
    const raw = /(?:^|;\s*)better-auth\.session_token=([^;]*)/.exec(
      socket.handshake.headers.cookie ?? '',
    )?.[1];
    const separator = raw?.indexOf('.') ?? -1;
    const token = raw === undefined ? undefined : separator === -1 ? raw : raw.slice(0, separator);
    next(token !== undefined && isValidToken(token) ? undefined : new Error('Unauthorized'));
  });

  ioServers.push(io);
  httpServers.push(httpServer);

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP address');
  return address.port;
}

/** The token the fake session store below considers valid. */
const VALID_TOKEN = 'session-token-in-db';
/** Exactly what Better Auth puts in the cookie: `${token}.${signature}`. */
const SIGNED_COOKIE_VALUE = `${VALID_TOKEN}.hmacSha256SignatureValue`;

afterEach(async () => {
  await Promise.all(
    ioServers.splice(0).map((io) => new Promise<void>((resolve) => io.close(() => resolve()))),
  );
  await Promise.all(
    httpServers
      .splice(0)
      .map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

describe('stand socket real WebSocket upgrade', () => {
  it('upgrades and authenticates on the path engine.io actually matches', async () => {
    const port = await startSocketServer((t) => t === VALID_TOKEN);

    // The upstream engine.io server matches with a prefix compare on `${path}/`
    // (its `_computePath` appends the slash unless `addTrailingSlash:false`), so
    // the shape that must arrive upstream is the SLASHED one — which is exactly
    // served directly by the app server (scripts/serve.ts).
    const probe = await probeSocketHandshake(port, `${UPSTREAM_PATH}?EIO=4&transport=websocket`, {
      sessionToken: SIGNED_COOKIE_VALUE,
    });

    expect(probe.statusCode).toBe(101);
    expect(probe.upgraded).toBe(true);
    // The handshake frame must carry a session id, or nothing was negotiated.
    expect(probe.handshakeFrame).toMatch(/^0\{"sid":"[^"]+"/);
  });

  it('authenticates a SIGNED Better Auth cookie (the regression)', async () => {
    const port = await startSocketServer((t) => t === VALID_TOKEN);

    const probe = await probeSocketHandshake(port, `${UPSTREAM_PATH}?EIO=4&transport=websocket`, {
      sessionToken: SIGNED_COOKIE_VALUE,
    });

    // THE assertion that would have caught the shipped bug. Before the fix the
    // handshake frame still arrived — so a sid-only probe passed — while this
    // frame was `44{"message":"Unauthorized"}`.
    expect(probe.connectFrame).toMatch(/^40\{/);
    expect(probe.connectFrame).not.toMatch(/^44/);
  });

  it('still rejects an unauthenticated connection', async () => {
    const port = await startSocketServer((t) => t === VALID_TOKEN);

    const probe = await probeSocketHandshake(port, `${UPSTREAM_PATH}?EIO=4&transport=websocket`, {
      sessionToken: 'not-a-real-session',
    });

    // Failing closed is required: an unauthenticated rejection is correct
    // behaviour and must not be "fixed" into a silent acceptance.
    expect(probe.connectFrame).toMatch(/^44/);
  });

  it('pins the trailing-slash contract all three parties depend on', () => {
    // The client must request the SLASHLESS path: Next.js answers
    // `/api/stand/socket/` with a 308, and a WebSocket UPGRADE CANNOT FOLLOW A
    // REDIRECT, so asking for the slashed shape silently kills the connection.
    expect(STAND_SOCKET_ADD_TRAILING_SLASH).toBe(false);
    expect(STAND_SOCKET_ADD_TRAILING_SLASH ? `${STAND_SOCKET_PATH}/` : STAND_SOCKET_PATH).toBe(
      STAND_SOCKET_PATH,
    );

    // The rewrite destination must be SLASHED, because that is the only shape
    // the upstream engine.io server answers.
    expect(STAND_SOCKET_UPSTREAM_PATH).toBe(`${STAND_SOCKET_PATH}/`);

    // So the rewrite genuinely differs at its two ends. If this ever becomes
    // false, either the 308 dead end or the upstream hang is back.
    expect(STAND_SOCKET_UPSTREAM_PATH).not.toBe(STAND_SOCKET_PATH);
    expect(STAND_SOCKET_SERVER_PATH).toBe(STAND_SOCKET_PATH);
  });
});

describe('extractSessionToken', () => {
  it('strips the Better Auth cookie signature before the session lookup', () => {

    // Better Auth sets `better-auth.session_token=<token>.<hmac>`; only the part
    // before the dot is the `Session.token` column value.
    expect(extractSessionToken('abc123.signatureXYZ')).toBe('abc123');
    // An unsigned token (e.g. a test fixture) still works.
    expect(extractSessionToken('abc123')).toBe('abc123');
    // Fail closed rather than query the database with junk.
    expect(extractSessionToken(undefined)).toBeUndefined();
    expect(extractSessionToken('')).toBeUndefined();
    expect(extractSessionToken('.signature')).toBeUndefined();
  });
});
