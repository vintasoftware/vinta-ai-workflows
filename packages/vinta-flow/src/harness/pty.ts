/**
 * One pseudoterminal, opened the same way for every harness that has one.
 *
 * §9's take over is interrupt → PTY attach → detach → resume headless. This
 * module owns the middle two verbs and nothing else: an adapter decides *what*
 * to run — `claude --resume <id>`, `codex resume <id>` — and this decides how
 * it is run, torn down, and proven gone. Three adapters spawning their own
 * pty and rolling their own kill is where the orphan lives in exactly one of
 * them.
 *
 * **A PTY is a shell on the operator's machine**, with the operator's own
 * privileges, in a lane worktree. Two rules follow and neither is negotiable.
 *
 * - **Nothing here reads the bytes.** `onData` hands them to one listener and
 *   this module keeps no copy: not a buffer for diagnostics, not a tail for an
 *   error message, not a line in the journal. A terminal carries repository
 *   contents and whatever the operator typed, which can be a pasted
 *   credential (§11). The only place a byte legitimately goes is the socket
 *   the operator's own terminal is on.
 * - **Nothing outlives its handle.** node-pty forks its child into a new
 *   session, so the pid is a process-group leader and `kill(-pid)` reaches
 *   the shell *and* everything it started. `detach` signals the group and
 *   resolves only once the child is reaped, so "no orphan" is a claim a caller
 *   can assert with `process.kill(pid, 0)` rather than hope for. The
 *   process-exit hook below is the same guarantee for the case no `detach`
 *   ever runs: the daemon being killed mid-attach.
 */
import { spawn as spawnPty, type IPty } from 'node-pty'
import { commandInvocation, type Invocation, killTree } from '../platform/platform.ts'
import type { PtyAttach, PtyHandle } from './adapter.ts'

/** What a terminal announces itself as when the environment names nothing. */
const TERM = 'xterm-256color'

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

/** How long a hung-up terminal has to exit on its own before it is killed. */
const HANGUP_GRACE_MS = 1_000

export interface PtySpec {
  /** §9's handoff token, carried onto the handle unchanged. */
  readonly sessionId: string
  readonly file: string
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
  readonly attach: PtyAttach
}

/**
 * Every terminal this process has open. The exit hook below is the last line
 * against an orphan: a daemon killed mid-attach never runs a `detach`, and
 * `process.on('exit')` is the one place still able to signal synchronously.
 */
const open = new Set<IPty>()

process.once('exit', () => {
  for (const pty of open) signalGroup(pty.pid, 'SIGKILL')
})

/**
 * The tree, then the pid, then silence: signalling a reaped child is not an
 * error. `killTree` is the platform seam — a process-group signal on POSIX,
 * `taskkill /T` on Windows, which has no groups. Both are synchronous, which
 * the exit hook above depends on.
 */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  if (killTree(pid, signal)) return
  try {
    process.kill(pid, signal)
  } catch {
    // Already reaped.
  }
}

/** node-pty reads a string as a verbatim command line and an array as argv. */
const argv = (invocation: Invocation): string[] | string =>
  invocation.windowsVerbatimArguments ? invocation.args.join(' ') : [...invocation.args]

export function openPty(spec: PtySpec): PtyHandle {
  const cols = Math.max(1, spec.attach.cols ?? DEFAULT_COLS)
  const rows = Math.max(1, spec.attach.rows ?? DEFAULT_ROWS)
  // ConPTY spawns through `CreateProcess`, which cannot run the `.cmd` shim npm
  // installs a CLI as — so on Windows the terminal's process is `cmd.exe` and
  // the CLI is the shell's child. node-pty takes a raw command line when `args`
  // is a string, which is exactly what the Windows invocation already is; on
  // POSIX the pair passes through unchanged.
  const invocation = commandInvocation(spec.file, spec.args)
  const pty = spawnPty(invocation.file, argv(invocation), {
    name: spec.env['TERM'] ?? TERM,
    cols,
    rows,
    cwd: spec.attach.cwd,
    env: { ...spec.env, TERM: spec.env['TERM'] ?? TERM },
  })
  open.add(pty)

  let alive = true
  let settle: (code: number) => void = () => {}
  const exited = new Promise<number>((resolve) => {
    settle = resolve
  })
  pty.onExit(({ exitCode }) => {
    alive = false
    open.delete(pty)
    settle(exitCode)
  })

  return {
    sessionId: spec.sessionId,
    pid: pty.pid,
    exited,
    onData: (listener) => {
      pty.onData((data) => listener(data))
    },
    write: (data) => {
      // A keystroke that arrives after the terminal ended is dropped. The
      // socket and the child close independently, so this is a race, not a bug.
      if (alive) pty.write(data)
    },
    resize: (nextCols, nextRows) => {
      if (alive) pty.resize(Math.max(1, nextCols), Math.max(1, nextRows))
    },
    detach: async () => {
      if (!alive) {
        await exited
        return
      }
      // SIGHUP first, so a CLI that persists its session on the way out gets
      // to. SIGKILL is the deadline, because a terminal that ignores a hangup
      // would otherwise be the orphan this whole module exists to prevent.
      signalGroup(pty.pid, 'SIGHUP')
      const deadline = setTimeout(() => signalGroup(pty.pid, 'SIGKILL'), HANGUP_GRACE_MS)
      try {
        await exited
      } finally {
        clearTimeout(deadline)
      }
    },
  }
}
