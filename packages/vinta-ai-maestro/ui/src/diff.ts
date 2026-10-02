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
