/**
 * jsdom ships a `WebSocket` whose events are dispatched by Node's undici
 * implementation into jsdom's `EventTarget`, and the two disagree about what
 * an `Event` is — every connection dies with `ERR_INVALID_ARG_TYPE` before a
 * frame arrives. That is a jsdom/undici incompatibility, not a fact about the
 * UI, so the global is replaced with the `ws` client the daemon's own tests
 * use: the same protocol, over a real socket, against a real server.
 *
 * `fetch` is left alone — Node's works in this environment.
 */
import { WebSocket as WsClient } from 'ws'

globalThis.WebSocket = WsClient as unknown as typeof globalThis.WebSocket

/**
 * Silences jsdom's `Not implemented: HTMLCanvasElement's getContext()`.
 *
 * xterm.js measures a character cell through a canvas when it sets its
 * renderer up, and jsdom has no canvas — so every terminal test printed the
 * warning, several times each, and buried the rest of the output.
 *
 * **Deliberately not solved by installing `canvas`.** That package is a native
 * module needing Cairo and Pango, so it would put a C toolchain back in the
 * install path of every contributor and every CI runner — the exact problem
 * that broke this package's Windows leg, and for far less reason: jsdom has no
 * layout engine, so a canvas it could actually draw on would still measure
 * nothing true. Nothing in this suite asserts a rendered glyph; the terminal
 * tests assert the *protocol* — which frames cross the socket, that there is
 * one socket, that a malformed frame is rejected.
 *
 * Returns `null`, which is exactly what jsdom returns after warning, so xterm
 * takes the same fallback it takes today. This removes the message, not a
 * behaviour.
 */
HTMLCanvasElement.prototype.getContext = (() =>
  null) as unknown as typeof HTMLCanvasElement.prototype.getContext
