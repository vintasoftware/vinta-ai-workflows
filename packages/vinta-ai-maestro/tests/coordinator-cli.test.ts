/**
 * `node`, `amend`, `workflow` and `exec`: steering a live run from a shell.
 *
 * Each command is invoked as a function with an injected `Io` and, where it
 * talks to a run, an injected `fetch` — what is under test is the request a
 * command builds and how it reads the answer, not a daemon (that is
 * `coordinator-api.test.ts`). The environment is injected too: inside the
 * coordinator's session the run is reached through `VINTA_AI_MAESTRO_*`, and a
 * test that read the real `process.env` would depend on where it was run.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { main } from '../src/cli/index.ts'
import { FAILED, OK, USAGE, type Io } from '../src/cli/io.ts'
import {
  amendCommand,
  execCommand,
  fixerCommand,
  gateCacheCommand,
  nodeCommand,
  switchHarnessCommand,
  workflowCommand,
} from '../src/cli/steer.ts'
import { REASON_HEADER } from '../src/daemon/schemas.ts'
import { openJournal } from '../src/journal/journal.ts'
import { shellQuote } from '../src/platform/platform.ts'
import { MAESTRO_RUN_ENV, MAESTRO_TOKEN_ENV, MAESTRO_URL_ENV } from '../src/resources/agent-leases.ts'
import { WorkflowSchema, type Workflow } from '../src/types.ts'

const RUN_ID = 'run-1'
const URL = 'http://127.0.0.1:4999'
const TOKEN = 'coordinator-token'
const ENV = { [MAESTRO_URL_ENV]: URL, [MAESTRO_TOKEN_ENV]: TOKEN, [MAESTRO_RUN_ENV]: RUN_ID }

const cleanups: (() => void)[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

/** A directory with no `.vinta-ai-maestro` in it: no job, so only the env can reach a run. */
function emptyRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-steer-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

interface Recorder {
  readonly io: Io
  readonly out: string[]
  readonly err: string[]
}

const recorder = (): Recorder => {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      confirm: async () => false,
    },
  }
}

interface Sent {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string
}

/** A `fetch` that answers every request with `answer` and keeps what it was sent. */
function fakeFetch(answer: () => Response): { readonly fetch: typeof fetch; readonly sent: Sent[] } {
  const sent: Sent[] = []
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    sent.push({
      url: String(input),
      headers: { ...(init?.headers as Record<string, string>) },
      body: String(init?.body ?? ''),
    })
    return answer()
  }
  return { fetch: impl as typeof fetch, sent }
}

const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// ---------------------------------------------------------------------------
// node
// ---------------------------------------------------------------------------

