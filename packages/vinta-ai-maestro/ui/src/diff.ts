/**
 * A unified diff, read into the rows a view renders.
 *
 * Git's patch format is small enough to read here and stable enough to be
 * worth no dependency: a `diff --git` header per file, a few header lines
 * saying what kind of change it is, and `@@` hunks whose body lines start with
 * a space, a `+` or a `-`. The parser is line-oriented and never throws — a
 * line it does not recognise inside a hunk is kept as context rather than
 * dropped, because the patch is the record of what a phase did and a viewer
 * that silently loses lines of it lies.
 *
 * Nothing here is rendered. The output is numbered rows, so the view can draw
 * a gutter without counting, and a `status` per file read off the headers, so
 * the view can say "added" without looking at whether every line is a `+`.
 */

export type LineKind = 'context' | 'add' | 'del'

export interface DiffLine {
  readonly kind: LineKind
  /** The line without its leading marker. */
  readonly text: string
  /** Line number on the old side, or null for an added line. */
  readonly oldNo: number | null
  /** Line number on the new side, or null for a deleted line. */
  readonly newNo: number | null
  /** `\ No newline at end of file` followed this line. */
  readonly noNewline?: boolean
}

export interface Hunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  /** The function context git puts after the second `@@`, if any. */
  readonly section: string
  readonly lines: readonly DiffLine[]
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied'

export interface FileDiff {
  /** The path as it is now; for a deletion, the path that was removed. */
  readonly path: string
  readonly oldPath: string | null
  readonly status: FileStatus
  readonly binary: boolean
  readonly hunks: readonly Hunk[]
  readonly additions: number
  readonly deletions: number
}

const FILE_HEADER = /^diff --git a\/(.*) b\/(.*)$/
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

export function parsePatch(patch: string): readonly FileDiff[] {
  const files: FileDiff[] = []
  // Split on the header rather than scanning for it, so a line *inside* a hunk
  // that happens to start with `diff --git` (a diff of a diff) is not a file.
  // A hunk line always has a marker in column one, so only a header is at
  // column zero after a newline.
  const sections = patch.split(/^(?=diff --git )/m).filter((section) => section.trim() !== '')
  for (const section of sections) {
    const file = parseFile(section)
    if (file !== null) files.push(file)
  }
  return files
}

function parseFile(section: string): FileDiff | null {
  const lines = section.split('\n')
  // A trailing newline leaves an empty last element; it is not a line.
  if (lines.at(-1) === '') lines.pop()
  const header = FILE_HEADER.exec(lines[0] ?? '')
  if (header === null) return null

  let path = header[2] ?? ''
  let oldPath: string | null = null
  let status: FileStatus = 'modified'
  let binary = false
  let index = 1

  // Extended headers, up to the first hunk or the end.
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.startsWith('@@')) break
    if (line.startsWith('new file mode')) status = 'added'
    else if (line.startsWith('deleted file mode')) status = 'deleted'
    else if (line.startsWith('rename from ')) {
      oldPath = unquote(line.slice('rename from '.length))
      status = 'renamed'
    } else if (line.startsWith('rename to ')) path = unquote(line.slice('rename to '.length))
    else if (line.startsWith('copy from ')) {
      oldPath = unquote(line.slice('copy from '.length))
      status = 'copied'
    } else if (line.startsWith('copy to ')) path = unquote(line.slice('copy to '.length))
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') binary = true
    else if (line.startsWith('+++ ')) {
      // `+++ b/path` is the authoritative new name; `/dev/null` is a deletion.
      const named = line.slice(4)
      if (named !== '/dev/null') path = unquote(named.replace(/^b\//, ''))
    } else if (line.startsWith('--- ')) {
      const named = line.slice(4)
      if (named === '/dev/null') status = status === 'modified' ? 'added' : status
    }
  }
  // A deletion's path is the one that was removed: `+++ /dev/null` names nothing.
  if (status === 'deleted') path = unquote(header[1] ?? path)

  const hunks: Hunk[] = []
  let additions = 0
  let deletions = 0
  while (index < lines.length) {
    const match = HUNK_HEADER.exec(lines[index] ?? '')
    if (match === null) {
      index += 1
      continue
    }
    const oldStart = Number(match[1])
    const oldLines = match[2] === undefined ? 1 : Number(match[2])
    const newStart = Number(match[3])
    const newLines = match[4] === undefined ? 1 : Number(match[4])
    const rows: DiffLine[] = []
    let oldNo = oldStart
    let newNo = newStart
    index += 1
    for (; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      if (line.startsWith('@@')) break
      if (line.startsWith('\\')) {
        // `\ No newline at end of file` qualifies the line before it.
        const last = rows.at(-1)
        if (last !== undefined) rows[rows.length - 1] = { ...last, noNewline: true }
        continue
      }
      const marker = line[0]
      const text = line.slice(1)
      if (marker === '+') {
        rows.push({ kind: 'add', text, oldNo: null, newNo })
        newNo += 1
        additions += 1
      } else if (marker === '-') {
        rows.push({ kind: 'del', text, oldNo, newNo: null })
        oldNo += 1
        deletions += 1
      } else {
        // A space, or — on an empty context line git may emit as nothing at
        // all — no marker. Either way it is on both sides.
        rows.push({ kind: 'context', text: marker === ' ' ? text : line, oldNo, newNo })
        oldNo += 1
        newNo += 1
      }
    }
    hunks.push({ oldStart, oldLines, newStart, newLines, section: match[5] ?? '', lines: rows })
  }

  return { path, oldPath, status, binary, hunks, additions, deletions }
}

