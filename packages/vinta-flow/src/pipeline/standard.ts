/**
 * `standard-phase` — the pipeline the package ships and `defaults.pipeline`
 * names when a workflow does not author its own (§5.2).
 *
 * ```
 * implement ──▶ review ──┬─ verdict=pass ──▶ gate ──┬─ exit=0 ──▶ integrate ──▶ done
 *                        │                          └─ exit≠0 ──▶ fix ──▶ review
 *                        └─ verdict=fail ──▶ fix ──▶ review
 * fix ── guard: fix_rounds >= node.max_fix_rounds ──▶ failed
 * ```
 *
 * The copy in `tests/fixtures/golden-workflow.json` is the same *graph* with
 * almost no effects: it is a schema fixture, and a fixture that ran agents
 * would make every parser test wait on one. This one is the runnable article —
 * every state carries the effects that state actually performs — which is why
 * it lives in `src/` and is parsed through `PipelineSchema` here rather than
 * being an object literal shaped like a pipeline.
 *
 * Three conventions the scheduler reads, all of them data rather than special
 * cased ids, because the interpreter is general over author-chosen vocabulary:
 *
 * - **`data.outcome` on a final state** says whether reaching it means the node
 *   succeeded or failed. Absent means success. Without it a host would have to
 *   recognise the id `failed`, which is exactly the special-casing §5.2 keeps
 *   out of the interpreter.
 * - **A fix round is a `spawn_agent` with `role: 'fixer'`.** That is what the
 *   host counts into `fix_rounds`; the state happening to be called `fix` is
 *   not what makes it one. Note that this is why sharing the implementer's
 *   session below leaves `max_fix_rounds` untouched — the budget counts roles,
 *   not sessions.
 * - **`session` names a slot to continue** (§15). `implement` and `fix` share
 *   `main`, so the fixer continues the session that wrote the code rather than
 *   paying for a cold context that has to be re-told the brief; `review` keeps
 *   its own slot across rounds, so a re-review remembers what it flagged. The
 *   reviewer is deliberately *not* on `main`: a reviewer sharing the
 *   implementer's session would be grading its own work from inside its own
 *   context. Omitting `session` entirely is what a pipeline does to opt out.
 * - **Effects resolve their own defaults** (`effects.ts`). `git_branch` with no
 *   `from` takes the dependency-derived base, `git_merge` with no `branch`
 *   merges the node's own phase branch, `run_gate` with no `gate` runs the
 *   gates the node declared — and a node declaring none passes the gate state
 *   vacuously, on an `exit_code` of 0.
 */
import { PipelineSchema, type Pipeline, type Workflow } from '../types.ts'

/** The id `defaults.pipeline` and `node.pipeline` refer to. */
export const STANDARD_PHASE_ID = 'standard-phase'

