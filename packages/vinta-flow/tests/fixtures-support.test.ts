/**
 * The fixture helpers themselves.
 *
 * These exist so the rest of the suite can stop being POSIX-only, which means
 * they are the one place where "does the Windows spelling make sense" has to be
 * answered — and answered from whatever machine the author is on, because
 * otherwise it is answered by CI twenty minutes later, or not at all.
 *
 * So the renderers take a platform and both branches are asserted here. The
 * running-it-for-real half is covered by every migrated suite: those spawn the
 * fake and read what comes back, on whichever platform they are running.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { commandInvocation } from '../src/platform/platform.ts'
import {
  fakeCli,
  fakeCliFromSource,
  renderPosixLauncher,
  renderWindowsLauncher,
} from './support/fake-cli.ts'
import { renderGate } from './support/gate-script.ts'

/**
 * Runs a fake the way the adapters do — through `commandInvocation`.
 *
 * Not a detail. On Windows the launcher is a `.cmd`, and since
 * CVE-2024-27980 Node refuses to spawn one without a shell: calling
 * `execFileSync(bin, …)` here answered `EINVAL` and took four of these tests
 * and everything downstream of them with it. That is exactly the restriction
 * `commandInvocation` exists to handle, and every spawn in `src/` already goes
 * through it — so a test that reached past it was testing something no caller
 * does. Going through the seam also means these tests exercise the same
 * `cmd.exe` routing a real npm-installed CLI needs.
 */
