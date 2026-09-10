/**
 * `vinta-flow run <workflow.json>` — start the daemon, then execute.
 *
 * The daemon comes up *before* the scheduler starts, and its URL is printed
 * before the first node dispatches. A run lasts hours; an operator who could
 * only reach the UI after the run finished would have no way to watch, steer or
 * answer an `await_human` gate — which is the entire §9 interaction model.
 *
 * This command composes; it decides nothing. The journal freezes the workflow
 * snapshot, `ResourcePools` owns capacity, `AdmissionControl` owns backpressure,
 * and `Scheduler` owns dispatch. What is assembled here is only the wiring, and
 * the one thing wiring can get wrong — teardown — is done in a `finally` so a
 * failed run does not leave a bound port and an open database behind.
 *
 * **What is not wired yet.** The scheduler implements two effect verbs itself
 * (`spawn_agent`, and the pools around `run_gate`) and delegates every other
 * verb body to a host `EffectExecutor`. No such executor unit exists in this
 * package — `src/gates/runner.ts` and `src/integration/` hold the pieces, but
 * nothing composes them — so the default below supplies no facts. Injecting one
 * through `RunDeps` is how a host closes that gap today.
 */
import { parseArgs } from 'node:util'

import { AdmissionControl } from '../admission/admission.ts'
import { runControl, startDaemon, type Daemon } from '../daemon/index.ts'
import { referencedHarnesses } from '../doctor/index.ts'
import type { HarnessAdapter } from '../harness/adapter.ts'
import { ClaudeCodeAdapter } from '../harness/claude-code.ts'
import { CodexAdapter } from '../harness/codex.ts'
import { OpencodeAdapter } from '../harness/opencode.ts'
import { openJournal } from '../journal/journal.ts'
import type { EffectExecutor } from '../pipeline/effects.ts'
import { ResourcePools } from '../resources/pools.ts'
import { createScheduler, type RunStop } from '../scheduler/index.ts'
import type { Workflow } from '../types.ts'
import { FAILED, OK, USAGE, loadWorkflow, type Io } from './io.ts'
import { laneRootFor } from './paths.ts'
import { SERVE_USAGE, announce, toBind } from './serve.ts'

export const RUN_USAGE = `usage: vinta-flow run <workflow.json> [--repo <dir>] [--host <host>] [--port <n>]

${SERVE_USAGE.split('\n').slice(1).join('\n')}`

/** Supplies no facts. See the note at the top of this file. */
const NO_HOST_EFFECTS: EffectExecutor = { execute: async () => ({}) }

export interface RunDeps {
  /** The host's effect verb bodies. */
  readonly executor?: EffectExecutor
  /** Adapters by harness id. Defaults to the real CLI-driving ones. */
  readonly adapters?: Readonly<Record<string, HarnessAdapter>>
  /** Defaults to `<workflow id>-<base36 timestamp>`. */
  readonly runId?: string
  /** Called once the daemon is up and the scheduler has been registered. */
  readonly onStarted?: (daemon: Daemon) => void
}

export async function runCommand(
  argv: readonly string[],
  io: Io,
  deps: RunDeps = {},
): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        repo: { type: 'string' },
        host: { type: 'string' },
        port: { type: 'string' },
      },
      allowPositionals: true,
    })
  } catch {
    io.err(RUN_USAGE)
    return USAGE
  }

  const path = parsed.positionals[0]
  if (path === undefined || parsed.positionals.length > 1) {
    io.err(RUN_USAGE)
    return USAGE
  }

  const bind = toBind(parsed.values, io)
  if (bind === null) return USAGE

  const workflow = await loadWorkflow(path, io)
  if (workflow === null) return FAILED

  const runId = deps.runId ?? `${workflow.id}-${Date.now().toString(36)}`
  const adapters = deps.adapters ?? defaultAdapters(workflow)
  const journal = openJournal(bind.repoPath)

  let daemon: Daemon
  try {
    daemon = await startDaemon({
      journal,
      warn: (message) => io.err(message),
      ...(bind.host === undefined ? {} : { host: bind.host }),
      ...(bind.port === undefined ? {} : { port: bind.port }),
    })
  } catch {
    journal.close()
    io.err(`vinta-flow: could not bind ${bind.host ?? '127.0.0.1'}:${bind.port ?? 0}`)
    return FAILED
  }

  // Freezes the snapshot and journals `run_started` plus one `node_registered`
  // per node — the log the projections are rebuilt from (§5.3).
  journal.createRun(runId, workflow)

  const pools = new ResourcePools(workflow.resources)
  const admission = new AdmissionControl({
    journal,
    runId,
    // A starting hint, not a contract: O1 settles that the real ceiling is
    // discovered at runtime, so the lane count is as good a first guess as any.
    ceilings: Object.fromEntries(
      Object.keys(adapters).map((id) => [id, workflow.resources['lane']?.capacity ?? 1]),
    ),
  })

  const scheduler = createScheduler({
    workflow,
    runId,
    journal,
    pools,
    admission,
    adapters,
    executor: deps.executor ?? NO_HOST_EFFECTS,
    laneRoot: laneRootFor(bind.repoPath),
  })

  daemon.register({ runId, control: runControl(scheduler), pools, admission })
  announce(daemon, io)
  io.out(`vinta-flow: run ${runId} started (${workflow.nodes.length} nodes).`)
  deps.onStarted?.(daemon)

  try {
    const report = await scheduler.run()
    const failed = Object.entries(report.statuses)
      .filter(([, status]) => status === 'failed')
      .map(([id]) => id)

    if (report.stop !== undefined) {
      io.err(`vinta-flow: run ${runId} stopped — ${describeStop(report.stop)}`)
    }
    // Node ids only. Why a node failed is in its transcript, which stays on disk.
    if (failed.length > 0) io.err(`vinta-flow: failed nodes: ${failed.join(', ')}`)

    io.out(`vinta-flow: run ${runId} ${report.status}.`)
    return report.status === 'completed' && failed.length === 0 ? OK : FAILED
  } catch {
    io.err(`vinta-flow: run ${runId} aborted. Its journal is intact and can be inspected.`)
    return FAILED
  } finally {
    admission.close()
    await daemon.close()
    journal.close()
  }
}

/** One real adapter per harness the workflow could dispatch to. */
function defaultAdapters(workflow: Workflow): Record<string, HarnessAdapter> {
  const adapters: Record<string, HarnessAdapter> = {}
  for (const id of referencedHarnesses(workflow)) {
    adapters[id] =
      id === 'claude-code'
        ? new ClaudeCodeAdapter()
        : id === 'codex'
          ? new CodexAdapter()
          : new OpencodeAdapter()
  }
  return adapters
}

/** Identifiers only, matching what `formatSimulation` says about the same union. */
function describeStop(stop: RunStop): string {
  if (stop.kind === 'cycle') return `dependency cycle: ${stop.cycle.join(' → ')}`
  if (stop.kind === 'unsatisfiable') {
    return `node "${stop.nodeId}" requires unknown resource pool "${stop.resource}"`
  }
  return `deadlock, pending: ${stop.pending.join(', ')}`
}