export const STANDARD_PHASE: Pipeline = PipelineSchema.parse({
  states: [
    {
      id: 'implement',
      name: 'Implement',
      position: { x: 0, y: 0 },
      onEnter: [
        {
          id: 'e-branch',
          definitionId: 'git_branch',
          description: 'Phase branch off the dependency-derived base.',
        },
        {
          id: 'e-implement',
          definitionId: 'spawn_agent',
          params: { role: 'implementer', prompt_template: 'implementer', session: 'main' },
        },
      ],
    },
    {
      id: 'review',
      name: 'Review',
      position: { x: 200, y: 0 },
      // On entry rather than on the incoming transitions: `review` is reached
      // from both `implement` and `fix`, and a reviewer declared per edge is
      // one edge away from being forgotten.
      onEnter: [
        {
          id: 'e-review',
          definitionId: 'spawn_agent',
          params: { role: 'reviewer', prompt_template: 'reviewer', session: 'review' },
        },
      ],
    },
    {
      id: 'fix',
      name: 'Fix',
      position: { x: 200, y: 140 },
      onEnter: [
        {
          id: 'e-fix',
          definitionId: 'spawn_agent',
          params: { role: 'fixer', prompt_template: 'fixer', session: 'main' },
        },
      ],
    },
    {
      id: 'gate',
      name: 'Gate',
      position: { x: 400, y: 0 },
      onEnter: [
        {
          id: 'e-gate',
          definitionId: 'run_gate',
          description: 'The gates this node declared, in declaration order.',
        },
      ],
    },
    {
      id: 'integrate',
      name: 'Integrate',
      position: { x: 600, y: 0 },
      // Tracking first, and the order is load-bearing rather than tidy.
      //
      // `phase-<id>.md` is the lane's own file, committed *on the phase's own
      // branch* (`parallel-lanes.md#TRACKING_DIR`) — that commit is how the
      // record reaches anybody. Written last, it lands after the wave merge has
      // already happened, after the branch was pushed and after the PR was
      // opened, so it reaches none of the three: the wave branch does not carry
      // it, the pushed branch does not have it, and it is not in the PR diff.
      // It has to be part of what gets merged, so it is written before the merge.
      onEnter: [
        { id: 'e-tracking', definitionId: 'write_tracking', params: { scope: 'phase' } },
        { id: 'e-merge', definitionId: 'git_merge', params: { strategy: '--no-ff' } },
        { id: 'e-push', definitionId: 'git_push' },
        { id: 'e-pr', definitionId: 'open_pr', params: { draft: true } },
      ],
    },
    { id: 'done', name: 'Done', position: { x: 800, y: 0 }, data: { outcome: 'done' } },
    {
      id: 'failed',
      name: 'Failed',
      position: { x: 400, y: 280 },
      data: { outcome: 'failed' },
      onEnter: [
        {
          id: 'e-failed',
          definitionId: 'notify',
          // Identifiers only: which node failed is the journal's to say.
          params: { channel: 'os', text: 'phase failed' },
        },
      ],
    },
  ],
  transitions: [
    { id: 't-implemented', from: 'implement', to: 'review' },
    { id: 't-review-pass', from: 'review', to: 'gate', guard: "review.verdict == 'pass'" },
    { id: 't-review-fail', from: 'review', to: 'fix', guard: "review.verdict == 'fail'" },
    { id: 't-gate-pass', from: 'gate', to: 'integrate', guard: 'gate.exit_code == 0' },
    { id: 't-gate-fail', from: 'gate', to: 'fix', guard: 'gate.exit_code != 0' },
    // Evaluated on the way *out* of `fix`, by which time the fixer that just
    // ran has been counted. `max_fix_rounds: 2` therefore allows two fixers.
    { id: 't-fix-retry', from: 'fix', to: 'review', guard: 'fix_rounds < node.max_fix_rounds' },
    { id: 't-fix-exhausted', from: 'fix', to: 'failed', guard: 'fix_rounds >= node.max_fix_rounds' },
    { id: 't-integrated', from: 'integrate', to: 'done' },
  ],
  initialStateIds: ['implement'],
  finalStateIds: ['done', 'failed'],
})

/**
 * Pipelines the package ships. A workflow may omit `pipelines` entirely and
 * name one of these in `defaults.pipeline`.
 *
 * This is why the field is optional: a pipeline is machinery, not plan data.
 * Requiring every emitted workflow to carry a verbatim copy of the block below
 * would duplicate it into every plan in every repo, and a fix here would never
 * reach a plan already written. A workflow that wants a *different* pipeline
 * still declares one, and a declared id shadows a built-in of the same name.
 */
export const BUILT_IN_PIPELINES: Readonly<Record<string, Pipeline>> = {
  [STANDARD_PHASE_ID]: STANDARD_PHASE,
}

/** The pipeline a node runs: declared first, built-in as the fallback. */
export function pipelineFor(
  workflow: Pick<Workflow, 'pipelines'>,
  id: string,
): Pipeline | undefined {
  return workflow.pipelines[id] ?? BUILT_IN_PIPELINES[id]
}
