/**
 * The rows themselves, shared by the two views that hold a conversation.
 *
 * `Transcript.tsx` owns a phase's: a window over a tail, a following rule, a
 * panel that opens full page. `Monitor.tsx` owns the run's, which needs none of
 * that and needs all of *this* — the same folding, the same author bands, the
 * same idea of what a row is worth. The daemon has always said these are the
 * same shape ("Entries are the same shape as a phase's, which is what lets the
 * UI render both with one component") and until this module existed that was
 * only true of the parsing: the monitor panel drew its own rows, so an agent's
 * thinking arrived there as a wall of undifferentiated prose.
 *
 * What a row looks like is decided by what it is (`transcript.ts`):
 *
 * - **Prose is markdown.** An agent's answer is headings, lists and fenced
 *   code, and it used to render as the asterisks. The operator's own message
 *   is set apart in a tinted block, the way every chat the operator has used
 *   sets their side apart.
 * - **A tool call is a verb and a target**, on one line — `Read` and a path,
 *   `Shell` and a command, `Edit` and a path with `+4 −1` beside it — with its
 *   result's verdict as a dot at the end, because `fold` seats the result
 *   under the call. Open, an edit is a diff, a write is the file, a shell
 *   call is the command and what it printed.
 * - **A stretch of exploring is one row**, "Explored · 3 reads, 2 searches",
 *   that opens into the calls. Reading is how an agent spends most of its
 *   turn and the least of what the operator came to see.
 * - **Thinking is quiet**: smaller, dimmer, folded.
 *
 * What is here is everything below the scroller. What is not is any opinion
 * about scrolling, windowing or panels, which is exactly the split that let the
 * monitor reuse it.
 */
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FilePlus2Icon,
  FileTextIcon,
  FolderIcon,
  FolderSearchIcon,
  GlobeIcon,
  ListTodoIcon,
  PencilLineIcon,
  SearchIcon,
  SquareTerminalIcon,
  TelescopeIcon,
  WrenchIcon,
  type LucideIcon,
} from 'lucide-react'
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { cn } from 'vinta-design-system/lib/utils'
import { Button } from 'vinta-design-system/ui/button'
import { ToneDot } from './Chip.tsx'
import { CodeBlock, Counts, FileDiffBody, PathName } from './Code.tsx'
import type { FileDiff } from './diff.ts'
import { languageFor, SHELL } from './highlight.ts'
import { Prose } from './Markdown.tsx'
import {
  bodyOf,
  editCounts,
  explorationSummary,
  hasMore,
  headlineOf,
  isExploration,
  settled,
  type EntryView,
  type Row,
  type ToolKind,
  type ToolView,
} from './transcript.ts'

/** The author's colour: the operator stands out, machinery recedes. */
const AUTHOR: Readonly<Record<string, string>> = {
  operator: 'text-tone-attention-foreground',
  tool: 'text-foreground',
  system: 'text-muted-foreground',
}

/** Which kinds are open. Prose is not in here because prose never folds. */
export type Folded = Record<'thinking' | 'tool', boolean>

export const CLOSED: Folded = { thinking: false, tool: false }

/**
 * The list, and the per-row memory of what the reader opened by hand.
 *
 * Those overrides are cleared whenever `open` moves, which is what makes the
 * header controls honest: that button means "show me all of this now", and
 * honouring a row somebody closed three minutes ago underneath it would make
 * the button lie about what it did.
 */
export function Entries({
  rows,
  open,
  className,
  listRef,
  onScroll,
  ...props
}: {
  readonly rows: readonly Row[]
  readonly open: Folded
  readonly className?: string
  readonly listRef?: (element: HTMLOListElement | null) => void
  readonly onScroll?: (event: React.UIEvent<HTMLOListElement>) => void
} & Omit<React.ComponentProps<'ol'>, 'onScroll' | 'className' | 'ref'>) {
  const [overrides, setOverrides] = useState<Readonly<Record<number, boolean>>>({})
  useEffect(() => setOverrides({}), [open])

  return (
    <ol ref={listRef} className={cn('entries divide-y', className)} onScroll={onScroll} {...props}>
      {rows.map((row, index) => {
        const shape = row.shape
        // The band, not a per-row badge. A phase is an implementer, a reviewer
        // and three fix rounds in one file, and what a reader needs is the
        // *boundary* — where one agent stopped and the next started — which a
        // label repeated on ninety consecutive rows states ninety times and
        // shows once.
        const previous = rows[index - 1]
        // A new band on a new author — or on a new chore by the same one, since a
        // phase runs its chores back to back on one slot.
        const turn =
          row.role !== null && (row.role !== previous?.role || row.chore !== previous?.chore)
        return (
          <Fragment key={row.at}>
            {turn && (
              <Author role={row.role as string} chore={row.chore} first={index === 0} />
            )}
            {shape === 'prose' ? (
              <Entry row={row} open />
            ) : (
              <Entry
                row={row}
                open={overrides[row.at] ?? open[shape]}
                onToggle={() =>
                  setOverrides((current) => ({
                    ...current,
                    [row.at]: !(current[row.at] ?? open[shape]),
                  }))
                }
              />
            )}
          </Fragment>
        )
      })}
    </ol>
  )
}

