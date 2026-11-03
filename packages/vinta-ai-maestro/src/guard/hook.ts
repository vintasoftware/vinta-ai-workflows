/**
 * `vinta-ai-maestro guard-hook` — the gate guard as a claude-code `PreToolUse`
 * hook, installed for every agent a run starts, whatever its permission mode.
 *
 * Installed per lane through the settings file the adapter already writes and
 * passes with `--settings` for that one spawn (`harness/claude-code.ts`). It is
 * never written into the repository's `.claude/settings.json`, so it reaches
 * the agents a run starts and nobody else: not a person's own session in the
 * same checkout, not `implement-plan`.
 *
 * It asks the run's daemon rather than deciding locally, because the daemon
 * holds the run's definition *as amended* — a gate retuned mid-run is matched
 * on its new command — and because a block is journalled there, against the
 * node, as `bare_gate_blocked`.
 *
 * **It fails open**, which is the opposite of the judge hook beside it, and on
 * purpose. The judge is a safety check on a run the operator chose to give
 * full permissions, so an unanswered question is a denial. This is a guardrail
 * against a wasted suite run, so an unanswered question is not a reason to stop
 * an agent working: no daemon, no run, unreadable input — it prints nothing and
 * exits 0, and claude-code proceeds as it would have without the hook. It also
 * never prints an `allow`, which would skip the permission prompt the session's
 * own mode asks for. It only ever denies or stays silent.
 */
import { fileURLToPath } from 'node:url'

import { shellQuote } from '../platform/platform.ts'
import {
  MAESTRO_NODE_ENV,
  MAESTRO_RUN_ENV,
  MAESTRO_TOKEN_ENV,
  MAESTRO_URL_ENV,
} from '../resources/agent-leases.ts'

export interface GuardHookIo {
  readonly stdin: () => Promise<string>
  readonly out: (text: string) => void
  readonly env: Readonly<Record<string, string | undefined>>
  readonly fetch?: typeof fetch
}

/** Long enough for a loaded daemon, short enough that nobody waits on a dead one. */
const ASK_TIMEOUT_MS = 5_000

/**
 * The command line claude-code runs. Built like the judge hook's — this
 * package's binary by absolute path under the daemon's node, never whatever
 * the agent's `PATH` resolves — but wrapped to exit 0 rather than 2: a hook
 * that cannot start must not block the call (see the module note).
 */
export function guardHookCommand(): string {
  const source = import.meta.url.endsWith('.ts')
  const bin = fileURLToPath(new URL(source ? '../cli/bin.ts' : '../cli/bin.js', import.meta.url))
  const flags = source ? ['--experimental-transform-types', '--disable-warning=ExperimentalWarning'] : []
  const line = [process.execPath, ...flags, bin, 'guard-hook'].map((token) => shellQuote(token)).join(' ')
  return process.platform === 'win32' ? `${line} || exit /b 0` : `${line} || exit 0`
}

export async function guardHookMain(io: GuardHookIo): Promise<number> {
  try {
    const url = io.env[MAESTRO_URL_ENV]
    const token = io.env[MAESTRO_TOKEN_ENV]
    const runId = io.env[MAESTRO_RUN_ENV]
    const holderNode = io.env[MAESTRO_NODE_ENV]
    if (url === undefined || token === undefined || runId === undefined || holderNode === undefined) return 0

    const call = JSON.parse(await io.stdin()) as { tool_name?: unknown; tool_input?: { command?: unknown } }
    const command = call.tool_input?.command
    if (call.tool_name !== 'Bash' || typeof command !== 'string') return 0

    const response = await (io.fetch ?? fetch)(`${url}/api/runs/${encodeURIComponent(runId)}/guard`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ holderNode, command }),
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    })
    if (!response.ok) return 0
    const body = (await response.json()) as { allow?: unknown; reason?: unknown }
    if (body.allow !== false || typeof body.reason !== 'string') return 0

    io.out(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `vinta-ai-maestro: ${body.reason}`,
        },
      }),
    )
    return 0
  } catch {
    return 0
  }
}
