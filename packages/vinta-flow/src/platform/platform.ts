/**
 * The one place that knows which operating system this is running on.
 *
 * Everything else in the package spawns processes, kills trees and runs
 * project command lines without a `process.platform` check in sight, because
 * the five questions where POSIX and Windows genuinely disagree are answered
 * here and nowhere else:
 *
 * 1. **How a project command line is run.** `/bin/sh -c` against
 *    `cmd.exe /d /s /c`.
 * 2. **How an executable is invoked**, given that a CLI installed by npm on
 *    Windows is a `.cmd` shim that `CreateProcess` cannot run at all.
 * 3. **Whether a child gets its own process group** — a POSIX idea with no
 *    Windows equivalent.
 * 4. **How the whole tree under a pid is ended.** `kill(-pid)` against
 *    `taskkill /T`.
 * 5. **Which separator a filesystem path is built with**, for the paths that
 *    end up inside one of those command lines.
 *
 * Every function takes `platform` as a parameter defaulting to
 * `process.platform`, so both branches are decidable — and therefore
 * testable — from either kind of machine. That is the point of the module:
 * the behaviour is a value, not an ambient fact.
 *
 * **Nothing here logs.** Command lines carry lane paths and a project's own
 * gate commands, which are repository content (§11); the one error this
 * module can raise names the constraint that was violated and never the
 * argument that violated it.
 */
import { spawnSync } from 'node:child_process'
import { posix, win32 } from 'node:path'

export type Platform = NodeJS.Platform

export const isWindows = (platform: Platform = process.platform): boolean => platform === 'win32'

/**
 * A `file`/`args` pair ready to hand to `spawn` or `execFile`, plus the single
 * spawn option Windows needs.
 *
 * `windowsVerbatimArguments` is true exactly when `args` is already a command
 * line we quoted ourselves: `cmd.exe` parses its own command line, so Node
 * re-quoting it would corrupt what we built. It is `false` — and inert — on
 * every POSIX invocation.
 */
export interface Invocation {
  readonly file: string
  readonly args: readonly string[]
  readonly windowsVerbatimArguments: boolean
}

/** Spread into a `spawn`/`execFile` options object. */
export const spawnOptionsFor = (invocation: Invocation): { windowsVerbatimArguments?: true } =>
  invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}

// ---------------------------------------------------------------------------
// Running a project command line
// ---------------------------------------------------------------------------

/**
 * How a gate's `cmd` — or a database's setup/reset line — is run.
 *
 * **POSIX: `/bin/sh -c`.** Unchanged, and deliberately `sh` rather than the
 * operator's login shell: a gate is a command a project's own CI would run.
 *
 * **Windows: `cmd.exe /d /s /c`, not PowerShell.** Stated rather than assumed,
 * because it is a real choice with consequences. A gate is written by the
 * project, and on Windows a project's own scripts — `package.json` scripts,
 * `.cmd` shims, everything npm and pnpm generate — are already `cmd.exe`
 * lines. `npm test && npm run lint` means what its author meant under
 * `cmd.exe`; under PowerShell 5.1 `&&` is a parse error, and under PowerShell
 * 7 it works but redirection, quoting and `%VAR%` do not. PowerShell also
 * costs several hundred milliseconds of startup per gate. So the shell that
 * matches what the project already assumes wins.
 *
 * `/d` skips any AutoRun command the registry has configured, so a gate does
 * not inherit a developer's shell profile. `/s` fixes the quote handling: with
 * it, `cmd` strips the first and last quote of the command line and leaves
 * everything between them alone, which is what makes it safe to hand over an
 * arbitrary command line by wrapping it once.
 *
 * The command is passed through untouched on both platforms. It is a shell
 * line, so escaping it would break the operators the author wrote it with.
 */
export function shellInvocation(command: string, platform: Platform = process.platform): Invocation {
  if (!isWindows(platform)) {
    return { file: '/bin/sh', args: ['-c', command], windowsVerbatimArguments: false }
  }
  return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], windowsVerbatimArguments: true }
}

// ---------------------------------------------------------------------------
// Invoking an executable
// ---------------------------------------------------------------------------

/**
 * An argument that cannot be passed through `cmd.exe` without changing what it
 * means. Carries no value — the argument is a session id, a model name or a
 * path, and paths are repository content (§11).
 *
 * A plain field rather than a parameter property, because this module is
 * imported by code that runs under `--experimental-strip-types`, which refuses
 * parameter properties outright (see `src/cli/bin.ts`).
 */
export class UnquotableArgumentError extends Error {
  readonly index: number

  constructor(index: number) {
    super(`argument ${index} contains a character the platform's shell cannot carry verbatim`)
    this.name = 'UnquotableArgumentError'
    this.index = index
  }
}

