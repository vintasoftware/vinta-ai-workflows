/**
 * `vinta-ai-maestro judge-hook` — the `PreToolUse` hook a `judged` session runs
 * before every call to a judged tool (§17.6).
 *
 * claude-code starts this process with the tool call on stdin and reads a
 * decision off stdout. It asks the daemon, over the same token-guarded route
 * family `vinta-ai-maestro gate` uses, and the daemon asks the classifier. The
 * classifier is not reached from here: the key and the judge's configuration
 * live in the daemon, and an agent's own process — which can read its own
 * environment — must not be handed either.
 *
 * **Every failure is a denial.** claude-code treats a hook that exits non-zero
 * with anything but 2 as a *non-blocking* error and runs the call anyway, so a
 * crash here would be the exact unchecked call `judged` exists to prevent.
 * Each path out of this file therefore either prints a decision or exits 2.
 *
 * The command line is never echoed: stderr reaches the agent's transcript, and
 * the call is already there once.
 */
import { fileURLToPath } from 'node:url'
import {
  MAESTRO_NODE_ENV,
  MAESTRO_RUN_ENV,
  MAESTRO_TOKEN_ENV,
  MAESTRO_URL_ENV,
} from '../resources/agent-leases.ts'
import { shellQuote } from '../platform/platform.ts'

/** claude-code's code for "block this call", and the only safe failure exit. */
export const HOOK_BLOCK = 2

/**
 * The command line claude-code runs for the hook: this package's own binary,
 * under the node running the daemon, by absolute path — never whatever
 * `vinta-ai-maestro` the agent's `PATH` happens to resolve, which an agent with
 * full permissions could have put there itself.
 *
 * Source and built layouts differ in one extension, and the source needs the
 * flag `bin.ts`'s shebang carries.
 */
export function judgeHookCommand(): string {
  const source = import.meta.url.endsWith('.ts')
  const bin = fileURLToPath(new URL(source ? '../cli/bin.ts' : '../cli/bin.js', import.meta.url))
  const flags = source ? ['--experimental-transform-types', '--disable-warning=ExperimentalWarning'] : []
  const line = [process.execPath, ...flags, bin, 'judge-hook'].map((token) => shellQuote(token)).join(' ')
  // A process that dies before `judgeHookCommandMain` can catch anything — a
  // failed import, an unsupported node — exits 1, which claude-code reads as a
  // non-blocking error and runs the call. The wrapper turns every such exit
  // into the blocking one. A decision printed with exit 0 passes straight through.
  return process.platform === 'win32' ? `${line} || exit /b ${HOOK_BLOCK}` : `${line} || exit ${HOOK_BLOCK}`
}

export interface JudgeHookIo {
  readonly stdin: () => Promise<string>
  readonly out: (text: string) => void
  readonly err: (text: string) => void
  readonly env: Readonly<Record<string, string | undefined>>
  readonly fetch?: typeof fetch
}

/** How long one ask may take before it is a denial. Under the hook timeout the adapter sets. */
const ASK_TIMEOUT_MS = 50_000

function decision(allow: boolean, reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: allow ? 'allow' : 'deny',
      permissionDecisionReason: reason,
    },
  })
}

export async function judgeHookCommandMain(io: JudgeHookIo): Promise<number> {
  const deny = (reason: string): number => {
    io.out(decision(false, `vinta-ai-maestro: ${reason}`))
    return 0
  }

  try {
    const url = io.env[MAESTRO_URL_ENV]
    const token = io.env[MAESTRO_TOKEN_ENV]
    const runId = io.env[MAESTRO_RUN_ENV]
    const holderNode = io.env[MAESTRO_NODE_ENV]
    if (url === undefined || token === undefined || runId === undefined || holderNode === undefined) {
      return deny('this session is not attributed to a live run, so its calls cannot be judged.')
    }

    let call: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(await io.stdin())
      if (parsed === null || typeof parsed !== 'object') throw new Error('not an object')
      call = parsed as Record<string, unknown>
    } catch {
      return deny('the tool call could not be read, so it was not judged.')
    }
    const tool = call['tool_name']
    const cwd = call['cwd']
    if (typeof tool !== 'string') return deny('the tool call names no tool, so it was not judged.')

    const request = io.fetch ?? fetch
    let response: Response
    try {
      response = await request(`${url}/api/runs/${encodeURIComponent(runId)}/permission`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          holderNode,
          tool,
          input: call['tool_input'] ?? null,
          cwd: typeof cwd === 'string' ? cwd : '',
        }),
        signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
      })
    } catch {
      return deny('the daemon could not be reached to judge this call, so it was denied.')
    }
    if (!response.ok) return deny(`the daemon refused to judge this call (${response.status}), so it was denied.`)

    const body = (await response.json().catch(() => null)) as { allow?: unknown; reason?: unknown } | null
    if (body === null || typeof body.allow !== 'boolean') {
      return deny('the daemon answered with no decision, so the call was denied.')
    }
    const reason = typeof body.reason === 'string' ? body.reason : ''
    io.out(decision(body.allow, body.allow ? reason : `vinta-ai-maestro: ${reason}`))
    return 0
  } catch {
    // Anything that escaped the paths above. Printing a decision may be what
    // failed, so this one uses the exit code alone.
    io.err('vinta-ai-maestro: the safety hook failed; the call was blocked.')
    return HOOK_BLOCK
  }
}
