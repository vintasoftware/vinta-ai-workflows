/**
 * What the phase changed, on the node view and full page (§10).
 *
 * The card is asserted against the stub's record of what it asked for — the
 * counts and never the patch — because the daemon runs git for each read and
 * "the card polls the cheap half" is a claim about requests.
 */
import { cleanup, fireEvent, waitFor, type RenderResult } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { CHANGES_SHOWN } from '../src/Changes.tsx'
import { LARGE_FILE_LINES } from '../src/Code.tsx'
import {
  changedFile,
  node,
  nodeChanges,
  nodeDetail,
  RUN_ID,
  runSummary,
  snapshot,
} from './fixtures.ts'
import { renderApp, textOf } from './render-app.tsx'
import { startStubDaemon, type StubDaemon } from './stub-daemon.ts'

let daemon: StubDaemon | null = null
let view: RenderResult | null = null

afterEach(async () => {
  view = null
  cleanup()
  sessionStorage.clear()
  await daemon?.close()
  daemon = null
})

function open(stub: StubDaemon, hash: string): RenderResult {
  view?.unmount()
  view = renderApp(stub, hash)
  return view
}

const FILES = [
  changedFile('src/billing/invoice.ts', { additions: 40, deletions: 12 }),
  changedFile('src/billing/serializer.ts', { status: 'added', additions: 88, deletions: 0 }),
  changedFile('src/legacy/totals.ts', { status: 'deleted', additions: 0, deletions: 31 }),
  changedFile('src/billing/model.ts', { status: 'renamed', oldPath: 'src/billing/models.ts', additions: 2, deletions: 2 }),
  changedFile('docs/logo.png', { status: 'added', additions: null, deletions: null, binary: true }),
]

const PATCH = `diff --git a/src/billing/invoice.ts b/src/billing/invoice.ts
index 1111111..2222222 100644
--- a/src/billing/invoice.ts
+++ b/src/billing/invoice.ts
@@ -1,3 +1,3 @@ export function total(invoice: Invoice) {
 const lines = invoice.lines
-return lines.reduce((sum, line) => sum + line.amount, 0)
+return lines.reduce((sum, line) => sum + line.amount * line.quantity, 0)
 }
diff --git a/src/billing/serializer.ts b/src/billing/serializer.ts
new file mode 100644
--- /dev/null
+++ b/src/billing/serializer.ts
@@ -0,0 +1,2 @@
+export function serialize(invoice: Invoice): string {
+  return JSON.stringify(invoice)
`

test('the card lists each changed file with its status and counts, and the way to the whole diff', async () => {
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [node('impl', 'running')] }) },
    details: { [`${RUN_ID}/impl`]: nodeDetail() },
    changes: { [`${RUN_ID}/impl`]: nodeChanges({ files: FILES, source: 'worktree', patch: PATCH }) },
  })
  daemon = stub
  const { container } = open(stub, `#/runs/${RUN_ID}/nodes/impl`)

  await waitFor(() => expect(container.querySelectorAll('[data-changed-files] li')).toHaveLength(5))

  // The headline: how many files, where the description came from, and the
  // totals across them. Binary files count as files and as no lines.
  expect(textOf(container, '[data-changes-summary]')).toContain('5 files changed')
  expect(textOf(container, '[data-changes-summary]')).toContain('working tree')
  expect(textOf(container, '[data-changes] [data-counts]')).toBe('+130−45')

  const rows = [...container.querySelectorAll('[data-changed-files] li')]
  expect(rows.map((row) => row.getAttribute('data-file'))).toEqual(FILES.map((file) => file.path))
  // The status is a mark with a word behind it, not a colour alone.
  expect(rows.map((row) => row.querySelector('[data-status]')?.textContent)).toEqual(['M', 'A', 'D', 'R', 'A'])
  expect(rows[1]?.querySelector('[data-status]')?.getAttribute('aria-label')).toBe('added')
  expect(rows[0]?.textContent).toContain('+40')
  expect(rows[0]?.textContent).toContain('−12')
  expect(rows[4]?.textContent).toContain('binary')

  // Nothing here asked for the patch: that is the diff view's read.
  expect(stub.changeReads.every((read) => !read.patch)).toBe(true)
  expect(stub.changeReads.length).toBeGreaterThan(0)

  // The call to action, and a row that goes straight to its file.
  const cta = container.querySelector('[data-action="view-diff"]') as HTMLAnchorElement
  expect(cta.getAttribute('href')).toBe(`#/runs/${RUN_ID}/nodes/impl/changes`)
  expect(rows[0]?.querySelector('a')?.getAttribute('href')).toBe(
    `#/runs/${RUN_ID}/nodes/impl/changes?file=${encodeURIComponent('src/billing/invoice.ts')}`,
  )
  // The token lives in the query string; a fragment link cannot carry it away.
  expect(cta.getAttribute('href')).not.toContain(stub.token)

  // The reference survives beside the description — it is what the operator
  // reaches for when the card cannot help.
  expect(textOf(container, '[data-diff-branch]')).toBe('feature/impl')
  expect(textOf(container, '[data-diff-base]')).toBe('main')
  expect(textOf(container, '[data-diff-lane]')).toBe('lane-1')
})

