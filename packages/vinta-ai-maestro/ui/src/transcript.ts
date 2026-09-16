/**
 * The transcript, read the way §5.3 stores it: one normalized `AgentEvent` per
 * line, served as the tail of that file by `/api/runs/:runId/nodes/:nodeId`.
 *
 * The API types those entries as `unknown` — deliberately, since the journal
 * copies whatever the adapter emitted — so the narrowing has to happen
 * somewhere, and this is the only place that knows what a chat row looks like.
 *
 * Three rules:
 *
 * - **The union is the daemon's, not a second opinion of it.** `AGENT_KINDS` is
 *   checked against `AgentEvent['type']` in both directions: `satisfies`
 *   rejects a kind that does not exist, and `ENTRY_KINDS_COVERED` fails to
 *   compile when a kind exists and has no member here. A harness that grows an
 *   event type breaks this file rather than rendering as a blank row. The same
 *   holds for the kinds the daemon writes itself (`EXTRA_KINDS`).
 * - **An entry that does not parse is still a row.** A transcript is the
 *   record of a run; silently dropping a line the UI did not recognise would
 *   make the record lie. It renders as an unreadable entry, and its content is
 *   not guessed at.
 * - **An entry with no attribution is still a row.** `by` is a sibling key the
 *   daemon only started writing recently, so every line of every earlier run
 *   lacks it. Those render exactly as they always did, with `role` null — an
 *   old transcript reads as a transcript, not as an error.
 *
 * Nothing here logs. Transcript text is repository content (§11) and this
 * module's only output is a value handed to a component that renders it.
 */
import { z } from 'zod'
import type { AgentEvent } from '../../src/harness/adapter.ts'
import type { TranscriptEntry } from '../../src/journal/transcript.ts'
import type { Tone } from './status.ts'

/** Mirrors `daemon/schemas.ts`'s exhaustiveness check, in the same shape. */
type Covers<Union extends string, Listed extends string> = [Exclude<Union, Listed>] extends [never]
  ? true
  : never

const AGENT_KINDS = [
  'session_started',
  'user_message',
  'assistant_text',
  'thinking',
  'tool_use',
  'tool_result',
  'permission_request',
  'permission_denied',
  'usage',
  'context_compacted',
  'error',
  'session_ended',
] as const satisfies readonly AgentEvent['type'][]

/**
 * Kinds the daemon writes that no harness emits (`journal/transcript.ts`).
 *
 * Split from the list above rather than merged into it, so the two-way check
 * survives: `AGENT_KINDS` still cannot name a harness event that does not
 * exist, and `ENTRY_KINDS_COVERED` below still fails to compile when one exists
 * with no member here. Folding them together would have made both halves mean
 * "some kind, somewhere", which is not a check.
 */
const EXTRA_KINDS = ['gate_run'] as const satisfies readonly Exclude<
  TranscriptEntry['type'],
  AgentEvent['type']
>[]

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
  z.object({
    type: z.literal('context_compacted'),
    trigger: z.enum(['auto', 'manual']),
    preTokens: z.number().optional(),
    postTokens: z.number().optional(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('session_ended'), result: z.enum(['ok', 'error', 'interrupted']) }),
  z.object({
    type: z.literal('gate_run'),
    gate: z.string(),
    exitCode: z.number(),
    status: z.string(),
    cached: z.boolean(),
  }),
])

type Entry = z.infer<typeof EntrySchema>

/**
 * `true` only while every kind a transcript can hold has a member above. A new
 * one makes this `never`, and the assignment stops compiling.
 */
export const ENTRY_KINDS_COVERED: Covers<TranscriptEntry['type'], Entry['type']> = true

/** Also exported so a test can name the kinds without restating them. */
export const TRANSCRIPT_KINDS: readonly TranscriptEntry['type'][] = [...AGENT_KINDS, ...EXTRA_KINDS]

/**
 * Who wrote the line, when the daemon recorded it.
 *
 * Parsed separately from the event because it is a *sibling* of the event's own
 * keys rather than part of any one kind's shape — see `journal/transcript.ts`
 * for why it is stored that way. Absent on every line written before this
 * existed, which is the case this has to survive rather than reject.
 */
