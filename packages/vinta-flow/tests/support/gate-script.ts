/**
 * A gate command line, in the shell the gate runner actually uses.
 *
 * A gate is project text run through `shellInvocation` (`src/platform/
 * platform.ts`) — `sh -c` on POSIX, `cmd.exe /d /s /c` on Windows. That seam is
 * the point: a gate must be run by the shell the project's own scripts already
 * assume. So unlike `fake-cli.ts`, these fixtures must *stay* shell, or they
 * would stop testing the thing they are named after.
 *
 * What they must not stay is **one** shell. The fixtures were `sh` lines, so
 * the whole gate-runner suite was skipped on Windows: `;` is not a separator
 * for `cmd.exe`, `>&2` is spelled `1>&2`, `$VAR` is `%VAR%`, and `exit 3` ends
 * the shell rather than the command. Written out by hand for one platform,
 * `echo nope >&2; exit 3` ran on Windows as a single `echo` of the literal
 * text and exited 0 — green, and testing nothing.
 *
 * So the *script* is declared as data and rendered per platform, and
 * `renderGate` takes the platform as a parameter so both renderings are
 * asserted from either kind of machine.
 *
 * One step deliberately is not shell. A gate that backgrounds a grandchild
 * exists to prove the runner kills a process *tree*, and that is a claim about
 * processes rather than about syntax — `sh` can say `cmd & echo $!` and
 * `cmd.exe` has no equivalent at all. The grandchild is therefore `node`,
 * which reports its own pid and is by definition installed wherever this suite
 * runs.
 */
import { shellQuote } from '../../src/platform/platform.ts'

export type Platform = NodeJS.Platform

const isWindows = (platform: Platform): boolean => platform === 'win32'

/** What a gate does, as data. Rendered in order, as one shell line. */
export interface GateScript {
  /** Lines echoed to stdout. */
  readonly stdout?: readonly string[]
  /** Lines echoed to stderr. */
  readonly stderr?: readonly string[]
  /** Echo the value of each named environment variable. */
  readonly echoEnv?: readonly string[]
  /** Print the working directory, to prove the gate ran where it was sent. */
  readonly printCwd?: boolean
  /** Append a line to a file — how a fixture counts the times it ran. */
  readonly append?: { readonly path: string; readonly line: string }
  /**
   * Background a grandchild that outlives the shell, record its pid, and wait.
   *
   * The fixture behind "a timeout kills the tree": killing only the shell
   * leaves this running, so the test can ask whether the pid is gone.
   */
  readonly background?: { readonly seconds: number; readonly pidFile: string }
  /** Exit code. Omitted means the shell's own, which is 0 after an echo. */
  readonly exit?: number
}

export function renderGate(script: GateScript, platform: Platform = process.platform): string {
  const windows = isWindows(platform)
  const steps: string[] = []

  for (const line of script.stdout ?? []) steps.push(`echo ${literal(line, platform)}`)
  for (const line of script.stderr ?? []) {
    // `1>&2` in both: `cmd.exe` requires the explicit descriptor, and `sh`
    // accepts it, so one spelling serves. The space before `1` matters on
    // Windows — `echo x1>&2` would redirect a stream named by the trailing 1.
    steps.push(`echo ${literal(line, platform)} 1>&2`)
  }
  for (const name of script.echoEnv ?? []) {
    steps.push(windows ? `echo %${name}%` : `echo "$${name}"`)
  }
  // `cd` with no argument prints the working directory on `cmd.exe`; `pwd` is
  // the POSIX spelling of the same question.
  if (script.printCwd === true) steps.push(windows ? 'cd' : 'pwd')

  if (script.append !== undefined) {
    const { path, line } = script.append
    // No space before `>>` on Windows: `echo ran >> f` writes "ran " with the
    // trailing space, which a test counting exact lines would not match.
    steps.push(
      windows
        ? `echo ${literal(line, platform)}>> "${path}"`
        : `echo ${literal(line, platform)} >> ${shellQuote(path, platform)}`,
    )
  }

  if (script.background !== undefined) steps.push(...backgroundSteps(script.background, platform))
  if (script.exit !== undefined) steps.push(windows ? `exit /b ${script.exit}` : `exit ${script.exit}`)

  // `&` is `cmd.exe`'s unconditional separator, `;` is `sh`'s. Neither is `&&`:
  // these steps run whatever the one before returned, and a failing `echo`
  // must not silently skip the `exit` that the test is asserting on.
  return steps.join(windows ? ' & ' : '; ')
}

/**
 * A grandchild that outlives its shell, plus the wait that keeps the gate open
 * long enough to be timed out.
 *
 * Node on both sides, for the reason in the header: `$!` has no `cmd.exe`
 * counterpart, and what this fixture is about is the process tree rather than
 * the syntax. The child writes *its own* pid, which is both portable and more
 * honest than the shell's idea of what it just started.
 */
function backgroundSteps(
  background: { readonly seconds: number; readonly pidFile: string },
  platform: Platform,
): string[] {
  const { seconds, pidFile } = background
  const child = nodeProgram(
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
      `setTimeout(() => {}, ${seconds * 1000})`,
  )
  const wait = nodeProgram(`setTimeout(() => {}, ${seconds * 1000})`)

  if (isWindows(platform)) {
    // `start /b` runs it in this console without a new window, so it stays in
    // the tree `taskkill /t` walks — which is the thing under test. It returns
    // at once, so the wait is an ordinary next step.
    return [`start /b ${child}`, wait]
  }
  // **One step, not two.** `sh` already treats `&` as a terminator, so a `;`
  // after it is a syntax error — `cmd &; next` does not parse. Rendered as two
  // steps the shell died instantly, the gate came back `failed` in 200ms, and
  // the timeout this fixture exists to test never fired at all.
  return [`${child} & ${wait}`]
}

/**
 * `node -e <program>`, quoted for the shell that will parse it.
 *
 * The program is written with no `"` of its own — see the callers, which use
 * `JSON.stringify` only on paths — because `cmd.exe` has no way to escape a
 * quote inside a quoted region, which is why `shellQuote` refuses one outright.
 */
function nodeProgram(program: string): string {
  return `node -e "${program.replaceAll('"', "'")}"`
}

/**
 * An echoed literal.
 *
 * `cmd.exe` does not strip quotes from `echo`, so a quoted string would print
 * its own quotes and a test looking for the bare word would miss it. The
 * characters that would need quoting there are refused instead: this renders
 * fixture text that the fixture author chose, so a caller hitting this should
 * pick different words rather than be given a subtly different line.
 */
function literal(value: string, platform: Platform): string {
  if (!isWindows(platform)) return shellQuote(value, platform)
  if (/[<>|&^"%]/.test(value)) {
    throw new Error(`gate fixture text is not renderable for cmd.exe: ${JSON.stringify(value)}`)
  }
  return value
}
