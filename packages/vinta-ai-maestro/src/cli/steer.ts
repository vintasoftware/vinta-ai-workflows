/**
 * Acting on a live run from a shell: `node`, `amend`, `workflow` and `exec`.
 *
 * The UI could steer a phase, amend a run and answer a question; a terminal
 * could only pause or stop the whole run. These are the same operations, over
 * the same API, for the two callers that have a shell and no browser: an
 * operator, and the run coordinator (`monitor/monitor.ts`), whose powers they
 * are.
 *
 * **Who is asking is decided by the token, not by this command.** Inside the
 * coordinator's session the environment carries the job's URL, the run id and
 * the coordinator's own token, and those are used when the run id matches; the
 * job then attributes the request to the coordinator and holds it to what the
 * coordinator may do. Anywhere else the run's `job.json` is read, as `pause`
 * and `stop` do, and the request is the operator's.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { liveJob } from '../job/job.ts'
import { openJournal } from '../journal/journal.ts'
import { shellQuote } from '../platform/platform.ts'
import { MAESTRO_RUN_ENV, MAESTRO_TOKEN_ENV, MAESTRO_URL_ENV } from '../resources/agent-leases.ts'
import { FAILED, OK, USAGE, type Io } from './io.ts'
import { storeFor } from './paths.ts'

export const NODE_USAGE = `usage: vinta-ai-maestro node <op> <runId> <phase> [text] [--repo <dir>]

  Acts on one phase of a live run, as the run view's buttons do.

  context  <runId> <phase> <text>         Tell the phase's agent something. It
                                          reaches a live session now, or the
                                          next turn on a harness that cannot
                                          take it mid-turn.
  redirect <runId> <phase> <instruction>  Interrupt the turn; resume with this.
  pause    <runId> <phase>                Stop after the current turn. On a
                                          phase waiting on a question, hold it:
                                          no --retry-after timer answers it.
  abort    <runId> <phase>                Kill it, fail it, block dependents.
  retry    <runId> <phase>                Run a failed phase again.
  answer   <runId> <phase> <choice>       Answer the question it is parked on.
           [--answers <json>]             An agent's questions take one JSON
                                          array of answers instead.

  Prints what the run did with it: sent, queued, held, delivered, or ignored
  when the phase had nothing for it to act on.

  --repo <dir>   The project. Defaults to the current directory.`

export const AMEND_USAGE = `usage: vinta-ai-maestro amend <runId> <workflow.json> [--repo <dir>]

  Applies an edited workflow to a live run (§9). Phases not yet started take
  it at once; finished phases whose base moved are rebased; a change that
  would move a phase still running is refused until it stops. Start from
  \`vinta-ai-maestro workflow <runId>\`, which prints the run's definition as
  it stands.

  --repo <dir>   The project. Defaults to the current directory.`

export const WORKFLOW_USAGE = `usage: vinta-ai-maestro workflow <runId> [--repo <dir>]

  Prints a run's workflow as it stands now — the snapshot it started with,
  with every amendment since applied — as JSON.

  --repo <dir>   The project. Defaults to the current directory.`

export const EXEC_USAGE = `usage: vinta-ai-maestro exec <runId> <lane|integration> [--repo <dir>] -- <command...>

  Runs one shell command in a live run's lane, or in its integration worktree,
  with that worktree's own environment: its database, compose project and
  ports — which a shell in the main checkout does not have. Prints what the
  command prints and exits with its exit code.

  In \`integration\` the command holds the integration worktree for as long as
  it runs: no wave merge, base preparation or retry checks a branch out
  underneath it. Lane names are in \`vinta-ai-maestro status <runId>\`.

  --repo <dir>   The project. Defaults to the current directory.`

const NODE_OPS = {
  context: { path: 'context', field: 'text' },
  redirect: { path: 'redirect', field: 'instruction' },
  pause: { path: 'pause', field: null },
  abort: { path: 'abort', field: null },
  retry: { path: 'retry', field: null },
  answer: { path: 'answer', field: 'answer' },
} as const

type NodeOp = keyof typeof NODE_OPS

export interface SteerDeps {
  readonly fetch?: typeof fetch
  readonly env?: NodeJS.ProcessEnv
}

interface Reach {
  readonly url: string
  readonly token: string
}

/** The run's API: the coordinator's own when this is its session, the job's otherwise. */
function reach(repoPath: string, runId: string, env: NodeJS.ProcessEnv): Reach | null {
  const url = env[MAESTRO_URL_ENV]
  const token = env[MAESTRO_TOKEN_ENV]
  if (url !== undefined && token !== undefined && env[MAESTRO_RUN_ENV] === runId) return { url, token }
  if (!existsSync(storeFor(repoPath))) return null
  const job = liveJob(repoPath, runId)
  return job === null ? null : { url: job.url, token: job.token }
}

