/**
 * `standard-phase` — the pipeline the package ships and `defaults.pipeline`
 * names when a workflow does not author its own (§5.2).
 *
 * ```
 * implement ──▶ gate ──┬─ exit=0 ──▶ review ──┬─ verdict=pass ──▶ polish ──▶ verify ──┬─ exit=0 ──▶ integrate ──▶ done
 *                      │                      └─ otherwise ──▶ unapproved             │             (merge, push, PR,
 *                      │                                                              │              after_pr chores)
 *                      ├─ exit≠0, rounds left ──▶ fix ──▶ gate                         ├─ exit≠0, rounds left ──▶ fix
 *                      └─ exit≠0, none left ──▶ exhausted                              └─ exit≠0, none left ──▶ exhausted
 * exhausted  ──┬─ continue (budget granted again) ──▶ fix
 *              └─ stop ──▶ failed
 * unapproved ──┬─ continue ──▶ review
 *              └─ stop ──▶ failed
 * ```
 *
 * **Each step runs only on what the step before it passed.** The gates run
 * first, because they are cheap next to a review, and a review of code that
 * does not build is wasted. The review runs once they are green, and the polish
 * chores once the review approved, so a comment pass never tidies code the
 * review is about to rewrite.
 *
 * **The review is a chore, not a role (§16).** `review` runs the node's
 * `when: review` chores — in a plan `plan-feature` writes, the thermo-nuclear
 * review loop — on the implementer's own session. That agent spawns one
 * reviewer sub-agent, checks each finding against the code, fixes what holds
 * up, answers what does not, and repeats until the reviewer approves. The loop
 * lives inside one turn, so a round costs a message to a warm reviewer rather
 * than a cold spawn, a prompt rebuilt from the plan and a pass through this
 * machine. The turn ends on a `VERDICT:` line, which is the `review.verdict`
 * fact. A node that runs no review chore passes, the way a node declaring no
 * gates does.
 *
 * **`unapproved` asks rather than fails.** With no `max_fix_rounds` the loop
 * runs until the reviewer approves; with one, it stops after that many
 * unsuccessful iterations and says so. Whether more rounds are
 * worth it is the operator's call: `continue` runs the review again, and the
 * new turn picks the argument up where the session left it. Unattended it
 * answers `stop`, so the phase goes to `--on-failure`.
 *
 * **`verify` runs the gates again, on the tree that merges.** The review loop
 * and the polish chores both edit it. The loop runs the gates through the
 * orchestrator as it goes (`vinta-ai-maestro gate`), on the same cache, so a
 * tree it left green and the polish left alone is a cache hit here rather than
 * a second run. A red `verify` goes back through `fix` and `gate` to the
 * review, because the fix changed code after the reviewer approved it.
 *
 * **`fix` answers red gates only.** The fixer continues `main`, so it is the
 * implementer with its own reasons for the code still in its context. The
 * budget is spent on the way *into* a fix, and every fix is gated again before
 * anything else happens to it. `max_fix_rounds` is the number of fixers a
 * phase may spend before somebody is asked; `0` means none at all, and no value
 * — the default — means no limit. **Exhaustion asks rather than fails**: `continue` grants the budget again —
 * `grant_fix_rounds`, the only verb that moves the counter — and goes straight
 * to a fixer, since the last thing that happened was a red gate nobody has
 * answered yet.
 *
 * `tests/fixtures/golden-workflow.json` carries a pipeline of the same kind with
 * almost no effects: it is a schema fixture, and a fixture that ran agents
 * would make every parser test wait on one. This one is the runnable article —
 * every state carries the effects that state actually performs — which is why
 * it lives in `src/` and is parsed through `PipelineSchema` here rather than
 * being an object literal shaped like a pipeline.
 *
 * Conventions the scheduler reads, all of them data rather than special-cased
 * ids, because the interpreter is general over author-chosen vocabulary:
 *
 * - **`data.outcome` on a final state** says whether reaching it means the node
 *   succeeded or failed. Absent means success. Without it a host would have to
 *   recognise the id `failed`, which is exactly the special-casing §5.2 keeps
 *   out of the interpreter.
 * - **A fix round is a `spawn_agent` with `role: 'fixer'`.** That is what the
 *   host counts into `fix_rounds`; the state happening to be called `fix` is
 *   not what makes it one.
 * - **`session` names a slot to continue** (§15). `implement`, `fix` and the
 *   chores all share `main`, so each turn continues the session that wrote the
 *   code rather than paying for a cold context that has to be re-told the
 *   brief. Omitting `session` entirely is what a pipeline does to opt out.
 * - **Effects resolve their own defaults** (`effects.ts`). `git_branch` with no
 *   `from` takes the dependency-derived base, `git_merge` with no `branch`
 *   merges the node's own phase branch, `run_gate` with no `gate` runs the
 *   gates the node declared — and a node declaring none passes the gate state
 *   vacuously, on an `exit_code` of 0.
 */
