/** Seeds a journal with a realistic run and serves the UI, so it can be looked at. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon } from './src/daemon/index.ts'
import { openJournal } from './src/journal/journal.ts'
import { parseWorkflow } from './src/validate.ts'

const root = mkdtempSync(join(tmpdir(), 'vinta-flow-demo-'))
const journal = openJournal(root)

const raw = JSON.parse(
  readFileSync(new URL('./tests/fixtures/golden-workflow.json', import.meta.url), 'utf8'),
)
const parsed = parseWorkflow(raw)
if (!parsed.ok) throw new Error('fixture invalid')

const runId = 'bookmark-folders-001'
journal.createRun(runId, parsed.workflow)

const status = (nodeId: string, s: string): void => {
  journal.append({ runId, nodeId, type: 'node_status', payload: { status: s } } as never)
}
const assign = (nodeId: string, patch: Record<string, unknown>): void => {
  journal.append({ runId, nodeId, type: 'node_assigned', payload: patch } as never)
}

// A run mid-flight: one done, one running, one parked on a vendor limit, one still pending.
assign('p1', { lane: 'lane-1', branch: 'plan/bookmark-folders/phase-p1', base_branch: 'main' })
status('p1', 'running')
status('p1', 'done')
assign('p2', {
  lane: 'lane-2',
  branch: 'plan/bookmark-folders/phase-p2',
  base_branch: 'plan/bookmark-folders/phase-p1',
  session_id: 'sess-2',
})
status('p2', 'running')
assign('p3', { lane: 'lane-3', branch: 'plan/bookmark-folders/phase-p3' })
status('p3', 'waiting_on_capacity')

const nodeDir = join(root, '.vinta-flow', 'runs', runId, 'nodes', 'p2')
mkdirSync(nodeDir, { recursive: true })
writeFileSync(
  join(nodeDir, 'transcript.jsonl'),
  `${[
    { type: 'session_started', sessionId: 'sess-2' },
    { type: 'assistant_text', text: 'Reading the phase brief and the BookmarkFolder model.' },
    { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'apps/bookmarks/models.py' } },
    { type: 'tool_result', id: 't1', ok: true, summary: '84 lines' },
    { type: 'thinking', text: 'The serializer needs the nested tree shape.' },
    { type: 'user_message', text: 'prefer a migration over a backfill here' },
    { type: 'assistant_text', text: 'Understood — writing a migration now.' },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n')}\n`,
)

const daemon = await startDaemon({ journal })
daemon.register({
  runId,
  control: { statuses: () => Object.fromEntries(journal.nodes(runId).map((n) => [n.node_id, n.status])) },
  pools: { capacity: (n) => (n === 'lane' ? 3 : 1), held: (n) => (n === 'lane' ? 2 : 0), waiting: 1 },
  admission: {
    ceiling: () => 3,
    inFlight: () => 1,
    wakeAt: (h) => (h === 'claude-code' ? Date.now() + 90_000 : undefined),
  },
} as never)

console.log(`URL ${daemon.url}/?token=${daemon.token}`)
console.log(`RUN ${runId}`)
