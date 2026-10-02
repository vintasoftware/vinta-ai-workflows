/**
 * Code on the page: a block of it, and a file's diff.
 *
 * Shared by the diff view, the changes card and the transcript's tool rows,
 * so a line of TypeScript looks the same whether an agent wrote it, edited it
 * or the operator is reviewing the branch it landed on.
 *
 * Highlighting is additive. Every renderer below draws the plain text first
 * and lays the tokens over it when `useTokens` has them — never a blank while
 * a grammar loads, and never a missing line for a language shiki does not
 * ship. The colours are shiki's GitHub themes through CSS variables; the
 * diff's own colours — the gutter, the row tints — are the design system's
 * green and red, because added-is-green and removed-is-red is the one
 * convention every operator arrives with.
 */
import { Fragment, useState, type ReactNode } from 'react'
import { cn } from 'vinta-design-system/lib/utils'
import { Button } from 'vinta-design-system/ui/button'
import type { ChangedFile } from '../../src/daemon/schemas.ts'
import type { FileDiff, Hunk, LineKind } from './diff.ts'
import { splitPath } from './diff.ts'
import { useTokens, type Token, type Tokens } from './highlight.ts'

// ---------------------------------------------------------------------------
// A block of code
// ---------------------------------------------------------------------------

/**
 * A block of code, highlighted as `lang` when one is known.
 *
 * `wrap` is on by default: the panels these sit in are a third of a grid row,
 * and a scroller inside a panel inside a page is the trap the gates panel
 * exists to avoid. A diff view that has the width turns it off.
 */
export function CodeBlock({
  code,
  lang,
  className,
  numbered = false,
  ...props
}: {
  readonly code: string
  readonly lang: string | null
  readonly numbered?: boolean
} & Omit<React.ComponentProps<'pre'>, 'children' | 'lang'>) {
  const tokens = useTokens(code, lang)
  const lines = code.split('\n')
  // A trailing newline is the file's, not an extra empty line of it.
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()

  return (
    <pre
      className={cn(
        'code m-0 overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs leading-5',
        className,
      )}
      data-lang={lang ?? undefined}
      {...props}
    >
      <code className={numbered ? 'grid grid-cols-[auto_minmax(0,1fr)] gap-x-3' : 'block'}>
        {lines.map((line, index) => (
          <Fragment key={index}>
            {numbered && (
              <span className="select-none text-right text-muted-foreground/60 tabular-nums">
                {index + 1}
              </span>
            )}
            <span className="whitespace-pre-wrap break-all">
              <Line text={line} tokens={tokens?.[index]} />
              {'\n'}
            </span>
          </Fragment>
        ))}
      </code>
    </pre>
  )
}

