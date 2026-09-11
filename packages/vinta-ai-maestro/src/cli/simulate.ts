/**
 * `vinta-ai-maestro simulate <workflow.json>` — §13.1's "CLI flag".
 *
 * Two ways a workflow can be unrunnable, and both exit non-zero:
 *
 * - **Statically**, which `parseWorkflow` finds first: a dependency cycle, an
 *   unknown node, a gate requiring a pool nobody declared. Those never reach
 *   the simulator, and are reported as located issues by `loadWorkflow`.
 * - **At dispatch**, which only driving the real scheduler can find: a
 *   deadlock, or a node whose resources can never all be free at once. Those
 *   come back as `status: 'stopped'` with the reason printed in the report.
 *
 * A projection is not a prediction, and `formatSimulation` says so in its own
 * closing paragraph — nothing needs repeating here.
 */
import { parseArgs } from 'node:util'

import { formatSimulation, simulate } from '../simulate/index.ts'
import { FAILED, OK, USAGE, loadWorkflow, type Io } from './io.ts'

export const SIMULATE_USAGE = 'usage: vinta-ai-maestro simulate <workflow.json>'

export async function simulateCommand(argv: readonly string[], io: Io): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({ args: [...argv], options: {}, allowPositionals: true })
  } catch {
    io.err(SIMULATE_USAGE)
    return USAGE
  }

  const path = parsed.positionals[0]
  if (path === undefined || parsed.positionals.length > 1) {
    io.err(SIMULATE_USAGE)
    return USAGE
  }

  const workflow = await loadWorkflow(path, io)
  if (workflow === null) return FAILED

  let report
  try {
    report = await simulate({ workflow })
  } catch {
    // The one way `simulate` rejects: the run stalled, which for a projection
    // means a pipeline suspended on `await_human` and no answer exists. The
    // thrown message names node ids only, but it is a stall rather than a
    // schedule, so it is reported as one rather than printed as a report.
    io.err('vinta-ai-maestro: the projection stalled — a node suspended on await_human.')
    return FAILED
  }

  io.out(formatSimulation(report))

  // `completed` means every node *settled*, not that every node passed — a
  // projection in which the first phase fails and the rest block is a settled
  // run and an unrunnable plan, and exiting zero on it would make `simulate`
  // useless in front of `run`. Node ids only; why a projected node failed is
  // not in `SimulationReport` at all (see the note in the CLI's report).
  const stuck = Object.entries(report.statuses)
    .filter(([, status]) => status === 'failed' || status === 'blocked')
    .map(([id]) => id)

  if (stuck.length > 0) {
    io.err(`vinta-ai-maestro: the projection did not complete cleanly: ${stuck.join(', ')}`)
  }
  return report.status === 'completed' && stuck.length === 0 ? OK : FAILED
}
