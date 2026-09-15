/** `vinta-ai-maestro with <resource> -- <cmd>` — an agent-held pool lease. */
import { spawn } from 'node:child_process'
import { AgentLeaseGrantSchema } from '../daemon/schemas.ts'
import { killTree, ownProcessGroup, shellInvocation, spawnOptionsFor } from '../platform/platform.ts'
import {
  MAESTRO_NODE_ENV,
  MAESTRO_RUN_ENV,
  MAESTRO_TOKEN_ENV,
  MAESTRO_URL_ENV,
} from '../resources/agent-leases.ts'
import { FAILED, USAGE, type Io } from './io.ts'

export const WITH_USAGE = `usage: vinta-ai-maestro with <resource> -- <cmd>

  Waits — for as long as it takes — until the running daemon grants
  <resource>, then runs <cmd> and releases the lease on exit. A resource held
  by another lane is not an error: this reports that it is waiting and keeps
  waiting. Long commands renew their lease automatically. This verb is intended
  for agent turns started by \`vinta-ai-maestro run\`; the daemon connection and
  current phase are supplied through that turn's environment.

  If it does fail, the command is not run. Report the failure rather than
  running <cmd> unleased.

  Quote <cmd> as one argument when it contains shell operators or significant
  whitespace.`

export interface WithDeps {
  readonly fetch?: typeof fetch
  readonly run?: (command: string, signal: AbortSignal) => Promise<number>
  /**
   * How the wait pauses between attempts. Injected so a test of the *loop* does
   * not pay for the politeness — real sleeping is the slowest thing about it,
   * and a test that spends a second and a half asleep is a test that eventually
   * flakes on a loaded machine for reasons that have nothing to do with it.
   */
  readonly sleep?: (ms: number) => Promise<void>
}

export async function withCommand(
  argv: readonly string[],
  io: Io,
  deps: WithDeps = {},
): Promise<number> {
  const separator = argv.indexOf('--')
  if (separator !== 1 || argv.length < 3 || argv[0] === undefined) {
    io.err(WITH_USAGE)
    return USAGE
  }

  const resource = argv[0]
  const command = argv.slice(2).join(' ').trim()
  if (resource.trim() === '' || command === '') {
    io.err(WITH_USAGE)
    return USAGE
  }

  const url = process.env[MAESTRO_URL_ENV]
  const token = process.env[MAESTRO_TOKEN_ENV]
  const runId = process.env[MAESTRO_RUN_ENV]
  const holderNode = process.env[MAESTRO_NODE_ENV]
  if (url === undefined || token === undefined || runId === undefined || holderNode === undefined) {
    io.err('vinta-ai-maestro: no live run is available for this command')
    return FAILED
  }

  const request = deps.fetch ?? fetch
  const endpoint = `${url}/api/runs/${encodeURIComponent(runId)}/leases`
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  let leaseId: string | null = null
  let renewal: ReturnType<typeof setInterval> | undefined
  const abort = new AbortController()

  try {
    const grant = await waitForLease({
      request,
      endpoint,
      headers,
      resource,
      holderNode,
      io,
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    })
    if (grant === null) return FAILED
    leaseId = grant.leaseId

    let loseLease: ((reason: Error) => void) | undefined
    const lost = new Promise<never>((_, reject) => {
      loseLease = reject
    })
    const every = Math.max(1_000, Math.floor(grant.ttlMs / 3))
    let renewing = false
    renewal = setInterval(() => {
      if (renewing || leaseId === null) return
      renewing = true
      void request(`${endpoint}/${encodeURIComponent(leaseId)}`, { method: 'PUT', headers })
        .then(async (response) => {
          if (!response.ok || !AgentLeaseGrantSchema.safeParse(await response.json()).success) {
            throw new Error('lease renewal failed')
          }
        })
        .catch((error: unknown) => {
          abort.abort()
          loseLease?.(error instanceof Error ? error : new Error('lease renewal failed'))
        })
        .finally(() => {
          renewing = false
        })
    }, every)
    renewal.unref?.()

    try {
      return await Promise.race([(deps.run ?? runShell)(command, abort.signal), lost])
    } catch {
      io.err('vinta-ai-maestro: the leased command could not complete')
      return FAILED
    }
  } catch {
    // `waitForLease` reports its own refusals; anything reaching here is the
    // renewal or the command itself coming apart.
    io.err(`vinta-ai-maestro: the leased command could not complete. ${DO_NOT_WORK_AROUND}`)
    return FAILED
  } finally {
    if (renewal !== undefined) clearInterval(renewal)
    abort.abort()
    if (leaseId !== null) {
      // Best effort and deliberately silent. Expiry may have won the race, and
      // the broker's release is idempotent for exactly this `finally`.
      try {
        await request(`${endpoint}/${encodeURIComponent(leaseId)}`, { method: 'DELETE', headers })
      } catch {}
    }
  }
}

/** Between attempts, once the daemon has said "still queued". */
const RETRY_MS = 500

/** How often a long wait says so out loud. */
const NOTICE_MS = 120_000

/** Consecutive transport failures tolerated before the wait gives up. */
const TRANSPORT_ATTEMPTS = 10

