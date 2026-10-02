/**
 * `standard-phase` — the pipeline the package ships and `defaults.pipeline`
 * names when a workflow does not author its own (§5.2).
 *
 * ```
 * implement ──▶ review ──┬─ verdict=pass ──▶ polish ──▶ gate ──┬─ exit=0 ──▶ integrate ──▶ done
 *                        │                                     ├─ exit≠0, rounds left ──▶ fix
 *                        │                                     └─ exit≠0, none left ──▶ exhausted
 *                        ├─ verdict=fail, rounds left ──▶ fix ──┬─ nothing gated ──▶ review
 *                        │                                      └─ gated ──▶ consult ──▶ review
 *                        └─ verdict=fail, none left ──▶ exhausted
 * exhausted ──┬─ continue (budget granted again) ──▶ fix
 *             └─ stop ──▶ failed
 * ```
 *
 * **The review/fix loop is the thermo-nuclear review loop (§16).** The reviewer
 * holds the `review` slot across rounds and is held to the Review Standard (or
 * the project's `REVIEW.md`); the fixer is the implementer continuing `main`,
 * and it verifies every finding before acting on it. What it will not decide —
 * a scenario nothing reaches, a defensive check, a requirements ambiguity, a
 * destructive operation — it gates, and `consult` puts the whole batch to the
 * operator at once. The answer is filed in the review ledger by
 * `record_decision`, so every later review and fix sees it as settled. A
 * consult is not a round: it goes straight back to the reviewer, who reads the
 * fix the round made and the decisions beside it.
 *
 * `consult` answers itself under `--retry-after` with `defaults` — each item
 * takes the default the fixer stated for it — because the plan says so here,
 * in `unattended_answer`. `exhausted` answers itself with `stop`, which hands
 * the phase to `--on-failure` exactly as an exhausted budget did before this
 * question existed; an unattended run therefore spends no more than it used to.
 *
 * **Why `polish` sits between the review and the gate**, rather than after the
 * gate or before the review. A chore edits the tree, so anywhere after the gate
 * is a diff that merges having never been gated — comment-only edits are
 * usually harmless, and `# type: ignore`, doctests and lint rules about comment
 * shape are exactly the cases where "usually" is not a guarantee. Before the
 * review is worse in the other direction: the fixer would rewrite what the
 * chore just tidied, round after round. Here it runs once, on the diff that is
 * actually going to merge, and the gates behind it check what it did. The tree
 * hash it changes is what makes those gates a real run rather than a cache hit
 * on the pre-chore tree, which is the point rather than a cost.
 *
 * A red gate sends the node to `fix` and back through `review` and `polish`, so
 * a phase that needs fixing runs its chores again. That is the price of having
 * them run on the final diff, and it is why a chore is expected to be
 * idempotent — a second pass over an already-tidied diff should change nothing.
 *
 * **The budget is spent on the way *into* a fix, not on the way out of one.**
 * It used to be the other way round: `fix` went straight to `failed` once the
 * count was up, so the *last* fixer's work was never reviewed and never gated.
 * Two phases in one run ended on a fixer reporting "all gates green, committed,
 * tree clean" and were failed anyway — the work was done and nothing was ever
 * asked to look at it. Every fix is reviewed now, and the review that follows
 * the last one can still pass the phase.
 *
 * The cost is one extra review turn per exhausted phase. The alternative the
 * report offered — run the gates on exhaustion and integrate if they are green
 * — would merge a diff no reviewer ever approved, and gates catch what gates
 * catch. The review is the thing standing between a plan and its merge, so the
 * budget question belongs in front of the fixer rather than behind it.
 *
 * `max_fix_rounds` still means what it said: the number of fixers a phase may
 * spend before somebody is asked. `0` means none at all.
 *
 * **Exhaustion asks rather than fails.** A phase that is still being argued over
 * after four rounds is either diminishing returns or a real disagreement, and
 * neither is the orchestrator's to call. `continue` grants the budget again —
 * `grant_fix_rounds`, the only verb that moves the counter — and goes straight
 * to a fixer, since the last thing that happened was a failure it has not yet
 * answered.
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
      id: 'consult',
      name: 'Consult',
      position: { x: 200, y: 280 },
      onEnter: [
        {
          id: 'e-consult',
          definitionId: 'await_human',
          params: {
            question:
              'The fixer has scope questions it will not decide for you. Its last report, in the ' +
              'transcript, lists each one with the evidence, the reviewer’s recommendation and ' +
              'its own. Answer per item, e.g. "g1: reject; g2: in scope — handle it", or ' +
              '"defaults" to take every item’s stated default.',
            kind: 'text',
            unattended_answer: 'defaults',
          },
        },
      ],
    },
    {
      id: 'exhausted',
      name: 'Exhausted',
      position: { x: 400, y: 140 },
      onEnter: [
        {
          id: 'e-exhausted',
          definitionId: 'await_human',
          params: {
            question:
              'This phase spent its fix rounds and the review has not approved it. The ' +
              'transcript has the remaining blockers and the fixer’s last report. Continue ' +
              'for another round of the same budget, or stop the phase?',
            kind: 'choice',
            choices: ['continue', 'stop'],
            unattended_answer: 'stop',
          },
        },
      ],
    },
    {
      id: 'polish',
      name: 'Polish',
      position: { x: 300, y: -140 },
      onEnter: [
        {
          id: 'e-chores',
          definitionId: 'run_chore',
          description: 'The chores this node runs, in order. None is a no-op.',
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
    { id: 't-review-pass', from: 'review', to: 'polish', guard: "review.verdict == 'pass'" },
    // Unconditional, and the chores state nothing a guard could branch on: a
    // chore is not allowed to be the thing standing between a phase and its
    // merge, which is what the gates after it are for.
    { id: 't-polished', from: 'polish', to: 'gate' },
    // The budget is checked here, in front of the fixer, so that every fixer
    // that does run is also reviewed. `max_fix_rounds: 2` allows two fixers:
    // the count is of fixers already spent, so the third failing review is the
    // one that ends the phase.
    {
      id: 't-review-fail',
      from: 'review',
      to: 'fix',
      guard: "review.verdict == 'fail' && fix_rounds < node.max_fix_rounds",
    },
    {
      id: 't-review-exhausted',
      from: 'review',
      to: 'exhausted',
      guard: "review.verdict == 'fail' && fix_rounds >= node.max_fix_rounds",
    },
    { id: 't-gate-pass', from: 'gate', to: 'integrate', guard: 'gate.exit_code == 0' },
    // The same check, because this is the *other* door into `fix`. Guarding
    // only the review side left a red gate under a passing reviewer with no
    // exit at all: review → gate → fix → review → gate → fix, forever, with the
    // budget counting up and nothing reading it.
    {
      id: 't-gate-fail',
      from: 'gate',
      to: 'fix',
      guard: 'gate.exit_code != 0 && fix_rounds < node.max_fix_rounds',
    },
    {
      id: 't-gate-exhausted',
      from: 'gate',
      to: 'exhausted',
      guard: 'gate.exit_code != 0 && fix_rounds >= node.max_fix_rounds',
    },
    // A fixer's work always goes back to a reviewer, which is the only thing
    // that can say it worked — through `consult` first when it gated something.
    // Written as a negation so that an executor reporting no `review.gated` at
    // all reaches the reviewer rather than stranding the node: a missing fact
    // makes every comparison false, and `!` turns that into the safe door.
    { id: 't-fix-gated', from: 'fix', to: 'consult', guard: 'review.gated > 0' },
    { id: 't-fix-reviewed', from: 'fix', to: 'review', guard: '!(review.gated > 0)' },
    {
      id: 't-consulted',
      from: 'consult',
      to: 'review',
      effects: [{ id: 'e-record-decision', definitionId: 'record_decision' }],
    },
    {
      id: 't-continue',
      from: 'exhausted',
      to: 'fix',
      guard: "human.answer == 'continue'",
      effects: [{ id: 'e-grant', definitionId: 'grant_fix_rounds' }],
    },
    { id: 't-stop', from: 'exhausted', to: 'failed', guard: "!(human.answer == 'continue')" },
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