/** Git quotes a path with unusual characters: `"src/caf\303\251.ts"`. Only the quotes are undone. */
function unquote(path: string): string {
  return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path
}

/** `src/billing/invoice.ts` → `['src/billing/', 'invoice.ts']`, for a row that dims the directory. */
export function splitPath(path: string): readonly [string, string] {
  const at = path.lastIndexOf('/')
  return at === -1 ? ['', path] : [path.slice(0, at + 1), path.slice(at + 1)]
}

// ---------------------------------------------------------------------------
// Pairing: which removed line became which added line
// ---------------------------------------------------------------------------

/**
 * A run of removed lines followed directly by a run of added lines is one
 * change: the first removed line became the first added, and so on. That is
 * how every review tool reads a hunk, and it is what both the word-level
 * emphasis and the split view are built on. Lines left over on either side
 * — three removed, one added — pair with nothing.
 *
 * Returns, for each line index, the index of its partner on the other side.
 */
export function pairs(hunk: Hunk): ReadonlyMap<number, number> {
  const partner = new Map<number, number>()
  const lines = hunk.lines
  let index = 0
  while (index < lines.length) {
    if (lines[index]?.kind !== 'del') {
      index += 1
      continue
    }
    const dels: number[] = []
    while (lines[index]?.kind === 'del') dels.push(index++)
    const adds: number[] = []
    while (lines[index]?.kind === 'add') adds.push(index++)
    for (let at = 0; at < Math.min(dels.length, adds.length); at += 1) {
      partner.set(dels[at] as number, adds[at] as number)
      partner.set(adds[at] as number, dels[at] as number)
    }
  }
  return partner
}

// ---------------------------------------------------------------------------
// Word-level emphasis
// ---------------------------------------------------------------------------

/** A stretch of a line: changed against its partner, or shared with it. */
export interface Segment {
  readonly text: string
  readonly changed: boolean
}

/**
 * Lines longer than this, in tokens, are not word-diffed. The LCS below is
 * quadratic, and a minified line against another minified line is work that
 * produces nothing a reader can use.
 */
const WORD_DIFF_LIMIT = 400

/**
 * Below this share of the line kept in common, the emphasis is dropped. A
 * line that was rewritten rather than edited would otherwise be highlighted
 * nearly end to end, which says less than the plain row colour does.
 */
const KEPT_SHARE = 0.3

