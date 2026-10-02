/**
 * The transcript, read the way §5.3 stores it: one normalized `AgentEvent` per
 * line, served as the tail of that file by `/api/runs/:runId/nodes/:nodeId`.
 *
 * The API types those entries as `unknown` — deliberately, since the journal
 * copies whatever the adapter emitted — so the narrowing has to happen
 * somewhere, and this is the only place that knows what a chat row looks like.
 *
 * Four rules:
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
 * - **An entry the model wrote for a parser is rendered for a reader.** One
 *   kind of `assistant_text` is not prose at all: the monitor's intervention
 *   proposal is a JSON document, journalled into the conversation a person
 *   reads (`proposal` below). It is shown as what it says. The *journal* keeps
 *   the bytes — nothing here rewrites the record, only the row.
 *
 * Nothing here logs. Transcript text is repository content (§11) and this
 * module's only output is a value handed to a component that renders it.
 */
import { z } from 'zod'
import type { AgentEvent } from '../../src/harness/adapter.ts'
import type { InterventionVerbId } from '../../src/intervention/intervention.ts'
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
const BySchema = z.object({
  role: z.string(),
  slot: z.string().optional(),
  chore: z.string().optional(),
})

function attribution(
  raw: unknown,
): { role: string; slot: string | null; chore: string | null } | null {
  if (typeof raw !== 'object' || raw === null || !('by' in raw)) return null
  const parsed = BySchema.safeParse(raw.by)
  return parsed.success
    ? {
        role: parsed.data.role,
        slot: parsed.data.slot ?? null,
        chore: parsed.data.chore ?? null,
      }
    : null
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
  /**
   * The call, read for a reader, on a `tool_use` row and nowhere else — see
   * `ToolView`. Null on every other kind.
   */
  readonly tool: ToolView | null
  /**
   * The call id a `tool_use` or `tool_result` carries, so `fold` can seat a
   * result under the call it answers. Null on every other kind.
   */
  readonly toolId: string | null
  /**
   * Which chore this turn was running, on a `chore` role and nowhere else.
   *
   * The role alone is not enough to band by here: a phase runs its chores one
   * after another on the same slot, so without the id three of them read as one
   * long turn by somebody called Chore.
   */
  readonly chore: string | null
}

/**
 * What a tool call *is*, across the harnesses' vocabularies.
 *
 * claude-code says `Read`, `Edit`, `Bash`; opencode says `read`, `edit`,
 * `bash`; codex says `command_execution` and `file_change`, and an MCP tool
 * says whatever its server named it. Rendering the vendor's name was honest
 * and unreadable — a row reading `Tool · str_replace_based_edit_tool` tells
 * the operator less than the one word "Edit" does. So the name is sorted into
 * a kind, the kind picks a verb and an icon, and the *arguments* are read by
 * the names every harness uses for them (`file_path` / `filePath` / `path`),
 * so the row can say what was read, edited or run.
 *
 * `other` is the honest fallback: the vendor's name on the label and the
 * argument that says most on the row, exactly as before.
 */
export type ToolKind =
  | 'read'
  | 'edit'
  | 'write'
  | 'shell'
  | 'search'
  | 'glob'
  | 'list'
  | 'fetch'
  | 'web'
  | 'agent'
  | 'todo'
  | 'other'

export interface ToolView {
  readonly id: string
  /** The harness's own name for the tool. */
  readonly name: string
  readonly kind: ToolKind
  /** What the row leads with: `Read`, `Edit`, `Shell` … or `Tool · <name>`. */
  readonly verb: string
  /** The one argument worth the collapsed row: a path, a command, a pattern, a URL. */
  readonly target: string | null
  /** The file the call is about, where there is one — what the open row highlights as. */
  readonly path: string | null
  readonly command: string | null
  /** An edit's two sides, for the open row's diff. */
  readonly edit: { readonly before: string; readonly after: string } | null
  /** A write's whole content. */
  readonly content: string | null
  /** The remaining scalar arguments, for the open row. */
  readonly args: readonly (readonly [string, string])[]
}

/** The kinds that read the tree rather than change it, which `fold` groups. */
export const EXPLORING: ReadonlySet<ToolKind> = new Set(['read', 'search', 'glob', 'list'])

const VERBS: Readonly<Record<Exclude<ToolKind, 'other'>, string>> = {
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  shell: 'Shell',
  search: 'Grep',
  glob: 'Glob',
  list: 'List',
  fetch: 'Fetch',
  web: 'Web search',
  agent: 'Agent',
  todo: 'Todo',
}

