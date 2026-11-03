/**
 * The patch reader: git's format in, numbered rows out, nothing dropped.
 */
import { expect, test } from 'vitest'
import { emphasis, pairs, parsePatch, splitPath, splitRows, wordDiff, type Hunk } from '../src/diff.ts'

const MODIFIED = `diff --git a/src/app.ts b/src/app.ts
index 1234567..89abcde 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@ export function app() {
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 const d = 5
`

test('a modified file: one hunk, numbered on both sides', () => {
  const [file] = parsePatch(MODIFIED)

  expect(file).toMatchObject({
    path: 'src/app.ts',
    oldPath: null,
    status: 'modified',
    binary: false,
    additions: 2,
    deletions: 1,
  })
  const hunk = file?.hunks[0]
  expect(hunk).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 })
  expect(hunk?.section).toBe('export function app() {')
  expect(hunk?.lines.map((line) => [line.kind, line.text, line.oldNo, line.newNo])).toEqual([
    ['context', 'const a = 1', 1, 1],
    ['del', 'const b = 2', 2, null],
    ['add', 'const b = 3', null, 2],
    ['add', 'const c = 4', null, 3],
    ['context', 'const d = 5', 3, 4],
  ])
})

test('added, deleted, renamed and binary files are read off their headers', () => {
  const patch = [
    'diff --git a/new.ts b/new.ts',
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ b/new.ts',
    '@@ -0,0 +1 @@',
    '+export const fresh = 1',
    'diff --git a/gone.ts b/gone.ts',
    'deleted file mode 100644',
    'index 2222222..0000000',
    '--- a/gone.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-export const gone = true',
    'diff --git a/src/old.ts b/src/renamed.ts',
    'similarity index 100%',
    'rename from src/old.ts',
    'rename to src/renamed.ts',
    'diff --git a/logo.png b/logo.png',
    'new file mode 100644',
    'index 0000000..3333333',
    'Binary files /dev/null and b/logo.png differ',
    '',
  ].join('\n')

  const files = parsePatch(patch)

  expect(files.map((file) => [file.path, file.oldPath, file.status, file.binary])).toEqual([
    ['new.ts', null, 'added', false],
    ['gone.ts', null, 'deleted', false],
    ['src/renamed.ts', 'src/old.ts', 'renamed', false],
    ['logo.png', null, 'added', true],
  ])
  // A one-line hunk range omits its count and means one.
  expect(files[0]?.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 })
  expect(files[1]?.hunks[0]?.lines[0]).toEqual({ kind: 'del', text: 'export const gone = true', oldNo: 1, newNo: null })
  // A pure rename and a binary have no rows; the view says so from the status.
  expect(files[2]?.hunks).toEqual([])
  expect(files[3]?.hunks).toEqual([])
})

test('a missing trailing newline marks the line before it rather than becoming a row', () => {
  const patch = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`
  const [file] = parsePatch(patch)

  expect(file?.hunks[0]?.lines).toEqual([
    { kind: 'del', text: 'old', oldNo: 1, newNo: null, noNewline: true },
    { kind: 'add', text: 'new', oldNo: null, newNo: 1, noNewline: true },
  ])
})

test('a diff of a diff does not split into two files', () => {
  // The added line begins `diff --git` after its `+` marker; only a header at
  // column zero starts a file.
  const patch = `diff --git a/notes.md b/notes.md
--- a/notes.md
+++ b/notes.md
@@ -1 +1,2 @@
 notes
+diff --git a/x b/x
`
  const files = parsePatch(patch)

  expect(files).toHaveLength(1)
  expect(files[0]?.hunks[0]?.lines[1]).toMatchObject({ kind: 'add', text: 'diff --git a/x b/x' })
})

test('an empty context line with no marker is still a context line', () => {
  const patch = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 a

-b
+c
`
  const [file] = parsePatch(patch)

  expect(file?.hunks[0]?.lines.map((line) => line.kind)).toEqual(['context', 'context', 'del', 'add'])
  expect(file?.hunks[0]?.lines[1]).toMatchObject({ text: '', oldNo: 2, newNo: 2 })
})

test('an empty patch is no files', () => {
  expect(parsePatch('')).toEqual([])
  expect(parsePatch('\n')).toEqual([])
})