/**
 * Characters this module refuses rather than guesses at.
 *
 * Every token below is wrapped in quotes unconditionally, which is what makes
 * `& | < > ( ) ^` — and the `(x86)` in `C:\Program Files (x86)\…` — literal
 * without any escaping. Three characters survive that treatment and so are
 * refused instead: `"` ends the quoted region, `%` is still expanded inside
 * one, and a newline ends the command line outright. No argument this package
 * builds contains any of them; an argument that does is a bug worth failing on
 * rather than a string worth escaping cleverly.
 */
const UNQUOTABLE = /["%\r\n\u0000]/

/** One token, quoted for `CommandLineToArgvW` — which every CRT-linked program uses. */
function quoteToken(token: string, index: number): string {
  if (UNQUOTABLE.test(token)) throw new UnquotableArgumentError(index)
  // Backslashes are only special immediately before a quote. A token ending in
  // one — `C:\lanes\run-1\` — would otherwise escape its own closing quote.
  return `"${token.replace(/(\\+)$/, '$1$1')}"`
}

/**
 * How an executable and its arguments are actually spawned.
 *
 * **POSIX: unchanged.** `file` and `args` go straight to `spawn`.
 *
 * **Windows: through `cmd.exe`, always.** Not a preference — a requirement,
 * for two independent reasons. `claude`, `codex` and `opencode` are installed
 * by npm as `claude.cmd`; `CreateProcess` cannot execute a batch file, and
 * Node refuses to try since CVE-2024-27980. And a bare name like `claude` only
 * resolves to `claude.cmd` through `PATHEXT`, which is a shell's job. Routing
 * every Windows spawn the same way is one rule instead of a guess about which
 * kind of file the operator's PATH happens to hold.
 *
 * The cost is real and worth naming: the child pid is `cmd.exe`'s, and the CLI
 * is its grandchild. `killTree` is what keeps that from mattering — it ends the
 * tree, so the extra layer is not an extra orphan. A missing binary also stops
 * presenting as a spawn error and starts presenting as `cmd.exe` saying it is
 * not recognised, which is why each adapter's `binary-not-found` signature
 * matches that phrase too.
 *
 * Quoting is ours rather than Node's `shell: true`, which joins the arguments
 * with spaces and escapes nothing — the injection sink this avoids.
 */
export function commandInvocation(
  file: string,
  args: readonly string[],
  platform: Platform = process.platform,
): Invocation {
  if (!isWindows(platform)) {
    return { file, args: [...args], windowsVerbatimArguments: false }
  }
  const line = [file, ...args].map((token, index) => quoteToken(token, index)).join(' ')
  // The outer pair is what `/s` strips, leaving the per-token quotes intact.
  return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true }
}

// ---------------------------------------------------------------------------
// Building a filesystem path
// ---------------------------------------------------------------------------

/**
 * Join path segments with the separator the *filesystem* uses on `platform`.
 *
 * Not a wrapper for convenience over `node:path`'s `join`: that one reads the
 * ambient `process.platform`, so a caller using it has a Windows branch no Mac
 * can decide — which is the whole reason every function in this module takes
 * the platform as a value. `win32.join` and `posix.join` are the very
 * implementations Node picks between; this picks by the parameter instead.
 *
 * What makes it worth a function rather than a `` `${dir}/${name}` `` is that
 * Windows *mostly* accepts `/`, so a mixed path like
 * `C:\pool\.templates/dev-db.sqlite3` passes through `fs` and looks harmless —
 * right up until it reaches `copyFileCommand` below, where `cmd.exe`'s `copy`
 * reads the leading `/` of an argument as the start of a switch and cannot
 * parse the path at all. `win32.join` collapses every segment onto `\`, so no
 * such argument is ever built.
 *
 * Paths handed to *git* are the exception and must not come through here: git
 * speaks posix paths on every platform, so those stay `/`-joined on Windows
 * too.
 */
export const joinPath = (
  segments: readonly string[],
  platform: Platform = process.platform,
): string => (isWindows(platform) ? win32.join(...segments) : posix.join(...segments))

// ---------------------------------------------------------------------------
// Building a command line for that shell
// ---------------------------------------------------------------------------

/**
 * One value, quoted for whichever shell `shellInvocation` names — for the
 * handful of places that build a command line as *data*: the database setup,
 * clone and reset lines a lane summary records and re-runs.
 *
 * POSIX gets single quotes, inside which nothing at all is special. Windows
 * gets double quotes, inside which `& | < > ^ ( )` are all literal — and, as in
 * `commandInvocation`, `"` and `%` are refused rather than escaped, because
 * neither survives a quoted region.
 */
