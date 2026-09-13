/**
 * The transcript, read the way §5.3 stores it: one normalized `AgentEvent` per
 * line, served as the tail of that file by `/api/runs/:runId/nodes/:nodeId`.
 *
 * The API types those entries as `unknown` — deliberately, since the journal
 * copies whatever the adapter emitted — so the narrowing has to happen
 * somewhere, and this is the only place that knows what a chat row looks like.
 *
 * Two rules:
 *
 * - **The union is `AgentEvent`'s, not a second opinion of it.** `KINDS` is
 *   checked against `AgentEvent['type']` in both directions: `satisfies`
 *   rejects a kind that does not exist, and `ENTRY_KINDS_COVERED` fails to
 *   compile when a kind exists and has no member here. A harness that grows an
 *   event type breaks this file rather than rendering as a blank row.
 * - **An entry that does not parse is still a row.** A transcript is the
 *   record of a run; silently dropping a line the UI did not recognise would
 *   make the record lie. It renders as an unreadable entry, and its content is
 *   not guessed at.
 *
 * Nothing here logs. Transcript text is repository content (§11) and this
 * module's only output is a value handed to a component that renders it.
 */
import { z } from 'zod'
import type { AgentEvent } from '../../src/harness/adapter.ts'
import type { Tone } from './status.ts'

/** Mirrors `daemon/schemas.ts`'s exhaustiveness check, in the same shape. */
type Covers<Union extends string, Listed extends string> = [Exclude<Union, Listed>] extends [never]
  ? true
  : never

const KINDS = [
  'session_started',
  'user_message',
  'assistant_text',
  'thinking',
  'tool_use',
  'tool_result',
  'permission_request',
  'permission_denied',
  'usage',
  'error',
  'session_ended',
] as const satisfies readonly AgentEvent['type'][]

const EntrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session_started'), sessionId: z.string() }),
  z.object({ type: z.literal('user_message'), text: z.string() }),
  z.object({ type: z.literal('assistant_text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), text: z.string() }),
  z.object({ type: z.literal('tool_use'), name: z.string(), id: z.string(), input: z.unknown() }),
  z.object({ type: z.literal('tool_result'), id: z.string(), ok: z.boolean(), summary: z.string() }),
  z.object({ type: z.literal('permission_request'), tool: z.string(), detail: z.unknown() }),
  z.object({
    type: z.literal('permission_denied'),
    tool: z.string(),
    reason: z.string(),
    detail: z.string().optional(),
  }),
  z.object({
    type: z.literal('usage'),
    input: z.number(),
    output: z.number(),
    costUsd: z.number().optional(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('session_ended'), result: z.enum(['ok', 'error', 'interrupted']) }),
])

type Entry = z.infer<typeof EntrySchema>

/**
 * `true` only while every `AgentEvent` kind has a member above. A new kind
 * makes this `never`, and the assignment stops compiling.
 */
export const ENTRY_KINDS_COVERED: Covers<AgentEvent['type'], Entry['type']> = true

/** Also exported so a test can name the kinds without restating them. */
export const TRANSCRIPT_KINDS: readonly AgentEvent['type'][] = KINDS

/** Who said it. The operator's own steering is never attributed to the agent. */
export type Author = 'agent' | 'operator' | 'tool' | 'system'

/** One chat row, ready to render. Presentation only — no element is built here. */
export interface EntryView {
  /** The event's own `type`, or `unreadable`. Becomes `data-kind`. */
  readonly kind: string
  readonly author: Author
  /** The attribution shown beside the row. */
  readonly label: string
  readonly body: string
  readonly tone: Tone | null
}

const AUTHOR_LABELS: Readonly<Record<Author, string>> = {
  agent: 'Agent',
  operator: 'Operator (you)',
  tool: 'Tool',
  system: 'Session',
}

export function present(raw: unknown): EntryView {
  const parsed = EntrySchema.safeParse(raw)
  if (!parsed.success) {
    return {
      kind: 'unreadable',
      author: 'system',
      label: 'Unreadable entry',
      body: 'This entry did not match any known agent event.',
      tone: null,
    }
  }
  const entry = parsed.data
  switch (entry.type) {
    case 'session_started':
      return row(entry.type, 'system', `session ${entry.sessionId}`, null, 'Session started')
    case 'user_message':
      // §7: the one input that changed a run's direction. It is the operator's,
      // and the row says so before it says anything else.
      return row(entry.type, 'operator', entry.text, 'attention')
    case 'assistant_text':
      return row(entry.type, 'agent', entry.text, null)
    case 'thinking':
      return row(entry.type, 'agent', entry.text, null, 'Agent · thinking')
    case 'tool_use':
      return row(entry.type, 'tool', preview(entry.input), null, `Tool · ${entry.name}`)
    case 'tool_result':
      return row(
        entry.type,
        'tool',
        entry.summary,
        entry.ok ? 'ok' : 'error',
        `Tool result · ${entry.ok ? 'ok' : 'failed'}`,
      )
    case 'permission_request':
      return row(entry.type, 'tool', preview(entry.detail), 'attention', `Permission · ${entry.tool}`)
    // `error`, not `attention`: a request is waiting for someone and a denial
    // is already over. The row above carries what the tool was trying to do.
    // The sentence when there is one, the token when there is not. The token
    // alone ("other") reads as though the record is broken; the sentence is
    // what an operator can act on.
    case 'permission_denied':
      return row(
        entry.type,
        'tool',
        entry.detail === undefined ? entry.reason : `${entry.reason} — ${entry.detail}`,
        'error',
        `Refused · ${entry.tool}`,
      )
    case 'usage':
      return row(entry.type, 'system', usage(entry), null, 'Usage')
    case 'error':
      return row(entry.type, 'system', entry.message, 'error', 'Error')
    case 'session_ended':
      return row(entry.type, 'system', entry.result, entry.result === 'ok' ? 'ok' : 'error', 'Session ended')
  }
}

function row(kind: string, author: Author, body: string, tone: Tone | null, label?: string): EntryView {
  return { kind, author, label: label ?? AUTHOR_LABELS[author], body, tone }
}

function usage(entry: Extract<Entry, { type: 'usage' }>): string {
  const cost = entry.costUsd === undefined ? '' : ` · $${entry.costUsd.toFixed(2)}`
  return `${entry.input} in · ${entry.output} out${cost}`
}

/** Tool payloads can be whole files. The row shows a look, the log has the rest. */
const PREVIEW_LIMIT = 400

function preview(value: unknown): string {
  if (typeof value === 'string') return clamp(value)
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    return '[unserialisable]'
  }
  return clamp(text)
}

function clamp(text: string): string {
  return text.length <= PREVIEW_LIMIT ? text : `${text.slice(0, PREVIEW_LIMIT)}…`
}
