/**
 * The Stand socket path contract — ONE place that defines every URL shape and
 * cookie rule involved in `/api/stand/socket`, so the parties that must agree
 * cannot silently drift apart again.
 *
 * Deliberately dependency-free (no imports) so `next.config.ts`, the browser
 * hook, the socket server and `src/lib/setup/setup-guard.ts` can all import it
 * without pulling anything in. `next.config.ts` is evaluated at BUILD time, so
 * this module must never gain an import.
 *
 * ── Why the path constants look contradictory on purpose ────────────────────
 * Three separate places have to agree on the exact path shape, and they used to
 * disagree:
 *
 *   1. the browser client        (`src/hooks/use-stand-sync.ts`)
 *   2. the Next.js rewrite       (`next.config.ts`, frozen into the build at
 *                                 BUILD time into `.next/routes-manifest.json`)
 *   3. the engine.io server      (`src/lib/websocket/stand-socket.ts`, hosted in
 *                                 the workers process on SOCKET_PORT)
 *
 * The two ends want DIFFERENT shapes, and that is not a bug — it is what makes
 * the proxy hop work at all:
 *
 *   - engine.io's server matches with a prefix compare against `${path}/`
 *     (`_computePath` appends the slash unless `addTrailingSlash:false`), so it
 *     only answers the **slashed** form.
 *   - Next.js normalises `/api/stand/socket/` to the slashless form and answers
 *     **308**, and a WebSocket UPGRADE CANNOT FOLLOW A REDIRECT.
 *
 * So the only shape that survives the hop is: the client asks for the SLASHLESS
 * path, Next's rewrite re-adds the slash on the way out, and engine.io upstream
 * matches it. Get any one of the three wrong and every member silently falls
 * back to polling while `/ready` still reports `sockets: true`.
 *
 * Verified against a running `npm run start:all`: a raw RFC6455 upgrade to the
 * slashless path on the app port returns 101, the engine.io handshake frame
 * arrives with a sid, socket.io replies `40` (connected), and a director page
 * turn sent over the socket is readable via GET /api/stand/sync.
 */

/** The path clients request and Next's rewrite matches. Must be SLASHLESS. */
export const STAND_SOCKET_PATH = '/api/stand/socket';

/**
 * Ask engine.io's client NOT to append a trailing slash.
 *
 * `false` ⇒ the browser requests `${STAND_SOCKET_PATH}?EIO=4...`, the one shape
 * Next.js is able to upgrade. `true` restores the 308 dead end.
 */
export const STAND_SOCKET_ADD_TRAILING_SLASH = false;

/**
 * The upstream path the rewrite destination must carry.
 *
 * MUST be slashed: it is what the engine.io server in the workers process
 * actually matches. Dropping this slash hangs every proxied handshake while
 * health endpoints keep reporting the sockets healthy — the exact failure the
 * preflight's `rewrite.socket-path` check exists to catch.
 */
export const STAND_SOCKET_UPSTREAM_PATH = `${STAND_SOCKET_PATH}/`;

/** The engine.io server's own `path` option. */
export const STAND_SOCKET_SERVER_PATH = STAND_SOCKET_PATH;

/**
 * Strip Better Auth's cookie signature from a session cookie value.
 *
 * Better Auth signs its session cookie as `${token}.${hmacSha256Signature}`
 * (`setSignedCookie`, read back with `getSignedCookie`). Only the part BEFORE the
 * dot is the `Session.token` column value.
 *
 * Callers that resolve a session from a raw `Cookie` header MUST strip it. A
 * lookup keyed on the raw value silently matches nothing, so the caller fails
 * closed and reports "not signed in" for a member who demonstrably is.
 *
 * This was a live production bug: `stand-socket`'s `io.use` middleware queried
 * `prisma.session.findFirst({ token })` with the raw cookie value, so EVERY
 * WebSocket connection was rejected with `44{"message":"Unauthorized"}` — even
 * for genuinely authenticated members holding a valid session cookie. The
 * engine.io handshake still completed (it runs BEFORE socket.io's auth
 * middleware), which is why a probe that only looked for a handshake sid
 * reported success while real clients could never connect. Polling kept working
 * because it goes through Better Auth, which verifies the signature itself.
 *
 * Splitting on the FIRST dot matches Better Auth's own reader: the token is a
 * base64url/hex random value that never contains a dot.
 */
export function extractSessionToken(cookieValue: string | undefined): string | undefined {
  if (!cookieValue) return undefined;
  const separator = cookieValue.indexOf('.');
  const token = separator === -1 ? cookieValue : cookieValue.slice(0, separator);
  return token.length > 0 ? token : undefined;
}