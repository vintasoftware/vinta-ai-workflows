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
