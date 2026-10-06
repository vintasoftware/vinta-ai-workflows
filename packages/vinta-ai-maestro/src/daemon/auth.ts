/**
 * The daemon's only security boundary (§11).
 *
 * There are no credentials in this system — no login, no key storage, no
 * session cookie. What exists is one random token, minted per daemon process,
 * that must accompany **every** request and the WebSocket upgrade. That single
 * secret is the whole reason a browser tab on the same machine cannot reach a
 * run it was not handed the URL for, and the reason a bound port is not an
 * open door.
 *
 * Three properties, each of which is a bug when it is absent:
 *
 * - **`node:crypto` randomness.** `Math.random` is a PRNG whose state is
 *   recoverable from a handful of outputs; a token drawn from it is guessable
 *   by anything that can observe one other token from the same process.
 * - **Constant-time comparison, over digests.** `===` on strings returns early
 *   at the first differing byte, which leaks the shared prefix to a caller
 *   that can time it. Comparing SHA-256 digests rather than the raw strings
 *   also fixes the length of both operands, so nothing leaks the token's size
 *   either — and `timingSafeEqual` never has to be guarded against a
 *   length mismatch that would itself be an early return.
 * - **Header *or* query.** §10 puts the token in the URL the daemon prints,
 *   because a WebSocket upgrade from a browser cannot carry an `Authorization`
 *   header. Accepting only the header would mean the UI could not connect;
 *   accepting only the query would push the token into every fetch's URL. Both
 *   are accepted and checked identically.
 *
 * Nothing in this module logs. The token is never an argument to anything that
 * writes — not a log line, not an error message, not a journal payload.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** The query parameter the token may arrive in, for the WebSocket upgrade (§10). */
export const TOKEN_QUERY = 'token'

const BEARER = /^Bearer (.+)$/

/** 256 bits of CSPRNG output. `base64url` so it survives a URL untouched. */
export function createToken(): string {
  return randomBytes(32).toString('base64url')
}

/** The token a request presents, from `Authorization: Bearer` or `?token=`. */
export function presentedToken(authorization: string | undefined, url: URL): string | null {
  const bearer = authorization === undefined ? null : BEARER.exec(authorization)?.[1]
  if (bearer !== undefined && bearer !== null) return bearer
  return url.searchParams.get(TOKEN_QUERY)
}

/** Constant-time, over fixed-length digests. A missing token is a mismatch. */
export function tokenMatches(expected: string, presented: string | null): boolean {
  if (presented === null) return false
  return timingSafeEqual(digest(expected), digest(presented))
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/** Loopback hosts, the only ones that do not earn the `--host` warning (§11). */
export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}
