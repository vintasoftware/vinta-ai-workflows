/**
 * What a phase is running, as processes. A phase whose agent waited on a suite
 * it had started in the background read as stuck: nothing on the node view
 * said anything was running at all.
 */
import { describe, expect, it } from 'vitest'

import type { LiveGate } from '../src/gates/runner.ts'
import {
  descendants,
  parseElapsed,
  parsePsTable,
  parseWindowsTable,
  stopTree,
  type ProcessTable,
} from '../src/platform/processes.ts'
import { displayCommand, nodeProcesses, stopNodeProcess, type ProcessSources } from '../src/processes/list.ts'

const NOW = 1_700_000_000_000

describe('the process table', () => {
  it('reads ps, with elapsed times of every shape', () => {
    const table = parsePsTable(
      ['  101     1    05:00 /usr/local/bin/claude --print', '  202   101 1-02:03:04 /bin/zsh -c pytest', 'garbage'].join('\n'),
      NOW,
    )
    expect(table).toEqual([
      { pid: 101, ppid: 1, startedAt: NOW - 300_000, command: '/usr/local/bin/claude --print' },
      { pid: 202, ppid: 101, startedAt: NOW - (86_400 + 7_384) * 1000, command: '/bin/zsh -c pytest' },
    ])
    expect(parseElapsed('00:07')).toBe(7)
    expect(parseElapsed('nonsense')).toBeNull()
  })

  it('reads PowerShell’s Win32_Process JSON, one object or many', () => {
    expect(
      parseWindowsTable('{"ProcessId":4,"ParentProcessId":0,"CreationDate":"/Date(1700000000000)/","CommandLine":null}'),
    ).toEqual([{ pid: 4, ppid: 0, startedAt: 1_700_000_000_000, command: '' }])
    expect(
      parseWindowsTable('[{"ProcessId":8,"ParentProcessId":4,"CreationDate":"2023-11-14T22:13:20Z","CommandLine":"cmd.exe /c test"}]'),
    ).toEqual([{ pid: 8, ppid: 4, startedAt: 1_700_000_000_000, command: 'cmd.exe /c test' }])
  })

  it('walks a tree, and stops it deepest first, killing what ignored the polite signal', async () => {
    const table: ProcessTable = [
      row(1, 0, 'agent'),
      row(2, 1, 'sh -c pytest'),
      row(3, 2, 'pytest'),
      row(4, 3, 'pytest worker'),
      row(9, 1, 'sh -c other'),
    ]
    expect(descendants(table, 2).map((entry) => entry.pid)).toEqual([3, 4])

    const sent: [number, string][] = []
    await stopTree(2, {
      table,
      graceMs: 0,
      sleep: async () => {},
      // pytest's worker ignored SIGTERM.
      read: async () => [row(4, 3, 'pytest worker')],
      signal: (pid, signal) => sent.push([pid, signal]),
    })
    expect(sent).toEqual([
      [4, 'SIGTERM'],
      [3, 'SIGTERM'],
      [2, 'SIGTERM'],
      [4, 'SIGKILL'],
    ])
  })
})