test('past ten files the card counts the rest rather than listing them', async () => {
  const many = Array.from({ length: 14 }, (_, index) => changedFile(`src/file-${index}.ts`))
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [node('impl', 'running')] }) },
    details: { [`${RUN_ID}/impl`]: nodeDetail() },
    changes: { [`${RUN_ID}/impl`]: nodeChanges({ files: many }) },
  })
  daemon = stub
  const { container } = open(stub, `#/runs/${RUN_ID}/nodes/impl`)

  await waitFor(() => expect(container.querySelector('[data-changes-rest]')).not.toBe(null))
  expect(container.querySelectorAll('[data-changed-files] li')).toHaveLength(CHANGES_SHOWN)
  expect(textOf(container, '[data-changes-rest]')).toBe('and 4 more files')
  expect(textOf(container, '[data-changes-summary]')).toContain('14 files changed')
})

test('a node with no branch, and a daemon that does not describe changes, each say so', async () => {
  const fresh = { ...node('impl', 'pending'), lane: null, branch: null, baseBranch: null }
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [fresh, node('old', 'done')] }) },
    details: {
      [`${RUN_ID}/impl`]: nodeDetail({ node: fresh, diff: { branch: null, baseBranch: null, lane: null } }),
      [`${RUN_ID}/old`]: nodeDetail({
        node: node('old', 'done'),
        diff: { branch: 'feature/old', baseBranch: 'main', lane: 'lane-1' },
      }),
    },
    changes: {
      [`${RUN_ID}/impl`]: nodeChanges({ branch: null, baseBranch: null, lane: null, source: 'none' }),
      // No entry for `old`: the stub answers 404, as an older daemon would.
    },
  })
  daemon = stub

  const unassigned = open(stub, `#/runs/${RUN_ID}/nodes/impl`)
  await waitFor(() => expect(textOf(unassigned.container, '[data-changes]')).toContain('no branch yet'))
  expect(unassigned.container.querySelector('[data-action="view-diff"]')).toBe(null)

  const older = open(stub, `#/runs/${RUN_ID}/nodes/old`)
  await waitFor(() =>
    expect(textOf(older.container, '[data-changes]')).toContain('does not describe changes'),
  )
  // The reference is the fallback, and it is still there.
  expect(textOf(older.container, '[data-diff-branch]')).toBe('feature/old')
  expect(older.container.querySelector('[data-action="view-diff"]')).toBe(null)
})

