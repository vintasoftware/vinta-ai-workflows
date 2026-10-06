/**
 * The PTY channel's frames — the second member of §10's one WebSocket.
 *
 * `stream.ts` built the envelope as a union discriminated by `channel` with a
 * single member, so that this arrives as an *addition* rather than a format
 * change: a client written against `events` switches on `channel`, ignores
 * what it does not know, and keeps working.
 *
 * **This module is browser-safe on purpose.** The daemon's PTY implementation
 * imports `node-pty`; the terminal view cannot. Frames are the only thing both
 * sides need, so they live apart from the machinery — the same reason the run
 * schemas do.
 *
 * Two rules about `data`, which is the only field here that carries content.
 *
 * - It is terminal bytes, UTF-8 decoded: repository contents, command output,
 *   and whatever the operator typed — including a credential they pasted. It
 *   is never logged, never journalled, never quoted into an error (§11). The
 *   `error` frame carries a fixed token for exactly this reason: an error that
 *   echoed what the terminal said would be the leak the rest of the file is
 *   written to prevent.
 * - It is bounded on the way in. An `input` frame is keystrokes; a client
 *   sending a megabyte of them is not a terminal, and the cap means a peer
 *   that has authenticated still cannot make the daemon buffer without limit.
 */
import { z } from 'zod'

/** One frame's worth of keystrokes. Generous for a paste, useless as a firehose. */
export const MAX_INPUT_BYTES = 64 * 1024

/** Terminal geometry a pty will accept. Anything outside it is a client bug. */
const Dimension = z.number().int().min(1).max(1000)

/**
 * Client → daemon. `attach` names the node, never a session id or a command:
 * *what* runs is the adapter's decision and the session id is the daemon's, so
 * a peer cannot choose either. That is the difference between "take over this
 * node" and "run this on my machine".
 */
export const PtyClientFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({
    channel: z.literal('pty'),
    type: z.literal('attach'),
    nodeId: z.string().min(1).max(200),
    cols: Dimension,
    rows: Dimension,
  }),
  z.strictObject({
    channel: z.literal('pty'),
    type: z.literal('input'),
    data: z.string().max(MAX_INPUT_BYTES),
  }),
  z.strictObject({
    channel: z.literal('pty'),
    type: z.literal('resize'),
    cols: Dimension,
    rows: Dimension,
  }),
  z.strictObject({ channel: z.literal('pty'), type: z.literal('detach') }),
])

/**
 * Why an attach did not happen, as fixed tokens. Never vendor prose and never
 * anything the terminal or the CLI said.
 */
export const PTY_ERRORS = [
  'unknown_run',
  'unknown_node',
  'not_supported',
  'attach_failed',
  'already_attached',
] as const

/** Daemon → client. */
export const PtyServerFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({
    channel: z.literal('pty'),
    type: z.literal('attached'),
    nodeId: z.string(),
    /** §9's handoff token, echoed so the operator sees which session they hold. */
    sessionId: z.string(),
  }),
  z.strictObject({ channel: z.literal('pty'), type: z.literal('data'), data: z.string() }),
  z.strictObject({ channel: z.literal('pty'), type: z.literal('exit'), code: z.number().int() }),
  z.strictObject({
    channel: z.literal('pty'),
    type: z.literal('error'),
    reason: z.enum(PTY_ERRORS),
  }),
])

export type PtyClientFrame = z.infer<typeof PtyClientFrameSchema>
export type PtyServerFrame = z.infer<typeof PtyServerFrameSchema>
export type PtyError = (typeof PTY_ERRORS)[number]