describe('node', () => {
  /**
   * Inside the coordinator's session the env names the run, and its token is
   * what makes the job attribute the request to the coordinator — so the token
   * sent has to be the env's, not one read from a job file.
   */
  it('posts context to the run the env names, with the env’s token', async () => {
    const r = recorder()
    const f = fakeFetch(json({ ok: true, delivery: 'queued' }))

    const code = await nodeCommand(['context', RUN_ID, 'p1', 'hello', 'there', '--repo', emptyRepo()], r.io, {
      env: ENV,
      fetch: f.fetch,
    })

    expect(code).toBe(OK)
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]?.url).toBe(`${URL}/api/runs/${RUN_ID}/nodes/p1/context`)
    expect(f.sent[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(f.sent[0]?.body ?? '')).toEqual({ text: 'hello there' })
    expect(r.out).toEqual(['context p1: queued'])
  })

  it('posts fresh with no body, and prints that it is queued for the next turn', async () => {
    const r = recorder()
    const f = fakeFetch(json({ ok: true, delivery: 'queued' }))
    const code = await nodeCommand(['fresh', RUN_ID, 'p1', '--repo', emptyRepo()], r.io, { env: ENV, fetch: f.fetch })
    expect(code).toBe(OK)
    expect(f.sent[0]?.url).toBe(`${URL}/api/runs/${RUN_ID}/nodes/p1/fresh`)
    expect(JSON.parse(f.sent[0]?.body ?? '')).toEqual({})
    expect(r.out).toEqual(['fresh p1: queued'])
  })

  /** Why travels in a header, so it reads the same on every verb — an amendment included. */
  it('sends --reason in the reason header, URI-encoded', async () => {
    const f = fakeFetch(json({ ok: true, delivery: 'sent' }))
    const code = await nodeCommand(
      ['interrupt', RUN_ID, 'p1', '--reason', 'p1 is looping — same test, 4 times', '--repo', emptyRepo()],
      recorder().io,
      { env: ENV, fetch: f.fetch },
    )
    expect(code).toBe(OK)
    expect(f.sent[0]?.url).toBe(`${URL}/api/runs/${RUN_ID}/nodes/p1/interrupt`)
    expect(decodeURIComponent(f.sent[0]?.headers[REASON_HEADER] ?? '')).toBe('p1 is looping — same test, 4 times')
  })

  it('posts a reassignment from its flags, now unless --after-turn', async () => {
    const f = fakeFetch(json({ ok: true, delivery: 'queued' }))
    const repo = emptyRepo()
    const deps = { env: ENV, fetch: f.fetch }
    expect(await nodeCommand(['reassign', RUN_ID, 'p1', '--crew', 'senior', '--repo', repo], recorder().io, deps)).toBe(OK)
    expect(
      await nodeCommand(
        ['reassign', RUN_ID, 'p1', '--harness', 'codex', '--model', 'gpt-5', '--after-turn', '--repo', repo],
        recorder().io,
        deps,
      ),
    ).toBe(OK)
    expect(f.sent.map((sent) => JSON.parse(sent.body))).toEqual([
      { crew: 'senior', when: 'now' },
      { harness: 'codex', model: 'gpt-5', when: 'after_turn' },
    ])
    // Reassign with nothing to reassign to, and its flags on another verb, are usage errors.
    expect(await nodeCommand(['reassign', RUN_ID, 'p1', '--repo', repo], recorder().io, deps)).toBe(USAGE)
    expect(await nodeCommand(['pause', RUN_ID, 'p1', '--crew', 'x', '--repo', repo], recorder().io, deps)).toBe(USAGE)
  })

  it('posts a step with the state to move to', async () => {
    const f = fakeFetch(json({ ok: true, delivery: 'delivered' }))
    const code = await nodeCommand(['step', RUN_ID, 'p1', 'verify', '--repo', emptyRepo()], recorder().io, {
      env: ENV,
      fetch: f.fetch,
    })
    expect(code).toBe(OK)
    expect(JSON.parse(f.sent[0]?.body ?? '')).toEqual({ to: 'verify' })
  })

  /** An operation that did nothing must not exit 0: a script would read it as done. */
  it('exits 1 when the run ignored the operation', async () => {
    const r = recorder()
    const f = fakeFetch(json({ ok: true, delivery: 'ignored' }))
    const code = await nodeCommand(['pause', RUN_ID, 'p1', '--repo', emptyRepo()], r.io, { env: ENV, fetch: f.fetch })
    expect(code).toBe(FAILED)
    expect(r.out).toEqual(['pause p1: ignored'])
  })

  /** A confirm question is answered with a boolean on the wire, so `true` cannot arrive as the string "true". */
  it('sends an answer as text, and true/false as booleans', async () => {
    const repo = emptyRepo()
    const sent: unknown[] = []
    for (const word of ['retry', 'true', 'false']) {
      const f = fakeFetch(json({ ok: true }))
      expect(await nodeCommand(['answer', RUN_ID, 'p1', word, '--repo', repo], recorder().io, { env: ENV, fetch: f.fetch })).toBe(OK)
      expect(f.sent[0]?.url).toBe(`${URL}/api/runs/${RUN_ID}/nodes/p1/answer`)
      sent.push(JSON.parse(f.sent[0]?.body ?? ''))
    }
    expect(sent).toEqual([{ answer: 'retry' }, { answer: true }, { answer: false }])
  })

  /** An agent's questions take an array of answers, which no positional word can express. */
  it('sends --answers as the answers array', async () => {
    const r = recorder()
    const f = fakeFetch(json({ ok: true }))
    const answers = [{ choice: 0 }, { other: 'use sqlite' }]
    const code = await nodeCommand(
      ['answer', RUN_ID, 'p1', '--answers', JSON.stringify(answers), '--repo', emptyRepo()],
      r.io,
      { env: ENV, fetch: f.fetch },
    )
    expect(code).toBe(OK)
    expect(JSON.parse(f.sent[0]?.body ?? '')).toEqual({ answers })
  })

  /** The coordinator reads the code to know to stop asking, so it is printed rather than swallowed. */
  it('prints a refusal’s code and exits 1', async () => {
    const r = recorder()
    const f = fakeFetch(json({ error: 'coordinator_forbidden', issues: null }, 403))
    const code = await nodeCommand(['answer', RUN_ID, 'p1', 'retry', '--repo', emptyRepo()], r.io, {
      env: ENV,
      fetch: f.fetch,
    })
    expect(code).toBe(FAILED)
    expect(r.err.join('\n')).toContain('coordinator_forbidden')
    expect(r.out).toEqual([])
  })

  /**
   * The env names a different run, and nothing hosts this one: the command
   * must not borrow another run's credentials, and says the run is not live.
   */
  it('says the run is not live when neither the env nor a job reaches it', async () => {
    const r = recorder()
    const f = fakeFetch(json({ ok: true }))
    const code = await nodeCommand(['context', 'run-2', 'p1', 'hello', '--repo', emptyRepo()], r.io, {
      env: ENV,
      fetch: f.fetch,
    })
    expect(code).toBe(FAILED)
    expect(f.sent).toEqual([])
    expect(r.err.join('\n')).toContain('is not live')
  })
})