/** The two header controls, for a view that has a header to put them in. */
export function FoldControls({
  open,
  onToggle,
}: {
  readonly open: Folded
  readonly onToggle: (shape: 'thinking' | 'tool') => void
}) {
  return (
    <>
      <Fold shape="thinking" label="Thinking" noun="thinking block" on={open.thinking} onToggle={onToggle} />
      <Fold shape="tool" label="Tools" noun="tool call" on={open.tool} onToggle={onToggle} />
    </>
  )
}

/** A header control that opens or closes every row of one kind. */
function Fold({
  shape,
  label,
  noun,
  on,
  onToggle,
}: {
  readonly shape: 'thinking' | 'tool'
  /** What the button says. */
  readonly label: string
  /** What it acts on, singular, for the sentence a screen reader gets. */
  readonly noun: string
  readonly on: boolean
  readonly onToggle: (shape: 'thinking' | 'tool') => void
}) {
  const sentence = `${on ? 'Collapse' : 'Expand'} every ${noun}`
  return (
    <Button
      type="button"
      variant={on ? 'secondary' : 'ghost'}
      size="xs"
      data-action={`fold-${shape}`}
      aria-pressed={on}
      aria-label={sentence}
      title={sentence}
      onClick={() => onToggle(shape)}
    >
      {label}
    </Button>
  )
}

/**
 * One row.
 *
 * Prose is never folded — an agent's answer and an operator's steering are the
 * things the transcript exists to show, and a chevron in front of them would be
 * a control whose only use is to hide the point. Everything else folds, and a
 * row with nothing behind its headline offers no control either: a chevron that
 * reveals what is already on screen teaches the operator not to trust chevrons.
 */
