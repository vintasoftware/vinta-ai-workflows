/**
 * Fitting a phase's effort to what a model actually offers.
 *
 * A plan writes the effort a phase needs, on the shared scale in `types.ts`.
 * Models do not all offer every level (`xhigh` is the usual gap), and a vendor
 * that is handed a level its model lacks may refuse the whole turn. So an
 * adapter that can learn a model's levels clamps before it asks: the nearest
 * level the model has at or below the one asked for, and the nearest above
 * only when nothing below is offered.
 *
 * Levels outside the shared scale (`none`, `minimal`) are never picked. They
 * sit below `low`, and a plan that wanted less than `low` could not have said
 * so.
 */
import { EFFORT_LEVELS, type Effort } from '../types.ts'

export function clampEffort(wanted: Effort, offered: readonly string[]): Effort | undefined {
  const available = EFFORT_LEVELS.filter((level) => offered.includes(level))
  const at = EFFORT_LEVELS.indexOf(wanted)
  const below = available.filter((level) => EFFORT_LEVELS.indexOf(level) <= at)
  if (below.length > 0) return below[below.length - 1]
  return available[0]
}