// ---------------------------------------------------------------------------
// amend
// ---------------------------------------------------------------------------

describe('switch-harness and fixer', () => {
  it('moves the run off a harness and prints the phases it moved', async () => {
    const r = recorder()
    const f = fakeFetch(json({ ok: true, moved: ['p1', 'p2'] }))
    const code = await switchHarnessCommand(
      [RUN_ID, '--from', 'codex', '--to', 'claude-code', '--model', 'opus', '--reason', 'out of credits', '--repo', emptyRepo()],
      r.io,
      { env: ENV, fetch: f.fetch },
    )
    expect(code).toBe(OK)
    expect(f.sent[0]?.url).toBe(`${URL}/api/runs/${RUN_ID}/switch-harness`)
    expect(JSON.parse(f.sent[0]?.body ?? '')).toEqual({ from: 'codex', to: 'claude-code', model: 'opus', when: 'now' })
    expect(r.out).toEqual([`run ${RUN_ID}: codex → claude-code (opus); moved p1, p2`])
    expect(await switchHarnessCommand([RUN_ID, '--from', 'codex'], recorder().io, { env: ENV, fetch: f.fetch })).toBe(USAGE)
  })

  it('ends or re-staffs the fixer’s round', async () => {
    const f = fakeFetch(json({ ok: true, ended: true }))
    const repo = emptyRepo()
    const deps = { env: ENV, fetch: f.fetch }
    expect(await fixerCommand(['interrupt', RUN_ID, '--repo', repo], recorder().io, deps)).toBe(OK)
    expect(
      await fixerCommand(['reassign', RUN_ID, '--harness', 'claude-code', '--model', 'opus', '--after-round', '--repo', repo], recorder().io, deps),
    ).toBe(OK)
    expect(f.sent.map((sent) => [sent.url.replace(URL, ''), JSON.parse(sent.body)])).toEqual([
      [`/api/runs/${RUN_ID}/fixer/interrupt`, {}],
      [`/api/runs/${RUN_ID}/fixer/reassign`, { harness: 'claude-code', model: 'opus', now: false }],
    ])
    expect(await fixerCommand(['reassign', RUN_ID, '--harness', 'codex', '--repo', repo], recorder().io, deps)).toBe(USAGE)
  })
})

