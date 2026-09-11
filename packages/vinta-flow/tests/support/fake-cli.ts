/**
 * A stand-in coding-agent CLI, on any platform.
 *
 * This suite proves the adapters against a *real child process* rather than a
 * mocked `spawn`, which is the only way the things that actually break — exit
 * codes, stderr framing, stdin that must stay open, a session id read back off
 * a stream — are being tested at all. The fixtures were written as
 * `#!/bin/sh` scripts, and that made every one of them unrunnable on Windows:
 * `CreateProcess` does not read a shebang, and `cmd.exe` shares no syntax with
 * `sh`. Eighty tests were skipped there, which is to say the adapter layer was
 * unverified on a platform the package claims to support.
 *
 * **The fake is Node, and the executable is a launcher.** Behaviour is written
 * once, in the one language guaranteed present on a machine running this suite,
 * and only the *launcher* differs per platform: a `#!/usr/bin/env node` script
 * marked executable on POSIX, a `.cmd` shim that runs `node` on Windows.
 *
 * That is not a workaround — it is what the real thing is. `claude`, `codex`
 * and `opencode` are npm packages, and npm installs exactly this pair: a
 * shebang script on POSIX and a generated `.cmd` shim on Windows. A fixture
 * shaped this way therefore exercises the path a real install takes, including
 * `commandInvocation`'s reason for existing (`src/platform/platform.ts`) — a
 * `.cmd` cannot be handed to `CreateProcess` directly, so the adapters route
 * through `cmd.exe`. Before this, nothing checked that.
 *
 * `render*` take the platform as a parameter, like `src/platform/platform.ts`
 * does, so both launchers are asserted from either kind of machine rather than
 * only the one the author happened to be on.
 */
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type Platform = NodeJS.Platform

const isWindows = (platform: Platform): boolean => platform === 'win32'

/**
 * What a fake CLI does, as data.
 *
 * Deliberately small. Every field here exists because a real fixture needed
 * it; a spec that could express anything would just be shell again, with the
 * portability problem moved rather than solved. Anything outside this
 * vocabulary uses `fakeCliFromSource` and says in Node what it means.
 */
export interface FakeCliSpec {
  /**
   * Answer `--version` with this line and exit 0, before anything else runs.
   *
   * Every adapter's `preflight` asks a CLI for its version first, so almost
   * every fixture needs this and none of them care how it is spelled.
   */
  readonly version?: string
  /** Lines written to stdout, in order, before exiting. */
  readonly stdout?: readonly string[]
  /** Lines written to stderr, in order, before exiting. */
  readonly stderr?: readonly string[]
  /**
   * Read one line from stdin and discard it before writing anything.
   *
   * The adapters that keep stdin open for injection hand the prompt over that
   * way, and a fake that ignored it would let a bug in that handover pass.
   * One *line*, not to EOF: an adapter that holds stdin open for a later
   * injection never closes it, so a fake waiting for EOF waits forever.
   */
  readonly readsLine?: boolean
  /** Stay alive this long instead of exiting — a CLI that hangs. */
  readonly lingerMs?: number
  /** Exit code. Defaults to 0. */
  readonly exit?: number
}

/**
 * Writes the fake and returns the path to hand an adapter as `bin`.
 *
 * `dir` is a caller-owned temp directory; this writes two files into it and
 * removes nothing, because the caller already has teardown for the directory.
 */
export function fakeCli(dir: string, name: string, spec: FakeCliSpec): string {
  return fakeCliFromSource(dir, name, renderSpec(spec))
}

/**
 * The escape hatch: a fake whose behaviour is Node source you write.
 *
 * For the fixtures a spec should not try to describe — the interactive CLI the
 * PTY tests drive, which reads a command loop off its terminal. Writing that as
 * data would mean inventing a language; writing it as Node means it is the same
 * program on both platforms, which is the whole point.
 */
export function fakeCliFromSource(dir: string, name: string, source: string): string {
  const scriptPath = join(dir, `${name}.mjs`)
  writeFileSync(scriptPath, source.endsWith('\n') ? source : `${source}\n`, 'utf8')
  return writeLauncher(dir, name, scriptPath)
}

/**
 * The executable an adapter is pointed at. POSIX gets a shebang script marked
 * executable; Windows gets a `.cmd` shim, because `CreateProcess` cannot run
 * either a shebang or a `.mjs`.
 */
function writeLauncher(dir: string, name: string, scriptPath: string): string {
  if (isWindows(process.platform)) {
    const path = join(dir, `${name}.cmd`)
    writeFileSync(path, renderWindowsLauncher(scriptPath), 'utf8')
    return path
  }
  const path = join(dir, name)
  writeFileSync(path, renderPosixLauncher(scriptPath), 'utf8')
  chmodSync(path, 0o755)
  return path
}

/**
 * `exec` rather than a plain call, so the fake *replaces* the shell instead of
 * running under it. A test that kills the process it spawned would otherwise
 * kill a `sh` and leave `node` orphaned, and "takeover leaves no orphan" is a
 * claim several of these fixtures exist to check.
 */
export function renderPosixLauncher(scriptPath: string): string {
  return `#!/bin/sh\nexec node ${JSON.stringify(scriptPath)} "$@"\n`
}

/**
 * `@echo off` so the shim's own lines never reach a stream a test is reading,
 * and `%*` to forward arguments. No `exec` equivalent exists, so `cmd.exe`
 * stays in the tree — which is exactly what a real npm `.cmd` shim does too,
 * and why the platform seam kills process *trees* rather than single pids.
 */
export function renderWindowsLauncher(scriptPath: string): string {
  return `@echo off\r\nnode "${scriptPath}" %*\r\n`
}

/** The spec as a Node program. */
function renderSpec(spec: FakeCliSpec): string {
  const lines: string[] = []

  if (spec.version !== undefined) {
    lines.push(
      `if (process.argv.slice(2).includes('--version')) {`,
      `  process.stdout.write(${JSON.stringify(`${spec.version}\n`)})`,
      `  process.exit(0)`,
      `}`,
    )
  }

  const body: string[] = []
  for (const line of spec.stdout ?? []) {
    body.push(`process.stdout.write(${JSON.stringify(`${line}\n`)})`)
  }
  for (const line of spec.stderr ?? []) {
    body.push(`process.stderr.write(${JSON.stringify(`${line}\n`)})`)
  }
  // `exit` after a linger, so a fixture can both hang and then end.
  body.push(
    spec.lingerMs === undefined
      ? `process.exit(${spec.exit ?? 0})`
      : `setTimeout(() => process.exit(${spec.exit ?? 0}), ${spec.lingerMs})`,
  )

  if (spec.readsLine !== true) {
    lines.push(...body)
    return lines.join('\n')
  }

  // One line off stdin, then the rest. `readline` rather than a chunk read
  // because the prompt is a line and the stream may deliver it in pieces.
  lines.push(
    `import { createInterface } from 'node:readline'`,
    `const rl = createInterface({ input: process.stdin })`,
    `rl.once('line', () => {`,
    `  rl.close()`,
    ...body.map((statement) => `  ${statement}`),
    `})`,
  )
  return lines.join('\n')
}