/**
 * What changed *within* each paired line: the words, as segments to emphasise.
 *
 * The row colour says a line was removed and another added; this says which
 * three characters of it differ, which for a renamed variable or a flipped
 * operator is the whole finding. Computed per pair over word-ish tokens — a
 * run of word characters, a run of spaces, or one punctuation mark — so that
 * `amount` against `amount * quantity` emphasises the two new tokens and not
 * every character after the first difference.
 *
 * Keyed by line index. A line with no partner, or whose partner shares too
 * little with it, has no entry and renders as the row colour alone.
 */
export function emphasis(hunk: Hunk): ReadonlyMap<number, readonly Segment[]> {
  const segments = new Map<number, readonly Segment[]>()
  const partner = pairs(hunk)
  for (const [from, to] of partner) {
    const line = hunk.lines[from]
    if (line === undefined || line.kind !== 'del') continue
    const other = hunk.lines[to]
    if (other === undefined) continue
    const result = wordDiff(line.text, other.text)
    if (result === null) continue
    segments.set(from, result.before)
    segments.set(to, result.after)
  }
  return segments
}

const TOKEN = /\w+|\s+|[^\w\s]/g

function tokens(text: string): string[] {
  return text.match(TOKEN) ?? []
}

/**
 * The two lines as segments, by longest common subsequence over tokens; null
 * when they are too long to compare or too different to be worth it.
 */
export function wordDiff(
  before: string,
  after: string,
): { readonly before: readonly Segment[]; readonly after: readonly Segment[] } | null {
  const a = tokens(before)
  const b = tokens(after)
  if (a.length > WORD_DIFF_LIMIT || b.length > WORD_DIFF_LIMIT) return null
  if (a.length === 0 || b.length === 0) return null

  // lcs[i][j]: length of the LCS of a[i..] and b[j..].
  const lcs: Uint16Array[] = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = lcs[i] as Uint16Array
    const next = lcs[i + 1] as Uint16Array
    for (let j = b.length - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number)
    }
  }

  const left: Segment[] = []
  const right: Segment[] = []
  let kept = 0
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      kept += (a[i] as string).length
      push(left, a[i] as string, false)
      push(right, b[j] as string, false)
      i += 1
      j += 1
    } else if (((lcs[i + 1] as Uint16Array)[j] as number) >= ((lcs[i] as Uint16Array)[j + 1] as number)) {
      push(left, a[i] as string, true)
      i += 1
    } else {
      push(right, b[j] as string, true)
      j += 1
    }
  }
  while (i < a.length) push(left, a[i++] as string, true)
  while (j < b.length) push(right, b[j++] as string, true)

  const longest = Math.max(before.length, after.length)
  if (longest === 0 || kept / longest < KEPT_SHARE) return null
  return { before: left, after: right }
}

/** Appends to the last segment when it is of the same kind, so a run is one span. */
function push(segments: Segment[], text: string, changed: boolean): void {
  const last = segments.at(-1)
  if (last !== undefined && last.changed === changed) {
    segments[segments.length - 1] = { text: last.text + text, changed }
  } else {
    segments.push({ text, changed })
  }
}

// ---------------------------------------------------------------------------
// Split view
// ---------------------------------------------------------------------------

/** One row of a side-by-side view: the index into `hunk.lines` on each side, or null for a blank. */
export interface SplitRow {
  readonly left: number | null
  readonly right: number | null
}

/**
 * A hunk as side-by-side rows. Context sits on both sides; a removed line and
 * the added line it pairs with share a row; what pairs with nothing has a
 * blank across from it.
 */
export function splitRows(hunk: Hunk): readonly SplitRow[] {
  const rows: SplitRow[] = []
  const lines = hunk.lines
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line === undefined) break
    if (line.kind === 'context') {
      rows.push({ left: index, right: index })
      index += 1
      continue
    }
    const dels: number[] = []
    while (lines[index]?.kind === 'del') dels.push(index++)
    const adds: number[] = []
    while (lines[index]?.kind === 'add') adds.push(index++)
    for (let at = 0; at < Math.max(dels.length, adds.length); at += 1) {
      rows.push({ left: dels[at] ?? null, right: adds[at] ?? null })
    }
  }
  return rows
}
