import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Journal, openJournal } from '../src/journal/journal.ts'
import type { Workflow } from '../src/types.ts'
import { parseWorkflow } from '../src/validate.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const JOURNAL_MODULE = pathToFileURL(join(HERE, '..', 'src', 'journal', 'journal.ts')).href

const golden = (): Workflow => {
  const result = parseWorkflow(
    JSON.parse(readFileSync(join(HERE, 'fixtures', 'golden-workflow.json'), 'utf8')),
  )
  if (!result.ok) throw new Error('golden workflow fixture is invalid')
  return result.workflow
}

/**
 * Appends `node_status` events forever, announcing progress on stdout, so the
 * parent can SIGKILL it while a write is genuinely in flight.
 */
const CRASH_CHILD = `
import { writeSync } from 'node:fs'
import { openJournal } from ${JSON.stringify(JOURNAL_MODULE)}

const [projectDir, runId, nodeId] = process.argv.slice(2)
const journal = openJournal(projectDir)

for (let i = 0; ; i += 1) {
  journal.append({
    runId,
    nodeId,
    type: 'node_status',
    payload: { status: i % 2 === 0 ? 'running' : 'pending' },
  })
  if (i % 25 === 24) writeSync(1, \`\${i + 1}\\n\`)
}
`

describe('journal', () => {
  let projectDir: string
  let journal: Journal

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'vinta-flow-journal-'))
    journal = openJournal(projectDir)
  })

  afterEach(() => {
    journal.close()
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('round-trips appended events in commit order', () => {
    journal.createRun('r1', golden())
    const id = journal.append({
      runId: 'r1',
      nodeId: 'p1',
      type: 'node_assigned',
      payload: { lane: 'lane-0', branch: 'phase/p1' },
    })
    journal.append({ runId: 'r1', nodeId: 'p1', type: 'node_status', payload: { status: 'running' } })

    const events = journal.events('r1')
    expect(events.map((e) => e.type)).toEqual([
      'run_started',
      'node_registered',
      'node_registered',
      'node_registered',
      'node_registered',
      'node_assigned',
      'node_status',
    ])
    expect(events.map((e) => e.id)).toEqual([...events.map((e) => e.id)].sort((a, b) => a - b))
    expect(journal.events('r1', id)).toHaveLength(1)
    expect(events.at(-2)).toMatchObject({
      runId: 'r1',
      nodeId: 'p1',
      payload: { lane: 'lane-0', branch: 'phase/p1' },
    })
  })

  it('freezes the workflow into the run directory', () => {
    const workflow = golden()
    journal.createRun('r1', workflow)

    expect(journal.readWorkflow('r1')).toEqual(workflow)
    expect(journal.run('r1')).toMatchObject({
      id: 'r1',
      workflow_id: workflow.id,
      status: 'running',
      base_branch: workflow.base_branch,
      ended_at: null,
    })
  })

  it('rebuilds projections identical to the ones maintained incrementally', () => {
    journal.createRun('r1', golden())
    journal.append({ runId: 'r1', nodeId: 'p1', type: 'node_status', payload: { status: 'running' } })
    journal.append({
      runId: 'r1',
      nodeId: 'p1',
      type: 'node_assigned',
      payload: { lane: 'lane-0', branch: 'phase/p1', base_branch: 'main' },
    })
    // A later partial patch must not blank the fields it omits.
    journal.append({ runId: 'r1', nodeId: 'p1', type: 'node_assigned', payload: { session_id: 's-1' } })
    journal.append({ runId: 'r1', nodeId: 'p1', type: 'node_status', payload: { status: 'done' } })
    journal.append({ runId: 'r1', nodeId: 'p2', type: 'node_status', payload: { status: 'blocked' } })
    journal.append({ runId: 'r1', type: 'run_ended', payload: { status: 'failed' } })

    const incrementalRun = journal.run('r1')
    const incrementalNodes = journal.nodes('r1')

    journal.rebuildProjections()

    expect(journal.run('r1')).toEqual(incrementalRun)
    expect(journal.nodes('r1')).toEqual(incrementalNodes)
    expect(journal.nodes('r1')[0]).toMatchObject({
      node_id: 'p1',
      status: 'done',
      wave: 1,
      lane: 'lane-0',
      branch: 'phase/p1',
      session_id: 's-1',
    })
    expect(journal.run('r1')?.status).toBe('failed')
  })

  it('lists every run across a close and reopen, newest first', () => {
    journal.createRun('r1', golden())
    journal.append({ runId: 'r1', type: 'run_ended', payload: { status: 'done' } })
    journal.createRun('r2', golden())
    journal.close()

    // A new process, with nothing in memory. The runs are still there, which
    // is the difference between a daemon restart and an empty machine.
    journal = openJournal(projectDir)
    expect(journal.runs().map((run) => [run.id, run.status])).toEqual([
      ['r2', 'running'],
      ['r1', 'done'],
    ])
    // And it is still only a projection: dropping it changes nothing.
    journal.rebuildProjections()
    expect(journal.runs().map((run) => [run.id, run.status])).toEqual([
      ['r2', 'running'],
      ['r1', 'done'],
    ])
  })

  it('reports the newest event id per run, and 0 for a run with none', () => {
    journal.createRun('r1', golden())
    journal.createRun('r2', golden())
    const last = journal.append({
      runId: 'r1',
      nodeId: 'p1',
      type: 'node_status',
      payload: { status: 'running' },
    })

    // The cursor is per run, so a busy neighbour never advances a quiet one.
    expect(journal.lastEventId('r1')).toBe(last)
    expect(journal.lastEventId('r1')).toBe(journal.events('r1').at(-1)?.id)
    expect(journal.lastEventId('r2')).toBeLessThan(last)
    expect(journal.events('r1', journal.lastEventId('r1'))).toEqual([])
    expect(journal.lastEventId('nothing-here')).toBe(0)
  })

  it('clears leases on open, because no process survives to hold one', () => {
    journal.acquireLease('test-suite', 'p1')
    expect(journal.leases()).toHaveLength(1)
    journal.close()

    journal = openJournal(projectDir)
    expect(journal.leases()).toEqual([])
  })

  it('appends and tails a transcript across a reopen', () => {
    journal.appendTranscript('r1', 'p1', { type: 'assistant_text', text: 'one' })
    journal.appendTranscript('r1', 'p1', { type: 'assistant_text', text: 'two' })
    journal.appendTranscript('r1', 'p1', { type: 'session_started' }, 'raw')
    journal.close()

    journal = openJournal(projectDir)
    journal.appendTranscript('r1', 'p1', { type: 'assistant_text', text: 'three' })

    expect(journal.tailTranscript('r1', 'p1')).toEqual([
      { type: 'assistant_text', text: 'one' },
      { type: 'assistant_text', text: 'two' },
      { type: 'assistant_text', text: 'three' },
    ])
    // The two streams are separate files, not one interleaved log.
    expect(journal.tailTranscript('r1', 'p1', 100, 'raw')).toEqual([{ type: 'session_started' }])
    expect(journal.tailTranscript('r1', 'p1', 2)).toEqual([
      { type: 'assistant_text', text: 'two' },
      { type: 'assistant_text', text: 'three' },
    ])
    expect(journal.tailTranscript('r1', 'nobody')).toEqual([])
  })

  it('tails the end of a file far larger than its read window', () => {
    for (let i = 0; i < 2000; i += 1) {
      journal.appendTranscript('r1', 'p1', { i, pad: 'x'.repeat(200) })
    }

    const tail = journal.tailTranscript('r1', 'p1', 3) as { i: number }[]
    expect(tail.map((entry) => entry.i)).toEqual([1997, 1998, 1999])
  })

  it('carries a human-gate question across a restart, without re-asking it', () => {
    journal.createRun('r1', golden())
    journal.append({
      runId: 'r1',
      nodeId: 'p1',
      type: 'human_question',
      payload: {
        effect_id: 'e-ask',
        question: 'The review found two migrations. Ship the branch?',
        kind: 'choice',
        choices: ['ship', 'hold'],
        context: { diffRef: 'phase/p1', gateLogRef: 'unit', transcriptCursor: 42 },
      },
    })
    journal.append({
      runId: 'r1',
      nodeId: 'p1',
      type: 'node_status',
      payload: { status: 'awaiting_human' },
    })

    const asked = journal.pendingQuestion('r1', 'p1')
    expect(asked).toMatchObject({
      runId: 'r1',
      nodeId: 'p1',
      effectId: 'e-ask',
      question: {
        question: 'The review found two migrations. Ship the branch?',
        kind: 'choice',
        choices: ['ship', 'hold'],
        context: { diffRef: 'phase/p1', gateLogRef: 'unit', transcriptCursor: 42 },
      },
    })

    // The restart: every scrap of in-memory state goes, and the projections
    // with it. What comes back must come back out of `events` alone.
    journal.close()
    journal = openJournal(projectDir)
    journal.rebuildProjections()

    expect(journal.pendingQuestion('r1', 'p1')).toEqual(asked)
    expect(journal.pendingQuestions('r1')).toEqual([asked])
    expect(journal.nodes('r1').find((row) => row.node_id === 'p1')?.status).toBe('awaiting_human')
    // Delivery is once per pause (§9.1): replaying the log re-derives the
    // question but does not append a second ask for anything to notify on.
    expect(journal.events('r1').filter((event) => event.type === 'human_question')).toHaveLength(1)
  })

  it('stops projecting a question once it is answered, or the node settles', () => {
    journal.createRun('r1', golden())
    const ask = (nodeId: string) =>
      journal.append({
        runId: 'r1',
        nodeId,
        type: 'human_question',
        payload: { effect_id: 'e-ask', question: 'Ship it?', kind: 'confirm' },
      })
    ask('p1')
    ask('p2')
    expect(journal.pendingQuestions('r1').map((q) => q.nodeId)).toEqual(['p1', 'p2'])

    journal.append({
      runId: 'r1',
      nodeId: 'p1',
      type: 'human_answered',
      payload: { effect_id: 'e-ask', answer: 'ship' },
    })
    // An abort ends the pause without answering it; the question goes too.
    journal.append({
      runId: 'r1',
      nodeId: 'p2',
      type: 'node_status',
      payload: { status: 'failed' },
    })

    const incremental = journal.pendingQuestions('r1')
    expect(incremental).toEqual([])

    journal.rebuildProjections()
    expect(journal.pendingQuestions('r1')).toEqual(incremental)
  })

  it('journals a steering operation with its text, projecting nothing', () => {
    journal.createRun('r1', golden())
    journal.append({
      runId: 'r1',
      nodeId: 'p1',
      type: 'node_operation',
      payload: { op: 'add_context', text: 'the other index is the fast one', delivery: 'sent' },
    })

    const before = journal.nodes('r1')
    journal.rebuildProjections()
    expect(journal.nodes('r1')).toEqual(before)
    expect(journal.events('r1').at(-1)).toMatchObject({
      type: 'node_operation',
      payload: { op: 'add_context', text: 'the other index is the fast one', delivery: 'sent' },
    })
  })

  /**
   * The gate lifecycle, round-tripped. Both variants are history rather than
   * state: `leases` is the *current* holder set and is cleared on open, so
   * folding these into it would resurrect capacity no live process holds —
   * and the rebuild below proves they change no projection at all.
   */
  it('round-trips the gate lifecycle without projecting it', () => {
    journal.createRun('r1', golden())
    journal.append({
      runId: 'r1',
      nodeId: 'p1',
      type: 'gate_pool',
      payload: { phase: 'requested', resources: ['test-suite'] },
    })
    journal.append({
      runId: 'r1',
      nodeId: 'p1',
      type: 'gate_pool',
      payload: { phase: 'granted', resources: ['test-suite'] },
    })
    journal.append({
      runId: 'r1',
      nodeId: 'p1',
      type: 'gate_result',
      payload: { gate: 'tests', exit_code: 1, status: 'failed' },
    })
    journal.append({
      runId: 'r1',
      nodeId: 'p1',
      type: 'gate_pool',
      payload: { phase: 'released', resources: ['test-suite'] },
    })

    const nodesBefore = journal.nodes('r1')
    const runBefore = journal.run('r1')
    const eventsBefore = journal.events('r1')

    journal.rebuildProjections()

    expect(journal.nodes('r1')).toEqual(nodesBefore)
    expect(journal.run('r1')).toEqual(runBefore)
    // The invariant: the events themselves are untouched by a rebuild, which
    // is what makes them the only durable truth here.
    expect(journal.events('r1')).toEqual(eventsBefore)
    expect(journal.events('r1').map((event) => event.type).slice(-4)).toEqual([
      'gate_pool',
      'gate_pool',
      'gate_result',
      'gate_pool',
    ])
    expect(journal.events('r1').at(-2)).toMatchObject({
      nodeId: 'p1',
      payload: { gate: 'tests', exit_code: 1, status: 'failed' },
    })
    // §5.3: identifiers, an exit code and a status. Whatever the gate printed
    // is in `gates/tests.log` and has no field here it could have reached.
    expect(Object.keys(journal.events('r1').at(-2)?.payload ?? {}).sort()).toEqual([
      'exit_code',
      'gate',
      'status',
    ])
  })

  it('reconstructs a consistent projection after the writer is SIGKILLed', async () => {
    journal.createRun('r1', golden())
    journal.close()

    const childPath = join(projectDir, 'crash-child.ts')
    writeFileSync(childPath, CRASH_CHILD)
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', childPath, projectDir, 'r1', 'p1'],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )

    // Kill only once the child has committed two batches, so the signal lands
    // in the middle of the append loop rather than before it starts.
    const killed = new Promise<number>((resolve, reject) => {
      let batches = 0
      let committed = 0
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        for (const line of chunk.split('\n').filter(Boolean)) {
          batches += 1
          committed = Number(line)
          if (batches >= 2) child.kill('SIGKILL')
        }
      })
      child.on('exit', (_code, signal) => {
        if (signal === 'SIGKILL') resolve(committed)
        else reject(new Error(`child exited without being killed (signal ${String(signal)})`))
      })
      child.on('error', reject)
    })
    const committed = await killed
    expect(committed).toBeGreaterThanOrEqual(50)

    journal = openJournal(projectDir)
    const events = journal.events('r1')
    const statusEvents = events.filter((e) => e.type === 'node_status')
    // Everything the child announced as committed survived the kill; whatever
    // it managed after that is a bonus, and nothing in between is torn.
    expect(statusEvents.length).toBeGreaterThanOrEqual(committed)
    expect(events.map((e) => e.id)).toEqual([...events.map((e) => e.id)].sort((a, b) => a - b))

    const survived = journal.nodes('r1')
    journal.rebuildProjections()
    // The projection the dead process left behind is exactly what its committed
    // events replay to: no event landed without its projection, or vice versa.
    expect(journal.nodes('r1')).toEqual(survived)
    expect(journal.run('r1')).toMatchObject({ id: 'r1', status: 'running' })

    const last = statusEvents.at(-1)
    expect(journal.nodes('r1').find((n) => n.node_id === 'p1')?.status).toBe(
      last?.type === 'node_status' ? last.payload.status : undefined,
    )
  })
})