describe('amend', () => {
  function proposalFile(contents: string): string {
    const path = join(emptyRepo(), 'proposal.workflow.json')
    writeFileSync(path, contents, 'utf8')
    return path
  }

  /** The file goes over as written: the job parses and validates it, and the CLI has no second opinion. */
  it('posts the file and prints what changed', async () => {
    const r = recorder()
    const contents = '{"id": "flow", "nodes": []}'
    const f = fakeFetch(
      json({
        ok: true,
        amendment: 2,
        runId: RUN_ID,
        changes: [{ node: 'b', kind: 'body_changed' }],
        affected: ['b'],
        applied: ['b'],
        rebased: ['a'],
      }),
    )

    const code = await amendCommand([RUN_ID, proposalFile(contents), '--repo', emptyRepo()], r.io, {
      env: ENV,
      fetch: f.fetch,
    })

    expect(code).toBe(OK)
    expect(f.sent[0]?.url).toBe(`${URL}/api/runs/${RUN_ID}/amend`)
    expect(f.sent[0]?.body).toBe(contents)
    expect(r.out).toEqual([
      `amendment 2 applied to run ${RUN_ID}`,
      '  b: body changed',
      '  takes effect now on: b',
      '  rebased: a',
    ])
  })

  /** "gates changed" for a running phase read as if its current gate step had the change. */
  it('says which affected phases take the change only once they stop', async () => {
    const r = recorder()
    const f = fakeFetch(
      json({
        ok: true,
        amendment: 3,
        runId: RUN_ID,
        changes: [{ node: 'p0b', kind: 'gates_changed' }],
        affected: ['p0b'],
        applied: [],
        rebased: [],
        waiting: [{ node: 'p0b', status: 'running' }],
      }),
    )
    expect(await amendCommand([RUN_ID, proposalFile('{}'), '--repo', emptyRepo()], r.io, { env: ENV, fetch: f.fetch })).toBe(OK)
    expect(r.out).toContain('  p0b is running: it takes the change only once it stops — at its next attempt or step')
  })

  /** A refusal is only useful if it says where, so each located issue gets its own line. */
  it('prints each located issue of a refusal', async () => {
    const r = recorder()
    const f = fakeFetch(
      json(
        {
          error: 'coordinator_forbidden',
          issues: [
            { path: 'nodes.c', code: 'coordinator_forbidden', message: 'node added on c changes what the plan builds' },
            { path: 'nodes.b.gates', code: 'coordinator_forbidden', message: 'b may not lose gate "unit"' },
          ],
        },
        409,
      ),
    )

    const code = await amendCommand([RUN_ID, proposalFile('{}'), '--repo', emptyRepo()], r.io, {
      env: ENV,
      fetch: f.fetch,
    })

    expect(code).toBe(FAILED)
    expect(r.err).toEqual([
      'vinta-ai-maestro: refused (409 coordinator_forbidden)',
      '  nodes.c: node added on c changes what the plan builds',
      '  nodes.b.gates: b may not lose gate "unit"',
    ])
  })
})

// ---------------------------------------------------------------------------
// workflow
// ---------------------------------------------------------------------------

describe('workflow', () => {
  /** `amend` starts from this output, so it must be the run's definition as it stands, not the plan file's. */
  it('prints the run’s workflow from the journal', async () => {
    const repo = emptyRepo()
    const workflow: Workflow = WorkflowSchema.parse({
      schema_version: 1,
      id: 'steer-flow',
      base_branch: 'main',
      defaults: { harness: 'claude-code', model: 'opus', pipeline: 'solo' },
      resources: { lane: { capacity: 1, kind: 'worktree' } },
      gates: { unit: { cmd: 'true' } },
      nodes: [{ id: 'a', name: 'A', prompt_ref: 'plan.md#a', gates: ['unit'] }],
      pipelines: {
        solo: {
          states: [
            { id: 'work', name: 'Work', position: { x: 0, y: 0 } },
            { id: 'done', name: 'Done', position: { x: 200, y: 0 }, data: { outcome: 'done' } },
          ],
          transitions: [{ id: 't', from: 'work', to: 'done' }],
          initialStateIds: ['work'],
          finalStateIds: ['done'],
        },
      },
    })
    const journal = openJournal(repo)
    journal.createRun(RUN_ID, workflow)
    const expected = journal.readWorkflow(RUN_ID)
    journal.close()

    const r = recorder()
    const code = await workflowCommand([RUN_ID, '--repo', repo], r.io)

    expect(code).toBe(OK)
    expect(JSON.parse(r.out.join('\n'))).toEqual(expected)
  })

  it('fails for a run the journal does not have', async () => {
    const r = recorder()
    expect(await workflowCommand(['nope', '--repo', emptyRepo()], r.io)).toBe(FAILED)
    expect(r.err.join('\n')).toContain('no run "nope"')
  })
})

// ---------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------