const BySchema = z.object({ role: z.string(), slot: z.string().optional() })

function attribution(raw: unknown): { role: string; slot: string | null } | null {
  if (typeof raw !== 'object' || raw === null || !('by' in raw)) return null
  const parsed = BySchema.safeParse(raw.by)
  return parsed.success ? { role: parsed.data.role, slot: parsed.data.slot ?? null } : null
}

/** Who said it. The operator's own steering is never attributed to the agent. */
export type Author = 'agent' | 'operator' | 'tool' | 'system'

/**
 * How much room a row is worth.
 *
 * A transcript is three kinds of thing wearing one costume. `prose` is what
 * somebody wrote to be read — the agent's answer, the operator's steering, an
 * error. `thinking` is the agent talking to itself, which is worth having and
 * not worth the same type size. `tool` is machinery: a row whose body is four
 * hundred characters of JSON, of which the first forty say everything.
 *
 * Rendering all three identically is what made the useful lines the hardest to
 * find, so the shape travels with the view and the component spends its space
 * accordingly.
 */
export type Shape = 'prose' | 'thinking' | 'tool'

/** One chat row, ready to render. Presentation only — no element is built here. */
export interface EntryView {
  /** The event's own `type`, or `unreadable`. Becomes `data-kind`. */
  readonly kind: string
  readonly author: Author
  /** The attribution shown beside the row. */
  readonly label: string
  /**
   * The single line a collapsed row shows. Equal to `body` when the body is
   * already one short line, which is what lets a row with nothing hidden say
   * so by offering no control.
   */
  readonly headline: string
  readonly body: string
  readonly tone: Tone | null
  readonly shape: Shape
  /**
   * Which agent produced this — `implementer`, `reviewer`, `fixer`, `gate`,
   * `monitor`. Null on a line written before the daemon recorded it, which is
   * every line of every run before this shipped.
   */
  readonly role: string | null
  /** The session slot (§15), where the turn ran on one. */
  readonly slot: string | null
}

const AUTHOR_LABELS: Readonly<Record<Author, string>> = {
  agent: 'Agent',
  operator: 'Operator (you)',
  tool: 'Tool',
  system: 'Session',
}

export function present(raw: unknown): EntryView {
  const view = build(raw)
  const by = attribution(raw)
  if (by === null) return view
  return { ...view, role: by.role, slot: by.slot, label: ATTRIBUTED[view.kind] ?? view.label }
}

/**
 * What a row calls itself once something above it has already named the author.
 *
 * Only the labels that were *only* ever the author: an unattributed
 * `assistant_text` has to say "Agent" because nothing else would, and an
 * attributed one under a band reading REVIEWER spends its first line on the
 * word "Agent". `Tool · Bash` and `Session started` are not in here because
 * they describe the event rather than who produced it, and stay useful under
 * any band.
 *
 * Keyed on the event kind rather than matched against the label text, so this
 * cannot start silently doing nothing when a label is reworded.
 */
const ATTRIBUTED: Readonly<Record<string, string>> = {
  assistant_text: '',
  thinking: 'thinking',
}