function runFake(
  bin: string,
  args: readonly string[],
  options: { readonly input?: string } = {},
): { status: number; stdout: string; stderr: string } {
  const invocation = commandInvocation(bin, args)
  // `spawnSync` rather than `execFileSync`: it reports a non-zero exit as a
  // value instead of a throw — several of these fixtures exit non-zero on
  // purpose — and its options are the ones `windowsVerbatimArguments` belongs
  // to, which is what carries `commandInvocation`'s pre-quoted command line
  // through unmangled.
  const result = spawnSync(invocation.file, [...invocation.args], {
    encoding: 'utf8',
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    ...(options.input === undefined ? {} : { input: options.input }),
  })
  if (result.error !== undefined) throw result.error
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

const temps: string[] = []
const makeTemp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-flow-fixtures-'))
  temps.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

describe('the fake CLI launcher', () => {
  it('is a shebang script that replaces itself with node, on POSIX', () => {
    const rendered = renderPosixLauncher('/tmp/x/fake.mjs')

    expect(rendered.startsWith('#!/bin/sh\n')).toBe(true)
    // `exec`, so a test that kills what it spawned does not leave `node`
    // orphaned behind a dead `sh`.
    expect(rendered).toContain('exec node')
    expect(rendered).toContain('"$@"')
  })

  it('is a .cmd shim that runs node, on Windows', () => {
    const rendered = renderWindowsLauncher('C:\\tmp\\x\\fake.mjs')

    // What npm itself generates for a package `bin` on Windows — which is the
    // reason the adapters route a spawn through `cmd.exe` at all.
    expect(rendered).toContain('@echo off')
    expect(rendered).toContain('node "C:\\tmp\\x\\fake.mjs" %*')
    // No shebang: `CreateProcess` would not read one, and `cmd` does not care.
    expect(rendered).not.toContain('#!')
  })
})

describe('the fake CLI, actually running', () => {
  it('answers --version and exits before doing anything else', () => {
    const bin = fakeCli(makeTemp(), 'versioned', {
      version: '1.2.3 (Fake)',
      stdout: ['this line must not be reached'],
      exit: 4,
    })

    const { stdout } = runFake(bin, ['--version'])

    expect(stdout.trim()).toBe('1.2.3 (Fake)')
    expect(stdout).not.toContain('must not be reached')
  })

  it('writes its scripted streams and exit code', () => {
    const bin = fakeCli(makeTemp(), 'noisy', {
      stdout: ['{"type":"system"}', 'second'],
      stderr: ['a diagnostic'],
      exit: 3,
    })

    const { status, stdout, stderr } = runFake(bin, [])

    expect(status).toBe(3)
    expect(stdout).toContain('{"type":"system"}')
    expect(stdout).toContain('second')
    expect(stderr).toContain('a diagnostic')
  })

  it('waits for a line of stdin before it says anything', () => {
    // The handover the adapters rely on: the prompt goes in over stdin, and a
    // fake that answered first would let a broken handover pass.
    const bin = fakeCli(makeTemp(), 'reader', { readsLine: true, stdout: ['after-the-prompt'] })

    const { stdout } = runFake(bin, [], { input: 'the prompt\n' })

    expect(stdout).toContain('after-the-prompt')
  })

  it('runs arbitrary source, and is handed its arguments', () => {
    const bin = fakeCliFromSource(
      makeTemp(),
      'args',
      `process.stdout.write('args:' + process.argv.slice(2).join(',') + '\\n')`,
    )

    expect(runFake(bin, ['one', 'two']).stdout.trim()).toBe('args:one,two')
  })
})

describe('rendering a gate', () => {
  const script = {
    stdout: ['out-line'],
    stderr: ['err-line'],
    echoEnv: ['GATE_MARKER'],
    printCwd: true,
    exit: 3,
  } as const

  it('is sh on POSIX', () => {
    expect(renderGate(script, 'darwin')).toBe(
      `echo 'out-line'; echo 'err-line' 1>&2; echo "$GATE_MARKER"; pwd; exit 3`,
    )
  })

  it('is cmd.exe on Windows, which shares none of that syntax', () => {
    // Every difference here is one the old fixtures got wrong by not having:
    // `&` not `;`, `%VAR%` not `$VAR`, `cd` not `pwd`, `exit /b` not `exit`.
    expect(renderGate(script, 'win32')).toBe(
      'echo out-line & echo err-line 1>&2 & echo %GATE_MARKER% & cd & exit /b 3',
    )
  })

  it('separates unconditionally, so a failing step cannot skip the exit', () => {
    expect(renderGate({ stdout: ['a'], exit: 1 }, 'darwin')).not.toContain('&&')
    expect(renderGate({ stdout: ['a'], exit: 1 }, 'win32')).not.toContain('&&')
  })

  it('appends without the trailing space cmd.exe would otherwise write', () => {
    // `echo ran >> f` on Windows writes "ran " — with the space — which a test
    // counting exact lines would never match.
    expect(renderGate({ append: { path: 'C:\\t\\c.txt', line: 'ran' } }, 'win32')).toBe(
      'echo ran>> "C:\\t\\c.txt"',
    )
  })

  it('backgrounds a grandchild that reports its own pid, on both shells', () => {
    const spec = { background: { seconds: 60, pidFile: '/t/pid' } } as const

    // `&` on sh, `start /b` on cmd — and node on both, because `$!` has no
    // Windows counterpart and the subject is the process tree, not the syntax.
    expect(renderGate(spec, 'darwin')).toContain('node -e "')
    expect(renderGate(spec, 'darwin')).toContain('&')
    // `sh` treats `&` as a terminator, so a `;` after it does not parse. Joined
    // as two steps the shell died instantly, the gate came back `failed` in
    // 200ms, and the timeout the fixture exists to test never fired.
    expect(renderGate(spec, 'darwin')).not.toContain('&;')
    expect(renderGate(spec, 'win32')).toContain('start /b node -e "')
    // The pid comes from the child itself rather than from the shell.
    expect(renderGate(spec, 'win32')).toContain('process.pid')
  })

  it('refuses fixture text cmd.exe cannot echo, rather than changing it', () => {
    // `shellQuote` refuses `"` and `%` for the same reason: there is no escape
    // for them inside a quoted region, so the honest answer is to say so.
    expect(() => renderGate({ stdout: ['a > b'] }, 'win32')).toThrow(/not renderable/)
    expect(() => renderGate({ stdout: ['100%'] }, 'win32')).toThrow(/not renderable/)
    // …and on POSIX the same text is fine, so this is not a vocabulary limit.
    expect(renderGate({ stdout: ['a > b'] }, 'darwin')).toContain('a > b')
  })
})