describe('exec', () => {
  /** An NDJSON answer delivered in exactly these byte chunks, however they split. */
  function streamed(chunks: readonly string[]): () => Response {
    return () => {
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
          controller.close()
        },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
    }
  }

  /**
   * Several words are argv, quoted for the job's shell, so `'a b'` arrives as
   * one argument. Output is printed by line, whatever the transport did to
   * the frames — split mid-frame, and a line split across two frames — and
   * the command's own exit code is the CLI's.
   */
  it('sends argv shell-quoted, prints output line by line, and exits with the command’s code', async () => {
    const r = recorder()
    const f = fakeFetch(
      streamed(['{"output":"one\\ntw"}\n{"out', 'put":"o\\nthr"}\n', '{"output":"ee"}\n{"exi', 't":4}\n']),
    )

    const code = await execCommand([RUN_ID, 'integration', '--repo', emptyRepo(), '--', 'echo', 'a b'], r.io, {
      env: ENV,
      fetch: f.fetch,
    })

    expect(code).toBe(4)
    expect(f.sent[0]?.url).toBe(`${URL}/api/runs/${RUN_ID}/exec`)
    expect(f.sent[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(f.sent[0]?.body ?? '')).toEqual({
      target: 'integration',
      command: `${shellQuote('echo')} ${shellQuote('a b')}`,
    })
    expect(r.out).toEqual(['one', 'two', 'three'])
  })

  /**
   * `exec --reason` was a usage error, so the coordinator's commands reached
   * the journal with no reason; and a command queued behind the integration
   * worktree printed nothing at all while it waited.
   */
  it('sends --reason, and says who it is queued behind while it waits', async () => {
    const r = recorder()
    const f = fakeFetch(streamed(['{"accepted":"ab12"}\n{"queued":"p6"}\n{"running":true}\n{"exit":0}\n']))
    const code = await execCommand(
      [RUN_ID, 'integration', '--reason', 'reset the test db', '--repo', emptyRepo(), '--', 'make test_reset'],
      r.io,
      { env: ENV, fetch: f.fetch },
    )
    expect(code).toBe(0)
    expect(decodeURIComponent(f.sent[0]?.headers[REASON_HEADER] ?? '')).toBe('reset the test db')
    expect(r.err.join('\n')).toContain('exec ab12 queued behind p6')
  })

  /** A stream that ends without an exit frame is a dropped connection, not a dead run. */
  it('says the connection was lost, not that the run is not live, when the stream ends early', async () => {
    const r = recorder()
    const f = fakeFetch(streamed(['{"accepted":"ab12"}\n']))
    const code = await execCommand([RUN_ID, 'lane-1', '--repo', emptyRepo(), '--', 'true'], r.io, {
      env: ENV,
      fetch: f.fetch,
    })
    expect(code).toBe(FAILED)
    expect(r.err.join('\n')).toContain('lost the connection')
    expect(r.err.join('\n')).not.toContain('not live')
  })

  it('detaches, lists and cancels', async () => {
    const detached = recorder()
    const started = fakeFetch(json({ id: 'ab12', target: 'integration', log: '/runs/r/execs/ab12.log' }, 202))
    expect(
      await execCommand([RUN_ID, 'integration', '--detach', '--repo', emptyRepo(), '--', 'make test'], detached.io, {
        env: ENV,
        fetch: started.fetch,
      }),
    ).toBe(OK)
    expect(JSON.parse(started.sent[0]?.body ?? '')).toMatchObject({ detach: true })
    expect(detached.out[0]).toContain('exec ab12 started, detached')

    const listed = recorder()
    const list = fakeFetch(
      json({ execs: [{ id: 'ab12', target: 'integration', by: 'coordinator', state: 'queued', startedAt: Date.now() }] }),
    )
    expect(await execCommand(['list', RUN_ID, '--repo', emptyRepo()], listed.io, { env: ENV, fetch: list.fetch })).toBe(OK)
    expect(list.sent[0]?.url).toBe(`${URL}/api/runs/${RUN_ID}/exec`)
    expect(listed.out[0]).toMatch(/^ab12 +queued +integration +by coordinator/)

    const cancelled = recorder()
    const cancel = fakeFetch(json({ id: 'ab12', cancelled: true, was: 'queued' }))
    expect(
      await execCommand(['cancel', RUN_ID, 'ab12', '--repo', emptyRepo()], cancelled.io, { env: ENV, fetch: cancel.fetch }),
    ).toBe(OK)
    expect(cancel.sent[0]?.url).toBe(`${URL}/api/runs/${RUN_ID}/exec/ab12`)
    expect(cancelled.out[0]).toBe('exec ab12 cancelled (it was queued)')
  })

  /** One word is a shell line as written, so a pipeline typed in quotes still runs as a pipeline. */
  it('sends a single word unquoted', async () => {
    const f = fakeFetch(streamed(['{"exit":0}\n']))
    const code = await execCommand([RUN_ID, 'lane-1', '--repo', emptyRepo(), '--', 'pytest -x | tail'], recorder().io, {
      env: ENV,
      fetch: f.fetch,
    })
    expect(code).toBe(0)
    expect(JSON.parse(f.sent[0]?.body ?? '')).toEqual({ target: 'lane-1', command: 'pytest -x | tail' })
  })

  /** Without `--` there is no telling the command from exec's own options. */
  it('is a usage error without --', async () => {
    const r = recorder()
    const f = fakeFetch(json({}))
    expect(await execCommand([RUN_ID, 'lane-1', 'echo', 'hi'], r.io, { env: ENV, fetch: f.fetch })).toBe(USAGE)
    expect(r.err.join('\n')).toContain('usage: vinta-ai-maestro exec')
    expect(f.sent).toEqual([])
  })

  /**
   * `--help` after `--` is the command's, not exec's: answering it with exec's
   * usage would make `exec … -- pytest --help` impossible. With nothing
   * hosting the run, reaching the request means "not live".
   */
  it('leaves a --help after -- to the command', async () => {
    // `main` reads the real environment; a suite run inside a coordinator
    // session must not reach that session's run.
    for (const name of [MAESTRO_URL_ENV, MAESTRO_TOKEN_ENV, MAESTRO_RUN_ENV]) vi.stubEnv(name, undefined)
    const r = recorder()
    const code = await main(['exec', RUN_ID, 'lane-1', '--repo', emptyRepo(), '--', 'pytest', '--help'], r.io)
    expect(code).toBe(FAILED)
    expect(r.out.join('\n')).not.toContain('usage: vinta-ai-maestro exec')
    expect(r.err.join('\n')).toContain('is not live')
  })
})