/**
 * The vendors' tool names, lower-cased, by kind. An MCP prefix
 * (`mcp__server__tool`) is stripped before the lookup, so a server that names
 * its tool `read_file` reads as a read.
 */
const TOOL_NAMES: Readonly<Record<string, ToolKind>> = {
  read: 'read',
  read_file: 'read',
  view: 'read',
  cat: 'read',
  notebookread: 'read',
  edit: 'edit',
  multiedit: 'edit',
  notebookedit: 'edit',
  str_replace_editor: 'edit',
  str_replace_based_edit_tool: 'edit',
  apply_patch: 'edit',
  file_change: 'edit',
  patch: 'edit',
  write: 'write',
  write_file: 'write',
  create_file: 'write',
  bash: 'shell',
  shell: 'shell',
  command_execution: 'shell',
  execute_command: 'shell',
  run_command: 'shell',
  terminal: 'shell',
  grep: 'search',
  search: 'search',
  rg: 'search',
  ripgrep: 'search',
  search_files: 'search',
  glob: 'glob',
  find: 'glob',
  find_files: 'glob',
  list: 'list',
  ls: 'list',
  list_dir: 'list',
  list_directory: 'list',
  webfetch: 'fetch',
  web_fetch: 'fetch',
  fetch: 'fetch',
  websearch: 'web',
  web_search: 'web',
  task: 'agent',
  agent: 'agent',
  subagent: 'agent',
  dispatch_agent: 'agent',
  todowrite: 'todo',
  todoread: 'todo',
  todo: 'todo',
  update_todo: 'todo',
}

/** The argument names each harness uses, in the order worth trying. */
const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'target_file', 'filename'] as const
const COMMAND_KEYS = ['command', 'cmd'] as const
const PATTERN_KEYS = ['pattern', 'query', 'regex'] as const
const BEFORE_KEYS = ['old_string', 'oldString', 'old_str', 'old_text'] as const
const AFTER_KEYS = ['new_string', 'newString', 'new_str', 'new_text'] as const
const CONTENT_KEYS = ['content', 'contents', 'file_text', 'text'] as const

/** An argument shown as `key=value` is clipped to this; the payload has the rest. */
const ARG_LIMIT = 120

function toolView(id: string, name: string, input: unknown): ToolView {
  const kind = kindOf(name)
  const fields: Record<string, unknown> =
    typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  const path = pick(fields, PATH_KEYS)
  const command = pick(fields, COMMAND_KEYS)
  const before = pick(fields, BEFORE_KEYS)
  const after = pick(fields, AFTER_KEYS)
  const content = pick(fields, CONTENT_KEYS)
  const pattern = pick(fields, PATTERN_KEYS)
  const taken = new Set<string>()
  const take = (keys: readonly string[]): void => {
    for (const key of keys) if (typeof fields[key] === 'string') taken.add(key)
  }

  let target: string | null
  switch (kind) {
    case 'read':
    case 'edit':
    case 'write':
      take(PATH_KEYS)
      // codex's `file_change` names its files in a list rather than a field.
      target = path ?? codexPaths(fields)
      break
    case 'shell':
      take(COMMAND_KEYS)
      target = command === null ? null : firstLine(command)
      break
    case 'search':
      take(PATTERN_KEYS)
      take(PATH_KEYS)
      target = pattern === null ? null : path === null ? pattern : `${pattern} in ${path}`
      break
    case 'glob':
      take(PATTERN_KEYS)
      take(PATH_KEYS)
      target = pattern ?? path
      break
    case 'list':
      take(PATH_KEYS)
      target = path
      break
    case 'fetch':
      take(['url'])
      target = pick(fields, ['url'])
      break
    case 'web':
      take(PATTERN_KEYS)
      target = pattern
      break
    case 'agent': {
      take(['description', 'prompt'])
      const description = pick(fields, ['description'])
      const prompt = pick(fields, ['prompt'])
      target = description ?? (prompt === null ? null : firstLine(prompt))
      break
    }
    case 'todo': {
      const todos = fields['todos']
      target = Array.isArray(todos) ? `${todos.length} ${todos.length === 1 ? 'item' : 'items'}` : null
      break
    }
    case 'other':
      target = null
  }
  // An edit's two sides and a write's body are the open row's, never a `key=value`.
  take(BEFORE_KEYS)
  take(AFTER_KEYS)
  if (kind === 'write') take(CONTENT_KEYS)

  const args: (readonly [string, string])[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (taken.has(key)) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const text = String(value)
      args.push([key, text.length > ARG_LIMIT ? `${text.slice(0, ARG_LIMIT)}…` : firstLine(text)])
    }
  }

  return {
    id,
    name,
    kind,
    verb: kind === 'other' ? `Tool · ${name}` : VERBS[kind],
    target,
    path: kind === 'search' ? null : path,
    command,
    edit: before !== null && after !== null ? { before, after } : null,
    content: kind === 'write' ? content : null,
    args,
  }
}

