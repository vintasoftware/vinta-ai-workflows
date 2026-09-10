/**
 * The operator-facing rendering of a simulation (§13.1's "CLI flag").
 *
 * Deterministic by construction — fixed column widths, declaration order, no
 * timestamps, no paths, no locale-dependent formatting — so the same workflow
 * and the same estimates print byte-identical text twice. That is what makes a
 * projection comparable: re-run it with `lane` at 3 and at 6 and diff the two.
 *
 * The closing section is not decoration. A number with a unit reads as a
 * measurement, and this one is a projection over durations the caller supplied;
 * printing what it cannot know next to what it computed is the difference
 * between a planning tool and a false promise.
 *
 * Identifiers only: node, pool and gate ids.
 */
import type { SimulationReport } from './simulate.ts'

/** `1h 30m`, `45s`, `250ms`. Fixed rules, no locale, no rounding surprises. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0s'
  if (ms < 1_000) return `${ms}ms`

  const seconds = Math.floor(ms / 1_000)
  const parts: string[] = []
  if (Math.floor(seconds / 3_600) > 0) parts.push(`${Math.floor(seconds / 3_600)}h`)
  if (Math.floor((seconds % 3_600) / 60) > 0) parts.push(`${Math.floor((seconds % 3_600) / 60)}m`)
  if (seconds % 60 > 0) parts.push(`${seconds % 60}s`)
  return parts.join(' ')
}

export function formatSimulation(report: SimulationReport): string {
  const lines: string[] = ['Simulated run — projection, not a prediction.', '']

  if (report.stop !== undefined) {
    lines.push(`STOPPED: ${describeStop(report.stop)}`, 'Nothing was spawned.', '')
  }

  lines.push(`Projected wall clock: ${formatDuration(report.projectedMs)}`, '')

  lines.push('Critical path')
  if (report.criticalPath.length === 0) {
    lines.push('  (nothing ran)')
  } else {
    for (const step of report.criticalPath) {
      lines.push(
        `  ${step.nodeId} (wave ${step.wave})` +
          `  ${formatDuration(step.startedAtMs)} → ${formatDuration(step.finishedAtMs)}` +
          `  work ${formatDuration(step.busyMs)}, queued ${formatDuration(step.queueMs)}`,
      )
    }
  }
  lines.push('')

  lines.push('Nodes')
  lines.push('  node                 wave  status      start       finish      work        queued')
  for (const node of report.nodes) {
    lines.push(
      '  ' +
        pad(node.id, 21) +
        pad(String(node.wave), 6) +
        pad(node.status, 12) +
        pad(node.startedAtMs === null ? '—' : formatDuration(node.startedAtMs), 12) +
        pad(node.finishedAtMs === null ? '—' : formatDuration(node.finishedAtMs), 12) +
        pad(formatDuration(node.busyMs), 12) +
        formatWaits(node.waits),
    )
  }
  lines.push('')

  lines.push('Pools')
  lines.push('  pool                 capacity  peak  busy        saturated   queued')
  for (const pool of report.pools) {
    lines.push(
      '  ' +
        pad(pool.resource, 21) +
        pad(String(pool.capacity), 10) +
        pad(String(pool.peakHeld), 6) +
        pad(formatDuration(pool.busyMs), 12) +
        pad(formatDuration(pool.saturatedMs), 12) +
        formatDuration(pool.queuedMs),
    )
  }
  lines.push('')

  lines.push(
    'What this projection knows: the graph, the pools, and the scheduler’s own',
    'dispatch rules — it drove the real scheduler on a virtual clock.',
    'What it cannot know: how long a real agent turn takes, how many fix rounds a',
    'phase needs, whether a gate fails, or when a vendor refuses a spawn. It',
    'simulates the clean path — every review passes, every gate exits zero — and',
    'answers only: given these durations, what is the schedule?',
  )
  return `${lines.join('\n')}\n`
}

function formatWaits(waits: Readonly<Record<string, number>>): string {
  const entries = Object.entries(waits).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  if (entries.length === 0) return '0s'
  return entries.map(([resource, ms]) => `${resource} ${formatDuration(ms)}`).join(', ')
}

function describeStop(stop: SimulationReport['stop']): string {
  if (stop === undefined) return ''
  if (stop.kind === 'cycle') return `cycle: ${stop.cycle.join(' → ')}`
  if (stop.kind === 'unsatisfiable') {
    return `node "${stop.nodeId}" requires unknown resource pool "${stop.resource}"`
  }
  return `deadlock, pending: ${stop.pending.join(', ')}`
}

function pad(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value.padEnd(width, ' ')
}