describe('gate-cache', () => {
  it('asks the run to forget one gate’s results, on every tree by default', async () => {
    const r = recorder()
    const f = fakeFetch(json({ gate: 'unit', removed: 3 }))

    const code = await gateCacheCommand(['invalidate', RUN_ID, 'unit', '--repo', emptyRepo()], r.io, {
      env: ENV,
      fetch: f.fetch,
    })

    expect(code).toBe(OK)
    expect(f.sent[0]?.url).toBe(`${URL}/api/runs/${RUN_ID}/gates/unit/invalidate`)
    expect(f.sent[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(f.sent[0]?.body ?? '')).toEqual({})
    expect(r.out).toEqual(['gate unit: 3 cached results forgotten'])
  })

  it('narrows to one tree with --tree', async () => {
    const r = recorder()
    const f = fakeFetch(json({ gate: 'unit', removed: 1 }))
    const tree = 'b'.repeat(40)

    const code = await gateCacheCommand(['invalidate', RUN_ID, 'unit', '--tree', tree, '--repo', emptyRepo()], r.io, {
      env: ENV,
      fetch: f.fetch,
    })

    expect(code).toBe(OK)
    expect(JSON.parse(f.sent[0]?.body ?? '')).toEqual({ tree })
    expect(r.out).toEqual(['gate unit: 1 cached result forgotten'])
  })

  it('asks for fresh databases with --databases, and says when the gate has no fresh form', async () => {
    const r = recorder()
    const f = fakeFetch(json({ gate: 'unit', removed: 0, databases: true }))
    expect(await gateCacheCommand(['invalidate', RUN_ID, 'unit', '--databases', '--repo', emptyRepo()], r.io, { env: ENV, fetch: f.fetch })).toBe(OK)
    expect(JSON.parse(f.sent[0]?.body ?? '')).toEqual({ databases: true })
    expect(r.out).toContain('gate unit: its next run in the integration worktree starts from fresh state')

    const plain = recorder()
    const g = fakeFetch(json({ gate: 'lint', removed: 0, databases: false }))
    await gateCacheCommand(['invalidate', RUN_ID, 'lint', '--databases', '--repo', emptyRepo()], plain.io, { env: ENV, fetch: g.fetch })
    expect(plain.err.join('\n')).toContain('declares no fresh_cmd')
  })

  it('is a usage error without the verb, and is reachable from main', async () => {
    const r = recorder()
    expect(await gateCacheCommand([RUN_ID, 'unit'], r.io, { env: ENV })).toBe(USAGE)

    const help = recorder()
    expect(await main(['gate-cache', '--help'], help.io)).toBe(OK)
    expect(help.out.join('\n')).toContain('gate-cache invalidate')
  })
})