export function shellQuote(value: string, platform: Platform = process.platform): string {
  if (!isWindows(platform)) return `'${value.replaceAll("'", `'\\''`)}'`
  if (UNQUOTABLE.test(value)) throw new UnquotableArgumentError(0)
  return `"${value}"`
}

/**
 * Delete a file if it is there, as a command line. `rm -f` tolerates a missing
 * file; `del` does not report usefully on one, so Windows asks first — the
 * command has to be idempotent, because it is the setup step that runs before
 * every template build.
 */
export const removeFileCommand = (path: string, platform: Platform = process.platform): string => {
  const quoted = shellQuote(path, platform)
  return isWindows(platform) ? `if exist ${quoted} del /f /q ${quoted}` : `rm -f ${quoted}`
}

/** Copy a file over whatever is at the destination, as a command line. */
export const copyFileCommand = (
  from: string,
  to: string,
  platform: Platform = process.platform,
): string => {
  const pair = `${shellQuote(from, platform)} ${shellQuote(to, platform)}`
  return isWindows(platform) ? `copy /y ${pair}` : `cp ${pair}`
}

// ---------------------------------------------------------------------------
// Process groups and killing trees
// ---------------------------------------------------------------------------

/**
 * Whether a spawned child should be asked to lead its own process group —
 * `spawn`'s `detached`.
 *
 * True on POSIX, and the reason is the whole of `killTree` below: a group is
 * what makes "kill the tree, not the leaf" a single syscall.
 *
 * False on Windows, where `detached` means something else entirely —
 * `DETACHED_PROCESS`, a child with no console at all. That buys nothing here
 * (stdio is piped) and costs anything the CLI does with a console, so it is
 * not asked for. Windows gets its tree from `taskkill /T` instead.
 */
export const ownProcessGroup = (platform: Platform = process.platform): boolean =>
  !isWindows(platform)

/**
 * What ending the tree under `pid` amounts to on this platform. A value rather
 * than an action, so both branches can be asserted from either machine.
 */
export type KillPlan =
  /** `process.kill(-pid, signal)` — the process *group*, not the process. */
  | { readonly kind: 'group'; readonly pid: number; readonly signal: NodeJS.Signals }
  /** A command to run. Windows has no group signal, so the tree is walked. */
  | { readonly kind: 'command'; readonly file: string; readonly args: readonly string[] }

/**
 * Windows has no signals. `taskkill /T` walks the process table and ends the
 * pid together with its descendants, which is the closest thing to a group
 * signal that exists without a Job Object (and a Job Object needs a native
 * dependency this package does not have).
 *
 * `/F` is the difference between the two stages every caller here already has.
 * Without it `taskkill` posts `WM_CLOSE`, which a console application ignores —
 * so on Windows the polite stage is close to a no-op and the caller's own
 * SIGKILL deadline is what actually ends the process. That is a behavioural
 * difference, not an implementation detail: an interrupted CLI on Windows does
 * not get the chance to persist its session that SIGINT gives it on POSIX.
 *
 * The weaker guarantee is worth stating too. A process group holds a grandchild
 * even after its parent dies; `taskkill /T` reads parent links that are already
 * gone by then. A backgrounded grandchild that outlives its parent therefore
 * survives on Windows, keeps the inherited stdout pipe open, and `close` never
 * fires. There is no dependency-free fix for that.
 */
export function killTreePlan(
  pid: number,
  signal: NodeJS.Signals,
  platform: Platform = process.platform,
): KillPlan {
  if (!isWindows(platform)) return { kind: 'group', pid, signal }
  const force = signal === 'SIGKILL' ? ['/f'] : []
  return { kind: 'command', file: 'taskkill', args: ['/pid', String(pid), '/t', ...force] }
}

/**
 * Ends the tree rooted at `pid`. Never throws: signalling a process that has
 * already been reaped is not an error, and neither is a `taskkill` that finds
 * nothing. Returns whether the tree signal landed, so a caller that has a
 * weaker fallback — signalling the direct child alone — knows when to use it.
 *
 * Synchronous on both platforms, because one of its callers is a
 * `process.on('exit')` hook — the last chance to avoid an orphan when the
 * daemon is killed mid-attach, and the one place nothing asynchronous will
 * ever run again. On Windows that costs the spawn of a short-lived
 * `taskkill`; the alternative is an exit hook that does not work.
 */
export function killTree(
  pid: number,
  signal: NodeJS.Signals,
  platform: Platform = process.platform,
): boolean {
  const plan = killTreePlan(pid, signal, platform)
  try {
    if (plan.kind === 'group') {
      process.kill(-plan.pid, plan.signal)
      return true
    }
    const result = spawnSync(plan.file, [...plan.args], { stdio: 'ignore', windowsHide: true })
    return result.error === undefined && result.status === 0
  } catch {
    // Already gone, or no `taskkill` on PATH. Either way there is nothing left
    // to do and nothing worth saying.
    return false
  }
}
