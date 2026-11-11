/**
 * The launcher the daemon writes for itself, so `vinta-ai-maestro with …` and
 * `vinta-ai-maestro gate …` resolve from inside a lane however maestro was
 * installed (`src/run/launcher.ts`).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  BINARY_NAME,
  ensureLauncher,
  renderPosixLauncher,
  renderWindowsLauncher,
  withLauncherOnPath,
} from '../src/run/launcher.ts'

const temps: string[] = []
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})
const makeTemp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-launcher-'))
  temps.push(dir)
  return dir
}

describe('the daemon’s own launcher', () => {
  it('renders the Node, the flags and the entry the daemon itself runs with, quoted', () => {
    const source = {
      execPath: '/opt/node 24/bin/node',
      execArgv: ['--experimental-transform-types'],
      entry: "/home/o'brien/vinta-ai-workflows/packages/vinta-ai-maestro/src/cli/bin.ts",
    }
    expect(renderPosixLauncher({ ...source, platform: 'linux' })).toBe(
      "#!/bin/sh\nexec '/opt/node 24/bin/node' '--experimental-transform-types' " +
        "'/home/o'\\''brien/vinta-ai-workflows/packages/vinta-ai-maestro/src/cli/bin.ts' \"$@\"\n",
    )
    expect(renderWindowsLauncher({ ...source, execPath: 'C:\\Program Files\\nodejs\\node.exe', platform: 'win32' })).toBe(
      '@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "--experimental-transform-types" ' +
        '"/home/o\'brien/vinta-ai-workflows/packages/vinta-ai-maestro/src/cli/bin.ts" %*\r\n',
    )
  })

  it('writes the platform’s executable under the store and puts it first on PATH', () => {
    const store = makeTemp()
    const source = { execPath: process.execPath, execArgv: [], entry: '/x/bin.js' }

    const posix = ensureLauncher(store, { ...source, platform: 'linux' })
    expect(posix).toBe(join(store, 'bin'))
    expect(existsSync(join(posix, BINARY_NAME))).toBe(true)
    if (process.platform !== 'win32') expect(statSync(join(posix, BINARY_NAME)).mode & 0o111).not.toBe(0)

    const windows = ensureLauncher(makeTemp(), { ...source, platform: 'win32' })
    expect(existsSync(join(windows, `${BINARY_NAME}.cmd`))).toBe(true)

    expect(withLauncherOnPath('/store/bin', '/usr/bin')).toBe(`/store/bin${delimiter}/usr/bin`)
    expect(withLauncherOnPath('/store/bin', undefined)).toBe('/store/bin')
  })

  it.skipIf(process.platform === 'win32')('runs the daemon’s entry, forwarding the arguments', () => {
    const store = makeTemp()
    const entry = join(store, 'entry.mjs')
    writeFileSync(entry, "console.log(JSON.stringify(process.argv.slice(2)))\n", 'utf8')
    const bin = ensureLauncher(store, { execPath: process.execPath, execArgv: [], entry })

    // Through PATH, the way an agent's shell reaches it.
    const out = execFileSync('sh', ['-c', 'vinta-ai-maestro with test-suite -- "pnpm test"'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: withLauncherOnPath(bin, process.env['PATH']) },
    })
    expect(JSON.parse(out)).toEqual(['with', 'test-suite', '--', 'pnpm test'])
    // Rewritten on every start, not appended to.
    ensureLauncher(store, { execPath: process.execPath, execArgv: ['--no-warnings'], entry })
    expect(readFileSync(join(bin, BINARY_NAME), 'utf8')).toContain("'--no-warnings'")
  })
})
