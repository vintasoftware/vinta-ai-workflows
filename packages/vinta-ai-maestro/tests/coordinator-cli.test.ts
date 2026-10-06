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
import { amendCommand, execCommand, nodeCommand, workflowCommand } from '../src/cli/steer.ts'
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
    expect(r.out).toEqual([`amendment 2 applied to run ${RUN_ID}`, '  b: body changed', '  rebased: a'])
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