function Entry({
  row,
  open,
  onToggle,
}: {
  readonly row: Row
  readonly open: boolean
  readonly onToggle?: () => void
}) {
  const view = row.views[0]
  if (view === undefined) return null
  const quiet = row.shape === 'thinking'
  const toggle = onToggle !== undefined && hasMore(row) ? onToggle : undefined

  if (row.shape === 'prose') return <ProseEntry row={row} view={view} />

  const exploring = isExploration(row)
  const tool = view.tool
  const Icon = exploring ? TelescopeIcon : tool === null ? null : ICONS[tool.kind]
  const result = row.results[0] ?? null
  // A tool row: the verb, then the target; otherwise the label as it was.
  const label = exploring ? (settled(row) ? 'Explored' : 'Exploring…') : view.label
  const attribution = (
    <>
      {Icon !== null && (
        <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span
        className={cn('entry-author shrink-0', quiet ? 'font-medium' : 'font-medium', AUTHOR[view.author])}
        data-author={view.author}
      >
        {label}
      </span>
      {/* The kind is `view.label`'s job and the status is the dot's; the event
          type stays in `data-kind`, where a test or a stylesheet can reach it
          and a reader is not asked to. */}
      {view.tone !== null && <ToneDot tone={view.tone} />}
    </>
  )

  const headline = exploring ? (
    <span className="entry-headline min-w-0 flex-1 truncate text-muted-foreground" data-headline>
      {explorationSummary(row)}
    </span>
  ) : tool !== null ? (
    <Target tool={tool} className="entry-headline min-w-0 flex-1" />
  ) : (
    <span className="entry-headline min-w-0 flex-1 truncate text-muted-foreground" data-headline>
      {headlineOf(row)}
    </span>
  )

  // What the call amounted to, on the right: an edit's size, and the verdict.
  const trailing = (
    <>
      {tool?.edit !== null && tool?.edit !== undefined && (
        <Counts {...editCounts(tool.edit)} className="shrink-0" />
      )}
      {!exploring && result !== null && <Verdict result={result} />}
      {exploring && !settled(row) && <ToneDot tone="active" />}
    </>
  )

  const head = cn(
    'entry-head flex min-w-0 items-center gap-2',
    quiet ? 'text-[11px]' : 'text-[13px]',
  )

  return (
    <li
      data-entry={row.at}
      data-kind={view.kind}
      data-shape={row.shape}
      data-group={exploring ? 'exploring' : undefined}
      data-open={open ? '' : undefined}
      className={cn(quiet ? 'py-1.5' : 'py-2', 'flex flex-col gap-1 first:pt-0 last:pb-0')}
    >
      {toggle === undefined ? (
        <p className={head}>
          {attribution}
          {headline}
          {trailing}
        </p>
      ) : (
        <button
          type="button"
          data-action="toggle-entry"
          aria-expanded={open}
          onClick={toggle}
          className={cn(head, 'w-full cursor-pointer border-0 bg-transparent p-0 text-left')}
        >
          {open ? (
            <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
          )}
          {attribution}
          {headline}
          {trailing}
        </button>
      )}
      {open && toggle !== undefined && (
        <div className={cn('entry-body flex flex-col gap-2 pl-5', quiet && 'text-xs text-muted-foreground')}>
          {quiet ? (
            <Prose text={bodyOf(row)} className="markdown-quiet" />
          ) : exploring ? (
            <Calls row={row} />
          ) : tool !== null ? (
            <Call tool={tool} view={view} result={result} />
          ) : (
            <pre className="m-0 whitespace-pre-wrap break-words font-mono text-xs">{bodyOf(row)}</pre>
          )}
        </div>
      )}
    </li>
  )
}

/**
 * A prose row: an agent's answer, the operator's message, an error, a gate.
 *
 * An agent's answer under a band that already reads REVIEWER needs no head at
 * all; `transcript.ts` decides that and empties the label. `bodyOf`, not
 * `view.body`: a streamed answer is several `assistant_text` events and one
 * statement, so a row can hold more than the view its head was built from.
 */
function ProseEntry({ row, view }: { readonly row: Row; readonly view: EntryView }) {
  const operator = view.author === 'operator'
  // Markdown for what a person or a model wrote to be read; the rest — an
  // error message, a gate verdict, a proposal laid out line by line — is text
  // whose line breaks mean something and must stay where they are.
  const markdown = view.kind === 'assistant_text' || view.kind === 'user_message'
  return (
    <li
      data-entry={row.at}
      data-kind={view.kind}
      data-shape="prose"
      data-open=""
      className={cn(ROW, operator && 'entry-operator')}
    >
      {(view.label !== '' || view.tone !== null) && (
        <p className="entry-head flex items-center gap-2 text-[13px]">
          <span
            className={cn('entry-author font-semibold', AUTHOR[view.author])}
            data-author={view.author}
          >
            {view.label}
          </span>
          {view.tone !== null && <ToneDot tone={view.tone} />}
        </p>
      )}
      {markdown ? (
        <Prose text={bodyOf(row)} className="entry-body text-sm" />
      ) : (
        <p className="entry-body text-sm">{bodyOf(row)}</p>
      )}
    </li>
  )
}

/** Shared by every row so the dividers land on an even rhythm. */
const ROW = 'flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0'

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

const ICONS: Readonly<Record<ToolKind, LucideIcon>> = {
  read: FileTextIcon,
  edit: PencilLineIcon,
  write: FilePlus2Icon,
  shell: SquareTerminalIcon,
  search: SearchIcon,
  glob: FolderSearchIcon,
  list: FolderIcon,
  fetch: ExternalLinkIcon,
  web: GlobeIcon,
  agent: BotIcon,
  todo: ListTodoIcon,
  other: WrenchIcon,
}

/**
 * The target, on the collapsed row: a path with its directory dimmed, a
 * command in mono, a sentence for an agent's brief. `data-headline` is what
 * the tests read, and what a reader reads too.
 */
function Target({ tool, className }: { readonly tool: ToolView; readonly className?: string }) {
  if (tool.target === null) {
    return (
      <span className={cn('truncate text-muted-foreground', className)} data-headline>
        {tool.args.length === 0 ? '' : tool.args.map(([key, value]) => `${key}=${value}`).join(' ')}
      </span>
    )
  }
  const mono = tool.kind !== 'agent' && tool.kind !== 'todo'
  if (tool.path !== null && tool.target === tool.path) {
    return (
      <span className={cn('flex min-w-0 items-center', className)} data-headline>
        <PathName path={tool.path} className="text-xs" />
      </span>
    )
  }
  return (
    <span className={cn('flex min-w-0 items-baseline gap-1', className)}>
      {tool.kind === 'shell' && (
        <span aria-hidden="true" className="shrink-0 font-mono text-xs text-muted-foreground">
          $
        </span>
      )}
      <span
        className={cn('truncate', mono ? 'font-mono text-xs' : 'text-muted-foreground')}
        data-headline
      >
        {tool.target}
      </span>
    </span>
  )
}

/** The result's verdict, as the dot the rows have always used. */
function Verdict({ result }: { readonly result: EntryView }) {
  return (
    <span data-result data-tone={result.tone ?? undefined} className="flex shrink-0 items-center">
      {result.tone !== null && <ToneDot tone={result.tone} />}
    </span>
  )
}

/** The open tool row: what the call was, in the form its kind reads best in. */
function Call({
  tool,
  view,
  result,
}: {
  readonly tool: ToolView
  readonly view: EntryView
  readonly result: EntryView | null
}) {
  return (
    <>
      {tool.kind === 'edit' && tool.edit !== null && (
        <div className="overflow-hidden rounded-md border" data-edit>
          <FileDiffBody file={editAsFile(tool)} lang={tool.path === null ? null : languageFor(tool.path)} numbered={false} />
        </div>
      )}
      {tool.kind === 'write' && tool.content !== null && (
        <CodeBlock code={tool.content} lang={tool.path === null ? null : languageFor(tool.path)} data-write />
      )}
      {tool.kind === 'shell' && tool.command !== null && (
        <CodeBlock code={tool.command} lang={SHELL} data-command />
      )}
      {tool.args.length > 0 && <Args args={tool.args} />}
      {/* Kinds whose arguments the forms above did not spend: the payload, indented. */}
      {!(tool.kind === 'edit' && tool.edit !== null) &&
        !(tool.kind === 'write' && tool.content !== null) &&
        !(tool.kind === 'shell' && tool.command !== null) &&
        tool.args.length === 0 &&
        tool.kind !== 'agent' &&
        tool.kind !== 'todo' && <CodeBlock code={view.body} lang="json" />}
      {(tool.kind === 'agent' || tool.kind === 'todo') && tool.args.length === 0 && (
        <pre className="m-0 whitespace-pre-wrap break-words text-xs text-muted-foreground">{view.body}</pre>
      )}
      {result !== null && <Output result={result} />}
    </>
  )
}

/** `key=value` rows, for the arguments a call's own form did not show. */
function Args({ args }: { readonly args: readonly (readonly [string, string])[] }) {
  return (
    <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-xs">
      {args.map(([key, value]) => (
        <Fragment key={key}>
          <dt className="text-muted-foreground">{key}</dt>
          <dd className="m-0 truncate">{value}</dd>
        </Fragment>
      ))}
    </dl>
  )
}

/** What the tool printed back. The harness clipped it; this wraps it. */
function Output({ result }: { readonly result: EntryView }) {
  if (result.body === '') return null
  return (
    <pre
      className={cn(
        'entry-output m-0 whitespace-pre-wrap break-words rounded-md border-l-2 bg-muted/60 px-3 py-2 font-mono text-xs',
        result.tone === 'error' ? 'border-tone-error' : 'border-border',
      )}
      data-output
    >
      {result.body}
    </pre>
  )
}

/** The calls inside a stretch of exploring, one line each, with their verdicts. */
function Calls({ row }: { readonly row: Row }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {row.views.map((view, index) => {
        const tool = view.tool
        if (tool === null) return null
        const Icon = ICONS[tool.kind]
        const result = row.results[index] ?? null
        return (
          <li key={index} className="flex min-w-0 items-center gap-2 text-[13px]" data-call={tool.id}>
            <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0 font-medium">{tool.verb}</span>
            <Target tool={tool} className="min-w-0 flex-1" />
            {result !== null && <Verdict result={result} />}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * An edit as a one-hunk file, so the diff table can draw it. The two sides
 * are the harness's `old_string` and `new_string`; there are no line numbers
 * to show because the call does not say where in the file it landed.
 */
function editAsFile(tool: ToolView): FileDiff {
  const before = lines(tool.edit?.before ?? '')
  const after = lines(tool.edit?.after ?? '')
  return {
    path: tool.path ?? '',
    oldPath: null,
    status: 'modified',
    binary: false,
    additions: after.length,
    deletions: before.length,
    hunks: [
      {
        oldStart: 1,
        oldLines: before.length,
        newStart: 1,
        newLines: after.length,
        section: '',
        lines: [
          ...before.map((text, index) => ({ kind: 'del' as const, text, oldNo: index + 1, newNo: null })),
          ...after.map((text, index) => ({ kind: 'add' as const, text, oldNo: null, newNo: index + 1 })),
        ],
      },
    ],
  }
}

function lines(text: string): string[] {
  if (text === '') return []
  const split = text.split('\n')
  if (split.at(-1) === '') split.pop()
  return split
}

// ---------------------------------------------------------------------------
// Author bands
// ---------------------------------------------------------------------------

/**
 * Where one agent stops and the next starts.
 *
 * A phase's transcript is an implementer, a reviewer, and a fix round or three,
 * appended to one file in order — and until the daemon started recording who
 * wrote each line there was no way to tell, mid-scroll, which of them you were
 * reading. This is that boundary, and only the boundary: a badge on every row
 * would say the same thing ninety times running.
 *
 * `role` is whatever the daemon wrote (`journal/transcript.ts` explains why it
 * is a string and not a union), so a role this build has never heard of shows
 * as itself rather than as nothing.
 *
 * **It sticks.** A boundary you can only read by scrolling back to it answers
 * the question one row too late: sixty rows into a fixer's output the band that
 * named it is long gone, and "whose output am I reading" is exactly what the
 * band exists to answer. Pinned, it stays over its own run of rows, and the
 * next band takes the offset off it on the way in — consecutive sticky siblings
 * all resolve to the same `top`, and the later one paints over the earlier, so
 * the handover needs no measuring and no grouping element per run. What that
 * costs is a few pixels of scroll where the outgoing label is half covered by
 * the incoming one; a true slide-out would mean giving each run its own
 * containing block, which is a nested list to buy an animation.
 *
 * Three things make that work, and each of them is a way it silently does not:
 *
 * - **The `ol` is the sticky ancestor**, because it is the element carrying
 *   `overflow-y-auto`, and these are its direct children. Any `overflow`,
 *   `transform`, `filter` or `contain` on an element *between* the two would
 *   retarget or kill the stick with no error and no visual clue — the card and
 *   its content well are checked clean, so keep them that way.
 * - **`bg-card` is not decoration.** A pinned band with a transparent
 *   background has rows sliding through the letters. The token is the card's
 *   own surface, which is also what the expanded panel paints (`Panel.tsx`
 *   portals the same `Card` to `document.body`, so the ground does not change),
 *   and it follows the theme where a literal colour would be wrong at night.
 * - **`z-10` puts it over the rows** and nowhere near the panel's own z-50
 *   overlay, which is an ancestor and so not something a child can climb past.
 *
 * The hairlines stay. In flow they read as a rule broken by a label; pinned,
 * the one running to the right edge is what keeps the band reading as a band
 * rather than as a stray line of text laid over the transcript. The bottom
 * padding is the other half of that — it is the gap rows pass through, so it is
 * wider than the flow layout strictly needed.
 */
function Author({
  role,
  chore,
  first,
}: {
  readonly role: string
  readonly chore: string | null
  readonly first: boolean
}) {
  return (
    <li
      data-turn={role}
      className={cn(
        'sticky top-0 z-10 flex items-center gap-2 bg-card pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground',
        first ? 'pt-0' : 'pt-3',
      )}
    >
      <span className="h-px flex-none basis-3 bg-border" aria-hidden="true" />
      {(ROLE_NAMES[role] ?? role) + (chore === null ? '' : ` · ${chore}`)}
      <span className="h-px min-w-0 flex-1 bg-border" aria-hidden="true" />
    </li>
  )
}

/** The roles the shipped pipeline and the daemon produce, in words. */
const ROLE_NAMES: Readonly<Record<string, string>> = {
  // §7's rule, in the band: the operator's steering is never filed under the
  // agent that received it, even though the adapter echoes it back on that
  // agent's own event stream.
  operator: 'You',
  implementer: 'Implementer',
  reviewer: 'Reviewer',
  fixer: 'Fixer',
  chore: 'Chore',
  'conflict-fixer': 'Conflict fixer',
  gate: 'Gate',
  monitor: 'Coordinator',
}

export type { ReactNode }
