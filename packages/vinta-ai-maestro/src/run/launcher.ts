/**
 * `vinta-ai-maestro` on every lane agent's `PATH`.
 *
 * The prompts tell an agent to take a lease with `vinta-ai-maestro with
 * <resource> -- <command>` and to run a gate with `vinta-ai-maestro gate
 * <id>`. Both assume the binary resolves from inside the lane, and it does
 * not when maestro was installed as the project's devDependency: the daemon
 * was started through `node_modules/.bin`, or `npx`, or a checkout alias,
 * none of which puts anything on the `PATH` an agent's shell inherits. The
 * observed result was reviewers reporting "lease command missing" and
 * skipping the test suite rather than running it unleased — the correct
 * reading of the prompt, and the worst possible outcome of it.
 *
 * So the daemon writes a launcher for *itself* — the Node that is running it,
 * with the flags it was started with, pointed at its own entry file — into
 * the project's store, and puts that directory first on the agents' `PATH`.
 * It is the same pair npm installs for any CLI (`tests/support/fake-cli.ts`
 * has the whole argument): a shebang script on POSIX, a `.cmd` shim on
 * Windows. Whatever way the daemon was started, the agents reach the same
 * build.
 *
 * Written on every run start, because the entry can move between installs
 * and a stale launcher would run yesterday's maestro against today's daemon.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { isWindows, type Platform } from '../platform/platform.ts'

export const LAUNCHER_DIRNAME = 'bin'
export const BINARY_NAME = 'vinta-ai-maestro'

export interface LauncherSource {
  /** `process.execPath`: the Node running the daemon. */
  readonly execPath: string
  /** `process.execArgv`: the flags it was started with — the type-stripping ones, from a checkout. */
  readonly execArgv: readonly string[]
  /** `process.argv[1]`: the daemon's own entry file. */
  readonly entry: string
  readonly platform?: Platform
}

/** Shell-quotes one word for `sh`. */
const sh = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`

/** Quotes one word for `cmd.exe`. */
const cmd = (word: string): string => `"${word.replaceAll('"', '""')}"`

export function renderPosixLauncher(source: LauncherSource): string {
  const words = [source.execPath, ...source.execArgv, source.entry].map(sh).join(' ')
  // `exec`, so the agent's shell sees maestro itself as the child and a
  // signal to the tree reaches it rather than an `sh` in front of it.
  return `#!/bin/sh\nexec ${words} "$@"\n`
}

export function renderWindowsLauncher(source: LauncherSource): string {
  const words = [source.execPath, ...source.execArgv, source.entry].map(cmd).join(' ')
  return `@echo off\r\n${words} %*\r\n`
}

/**
 * Writes the launcher under `<store>/bin/` and returns that directory, to go
 * first on the agents' `PATH`.
 */
export function ensureLauncher(storeDir: string, source: LauncherSource): string {
  const dir = join(storeDir, LAUNCHER_DIRNAME)
  mkdirSync(dir, { recursive: true })
  if (isWindows(source.platform)) {
    writeFileSync(join(dir, `${BINARY_NAME}.cmd`), renderWindowsLauncher(source), 'utf8')
    return dir
  }
  const path = join(dir, BINARY_NAME)
  writeFileSync(path, renderPosixLauncher(source), 'utf8')
  chmodSync(path, 0o755)
  return dir
}

/** `dir` first, then whatever `PATH` the daemon has. */
export function withLauncherOnPath(dir: string, path: string | undefined): string {
  return path === undefined || path === '' ? dir : `${dir}${delimiter}${path}`
}

/** The daemon's own process, as a launcher source. */
export function selfSource(): LauncherSource {
  return {
    execPath: process.execPath,
    execArgv: process.execArgv,
    entry: process.argv[1] ?? '',
  }
}