/** One line: its tokens when there are some, its text otherwise. */
function Line({
  text,
  tokens,
}: {
  readonly text: string
  readonly tokens?: readonly Token[] | undefined
}) {
  if (tokens === undefined) return <>{text}</>
  return (
    <>
      {tokens.map((token, index) => (
        <span key={index} style={token.style}>
          {token.content}
        </span>
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// A file's diff
// ---------------------------------------------------------------------------

/**
 * Past this many changed lines a file opens collapsed. A regenerated lockfile
 * or a vendored bundle is the usual case, and it is the one file in a diff
 * nobody wants to scroll through to reach the next.
 */
export const LARGE_FILE_LINES = 400

/**
 * One file's hunks, as a table: old line, new line, marker, code.
 *
 * The two sides are tokenised separately — every context and added line as
 * the new text, every context and removed line as the old — so a construct
 * that spans lines highlights the way it does in the editor, and a line is
 * never coloured by what sits above it on the other side.
 */
export function FileDiffBody({
  file,
  lang,
  numbered = true,
}: {
  readonly file: FileDiff
  readonly lang: string | null
  /** Off for a diff that has no line numbers to show — an edit's two strings. */
  readonly numbered?: boolean
}) {
  if (file.binary) return <DiffNote>Binary file — no text to show.</DiffNote>
  if (file.hunks.length === 0) {
    return (
      <DiffNote>
        {file.status === 'renamed' || file.status === 'copied'
          ? `${file.status === 'renamed' ? 'Renamed' : 'Copied'} from ${file.oldPath ?? '?'} with no other change.`
          : 'No lines changed.'}
      </DiffNote>
    )
  }
  return (
    <div className="diff overflow-x-auto" data-diff-file={file.path}>
      <table className="w-full border-collapse font-mono text-xs leading-5">
        <tbody>
          {file.hunks.map((hunk, index) => (
            <HunkRows key={index} hunk={hunk} lang={lang} numbered={numbered} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DiffNote({ children }: { readonly children: ReactNode }) {
  return <p className="px-3 py-2 text-xs text-muted-foreground">{children}</p>
}

function HunkRows({
  hunk,
  lang,
  numbered,
}: {
  readonly hunk: Hunk
  readonly lang: string | null
  readonly numbered: boolean
}) {
  const [oldText, newText, oldIndex, newIndex] = sides(hunk)
  const oldTokens = useTokens(oldText, lang)
  const newTokens = useTokens(newText, lang)

  return (
    <>
      {numbered && (
        <tr className="diff-hunk bg-muted/60 text-muted-foreground" data-hunk>
          <td colSpan={3} className="select-none px-2 py-0.5 text-right">
            …
          </td>
          <td className="px-2 py-0.5">
            @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
            {hunk.section !== '' && <span className="ml-2 opacity-70">{hunk.section}</span>}
          </td>
        </tr>
      )}
      {hunk.lines.map((line, index) => {
        const tokens =
          line.kind === 'del' ? oldTokens?.[oldIndex[index] ?? -1] : newTokens?.[newIndex[index] ?? -1]
        return (
          <tr key={index} className={ROW[line.kind]} data-line={line.kind}>
            {numbered && <td className={GUTTER}>{line.oldNo ?? ''}</td>}
            {numbered && <td className={GUTTER}>{line.newNo ?? ''}</td>}
            <td className={cn(GUTTER, 'diff-marker w-4 px-1 text-center')}>{MARKER[line.kind]}</td>
            <td className="whitespace-pre-wrap break-all px-2">
              <Line text={line.text} tokens={tokens} />
              {line.noNewline === true && (
                <span className="ml-2 text-muted-foreground" title="No newline at end of file">
                  ⏎
                </span>
              )}
            </td>
          </tr>
        )
      })}
    </>
  )
}

/**
 * The two texts a hunk tokenises as, and for each row the line it is in each
 * one. A context line is in both; a deleted line is only in the old text.
 */
function sides(hunk: Hunk): [string, string, readonly number[], readonly number[]] {
  const oldLines: string[] = []
  const newLines: string[] = []
  const oldIndex: number[] = []
  const newIndex: number[] = []
  for (const line of hunk.lines) {
    oldIndex.push(line.kind === 'add' ? -1 : oldLines.length)
    newIndex.push(line.kind === 'del' ? -1 : newLines.length)
    if (line.kind !== 'add') oldLines.push(line.text)
    if (line.kind !== 'del') newLines.push(line.text)
  }
  return [oldLines.join('\n'), newLines.join('\n'), oldIndex, newIndex]
}

const GUTTER = 'select-none px-2 text-right text-muted-foreground/60 tabular-nums align-top w-[1%]'

const ROW: Readonly<Record<LineKind, string>> = {
  context: '',
  add: 'diff-add',
  del: 'diff-del',
}

const MARKER: Readonly<Record<LineKind, string>> = {
  context: ' ',
  add: '+',
  del: '-',
}

// ---------------------------------------------------------------------------
// A changed file, named
// ---------------------------------------------------------------------------

/** The status as one letter, the way `git status --short` and every review tool say it. */
const LETTERS: Readonly<Record<ChangedFile['status'], string>> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  type_changed: 'T',
  unmerged: 'U',
  untracked: '?',
  unknown: '·',
}

const STATUS_WORDS: Readonly<Record<ChangedFile['status'], string>> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
  type_changed: 'type changed',
  unmerged: 'unmerged',
  untracked: 'untracked — not yet added to git',
  unknown: 'changed',
}

const STATUS_CLASS: Readonly<Record<ChangedFile['status'], string>> = {
  added: 'diff-mark-add',
  modified: 'diff-mark-mod',
  deleted: 'diff-mark-del',
  renamed: 'diff-mark-mod',
  copied: 'diff-mark-add',
  type_changed: 'diff-mark-mod',
  unmerged: 'diff-mark-del',
  untracked: 'diff-mark-add',
  unknown: 'diff-mark-mod',
}

/** The one-letter status mark. The word is on hover and for assistive tech. */
export function StatusMark({ status }: { readonly status: ChangedFile['status'] }) {
  return (
    <span
      className={cn(
        'inline-grid size-5 shrink-0 place-items-center rounded font-mono text-[11px] font-semibold',
        STATUS_CLASS[status],
      )}
      title={STATUS_WORDS[status]}
      aria-label={STATUS_WORDS[status]}
      data-status={status}
    >
      {LETTERS[status]}
    </span>
  )
}

/** `+12 −3`, in the two colours, or `binary` for a file with no line count. */
export function Counts({
  additions,
  deletions,
  className,
}: {
  readonly additions: number | null
  readonly deletions: number | null
  readonly className?: string
}) {
  if (additions === null && deletions === null) {
    return <span className={cn('text-xs text-muted-foreground', className)}>binary</span>
  }
  return (
    <span
      className={cn('flex shrink-0 items-baseline gap-1.5 font-mono text-xs tabular-nums', className)}
      data-counts
    >
      <span className="diff-text-add">+{additions ?? 0}</span>
      <span className="diff-text-del">−{deletions ?? 0}</span>
    </span>
  )
}

/**
 * Five blocks, green then red then grey, proportional to the change — the
 * glance a reviewer takes before the numbers. Scaled against the largest
 * change in the list so the blocks compare files to each other, not to an
 * absolute nobody set.
 */
export function ChangeBar({
  additions,
  deletions,
  scale,
}: {
  readonly additions: number | null
  readonly deletions: number | null
  readonly scale: number
}) {
  const total = (additions ?? 0) + (deletions ?? 0)
  if (total === 0 || scale === 0) return <span className="inline-block w-[22px]" aria-hidden="true" />
  const blocks = Math.max(1, Math.min(5, Math.round((total / scale) * 5)))
  const green = Math.round((blocks * (additions ?? 0)) / total)
  return (
    <span className="inline-flex shrink-0 gap-px" aria-hidden="true">
      {Array.from({ length: 5 }, (_, index) => (
        <span
          key={index}
          className={cn(
            'h-2.5 w-1 rounded-[1px]',
            index < green ? 'diff-bar-add' : index < blocks ? 'diff-bar-del' : 'bg-border',
          )}
        />
      ))}
    </span>
  )
}

/** A path with its directory dimmed, so the name is what the eye lands on. */
export function PathName({ path, className }: { readonly path: string; readonly className?: string }) {
  const [directory, name] = splitPath(path)
  return (
    <span className={cn('min-w-0 truncate font-mono text-xs', className)} title={path}>
      {directory !== '' && <span className="text-muted-foreground">{directory}</span>}
      <span className="font-medium">{name}</span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// A whole file, header and body, folding
// ---------------------------------------------------------------------------

/**
 * A file in the diff view: a header that names it and a body that can fold.
 *
 * Open by default unless it is large, in which case the header says how many
 * lines it is hiding and opens on request. `onPathClick` is for a header that
 * doubles as the file list's target, which `DiffView` uses to scroll.
 */
export function FileDiffCard({
  file,
  lang,
  counts,
  status,
  id,
}: {
  readonly file: FileDiff
  readonly lang: string | null
  /** The daemon's counts, which are authoritative where a truncated patch's are not. */
  readonly counts: { readonly additions: number | null; readonly deletions: number | null }
  readonly status: ChangedFile['status']
  readonly id: string
}) {
  const changed = file.additions + file.deletions
  const [open, setOpen] = useState(changed <= LARGE_FILE_LINES)

  return (
    <section
      id={id}
      className="file-diff scroll-mt-20 overflow-hidden rounded-lg border bg-card"
      data-file={file.path}
      data-open={open ? '' : undefined}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/40 px-3 py-2">
        <StatusMark status={status} />
        <PathName path={file.path} className="flex-1 text-[13px]" />
        {file.oldPath !== null && (
          <span className="truncate font-mono text-xs text-muted-foreground">
            from {file.oldPath}
          </span>
        )}
        <Counts additions={counts.additions} deletions={counts.deletions} />
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-action="toggle-file"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? 'Collapse' : `Show ${changed} changed lines`}
        </Button>
      </header>
      {open && <FileDiffBody file={file} lang={lang} />}
    </section>
  )
}

export type { Tokens }