test('the full diff renders every file, numbered on both sides, from one read of the patch', async () => {
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [node('impl', 'running')] }) },
    details: { [`${RUN_ID}/impl`]: nodeDetail() },
    changes: {
      [`${RUN_ID}/impl`]: nodeChanges({ files: FILES, source: 'branch', patch: PATCH, truncated: true }),
    },
  })
  daemon = stub
  const { container } = open(stub, `#/runs/${RUN_ID}/nodes/impl/changes?file=${encodeURIComponent('src/billing/serializer.ts')}`)

  await waitFor(() => expect(container.querySelectorAll('[data-diff-files] a')).toHaveLength(5))

  // This view is the one that asks for the patch.
  expect(stub.changeReads.at(-1)?.patch).toBe(true)
  expect(textOf(container, '[data-diff-totals]')).toBe('5 files')

  // The modified file: its hunk, with the old and new line numbers and the
  // markers in the gutter, and the function context on the hunk header.
  const invoice = container.querySelector('[data-diff-file="src/billing/invoice.ts"]')
  expect(invoice).not.toBe(null)
  expect(invoice?.querySelector('[data-hunk]')?.textContent).toContain('@@ -1,3 +1,3 @@')
  expect(invoice?.querySelector('[data-hunk]')?.textContent).toContain('export function total')
  const lines = [...(invoice?.querySelectorAll('tr[data-line]') ?? [])]
  expect(lines.map((line) => line.getAttribute('data-line'))).toEqual(['context', 'del', 'add', 'context'])
  const cells = (row: Element | undefined): string[] =>
    [...(row?.querySelectorAll('td') ?? [])].map((cell) => cell.textContent ?? '')
  expect(cells(lines[1])).toEqual(['2', '', '-', 'return lines.reduce((sum, line) => sum + line.amount, 0)'])
  expect(cells(lines[2])).toEqual(['', '2', '+', 'return lines.reduce((sum, line) => sum + line.amount * line.quantity, 0)'])

  // Files the daemon counted but the cut patch does not hold are still named,
  // and say why they are empty — the list never shrinks with the patch.
  expect(container.querySelector('[data-diff-truncated]')).not.toBe(null)
  const missing = container.querySelector('section[data-file="src/legacy/totals.ts"]')
  expect(missing?.textContent).toContain('Not in the served patch')
  expect(missing?.textContent).toContain('−31')

  // The sidebar scrolls rather than navigating: the hash is the route.
  const link = container.querySelector('[data-file-link="src/billing/invoice.ts"]') as HTMLAnchorElement
  fireEvent.click(link)
  expect(window.location.hash).toContain('/changes')

  // And the way back is to the phase.
  expect(container.querySelector(`a[href="#/runs/${RUN_ID}/nodes/impl"]`)).not.toBe(null)
})

test('a large file opens folded, with the number of lines it is hiding', async () => {
  const lines = Array.from({ length: LARGE_FILE_LINES + 1 }, (_, index) => `+line ${index}`).join('\n')
  const big = `diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1 +1,${LARGE_FILE_LINES + 2} @@
 lockfileVersion: 9
${lines}
`
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [node('impl', 'running')] }) },
    details: { [`${RUN_ID}/impl`]: nodeDetail() },
    changes: {
      [`${RUN_ID}/impl`]: nodeChanges({
        files: [changedFile('pnpm-lock.yaml', { additions: LARGE_FILE_LINES + 1, deletions: 0 })],
        patch: big,
      }),
    },
  })
  daemon = stub
  const { container } = open(stub, `#/runs/${RUN_ID}/nodes/impl/changes`)

  await waitFor(() => expect(container.querySelector('[data-action="toggle-file"]')).not.toBe(null))
  const card = container.querySelector('section[data-file="pnpm-lock.yaml"]')
  expect(card?.hasAttribute('data-open')).toBe(false)
  expect(textOf(container, '[data-action="toggle-file"]')).toBe(`Show ${LARGE_FILE_LINES + 1} changed lines`)
  expect(card?.querySelector('tr[data-line]')).toBe(null)

  fireEvent.click(container.querySelector('[data-action="toggle-file"]')!)
  expect(card?.hasAttribute('data-open')).toBe(true)
  expect(card?.querySelectorAll('tr[data-line="add"]')).toHaveLength(LARGE_FILE_LINES + 1)
})