describe('a phase’s processes', () => {
  const claudeShell = (command: string): string =>
    `/bin/zsh -c -l source /Users/x/.claude/shell-snapshots/snapshot-zsh-1.sh && eval '${command.replaceAll("'", "'\\''")}' \\< /dev/null && pwd -P >| /tmp/claude-cwd`

  const sources = (overrides: Partial<ProcessSources> = {}, table: ProcessTable = []): ProcessSources => ({
    liveTurn: () => ({ pid: 100, foreground: ['make test'] }),
    lanePath: () => '/lanes/run-1-lane-1',
    integrationPath: '/integration',
    integrationHolder: () => null,
    gates: () => [],
    table: async () => table,
    stopGate: () => true,
    ...overrides,
  })

  it('lists the agent’s commands, foreground and background, and leaves out what is not a shell', async () => {
    const table: ProcessTable = [
      row(100, 1, 'claude --print'),
      row(101, 100, claudeShell('make test'), NOW - 60_000),
      row(102, 101, 'pytest -n auto'),
      row(103, 100, claudeShell("pnpm dev --port 3000 && echo 'up'"), NOW - 600_000),
      row(104, 100, 'node /mcp/server.js'),
    ]
    const listed = await nodeProcesses(sources({}, table), 'p1')
    expect(listed).toEqual([
      { pid: 101, kind: 'agent', mode: 'foreground', command: 'make test', gateId: null, startedAt: NOW - 60_000, descendants: 1 },
      {
        pid: 103,
        kind: 'agent',
        mode: 'background',
        command: "pnpm dev --port 3000 && echo 'up'",
        gateId: null,
        startedAt: NOW - 600_000,
        descendants: 0,
      },
    ])
  })

  it('attributes gates by where they run: the phase’s lane, or the integration worktree while it holds it', async () => {
    const gates: LiveGate[] = [
      { pid: 300, gateId: 'unit', cwd: '/lanes/run-1-lane-1', startedAt: NOW - 5_000 },
      { pid: 301, gateId: 'lint', cwd: '/lanes/run-1-lane-2', startedAt: NOW },
      { pid: 302, gateId: 'unit', cwd: '/integration', startedAt: NOW },
    ]
    const table = [row(300, 1, 'sh -c pytest'), row(301, 1, 'sh -c ruff'), row(302, 1, 'sh -c pytest')]
    const notHolding = await nodeProcesses(sources({ gates: () => gates, liveTurn: () => null }, table), 'p1')
    expect(notHolding?.map((entry) => [entry.pid, entry.kind, entry.gateId, entry.mode])).toEqual([[300, 'gate', 'unit', 'foreground']])

    const holding = await nodeProcesses(
      sources({ gates: () => gates, liveTurn: () => null, integrationHolder: () => 'p1' }, table),
      'p1',
    )
    expect(holding?.map((entry) => entry.pid)).toEqual([300, 302])
  })

  it('answers null, not an empty list, when the table cannot be read', async () => {
    expect(await nodeProcesses(sources({ table: async () => null }), 'p1')).toBeNull()
  })

  it('stops only a process the phase is running now, a gate through the runner', async () => {
    const stoppedTrees: number[] = []
    const stoppedGates: number[] = []
    const table: ProcessTable = [row(100, 1, 'claude'), row(101, 100, claudeShell('sleep 600')), row(300, 1, 'sh -c pytest')]
    const wired = sources(
      {
        gates: () => [{ pid: 300, gateId: 'unit', cwd: '/lanes/run-1-lane-1', startedAt: NOW }],
        stopGate: (pid) => {
          stoppedGates.push(pid)
          return true
        },
        stopTree: async (pid) => {
          stoppedTrees.push(pid)
        },
      },
      table,
    )

    expect((await stopNodeProcess(wired, 'p1', 101)).stopped).toBe(true)
    expect((await stopNodeProcess(wired, 'p1', 300)).stopped).toBe(true)
    // The agent's CLI itself, and a pid the phase is not running.
    expect((await stopNodeProcess(wired, 'p1', 100)).stopped).toBe(false)
    expect((await stopNodeProcess(wired, 'p1', 4242)).stopped).toBe(false)
    expect(stoppedTrees).toEqual([101])
    expect(stoppedGates).toEqual([300])
  })

  it('unwraps the shells the harnesses run commands in', () => {
    expect(displayCommand(claudeShell("grep -r 'it' src"))).toBe("grep -r 'it' src")
    expect(displayCommand("/bin/bash -lc 'pnpm test'")).toBe('pnpm test')
    expect(displayCommand('python manage.py runserver')).toBe('python manage.py runserver')
  })
})

function row(pid: number, ppid: number, command: string, startedAt = NOW): ProcessTable[number] {
  return { pid, ppid, startedAt, command }
}
