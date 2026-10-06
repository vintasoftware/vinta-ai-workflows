/**
 * The gate guard's question: is this shell line a gate, or a command a pool
 * exists to ration, run without going through the daemon?
 *
 * Two rules, both read off the run's definition as it stands:
 *
 * - **A gate's own command** — its full `cmd`, exactly — is the daemon's to
 *   run. Run bare it is invisible to the gate cache, outside the gate's pools,
 *   and a result the `gate` node will run again anyway. The answer is
 *   `vinta-ai-maestro gate <id>`.
 *
 *   Not its `scoped_cmd`. `pytest {changed_files}` with a file list in it is
 *   the same line as an agent running one test file in its inner loop, which
 *   is exactly what an agent should be doing; refusing it would be refusing
 *   the work. A narrowed run is the pool rule's business instead: it takes the
 *   lease, and that is all it owes.
 * - **A command matching a pool's `match` pattern** needs that pool's lease.
 *   Run bare it stampedes the CPU or the shared server the pool is rationing.
 *   The answer is `vinta-ai-maestro with <pool> -- <cmd>`.
 *
 * It is a guardrail against habit, and says so wherever it is described: it
 * compares command *lines*, so `bash -c "…"`, a script that runs the suite, or
 * a spelling with different flags is not seen. The agents are not adversaries;
 * the failure this exists for is an agent typing the familiar command because
 * that is what it always types.
 *
 * Pure. Returns ids only — never the command — so a caller can journal the
 * answer without carrying repository content (§11).
 */
import { isJudgeGate, type Workflow } from '../types.ts'

export type GuardHit =
  | { readonly rule: 'gate'; readonly gate: string }
  | { readonly rule: 'pool'; readonly pool: string }

/** The binary agents reach the daemon through, by any of its usual launchers. */
const MAESTRO = 'vinta-ai-maestro'
const LAUNCHERS = new Set(['npx', 'pnpx', 'bunx'])

export function checkCommand(workflow: Workflow, command: string): GuardHit | null {
  const whole = normalize(command)
  if (whole === '') return null
  const gate = gateHit(workflow, whole)
  if (gate !== null) return gate

  for (const segment of segments(command)) {
    const tokens = words(segment)
    const leased = leasedPools(tokens)
    const inner = leased === null ? tokens : innerCommand(tokens)
    if (inner === null) continue
    const text = inner.join(' ')
    const hit = gateHit(workflow, text) ?? poolHit(workflow, text, leased ?? new Set())
    if (hit !== null) return hit
  }
  return null
}

/** The deny reason an agent reads. It is the instruction, so it names the verb to use. */
export function guardReason(hit: GuardHit): string {
  return hit.rule === 'gate'
    ? `this is gate "${hit.gate}" — run \`${MAESTRO} gate ${hit.gate}\` instead. The daemon runs ` +
        'it in this lane with its pools held and its result cached, and the run’s own gate uses that result.'
    : `this command needs the "${hit.pool}" pool — run it as \`${MAESTRO} with ${hit.pool} -- <command>\` ` +
        'so it waits its turn instead of competing with the other lanes.'
}

function gateHit(workflow: Workflow, text: string): GuardHit | null {
  for (const [id, gate] of Object.entries(workflow.gates)) {
    if (isJudgeGate(gate)) continue
    if (normalize(gate.cmd) === text) return { rule: 'gate', gate: id }
  }
  return null
}

function poolHit(workflow: Workflow, text: string, leased: ReadonlySet<string>): GuardHit | null {
  for (const [id, pool] of Object.entries(workflow.resources)) {
    if (pool.kind !== 'semaphore' || pool.match === undefined || leased.has(id)) continue
    if (pool.match.some((pattern) => globPattern(pattern).test(text))) return { rule: 'pool', pool: id }
  }
  return null
}

/**
 * The pools a `vinta-ai-maestro with <pool> -- …` segment holds, or null when
 * the segment is not one. Any other `vinta-ai-maestro` verb holds none and
 * runs nothing the guard is about, so it answers with an empty inner command.
 */
function leasedPools(tokens: readonly string[]): Set<string> | null {
  const start = maestroIndex(tokens)
  if (start === null) return null
  if (tokens[start + 1] !== 'with') return new Set()
  const pool = tokens[start + 2]
  return new Set(pool === undefined ? [] : [pool])
}

function innerCommand(tokens: readonly string[]): string[] | null {
  const start = maestroIndex(tokens)
  if (start === null || tokens[start + 1] !== 'with') return null
  const separator = tokens.indexOf('--', start)
  if (separator === -1) return null
  // `with` joins its arguments into one line and the shell runs it, so a
  // quoted single argument is the command as well as several bare ones are.
  return words(tokens.slice(separator + 1).join(' '))
}

function maestroIndex(tokens: readonly string[]): number | null {
  const first = tokens[0]
  if (first === undefined) return null
  if (basename(first) === MAESTRO) return 0
  if (LAUNCHERS.has(first) && tokens[1] === MAESTRO) return 1
  if ((first === 'pnpm' || first === 'yarn') && tokens[1] === 'exec' && tokens[2] === MAESTRO) return 2
  return null
}

/**
 * The simple commands in a line, split on `&&`, `||`, `;`, `|` and newlines.
 * Quote-aware enough for the lines agents actually write, not a shell parser.
 */
function segments(command: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i] as string
    if (quote !== null) {
      if (char === quote) quote = null
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    const pair = command.slice(i, i + 2)
    if (pair === '&&' || pair === '||') {
      out.push(current)
      current = ''
      i += 1
      continue
    }
    if (char === ';' || char === '|' || char === '\n') {
      out.push(current)
      current = ''
      continue
    }
    current += char
  }
  out.push(current)
  return out.filter((segment) => segment.trim() !== '')
}

/** Words with quotes removed and leading `VAR=value` assignments dropped. */
function words(segment: string): string[] {
  const tokens: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const match of segment.matchAll(pattern)) tokens.push(match[1] ?? match[2] ?? match[3] ?? '')
  let start = 0
  while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start] as string)) start += 1
  return tokens.slice(start)
}

function normalize(command: string): string {
  return words(command).join(' ')
}

/** `*` matches any run of characters; everything else is literal. */
function globPattern(glob: string): RegExp {
  return new RegExp(`^${normalize(glob).split('*').map(escape).join('.*')}$`)
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/**
 * The shell line a normalized `tool_use` event ran, on the harnesses the guard
 * can only watch: codex's `command_execution` (a login-shell wrapper around the
 * real line) and opencode's `bash`. Null for anything else, including
 * claude-code's `Bash`, which the hook already saw before it ran.
 */
export function shellLineOf(harness: string, name: string, input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const command = (input as { command?: unknown }).command
  if (typeof command !== 'string') return null
  if (harness === 'opencode' && name === 'bash') return command
  if (harness === 'codex' && name === 'command_execution') return unwrapShell(command)
  return null
}

/** `/bin/zsh -lc 'pnpm test'` → `pnpm test`. Anything else as it came. */
function unwrapShell(command: string): string {
  const match = /^\S*\b(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command.trim())
  return match?.[2] ?? command
}
