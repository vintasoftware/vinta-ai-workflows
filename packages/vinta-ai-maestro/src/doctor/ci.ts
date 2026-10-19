/**
 * Gates checked against CI: the commands a project's CI runs that no gate does.
 *
 * Every gate passed while CI failed on twenty review PRs of one run, because
 * `manage.py check --deploy` and a "generated client is up to date" diff ran
 * in CI and in no gate. The run cannot see CI until a PR is open, and by then
 * every phase has landed on a red base. The doctor can read the CI workflow
 * before the run starts and say which of its checks the gates leave out.
 *
 * **A heuristic, and a warning.** CI is a shell script in YAML; a gate is a
 * shell command in JSON. What is compared is each command's *signature* — the
 * tool and its subcommand, after the wrappers that do not change what runs
 * (`uv run`, `poetry run`, `npx`, `docker compose run … <service>`, env
 * assignments, `npm run` against `pnpm`) are taken off — and then its long
 * flags, so `check --deploy` is not covered by a gate running `check`. What it
 * cannot see:
 *
 * - **only GitHub Actions** (`.github/workflows/*.yml`), and only `run:` steps.
 *   A `uses:` step — `pre-commit/action`, a lint action — runs commands this
 *   cannot name;
 * - a CI script that calls a file (`./ci/check.sh`) is one command, compared
 *   by name: what the script runs is not read;
 * - a gate that runs the same check under another name (`make lint` for
 *   `ruff check`) reads as missing, and a gate whose command merely *mentions*
 *   the tool reads as covering it.
 *
 * So it never fails a run: a false warning costs a glance, a false failure
 * would block a run that is fine.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import { isJudgeGate, type Workflow } from '../types.ts'

/** One command a CI step runs, and where. */
export interface CiCommand {
  /** Repository-relative path of the workflow file. */
  readonly file: string
  readonly job: string
  /** The step's `name`, else its 1-based index. */
  readonly step: string
  readonly command: string
}

/** A CI command no gate covers, and the gate that comes closest. */
export interface UncoveredCommand extends CiCommand {
  /** The long flags the nearest gate leaves out, when a gate runs the same tool. */
  readonly missingFlags: readonly string[]
  readonly nearest?: string
}

const WORKFLOW_DIR = join('.github', 'workflows')

/** Every `run:` line of every GitHub Actions workflow in the checkout. */
export async function readCiCommands(repoPath: string): Promise<CiCommand[]> {
  let files: string[]
  try {
    files = (await readdir(join(repoPath, WORKFLOW_DIR))).filter((name) => /\.ya?ml$/.test(name)).sort()
  } catch {
    return []
  }
  const found: CiCommand[] = []
  for (const name of files) {
    const file = join(WORKFLOW_DIR, name)
    let doc: unknown
    try {
      doc = parse(await readFile(join(repoPath, file), 'utf8'))
    } catch {
      // A workflow that does not parse is GitHub's to reject, not this check's.
      continue
    }
    const jobs = (doc as { jobs?: unknown } | null)?.jobs
    if (jobs === null || typeof jobs !== 'object') continue
    for (const [job, body] of Object.entries(jobs as Record<string, unknown>)) {
      const steps = (body as { steps?: unknown } | null)?.steps
      if (!Array.isArray(steps)) continue
      steps.forEach((raw, index) => {
        const step = raw as { run?: unknown; name?: unknown } | null
        if (typeof step?.run !== 'string') return
        const label = typeof step.name === 'string' ? step.name : String(index + 1)
        for (const command of commandLines(step.run)) found.push({ file, job, step: label, command })
      })
    }
  }
  return found
}

/**
 * The commands in a `run:` script that check something: continuation lines
 * joined, comments, shell control and setup (installs, `cd`, `echo`) dropped,
 * `&&` chains split.
 */