function build(raw: unknown): EntryView {
  const parsed = EntrySchema.safeParse(raw)
  if (!parsed.success) {
    return {
      kind: 'unreadable',
      author: 'system',
      label: 'Unreadable entry',
      headline: 'This entry did not match any known agent event.',
      body: 'This entry did not match any known agent event.',
      tone: null,
      shape: 'prose',
      role: null,
      slot: null,
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
      return row(entry.type, 'agent', entry.text, null, 'Agent · thinking', { shape: 'thinking' })
    case 'tool_use':
      return row(entry.type, 'tool', payload(entry.input), null, `Tool · ${entry.name}`, {
        shape: 'tool',
        // Not the first line of the payload, which for every structured tool
        // call is `{`. The argument that says what the call *does* — a command,
        // a path — is the one the collapsed row is for.
        headline: argument(entry.input),
      })
    case 'tool_result':
      return row(
        entry.type,
        'tool',
        entry.summary,
        entry.ok ? 'ok' : 'error',
        `Tool result · ${entry.ok ? 'ok' : 'failed'}`,
        { shape: 'tool' },
      )
    case 'permission_request':
      // Compact, not the indented form the tool rows use. This one is prose —
      // it is the thing the operator has to read and answer — so it is never
      // folded, and an indented payload spends four lines of an unfoldable row
      // on punctuation.
      return row(entry.type, 'tool', compact(entry.detail), 'attention', `Permission · ${entry.tool}`)
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
    // `wait`, not `error` and not null. Nothing failed — this is the harness
    // doing the thing that keeps a long phase alive — so `error` would be a
    // lie. But it is also the line that explains why the agent below it stops
    // referring to work it plainly did, and a row with no tone at all reads as
    // bookkeeping worth skipping. `wait` is the one that says "notice this,
    // nothing is broken".
    case 'context_compacted':
      return row(entry.type, 'system', compaction(entry), 'wait', 'Context compacted')
    case 'error':
      return row(entry.type, 'system', entry.message, 'error', 'Error')
    case 'session_ended':
      return row(entry.type, 'system', entry.result, entry.result === 'ok' ? 'ok' : 'error', 'Session ended')
    // Prose, and never folded: a gate's verdict is the thing the rest of the
    // phase turns on, and the row is three identifiers long anyway.
    case 'gate_run':
      return row(
        entry.type,
        'system',
        `${entry.status}, exit ${entry.exitCode}${entry.cached ? ' — cached, not re-run' : ''}`,
        entry.exitCode === 0 ? 'ok' : 'error',
        `Gate \u00b7 ${entry.gate}`,
      )
  }
}

function row(
  kind: string,
  author: Author,
  body: string,
  tone: Tone | null,
  label?: string,
  options: { readonly shape?: Shape; readonly headline?: string } = {},
): EntryView {
  const text = body.trim()
  return {
    kind,
    author,
    label: label ?? AUTHOR_LABELS[author],
    headline: options.headline ?? firstLine(text),
    body: text,
    tone,
    shape: options.shape ?? 'prose',
    role: null,
    slot: null,
  }
}

/**
 * Folds a window of raw entries into the rows the view renders.
 *
 * The one thing it does beyond `present` is **group consecutive thinking**. A
 * streamed thought does not arrive as one event; it arrives as a dozen, and a
 * dozen separately collapsible rows is not a thought the operator can open —
 * it is twelve chevrons over one paragraph. Grouping is by adjacency only, so
 * a tool call between two thoughts still separates them, which is the sequence
 * that actually happened.
 *
 * `offset` is the absolute index of `entries[0]` within the served tail, so a
 * row's key survives new entries arriving at the end.
 */
/**
 * The kinds that arrive in pieces and mean one thing.
 *
 * A streamed thought does not arrive as one event; it arrives as a dozen, and a
 * dozen separately collapsible rows is not a thought the operator can open — it
 * is twelve chevrons over one paragraph. An answer is the same story with a
 * different consequence: the monitor journals as it speaks, so one reply is
 * several `assistant_text` entries, and without this they render as several
 * paragraphs with a divider ruled between each of them.
 *
 * Nothing else is in here. Two tool calls in a row are two tool calls.
 */
const GROUPED: ReadonlySet<string> = new Set(['thinking', 'assistant_text'])

export function fold(entries: readonly unknown[], offset: number): readonly Row[] {
  const rows: Row[] = []
  for (const [index, raw] of entries.entries()) {
    const view = present(raw)
    const last = rows.at(-1)
    // Same kind *and* same author. Two agents thinking in sequence is two
    // thoughts, and merging them would attribute half of one to the other.
    if (GROUPED.has(view.kind) && last?.views.at(-1)?.kind === view.kind && last.role === view.role) {
      last.views.push(view)
      continue
    }
    rows.push({ at: offset + index, shape: view.shape, role: view.role, views: [view] })
  }
  return rows
}

/** One rendered row: a single entry, or a run of consecutive thinking. */
export interface Row {
  /** Absolute index of the first entry in the row. The React key. */
  readonly at: number
  readonly shape: Shape
  /** Whose row it is, so the list can say when the author changes. */
  readonly role: string | null
  readonly views: EntryView[]
}

/** The body of a row, which for grouped thinking is every member's. */
export function bodyOf(row: Row): string {
  return row.views.map((view) => view.body).join('\n\n')
}

/** What a collapsed row shows: the first member's line, whatever the row holds. */
export function headlineOf(row: Row): string {
  return row.views[0]?.headline ?? ''
}

/** Whether opening the row would reveal anything the headline did not say. */
export function hasMore(row: Row): boolean {
  return bodyOf(row) !== headlineOf(row)
}

/** A headline is one line and fits on one line. */
const HEADLINE_LIMIT = 140

function firstLine(text: string): string {
  const trimmed = text.trim()
  const end = trimmed.indexOf('\n')
  const first = end === -1 ? trimmed : trimmed.slice(0, end)
  return first.length <= HEADLINE_LIMIT ? first : `${first.slice(0, HEADLINE_LIMIT)}…`
}

/**
 * The argument of a tool call worth putting on the collapsed row, in the order
 * worth trying.
 *
 * Deliberately a fixed list of *argument names* rather than a table of tools:
 * the harnesses do not agree on a tool vocabulary and this file must not grow
 * one. A tool nobody here has heard of that takes a `command` still gets a
 * readable line, and one that takes none falls back to its payload.
 */
const HEADLINE_KEYS = [
  'command',
  'file_path',
  'path',
  'notebook_path',
  'pattern',
  'url',
  'query',
  'description',
  'prompt',
] as const

function argument(input: unknown): string {
  if (typeof input === 'string') return firstLine(input)
  if (typeof input === 'object' && input !== null) {
    const fields = input as Record<string, unknown>
    for (const key of HEADLINE_KEYS) {
      const value = fields[key]
      if (typeof value === 'string' && value.trim() !== '') return firstLine(value)
    }
  }
  return firstLine(payload(input))
}

function usage(entry: Extract<Entry, { type: 'usage' }>): string {
  const cost = entry.costUsd === undefined ? '' : ` · $${entry.costUsd.toFixed(2)}`
  return `${entry.input} in · ${entry.output} out${cost}`
}

/**
 * What the session traded away, when the harness said.
 *
 * The counts are optional and a missing one is not a zero — the same rule
 * `usage` follows for cost. opencode reports no figures at all, so its row says
 * only that compaction happened; rendering "0 → 0 tokens" there would describe
 * a session that lost nothing, which is the opposite of what occurred.
 */
function compaction(entry: Extract<Entry, { type: 'context_compacted' }>): string {
  const how = entry.trigger === 'manual' ? 'compacted on request' : 'context window filled'
  const counts =
    entry.preTokens === undefined || entry.postTokens === undefined
      ? ''
      : ` · ${entry.preTokens} → ${entry.postTokens} tokens`
  return `${how}${counts}`
}

/**
 * Tool payloads can be whole files. An open row shows a generous look and the
 * journal has the rest.
 *
 * Larger than the 400 characters this used to allow, and indented, because the
 * payload is no longer what the row *is* — it is what opening the row reveals.
 * A collapsed row costs one line whatever this holds, so the limit stopped
 * being a defence of the page's length and became only a defence of its
 * memory.
 */
const PAYLOAD_LIMIT = 4_000

function payload(value: unknown): string {
  return serialise(value, 2)
}

/** The same, on one line, for a row that does not fold. */
function compact(value: unknown): string {
  return serialise(value, 0)
}

function serialise(value: unknown, indent: number): string {
  if (typeof value === 'string') return clamp(value)
  let text: string
  try {
    text = JSON.stringify(value, null, indent) ?? String(value)
  } catch {
    return '[unserialisable]'
  }
  return clamp(text)
}

function clamp(text: string): string {
  return text.length <= PAYLOAD_LIMIT ? text : `${text.slice(0, PAYLOAD_LIMIT)}…`
}