test('a path splits into the directory to dim and the name to show', () => {
  expect(splitPath('src/billing/invoice.ts')).toEqual(['src/billing/', 'invoice.ts'])
  expect(splitPath('README.md')).toEqual(['', 'README.md'])
})

// ---------------------------------------------------------------------------
// Pairing, word emphasis, and the split view
// ---------------------------------------------------------------------------

const hunkOf = (...spec: readonly (readonly [string, string])[]): Hunk => {
  let oldNo = 1
  let newNo = 1
  return {
    oldStart: 1,
    oldLines: 0,
    newStart: 1,
    newLines: 0,
    section: '',
    lines: spec.map(([kind, text]) => {
      if (kind === 'del') return { kind: 'del', text, oldNo: oldNo++, newNo: null }
      if (kind === 'add') return { kind: 'add', text, oldNo: null, newNo: newNo++ }
      return { kind: 'context', text, oldNo: oldNo++, newNo: newNo++ }
    }),
  }
}

test('a removed line pairs with the added line in the same position of the run', () => {
  const hunk = hunkOf(['context', 'a'], ['del', 'b1'], ['del', 'b2'], ['del', 'b3'], ['add', 'c1'], ['add', 'c2'], ['context', 'd'])
  const partner = pairs(hunk)

  expect(partner.get(1)).toBe(4)
  expect(partner.get(2)).toBe(5)
  expect(partner.get(4)).toBe(1)
  // The third removed line became nothing.
  expect(partner.has(3)).toBe(false)
  expect(partner.has(0)).toBe(false)
})

test('an added run with no removed run before it pairs with nothing', () => {
  const hunk = hunkOf(['add', 'x'], ['context', 'y'], ['del', 'z'])

  expect(pairs(hunk).size).toBe(0)
})

/** The whole finding, for a renamed variable: the two tokens that differ, not the tail of the line. */
test('a word diff emphasises the tokens that changed and keeps the rest', () => {
  const result = wordDiff(
    'return lines.reduce((sum, line) => sum + line.amount, 0)',
    'return lines.reduce((sum, line) => sum + line.amount * line.quantity, 0)',
  )

  expect(result).not.toBeNull()
  expect(result?.before.every((segment) => !segment.changed)).toBe(true)
  const added = result?.after.filter((segment) => segment.changed).map((segment) => segment.text)
  expect(added).toEqual([' * line.quantity'])
  // The segments concatenate back to the line: nothing is lost in the emphasis.
  expect(result?.after.map((segment) => segment.text).join('')).toBe(
    'return lines.reduce((sum, line) => sum + line.amount * line.quantity, 0)',
  )
})

test('a word diff marks both sides of a substitution', () => {
  const result = wordDiff('const value = 1', 'const value = 2')

  expect(result?.before).toEqual([
    { text: 'const value = ', changed: false },
    { text: '1', changed: true },
  ])
  expect(result?.after).toEqual([
    { text: 'const value = ', changed: false },
    { text: '2', changed: true },
  ])
})

/** A rewritten line gets the row colour alone; highlighting most of it says less than nothing. */
test('lines that share too little are not word-diffed', () => {
  expect(wordDiff('import { a } from "./a"', 'export default function main() {}')).toBeNull()
  expect(wordDiff('', 'anything')).toBeNull()
})

test('emphasis is keyed by line index, for the paired lines only', () => {
  const hunk = hunkOf(['del', 'const a = 1'], ['del', 'gone entirely'], ['add', 'const a = 2'])
  const marks = emphasis(hunk)

  expect([...marks.keys()]).toEqual([0, 2])
  expect(marks.get(2)?.find((segment) => segment.changed)?.text).toBe('2')
})

test('split rows put context on both sides, pairs across, and leftovers alone', () => {
  const hunk = hunkOf(['context', 'a'], ['del', 'b1'], ['del', 'b2'], ['add', 'c1'], ['context', 'd'], ['add', 'e'])

  expect(splitRows(hunk)).toEqual([
    { left: 0, right: 0 },
    { left: 1, right: 3 },
    { left: 2, right: null },
    { left: 4, right: 4 },
    { left: null, right: 5 },
  ])
})
