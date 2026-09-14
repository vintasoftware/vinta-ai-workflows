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

  Blocks until the running daemon grants <resource>, runs <cmd>, and releases
  the lease on exit. Long commands renew their lease automatically. This verb
  is intended for agent turns started by \`vinta-ai-maestro run\`; the daemon
  connection and current phase are supplied through that turn's environment.

  Quote <cmd> as one argument when it contains shell operators or significant
  whitespace.`

export interface WithDeps {
  readonly fetch?: typeof fetch
  readonly run?: (command: string, signal: AbortSignal) => Promise<number>
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
    const acquired = await request(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ resources: [resource], holderNode }),
    })
    if (!acquired.ok) {
      io.err('vinta-ai-maestro: the resource lease was not granted')
      return FAILED
    }

    const parsed = AgentLeaseGrantSchema.safeParse(await acquired.json())
    if (!parsed.success) {
      io.err('vinta-ai-maestro: the daemon returned an invalid lease')
      return FAILED
    }
    leaseId = parsed.data.leaseId

    let loseLease: ((reason: Error) => void) | undefined
    const lost = new Promise<never>((_, reject) => {
      loseLease = reject
    })
    const every = Math.max(1_000, Math.floor(parsed.data.ttlMs / 3))
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
    io.err('vinta-ai-maestro: could not reach the lease daemon')
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