async function post(
  target: Reach,
  path: string,
  body: string,
  fetchImpl: typeof fetch,
): Promise<{ readonly status: number; readonly body: unknown } | null> {
  try {
    const response = await fetchImpl(`${target.url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json' },
      body,
    })
    return { status: response.status, body: await response.json().catch(() => null) }
  } catch {
    return null
  }
}

/** A refusal as the operator reads it: the code, then each located issue. */
function refused(io: Io, status: number, body: unknown): number {
  const error = body as { error?: string; issues?: { path?: string; message?: string }[] | null } | null
  io.err(`vinta-ai-maestro: refused (${status} ${error?.error ?? 'error'})`)
  for (const issue of error?.issues ?? []) {
    io.err(`  ${issue.path === undefined || issue.path === '' ? '' : `${issue.path}: `}${issue.message ?? ''}`)
  }
  return FAILED
}

function notLive(io: Io, runId: string): number {
  io.err(`vinta-ai-maestro: run ${runId} is not live — nothing is hosting it to act on.`)
  return FAILED
}

export async function nodeCommand(argv: readonly string[], io: Io, deps: SteerDeps = {}): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { repo: { type: 'string' }, answers: { type: 'string' } },
      allowPositionals: true,
    })
  } catch {
    io.err(NODE_USAGE)
    return USAGE
  }
  const [op, runId, nodeId, ...rest] = parsed.positionals
  if (op === undefined || !(op in NODE_OPS) || runId === undefined || nodeId === undefined) {
    io.err(NODE_USAGE)
    return USAGE
  }
  const spec = NODE_OPS[op as NodeOp]
  let body: Record<string, unknown> = {}
  if (op === 'answer' && parsed.values.answers !== undefined) {
    try {
      body = { answers: JSON.parse(parsed.values.answers) as unknown }
    } catch {
      io.err('vinta-ai-maestro: --answers is not valid JSON')
      return USAGE
    }
  } else if (spec.field !== null) {
    const text = rest.join(' ')
    if (text.trim() === '') {
      io.err(NODE_USAGE)
      return USAGE
    }
    body = { [spec.field]: op === 'answer' ? answerOf(text) : text }
  } else if (rest.length > 0) {
    io.err(NODE_USAGE)
    return USAGE
  }

  const repoPath = resolve(parsed.values.repo ?? process.cwd())
  const target = reach(repoPath, runId, deps.env ?? process.env)
  if (target === null) return notLive(io, runId)
  const path = `/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/${spec.path}`
  const answered = await post(target, path, JSON.stringify(body), deps.fetch ?? fetch)
  if (answered === null) return notLive(io, runId)
  if (answered.status >= 400) return refused(io, answered.status, answered.body)
  const delivery = (answered.body as { delivery?: string } | null)?.delivery
  io.out(`${op} ${nodeId}: ${delivery ?? 'ok'}`)
  return delivery === 'ignored' ? FAILED : OK
}

/** `true`/`false` for a yes-or-no question; the text itself for a choice. */
function answerOf(text: string): string | boolean {
  if (text === 'true') return true
  if (text === 'false') return false
  return text
}

export async function amendCommand(argv: readonly string[], io: Io, deps: SteerDeps = {}): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({ args: [...argv], options: { repo: { type: 'string' } }, allowPositionals: true })
  } catch {
    io.err(AMEND_USAGE)
    return USAGE
  }
  const [runId, file] = parsed.positionals
  if (runId === undefined || file === undefined || parsed.positionals.length > 2) {
    io.err(AMEND_USAGE)
    return USAGE
  }
  let text: string
  try {
    text = readFileSync(resolve(file), 'utf8')
  } catch {
    io.err(`vinta-ai-maestro: cannot read ${file}`)
    return FAILED
  }
  const repoPath = resolve(parsed.values.repo ?? process.cwd())
  const target = reach(repoPath, runId, deps.env ?? process.env)
  if (target === null) return notLive(io, runId)
  const answered = await post(target, `/api/runs/${encodeURIComponent(runId)}/amend`, text, deps.fetch ?? fetch)
  if (answered === null) return notLive(io, runId)
  if (answered.status >= 400) return refused(io, answered.status, answered.body)
  const result = answered.body as {
    amendment?: number
    changes?: { node: string; kind: string }[]
    applied?: string[]
    rebased?: string[]
  }
  io.out(`amendment ${result.amendment ?? '?'} applied to run ${runId}`)
  for (const change of result.changes ?? []) io.out(`  ${change.node}: ${change.kind.replaceAll('_', ' ')}`)
  if ((result.rebased ?? []).length > 0) io.out(`  rebased: ${(result.rebased ?? []).join(', ')}`)
  return OK
}

export async function workflowCommand(argv: readonly string[], io: Io): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({ args: [...argv], options: { repo: { type: 'string' } }, allowPositionals: true })
  } catch {
    io.err(WORKFLOW_USAGE)
    return USAGE
  }
  const [runId] = parsed.positionals
  if (runId === undefined || parsed.positionals.length > 1) {
    io.err(WORKFLOW_USAGE)
    return USAGE
  }
  const repoPath = resolve(parsed.values.repo ?? process.cwd())
  if (!existsSync(storeFor(repoPath))) {
    io.err(`vinta-ai-maestro: no run "${runId}" in ${repoPath}`)
    return FAILED
  }
  const journal = openJournal(repoPath)
  try {
    if (journal.run(runId) === undefined) {
      io.err(`vinta-ai-maestro: no run "${runId}" in ${repoPath}`)
      return FAILED
    }
    io.out(JSON.stringify(journal.readWorkflow(runId), null, 2))
    return OK
  } finally {
    journal.close()
  }
}

export async function execCommand(argv: readonly string[], io: Io, deps: SteerDeps = {}): Promise<number> {
  const split = argv.indexOf('--')
  if (split === -1) {
    io.err(EXEC_USAGE)
    return USAGE
  }
  let parsed
  try {
    parsed = parseArgs({ args: argv.slice(0, split), options: { repo: { type: 'string' } }, allowPositionals: true })
  } catch {
    io.err(EXEC_USAGE)
    return USAGE
  }
  const [runId, where] = parsed.positionals
  const words = argv.slice(split + 1)
  if (runId === undefined || where === undefined || parsed.positionals.length > 2 || words.length === 0) {
    io.err(EXEC_USAGE)
    return USAGE
  }
  // One word is a shell line as written; several are argv, quoted for the
  // job's shell so they arrive as they were typed.
  const command = words.length === 1 ? (words[0] as string) : words.map((word) => shellQuote(word)).join(' ')

  const repoPath = resolve(parsed.values.repo ?? process.cwd())
  const target = reach(repoPath, runId, deps.env ?? process.env)
  if (target === null) return notLive(io, runId)
  let response: Response
  try {
    response = await (deps.fetch ?? fetch)(`${target.url}/api/runs/${encodeURIComponent(runId)}/exec`, {
      method: 'POST',
      headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ target: where, command }),
    })
  } catch {
    return notLive(io, runId)
  }
  if (response.status >= 400) return refused(io, response.status, await response.json().catch(() => null))
  if (response.body === null) return FAILED

  let exit = FAILED
  let printed = ''
  let pending = ''
  const decoder = new TextDecoder()
  const emit = (text: string): void => {
    printed += text
    const lines = printed.split('\n')
    printed = lines.pop() ?? ''
    for (const line of lines) io.out(line)
  }
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true })
    const frames = pending.split('\n')
    pending = frames.pop() ?? ''
    for (const frame of frames) {
      if (frame.trim() === '') continue
      const parsedFrame = JSON.parse(frame) as { output?: string; exit?: number }
      if (typeof parsedFrame.output === 'string') emit(parsedFrame.output)
      if (typeof parsedFrame.exit === 'number') exit = parsedFrame.exit
    }
  }
  if (printed !== '') io.out(printed)
  return exit
}