import { PipelineSchema, type Pipeline, type Workflow } from '../types.ts'

/** The id `defaults.pipeline` and `node.pipeline` refer to. */
export const STANDARD_PHASE_ID = 'standard-phase'

/**
 * A node with no `max_fix_rounds` has no budget to run out of. The scheduler
 * states the fact as `null` rather than leaving it out, because a missing fact
 * makes every comparison false; and the `||` short-circuits before a number
 * comparison is asked of a `null`.
 */
const UNLIMITED = 'node.max_fix_rounds == null'

/** `gate` and `verify` run the same check, on different trees. */
const runGates = (id: string) => ({
  id,
  definitionId: 'run_gate',
  description: 'The gates this node declared, in declaration order.',
})

/** A budget question: `continue` or `stop`, and `stop` when nobody is there. */
const askToContinue = (id: string, question: string) => ({
  id,
  definitionId: 'await_human',
  params: { question, kind: 'choice', choices: ['continue', 'stop'], unattended_answer: 'stop' },
})

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
    { id: 'gate', name: 'Gate', position: { x: 200, y: 0 }, onEnter: [runGates('e-gate')] },
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
      id: 'exhausted',
      name: 'Exhausted',
      position: { x: 200, y: 280 },
      onEnter: [
        askToContinue(
          'e-exhausted',
          'This phase spent its fix rounds and its gates are still red. The transcript has ' +
            'the gate output and the fixer’s last report. Continue for another round of the ' +
            'same budget, or stop the phase?',
        ),
      ],
    },
    {
      id: 'review',
      name: 'Review',
      position: { x: 400, y: 0 },
      onEnter: [
        {
          id: 'e-review',
          definitionId: 'run_chore',
          params: { when: 'review' },
          description: 'The review chores this node runs, in order. None passes.',
        },
      ],
    },
    {
      id: 'unapproved',
      name: 'Unapproved',
      position: { x: 400, y: 140 },
      onEnter: [
        askToContinue(
          'e-unapproved',
          'The review loop ran its iterations and the reviewer has not approved this phase. ' +
            'The transcript has the blockers that remain and the implementer’s report on ' +
            'them. Continue the review for another round of the same budget, or stop the phase?',
        ),
      ],
    },
    {
      id: 'polish',
      name: 'Polish',
      position: { x: 600, y: 0 },
      onEnter: [
        {
          id: 'e-chores',
          definitionId: 'run_chore',
          params: { when: 'after_review' },
          description: 'The chores this node runs once its review approved. None is a no-op.',
        },
      ],
    },
    { id: 'verify', name: 'Verify', position: { x: 800, y: 0 }, onEnter: [runGates('e-verify')] },
    {
      id: 'integrate',
      name: 'Integrate',
      position: { x: 1000, y: 0 },
      // Tracking first, and the order is load-bearing rather than tidy.
      //
      // `phase-<id>.md` is the lane's own file, committed *on the phase's own
      // branch* (`parallel-lanes.md#TRACKING_DIR`) — that commit is how the
      // record reaches anybody. Written last, it lands after the wave merge has
      // already happened, after the branch was pushed and after the PR was
      // opened, so it reaches none of the three: the wave branch does not carry
      // it, the pushed branch does not have it, and it is not in the PR diff.
      // It has to be part of what gets merged, so it is written before the merge.
      //
      // The `after_pr` chores come last because they are about the PR: a review
      // canvas posted as a PR comment needs the PR to exist. They edit nothing,
      // so nothing after them has to be re-merged or re-gated.
      onEnter: [
        { id: 'e-tracking', definitionId: 'write_tracking', params: { scope: 'phase' } },
        { id: 'e-merge', definitionId: 'git_merge', params: { strategy: '--no-ff' } },
        { id: 'e-push', definitionId: 'git_push' },
        { id: 'e-pr', definitionId: 'open_pr', params: { draft: true } },
        {
          id: 'e-pr-chores',
          definitionId: 'run_chore',
          params: { when: 'after_pr' },
          description: 'The chores this node runs once its PR is open. None is a no-op.',
        },
      ],
    },
    { id: 'done', name: 'Done', position: { x: 1200, y: 0 }, data: { outcome: 'done' } },
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
    { id: 't-implemented', from: 'implement', to: 'gate' },
    { id: 't-gate-pass', from: 'gate', to: 'review', guard: 'gate.exit_code == 0' },
    // The budget is checked here, in front of the fixer, so that every fixer
    // that does run is also gated. `max_fix_rounds: 2` allows two fixers: the
    // count is of fixers already spent, so the third red gate is the one that
    // asks.
    {
      id: 't-gate-fail',
      from: 'gate',
      to: 'fix',
      guard: `gate.exit_code != 0 && (${UNLIMITED} || fix_rounds < node.max_fix_rounds)`,
    },
    {
      id: 't-gate-exhausted',
      from: 'gate',
      to: 'exhausted',
      guard: `gate.exit_code != 0 && !${UNLIMITED} && fix_rounds >= node.max_fix_rounds`,
    },
    { id: 't-fixed', from: 'fix', to: 'gate' },
    {
      id: 't-continue',
      from: 'exhausted',
      to: 'fix',
      guard: "human.answer == 'continue'",
      effects: [{ id: 'e-grant', definitionId: 'grant_fix_rounds' }],
    },
    { id: 't-stop', from: 'exhausted', to: 'failed', guard: "!(human.answer == 'continue')" },
    { id: 't-review-pass', from: 'review', to: 'polish', guard: "review.verdict == 'pass'" },
    // Written as a negation so that a review that stated no verdict at all
    // reaches the operator rather than stranding the node: a missing fact makes
    // every comparison false, and `!` turns that into the safe door.
    { id: 't-review-fail', from: 'review', to: 'unapproved', guard: "!(review.verdict == 'pass')" },
    {
      id: 't-review-again',
      from: 'unapproved',
      to: 'review',
      guard: "human.answer == 'continue'",
    },
    {
      id: 't-review-stop',
      from: 'unapproved',
      to: 'failed',
      guard: "!(human.answer == 'continue')",
    },
    // Unconditional, and the polish chores state nothing a guard could branch
    // on: they are not allowed to stand between a phase and its merge, which is
    // what the gates after them are for.
    { id: 't-polished', from: 'polish', to: 'verify' },
    { id: 't-verify-pass', from: 'verify', to: 'integrate', guard: 'gate.exit_code == 0' },
    {
      id: 't-verify-fail',
      from: 'verify',
      to: 'fix',
      guard: `gate.exit_code != 0 && (${UNLIMITED} || fix_rounds < node.max_fix_rounds)`,
    },
    {
      id: 't-verify-exhausted',
      from: 'verify',
      to: 'exhausted',
      guard: `gate.exit_code != 0 && !${UNLIMITED} && fix_rounds >= node.max_fix_rounds`,
    },
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