export function commandLines(script: string): string[] {
  const joined = script.replace(/\\\r?\n\s*/g, ' ')
  const out: string[] = []
  for (const line of joined.split(/\r?\n/)) {
    const bare = line.replace(/(^|\s)#.*$/, '').trim()
    if (bare === '') continue
    for (const part of bare.split(/\s*(?:&&|\|\||;)\s*/)) {
      const command = part.trim()
      if (command !== '' && isCheck(command)) out.push(command)
    }
  }
  return out
}

const SETUP_FIRST = new Set([
  'cd', 'echo', 'export', 'set', 'unset', 'mkdir', 'cp', 'mv', 'rm', 'ls', 'cat', 'source', '.', 'true', 'false',
  'sleep', 'curl', 'wget', 'apt', 'apt-get', 'brew', 'chmod', 'chown', 'tee', 'printf', 'touch', 'ln', 'env',
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'exit', 'corepack', 'nvm',
  'pushd', 'popd', 'trap', 'wait', 'tar', 'unzip', 'gzip', 'sed', 'awk', 'grep', 'find', 'xargs', 'test', '[',
  'pipx', 'ssh-keyscan', 'ssh-add', 'gh', 'aws', 'gcloud', 'az', 'kubectl', 'helm', 'heroku', 'flyctl', 'vercel',
])

/** `<tool> <sub>` pairs that install, start or publish rather than check. */
const SETUP_PAIR =
  /^(?:pip3?|uv pip|python -m pip) install\b|^(?:uv (?:sync|venv|lock|tool install|python install)|poetry (?:install|lock|config)|pipenv (?:install|sync)|npm (?:ci|install|i|publish)|pnpm (?:install|i|fetch|add|publish)|yarn(?: install)?$|yarn (?:add|publish)|bun (?:install|i|add)|bundle (?:install|config)|gem install|go (?:mod download|install|get)|cargo (?:fetch|install|publish)|composer install|mix deps\.get|docker (?:login|pull|push|tag|buildx create|network|volume)|docker compose (?:up|pull|down|build|create|start|stop|logs)|docker-compose (?:up|pull|down|build|create|start|stop|logs)|git (?:config|checkout|fetch|clone|submodule|switch|pull|push|tag|status|log)|npx playwright install)\b/

function isCheck(command: string): boolean {
  const words = signatureWords(command)
  const first = words[0]
  if (first === undefined) return false
  if (SETUP_FIRST.has(first)) return false
  if (/^\$\{\{.*\}\}$/.test(command)) return false
  return !SETUP_PAIR.test(words.join(' '))
}

/** Wrappers that do not change what runs, as the words they start with. */
const WRAPPERS: readonly (readonly string[])[] = [
  ['uv', 'run'],
  ['poetry', 'run'],
  ['pipenv', 'run'],
  ['pdm', 'run'],
  ['hatch', 'run'],
  ['bundle', 'exec'],
  ['npx'],
  ['pnpx'],
  ['bunx'],
  ['pnpm', 'exec'],
  ['pnpm', 'dlx'],
  ['yarn', 'dlx'],
  ['sudo'],
  ['time'],
  ['xvfb-run'],
]

/** Wrapper options that take a value as the next word. */
const WRAPPER_VALUE_FLAGS = new Set([
  '--with', '--with-requirements', '--group', '--extra', '--package', '--project', '--directory', '--python', '-p',
  '--env-file', '--index', '--filter', '-C', '--dir', '-u', '--user',
])

/**
 * A command reduced to what identifies it: env assignments, wrappers, an
 * interpreter in front of a script (`python manage.py` → `manage.py`), and
 * `docker compose run|exec [opts] <service>` taken off; `npm run x`,
 * `pnpm run x`, `pnpm x`, `yarn x` and `bun run x` all spelled `run x`.
 */
export function signatureWords(command: string): string[] {
  let words = command
    .replace(/\$\{\{[^}]*\}\}/g, '')
    .split(/\s+/)
    .filter((word) => word !== '')
    .map((word) => word.replace(/^['"]|['"]$/g, ''))
  for (let changed = true; changed; ) {
    changed = false
    while (words[0] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
      words = words.slice(1)
      changed = true
    }
    for (const wrapper of WRAPPERS) {
      if (wrapper.every((word, index) => words[index] === word)) {
        words = words.slice(wrapper.length)
        // `uv run --frozen --with x pytest`: a wrapper's own options go with it.
        while (words[0]?.startsWith('-') === true) {
          words = words.slice(WRAPPER_VALUE_FLAGS.has(words[0]) ? 2 : 1)
        }
        changed = true
      }
    }
    const compose =
      words[0] === 'docker' && words[1] === 'compose' ? 2 : words[0] === 'docker-compose' ? 1 : 0
    if (compose > 0 && (words[compose] === 'run' || words[compose] === 'exec')) {
      let rest = words.slice(compose + 1)
      while (rest[0]?.startsWith('-') === true) {
        const flag = rest[0]
        // `--rm`, `-T` take nothing; `-e X=1`, `-w /app`, `--user u` take one.
        rest = rest.slice(/^(-[ewu]|--(?:env|workdir|user|entrypoint|name|volume|publish))$/.test(flag) ? 2 : 1)
      }
      words = rest.slice(1)
      changed = true
    }
    if (/^python[0-9.]*$/.test(words[0] ?? '') && words[1] !== undefined && words[1] !== '-m' && !words[1].startsWith('-')) {
      words = words.slice(1)
      changed = true
    }
    if (/^python[0-9.]*$/.test(words[0] ?? '') && words[1] === '-m' && words[2] !== undefined) {
      words = words.slice(2)
      changed = true
    }
  }
  const [first, second] = words
  if ((first === 'npm' || first === 'pnpm' || first === 'bun' || first === 'yarn') && second === 'run') {
    return ['run', ...words.slice(2)]
  }
  if ((first === 'pnpm' || first === 'yarn') && second !== undefined && !second.startsWith('-')) {
    return ['run', ...words.slice(1)]
  }
  return words.map((word) => word.replace(/^\.\//, ''))
}

/** The tool and its subcommand, the part two commands must share to be the same check. */
function signature(words: readonly string[]): string {
  const positional = words.filter((word) => !word.startsWith('-'))
  const [tool, sub] = positional
  if (tool === undefined) return ''
  // A subcommand is a bare word; a path or a target (`tests/`, `src`) is an argument.
  return sub !== undefined && /^[a-z][a-z0-9:_-]*$/.test(sub) && !sub.includes('/') ? `${tool} ${sub}` : tool
}

const IGNORED_FLAGS = /^--(?:cov|color|no-color|verbose|quiet|junitxml|junit-xml|reporter|output|format|show-|tb|maxfail|durations|workers|parallel|numprocesses|no-cache|ci$|silent|progress|github|annotate)/

function longFlags(words: readonly string[]): string[] {
  return words
    .filter((word) => word.startsWith('--') && word.length > 2)
    .map((word) => word.split('=')[0] as string)
    .filter((flag) => !IGNORED_FLAGS.test(flag))
}

/** Every command a gate runs, split on `&&`, `||`, `;` and `|`. */
export function gateCommands(workflow: Workflow): { readonly gate: string; readonly command: string }[] {
  const found: { gate: string; command: string }[] = []
  for (const [id, gate] of Object.entries(workflow.gates)) {
    if (isJudgeGate(gate)) continue
    for (const line of [gate.cmd, gate.scoped_cmd]) {
      if (line === undefined) continue
      for (const part of line.split(/\s*(?:&&|\|\||;|\|)\s*/)) {
        if (part.trim() !== '') found.push({ gate: id, command: part.trim() })
      }
    }
  }
  return found
}

/**
 * The CI commands no gate covers. A gate covers a command when it runs the
 * same signature with every long flag the CI command passes (output and
 * coverage flags aside). Repeats — the same check in three jobs of a matrix —
 * are reported once.
 */
export function uncoveredCommands(ci: readonly CiCommand[], workflow: Workflow): UncoveredCommand[] {
  const leftToCi = new Set(workflow.ci_only.map((entry) => signature(signatureWords(entry.command))))
  const gates = gateCommands(workflow).map((entry) => {
    const words = signatureWords(entry.command)
    return { ...entry, signature: signature(words), flags: new Set(longFlags(words)) }
  })
  const seen = new Set<string>()
  const out: UncoveredCommand[] = []
  for (const command of ci) {
    const words = signatureWords(command.command)
    const sig = signature(words)
    if (sig === '' || leftToCi.has(sig)) continue
    const flags = longFlags(words)
    const key = `${sig}\u0000${[...flags].sort().join(' ')}`
    if (seen.has(key)) continue
    seen.add(key)
    const same = gates.filter((gate) => gate.signature === sig)
    if (same.some((gate) => flags.every((flag) => gate.flags.has(flag)))) continue
    const nearest = same
      .map((gate) => ({ gate, missing: flags.filter((flag) => !gate.flags.has(flag)) }))
      .sort((a, b) => a.missing.length - b.missing.length)[0]
    out.push({
      ...command,
      missingFlags: nearest?.missing ?? [],
      ...(nearest === undefined ? {} : { nearest: nearest.gate.gate }),
    })
  }
  return out
}

/** A command as a check line quotes it: expressions out, one line, bounded. */
export function quoteCommand(command: string): string {
  const line = command.replace(/\$\{\{[^}]*\}\}/g, '${{…}}').replace(/\s+/g, ' ').trim()
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}