/**
 * The line every refusal ends on.
 *
 * Because the observed failure was not the lease mechanism: it was what an
 * agent did when the lease mechanism said no. Told "the resource lease was not
 * granted", agents ran the command without a lease — a reasonable reading of an
 * error that offers no alternative, and exactly the stampede the pool exists to
 * prevent. The rule has to travel with the refusal, not only in a prompt the
 * agent read twenty minutes earlier.
 */
const DO_NOT_WORK_AROUND =
  'Do not run the command without the lease. Report this instead — running it ' +
  'unleased stampedes the same machine as every sibling lane.'

interface LeaseWait {
  readonly request: typeof fetch
  readonly endpoint: string
  readonly headers: Readonly<Record<string, string>>
  readonly resource: string
  readonly holderNode: string
  readonly io: Io
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
}

/**
 * Blocks until the lease is granted, which is what the usage always claimed and
 * what this now does.
 *
 * It used to be one HTTP request, awaited. That reads as a wait and behaves as
 * one for about five minutes, which is where Node's own fetch stops waiting for
 * a response — and a test suite behind a capacity-1 semaphore is regularly
 * slower than that. What the agent saw was "could not reach the lease daemon",
 * and what it did was run the command bare.
 *
 * So the wait belongs on this side. The daemon answers `202` for "still
 * queued", leaving its own queue behind it so nothing is granted to a request
 * that has gone away, and this loops. Only the answers that waiting cannot
 * change end it.
 */
async function waitForLease(wait: LeaseWait): Promise<{ leaseId: string; ttlMs: number } | null> {
  const { request, endpoint, headers, resource, holderNode, io } = wait
  const sleep = wait.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const now = wait.now ?? (() => Date.now())
  const body = JSON.stringify({ resources: [resource], holderNode })

  let transportFailures = 0
  let announcedAt: number | null = null

  for (;;) {
    let response: Response
    try {
      response = await request(endpoint, { method: 'POST', headers, body })
      transportFailures = 0
    } catch {
      // A daemon that is restarting is worth waiting through; one that is gone
      // is not, and an unbounded retry against it would hang the whole turn.
      transportFailures += 1
      if (transportFailures >= TRANSPORT_ATTEMPTS) {
        io.err(`vinta-ai-maestro: could not reach the lease daemon. ${DO_NOT_WORK_AROUND}`)
        return null
      }
      await sleep(RETRY_MS)
      continue
    }

    if (response.status === 202) {
      // Said once, then occasionally: a transcript should show a turn waiting
      // rather than a turn that stopped saying anything.
      if (announcedAt === null) {
        io.err(`vinta-ai-maestro: waiting for "${resource}" — it is held by another lane.`)
        announcedAt = now()
      } else if (now() - announcedAt >= NOTICE_MS) {
        io.err(`vinta-ai-maestro: still waiting for "${resource}".`)
        announcedAt = now()
      }
      await sleep(RETRY_MS)
      continue
    }

    // Any other success is a grant. `202` is the one 2xx that is not, which is
    // why it is checked first; keying on `201` alone would make the contract
    // narrower than "it worked" for no benefit.
    if (response.ok) {
      const parsed = AgentLeaseGrantSchema.safeParse(await response.json())
      if (!parsed.success) {
        io.err(`vinta-ai-maestro: the daemon returned an invalid lease. ${DO_NOT_WORK_AROUND}`)
        return null
      }
      return { leaseId: parsed.data.leaseId, ttlMs: parsed.data.ttlMs }
    }

    io.err(`vinta-ai-maestro: ${await refusal(response, resource)} ${DO_NOT_WORK_AROUND}`)
    return null
  }
}

/** What a refusal means, in terms of the thing the operator can change. */
async function refusal(response: Response, resource: string): Promise<string> {
  let code = ''
  try {
    const body: unknown = await response.json()
    const named = (body as { error?: unknown } | null)?.error
    if (typeof named === 'string') code = named
  } catch {
    // A body that will not parse tells us nothing the status does not.
  }

  switch (code) {
    case 'invalid_resource':
      return `this run declares no semaphore called "${resource}" — the ones it does are listed in your instructions.`
    case 'invalid_holder':
      return 'this turn is not attributed to a phase of the running plan.'
    case 'run_not_live':
      return 'the run is no longer live, so it can grant nothing.'
    case 'leases_unavailable':
      return 'this run was started by a host that offers no resource leases.'
    case 'unauthorized':
      return 'the daemon rejected this turn’s token.'
    default:
      return `the lease was refused (${response.status}).`
  }
}

function runShell(command: string, signal: AbortSignal): Promise<number> {
  return new Promise((resolve) => {
    const invocation = shellInvocation(command)
    const child = spawn(invocation.file, [...invocation.args], {
      stdio: 'inherit',
      detached: ownProcessGroup(),
      ...spawnOptionsFor(invocation),
    })
    let settled = false
    const stop = (): void => {
      if (child.pid !== undefined) killTree(child.pid, 'SIGTERM')
    }
    const signals = ['SIGINT', 'SIGTERM'] as const
    for (const signal of signals) process.once(signal, stop)
    process.once('exit', stop)
    signal.addEventListener('abort', stop, { once: true })
    const detach = (): void => {
      signal.removeEventListener('abort', stop)
      for (const name of signals) process.removeListener(name, stop)
      process.removeListener('exit', stop)
    }
    child.once('error', () => {
      if (settled) return
      settled = true
      detach()
      resolve(FAILED)
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      detach()
      resolve(code ?? FAILED)
    })
  })
}
