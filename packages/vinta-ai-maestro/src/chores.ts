/**
 * Which chores a node runs, and what each one resolves to.
 *
 * The list lives in two places — `defaults.chores` for the run, `node.chores`
 * for the exception — and every consumer has to agree on how they combine. The
 * scheduler spawns from it, the validator checks the ids in it, and the
 * post-run report counts the turns it produced: three readings of one rule is
 * two too many, so the rule is here and nowhere else.
 *
 * **Absent takes the default; a list replaces it.** `node.chores` is optional
 * rather than defaulted precisely so that `[]` is a thing a plan can say. Under
 * a merge rule there would be no way to skip a run-wide chore on the one phase
 * it makes no sense for, and the plan's author would have to drop it from
 * `defaults` and repeat it on every other node instead.
 *
 * An id naming no declared chore is dropped here and refused by `validate.ts`.
 * A resolver that threw would turn an authoring mistake into a phase that dies
 * mid-run, long after the document could have been fixed.
 */
import type { Chore, Node, Workflow } from './types.ts'

/** The chore ids this node runs, in order, before any of them are resolved. */
export function choreIdsFor(
  workflow: Pick<Workflow, 'defaults'>,
  node: Pick<Node, 'chores'>,
): readonly string[] {
  return node.chores ?? workflow.defaults.chores
}

/** One resolved chore: its id, so the journal can name it, and its declaration. */
export interface ResolvedChore {
  readonly id: string
  readonly chore: Chore
}

/** The chores this node runs, in order, with undeclared ids dropped. */
export function choresFor(
  workflow: Pick<Workflow, 'defaults' | 'chores'>,
  node: Pick<Node, 'chores'>,
): readonly ResolvedChore[] {
  return choreIdsFor(workflow, node).flatMap((id) => {
    const chore = workflow.chores[id]
    return chore === undefined ? [] : [{ id, chore }]
  })
}
