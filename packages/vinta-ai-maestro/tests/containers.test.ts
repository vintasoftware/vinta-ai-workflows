/**
 * Containers a killed command leaves running. A gate's process group dies on
 * a timeout, but `docker compose run`'s container belongs to the docker daemon:
 * one observed run had two such containers running for 6 and 22 minutes against
 * the lane databases of the rerun that replaced them, until someone stopped
 * them by hand.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runCommand } from '../src/coordinator/exec.ts'
import { executeGate, killLiveGates, runGate } from '../src/gates/runner.ts'
import { sweepOrphanContainers } from '../src/lanes/orphans.ts'
import { stopOneOffsSince, type DockerExec } from '../src/platform/containers.ts'
import { ResourcePools } from '../src/resources/pools.ts'
import { renderGate } from './support/gate-script.ts'

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'vinta-ai-maestro-containers-'))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

/** A docker CLI answering `ps`, `inspect` and `rm` from a table, recording each call. */
function fakeDocker(containers: Record<string, { project: string; created: string }>) {
  const calls: string[][] = []
  const removed: string[] = []
  const exec: DockerExec = async (args) => {
    calls.push([...args])
    if (args[0] === 'ps') {
      const project = args.find((arg) => arg.startsWith('label=com.docker.compose.project='))?.split('=')[2]
      return Object.entries(containers)
        .filter(([id, c]) => c.project === project && !removed.includes(id))
        .map(([id]) => id)
        .join('\n')
    }
    if (args[0] === 'inspect') {
      return args
        .slice(3)
        .map((id) => `${id} ${containers[id]?.created}`)
        .join('\n')
    }
    if (args[0] === 'rm') {
      removed.push(...args.slice(2))
      return ''
    }
    return ''
  }
  return { exec, calls, removed }
}

describe('stopping a killed command’s containers', () => {
  it('stops the lane project’s one-offs created since the command started, and no others', async () => {
    const started = Date.parse('2026-10-19T06:00:00Z')
    const docker = fakeDocker({
      before: { project: 'repo_lane-1', created: '2026-10-19T05:00:00Z' },
      mine: { project: 'repo_lane-1', created: '2026-10-19T06:00:05Z' },
      elsewhere: { project: 'repo_lane-2', created: '2026-10-19T06:00:05Z' },
    })
    expect(await stopOneOffsSince('repo_lane-1', started, docker.exec)).toEqual(['mine'])
    expect(docker.removed).toEqual(['mine'])
    // Only compose `run` containers: the lane's long-lived services are not one-offs.
    expect(docker.calls[0]).toContain('label=com.docker.compose.oneoff=True')
  })

  it('does nothing, quietly, without docker', async () => {
    const missing: DockerExec = async () => {
      throw new Error('spawn docker ENOENT')
    }
    expect(await stopOneOffsSince('repo_lane-1', 0, missing)).toEqual([])
  })

  it('stops a timed-out gate’s containers before its pools are released', async () => {
    const pools = new ResourcePools({ 'test-suite': { capacity: 1, kind: 'semaphore' } }, { agingMs: 0 })
    let heldDuringCleanup: number | null = null
    const projects: string[] = []
    const result = await runGate({
      gateId: 'test',
      gate: {
        cmd: renderGate({ background: { seconds: 60, pidFile: join(workspace, 'pid') } }),
        requires: ['test-suite'],
        timeout_s: 1,
      },
      cwd: workspace,
      env: { COMPOSE_PROJECT_NAME: 'repo_lane-1' },
      logPath: join(workspace, 'test.log'),
      pools,
      stopContainers: async (project) => {
        projects.push(project)
        heldDuringCleanup = pools.held('test-suite')
        return ['c1']
      },
    })
    expect(result.status).toBe('timed_out')
    expect(result.containersStopped).toBe(1)
    expect(projects).toEqual(['repo_lane-1'])
    // The next holder of `test-suite` must not share the lane with the container.
    expect(heldDuringCleanup).toBe(1)
    expect(pools.held('test-suite')).toBe(0)
    expect(await readFile(join(workspace, 'test.log'), 'utf8')).toContain('stopped 1 container(s)')
  }, 20_000)

  it('stops a cancelled gate’s containers too, and leaves a gate that exited alone untouched', async () => {
    const stopped: string[] = []
    const stopContainers = async (project: string) => {
      stopped.push(project)
      return []
    }
    const running = executeGate({
      gateId: 'test',
      gate: { cmd: renderGate({ background: { seconds: 60, pidFile: join(workspace, 'pid') } }), requires: [], timeout_s: 60 },
      cwd: workspace,
      env: { COMPOSE_PROJECT_NAME: 'repo_lane-1' },
      logPath: join(workspace, 'cancel.log'),
      stopContainers,
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    killLiveGates()
    await running
    expect(stopped).toEqual(['repo_lane-1'])

    await executeGate({
      gateId: 'lint',
      gate: { cmd: renderGate({ stdout: ['ok'] }), requires: [], timeout_s: 30 },
      cwd: workspace,
      env: { COMPOSE_PROJECT_NAME: 'repo_lane-1' },
      logPath: join(workspace, 'lint.log'),
      stopContainers,
    })
    expect(stopped).toEqual(['repo_lane-1'])
  }, 20_000)

  it('stops a cancelled exec’s containers', async () => {
    const abort = new AbortController()
    const stopped: string[] = []
    const running = runCommand(
      { path: workspace, env: { COMPOSE_PROJECT_NAME: 'repo_lane-1' } },
      renderGate({ background: { seconds: 60, pidFile: join(workspace, 'pid') } }),
      () => {},
      abort.signal,
      async (project) => {
        stopped.push(project)
        return []
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    abort.abort()
    await running
    expect(stopped).toEqual(['repo_lane-1'])
  }, 20_000)
})

describe('the orphan sweep', () => {
  it('stops one-offs only in lanes nobody holds', async () => {
    const docker = fakeDocker({
      idle: { project: 'p_idle', created: '2026-10-19T06:00:00Z' },
      busy: { project: 'p_busy', created: '2026-10-19T06:00:00Z' },
    })
    const swept = await sweepOrphanContainers({
      lanes: [
        { name: 'lane-idle', project: 'p_idle' },
        { name: 'lane-busy', project: 'p_busy' },
        { name: 'lane-plain', project: undefined },
      ],
      busy: (lane) => lane === 'lane-busy',
      exec: docker.exec,
    })
    expect(swept).toEqual([{ lane: 'lane-idle', stopped: ['idle'] }])
    expect(docker.removed).toEqual(['idle'])
  })
})