function kindOf(name: string): ToolKind {
  const bare = name.toLowerCase().replace(/^mcp__.*?__/, '')
  return TOOL_NAMES[bare] ?? TOOL_NAMES[bare.split('.').at(-1) ?? ''] ?? 'other'
}

function pick(fields: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = fields[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

/** codex's `file_change`: `changes: [{ path, kind }]`. The first path, and how many more. */
function codexPaths(fields: Record<string, unknown>): string | null {
  const changes = fields['changes']
  if (!Array.isArray(changes) || changes.length === 0) return null
  const paths = changes
    .map((change: unknown) =>
      typeof change === 'object' && change !== null ? (change as Record<string, unknown>)['path'] : undefined,
    )
    .filter((path): path is string => typeof path === 'string')
  if (paths.length === 0) return null
  return paths.length === 1 ? (paths[0] ?? null) : `${paths[0]} and ${paths.length - 1} more`
}

/** How many lines an edit adds and removes, for the `+N −M` beside it. */
export function editCounts(edit: { readonly before: string; readonly after: string }): {
  readonly additions: number
  readonly deletions: number
} {
  return { additions: lineCount(edit.after), deletions: lineCount(edit.before) }
}

function lineCount(text: string): number {
  if (text === '') return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
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
  return {
    ...view,
    role: by.role,
    slot: by.slot,
    chore: by.chore,
    label: ATTRIBUTED[view.kind] ?? view.label,
  }
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
      tool: null,
      toolId: null,
      chore: null,
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
      // A proposal first, because the monitor writes those into the same
      // conversation and they are not prose. Then the raw text, indented if it
      // turns out to be a JSON document of some other shape.
      return proposal(entry.text) ?? row(entry.type, 'agent', reflow(entry.text), null)
    case 'thinking':
      return row(entry.type, 'agent', entry.text, null, 'Agent · thinking', { shape: 'thinking' })
    case 'tool_use': {
      const tool = toolView(entry.id, entry.name, entry.input)
      return row(entry.type, 'tool', payload(entry.input), null, tool.verb, {
        shape: 'tool',
        // Not the first line of the payload, which for every structured tool
        // call is `{`. The argument that says what the call *does* — a command,
        // a path — is the one the collapsed row is for.
        headline: tool.target ?? argument(entry.input),
        tool,
        toolId: entry.id,
      })
    }
    case 'tool_result':
      return row(
        entry.type,
        'tool',
        entry.summary,
        entry.ok ? 'ok' : 'error',
        `Tool result · ${entry.ok ? 'ok' : 'failed'}`,
        { shape: 'tool', toolId: entry.id },
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
  options: {
    readonly shape?: Shape
    readonly headline?: string
    readonly tool?: ToolView
    readonly toolId?: string
  } = {},
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
    tool: options.tool ?? null,
    toolId: options.toolId ?? null,
    chore: null,
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

/**
 * How far back a result looks for its call. A call's result follows it within
 * a handful of entries in every harness; the bound is against a result whose
 * call fell outside the served tail, which must not scan the whole window.
 */
const PAIR_WINDOW = 50

export function fold(entries: readonly unknown[], offset: number): readonly Row[] {
  const rows: Row[] = []
  for (const [index, raw] of entries.entries()) {
    const view = present(raw)
    const last = rows.at(-1)

    // A result sits under the call it answers, matched by id — the row then
    // says what the call was *and* how it went, and the list is half as long.
    // A result whose call is not here (it fell outside the served tail) is
    // still a row of its own: the record must not drop what happened.
    if (view.kind === 'tool_result' && view.toolId !== null && seat(rows, view)) continue

    // Same kind *and* same author. Two agents thinking in sequence is two
    // thoughts, and merging them would attribute half of one to the other.
    if (
      GROUPED.has(view.kind) &&
      last?.views.at(-1)?.kind === view.kind &&
      last.role === view.role &&
      last.chore === view.chore
    ) {
      last.views.push(view)
      last.results.push(null)
      continue
    }

    // Consecutive reads, searches and listings are one stretch of looking
    // around, and read better as "Explored · 4 reads, 2 searches" than as six
    // rows. Only the exploring kinds group, only with each other, and only
    // under one author: an edit between two reads is its own row.
    if (
      view.tool !== null &&
      EXPLORING.has(view.tool.kind) &&
      last !== undefined &&
      isExploring(last) &&
      last.role === view.role &&
      last.chore === view.chore
    ) {
      last.views.push(view)
      last.results.push(null)
      continue
    }

    rows.push({
      at: offset + index,
      shape: view.shape,
      role: view.role,
      chore: view.chore,
      views: [view],
      results: [null],
    })
  }
  return rows
}

/** Puts a result under its call, if the call is in the last `PAIR_WINDOW` rows. */
function seat(rows: Row[], result: EntryView): boolean {
  for (let back = rows.length - 1; back >= Math.max(0, rows.length - PAIR_WINDOW); back -= 1) {
    const row = rows[back]
    if (row === undefined || row.shape !== 'tool') continue
    const index = row.views.findIndex(
      (view, position) => view.tool?.id === result.toolId && row.results[position] === null,
    )
    if (index !== -1) {
      row.results[index] = result
      return true
    }
  }
  return false
}

/** Whether every call in the row is one of the exploring kinds. */
function isExploring(row: Row): boolean {
  return (
    row.shape === 'tool' &&
    row.views.every((view) => view.tool !== null && EXPLORING.has(view.tool.kind))
  )
}

/** One rendered row: a single entry, a run of consecutive thinking, or a stretch of exploring. */
export interface Row {
  /** Absolute index of the first entry in the row. The React key. */
  readonly at: number
  readonly shape: Shape
  /** Whose row it is, so the list can say when the author changes. */
  readonly role: string | null
  /** Which chore, where the author is one — two chores are two turns. */
  readonly chore: string | null
  readonly views: EntryView[]
  /**
   * Aligned with `views`: the result each call received, or null where none
   * has (yet). Always null outside a tool row.
   */
  readonly results: (EntryView | null)[]
}

/** A row holding more than one call: a stretch of exploring, grouped by `fold`. */
export function isExploration(row: Row): boolean {
  return row.shape === 'tool' && row.views.length > 1
}

/** Whether every call in the row has its result — "Explored" rather than "Exploring". */
export function settled(row: Row): boolean {
  return row.results.every((result) => result !== null)
}

/** `3 reads, 2 searches, 1 listing` — what a stretch of exploring amounted to. */
export function explorationSummary(row: Row): string {
  const counts = { read: 0, search: 0, list: 0 }
  for (const view of row.views) {
    const kind = view.tool?.kind
    if (kind === 'read') counts.read += 1
    else if (kind === 'search' || kind === 'glob') counts.search += 1
    else if (kind === 'list') counts.list += 1
  }
  const parts: string[] = []
  if (counts.read > 0) parts.push(`${counts.read} ${counts.read === 1 ? 'read' : 'reads'}`)
  if (counts.search > 0) parts.push(`${counts.search} ${counts.search === 1 ? 'search' : 'searches'}`)
  if (counts.list > 0) parts.push(`${counts.list} ${counts.list === 1 ? 'listing' : 'listings'}`)
  return parts.join(', ')
}

/** The body of a row, which for grouped thinking is every member's. */
export function bodyOf(row: Row): string {
  return row.views.map((view) => view.body).join('\n\n')
}

/** What a collapsed row shows: the first member's line, or what a stretch of exploring amounted to. */
export function headlineOf(row: Row): string {
  return isExploration(row) ? explorationSummary(row) : (row.views[0]?.headline ?? '')
}

/**
 * Whether opening the row would reveal anything the headline did not say. A
 * call always has its payload behind it, and a call with a result has that.
 */
export function hasMore(row: Row): boolean {
  if (isExploration(row) || row.results.some((result) => result !== null)) return true
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

/**
 * The monitor's intervention proposal — JSON on purpose, unreadable by accident.
 *
 * A watchdog turn must answer with one object matching
 * `schemas/intervention.v1.schema.json`, and that is the point of the feature:
 * the monitor's authority over a live run is a closed set of verbs rather than
 * an editor over `workflow.json` (`intervention/intervention.ts`). The same
 * turn is journalled into the *operator's* conversation, because a run that
 * retuned itself should say so where a person is already looking.
 *
 * Those two facts together are what filled the monitor thread with braces: a
 * document written for a parser, rendered to a reader — and the summary
 * paragraph, which is the part a person actually wanted, buried a thousand
 * characters into one unwrapped line. So it is read back and shown as what it
 * says. The journal keeps the bytes the model wrote; only the row changes.
 *
 * **Shaped loosely, deliberately.** This is a view of a document the host has
 * already validated or refused elsewhere, and a proposal that rendered as raw
 * JSON again because a field this view never reads failed a check would hide
 * the one entry the operator most needs. What *is* checked is the verb
 * vocabulary: `VERB_LINES` is keyed on the daemon's own union, so a fifth verb
 * fails to compile here rather than shipping as its own identifier.
 */
const ProposalSchema = z.object({
  schema_version: z.number(),
  summary: z.string(),
  changes: z.array(z.record(z.string(), z.unknown())).default([]),
})

/**
 * One change, in a sentence, per verb.
 *
 * `Record<InterventionVerbId, …>`, so this cannot go quietly out of date: a
 * verb added to `InterventionVerbSchema` and not to this table is a type error
 * in the UI build, which is the only place that would otherwise never notice.
 */
const VERB_LINES: Readonly<
  Record<InterventionVerbId, (change: Record<string, unknown>) => string>
> = {
  retune_gate: (change) => `Gate ${field(change, 'gate')} — run: ${field(change, 'cmd')}`,
  retime_gate: (change) => `Gate ${field(change, 'gate')} — time out after ${field(change, 'timeout_s')}s`,
  rebudget_fixes: (change) =>
    `Phase ${field(change, 'node')} — ${field(change, 'max_fix_rounds')} fix rounds`,
  retier_phase: (change) => `Phase ${field(change, 'node')} — run on ${field(change, 'model')}`,
}

function proposal(text: string): EntryView | null {
  const parsed = ProposalSchema.safeParse(document(text))
  if (!parsed.success) return null
  const { summary, changes } = parsed.data

  const lines = [summary.trim(), '']
  if (changes.length === 0) {
    lines.push('Proposed no changes.')
  } else {
    lines.push(`Proposed ${changes.length} change${changes.length === 1 ? '' : 's'}:`)
    for (const [index, change] of changes.entries()) lines.push(...describe(change, index))
  }

  // `attention` only when something was actually proposed. A turn that looked
  // and changed nothing is the expected outcome (`intervention.ts` says so
  // twice), and a dot on every one of them would spend the tone on the case
  // that needs no attention at all.
  return row(
    'intervention',
    'agent',
    lines.join('\n'),
    changes.length === 0 ? null : 'attention',
    'Proposal',
  )
}

function describe(change: Record<string, unknown>, index: number): readonly string[] {
  const verb = change['verb']
  const known = typeof verb === 'string' && verb in VERB_LINES
  const line = known
    ? (VERB_LINES[verb as InterventionVerbId] as (c: Record<string, unknown>) => string)(change)
    : // A verb this build has not heard of still gets a row, for the reason an
      // unparsed entry does: the record must not quietly drop what happened.
      `${typeof verb === 'string' ? verb : 'unknown verb'} — ${compact(rest(change))}`
  const evidence = change['evidence']
  const head = `${index + 1}. ${line}`
  return typeof evidence === 'string' && evidence.trim() !== ''
    ? [head, `   Evidence: ${evidence.trim()}`]
    : [head]
}

/** Everything a verb's own line did not already say. */
function rest(change: Record<string, unknown>): Record<string, unknown> {
  const { verb: _verb, evidence: _evidence, ...remaining } = change
  return remaining
}

/** One field of a change, as a reader sees it. Never `[object Object]`. */
function field(change: Record<string, unknown>, key: string): string {
  const value = change[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return value === undefined ? '?' : compact(value)
}

/**
 * An answer that is wholly a JSON document, indented.
 *
 * The fallback under `proposal`, for a shape this build does not recognise —
 * an older intervention, a model that answered in JSON when nobody asked it to.
 * Indenting it is not much, but it is the difference between a paragraph of
 * braces and something a person can skim, and it costs nothing when the answer
 * is the prose it is supposed to be.
 */
function reflow(text: string): string {
  const value = document(text)
  return value === undefined ? text : serialise(value, 2)
}

/** ```json … ``` — the fence the brief forbids and a model writes anyway. */
const FENCE = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/

/**
 * The text as a JSON object or array, or `undefined` when it is not one.
 *
 * Whole-text only. A sentence that happens to contain braces is prose and must
 * stay prose, which is why this tests the trimmed text's first character rather
 * than hunting for a document inside it.
 */
function document(text: string): unknown {
  const trimmed = text.trim()
  const body = (FENCE.exec(trimmed)?.[1] ?? trimmed).trim()
  if (!body.startsWith('{') && !body.startsWith('[')) return undefined
  try {
    const parsed: unknown = JSON.parse(body)
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}
