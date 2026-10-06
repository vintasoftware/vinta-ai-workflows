/**
 * What a phase's pull request actually says.
 *
 * The PR used to be opened with `title: node.name` and `body: node.prompt_ref`
 * — one line, the plan anchor, nothing else. Seven PRs from one fourteen-hour
 * run each read `ai-plans/2026-…_IMPLEMENTATION_PLAN.md#phase-7` and no more,
 * which is not a description of a change so much as a note that a change
 * happened somewhere.
 *
 * Meanwhile the skills path — `open-pr-from-context`, the `prs-context/` files
 * and `open-pr.sh` — has always rendered a real body from a file an agent
 * wrote, following the project's own PR template. The daemon never knew that
 * mechanism existed: there was no reference to `prs-context` anywhere in this
 * package. Two implementations of "open a PR", and the run used the thin one.
 *
 * So this module does two things, in order:
 *
 * 1. **Read the phase's `prs-context` file when there is one.** That is the
 *    convention the rest of the toolchain already writes and reads, and a body
 *    an agent wrote about its own change beats anything composed from metadata.
 * 2. **Compose from the journal when there is not.** The fallback is not the
 *    old one-liner: the orchestrator knows which gates ran and what they
 *    returned, how many attempts the phase took, which conflicts were resolved
 *    and against what it was based. None of that was on the PR, and all of it
 *    is what a reviewer opens the PR wanting to know.
 *
 * **Everything here is identifiers (§11).** Gate ids, exit codes, counts, node
 * ids, branch names and paths. No gate output, no diff, no transcript text —
 * a PR body is published to a forge, which is the last place repository
 * content should arrive by accident.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Where the toolchain keeps them, and what this reads. */
export const PRS_CONTEXT_DIR = join('.vinta-ai-workflows', 'prs-context')

/** A title and a body, however they were arrived at. */
export interface PrText {
  readonly title: string
  readonly body: string
  /** Which of the two paths produced it. Journalled, so the operator can tell. */
  readonly source: 'context' | 'composed'
}

/**
 * The phase's context file, if the agent wrote one.
 *
 * Parsed here rather than with a YAML dependency because only two sections are
 * wanted and the frontmatter is not one of them: `open-pr.sh` owns the
 * frontmatter contract (status, pr_url, inline comments) and this is
 * deliberately not a second implementation of that script. What it takes is the
 * prose a human will read — `# Title` and `# Description` — and it takes them
 * verbatim.
 *
 * Returns null for anything it cannot read confidently. A half-understood file
 * would put a fragment of a template on a pull request, which is worse than the
 * composed body it would have displaced.
 */
export function readPrContext(lanePath: string, planId: string, nodeId: string): PrText | null {
  const path = join(lanePath, PRS_CONTEXT_DIR, planId, `phase-${nodeId}.md`)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }

  const title = sectionOf(raw, 'Title')
  const body = sectionOf(raw, 'Description')
  if (title === null || body === null) return null
  // A template the agent never filled in: every placeholder is still angle
  // -bracketed and the whole point of reading the file is missing. The composed
  // body is better than shipping `<single-line PR title — …>` as a title.
  if (title.startsWith('<') || body.startsWith('<')) return null

  return { title: firstLine(title), body, source: 'context' }
}

/** The text under `# <name>`, up to the next `# ` heading. Trimmed, or null. */
function sectionOf(raw: string, name: string): string | null {
  const lines = raw.split('\n')
  const start = lines.findIndex((line) => line.trim() === `# ${name}`)
  if (start === -1) return null

  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('# '))
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()
  return body.length === 0 ? null : body
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').trim()
}

/** What the orchestrator knows about a finished phase, for the composed body. */
export interface PhaseFacts {
  readonly nodeId: string
  readonly name: string
  /** The plan anchor. Kept — it is the one link a reviewer always wants. */
  readonly promptRef: string
  readonly branch: string
  readonly base: string
  readonly dependsOn: readonly string[]
  /** Final result per gate, in declaration order. */
  readonly gates: readonly { readonly gate: string; readonly exitCode: number }[]
  /** Attempts the phase took. 1 means it passed the first time. */
  readonly attempts: number
  /** Conflicts resolved on the way in, as `node_conflict` recorded them. */
  readonly conflicts: readonly { readonly paths: readonly string[]; readonly rounds: number }[]
  /** Files the phase declared it would touch, from the plan. */
  readonly touches: readonly string[]
}

/**
 * A body built from the run's own record, for a phase with no context file.
 *
 * Ordered by what a reviewer needs first: what this phase was asked to do, what
 * it is based on (which is *not* the default branch for a phase with
 * dependencies, and a reviewer who assumes otherwise misreads the diff), then
 * the evidence — gates, attempts, conflicts.
 *
 * The attempt count and the conflicts are here because they are the two things
 * that predict a bad review and were invisible: a phase that passed on its
 * third attempt after a merge someone else's agent resolved is worth a closer
 * read than one that went green first time, and nothing on the PR said so.
 */
export function composePrBody(facts: PhaseFacts): PrText {
  const lines: string[] = [
    `Phase \`${facts.nodeId}\` of this plan. The brief is [${facts.promptRef}](${facts.promptRef}).`,
    '',
    '## What this is based on',
    '',
    facts.dependsOn.length === 0
      ? `Branched from \`${facts.base}\`, with no phase dependencies.`
      : `Branched from \`${facts.base}\` — derived from this phase's dependencies ` +
        `(${facts.dependsOn.map((id) => `\`${id}\``).join(', ')}), not from plan order. ` +
        'The diff is this phase only; its dependencies are already in the base.',
  ]

  if (facts.touches.length > 0) {
    lines.push('', '## Declared surface', '')
    lines.push('The plan said this phase would touch:', '')
    for (const path of facts.touches) lines.push(`- \`${path}\``)
  }

  lines.push('', '## How it got here', '')
  if (facts.gates.length > 0) {
    const passed = facts.gates.filter((gate) => gate.exitCode === 0).length
    lines.push(
      `Gates: ${passed}/${facts.gates.length} green — ` +
        facts.gates
          .map((gate) => `\`${gate.gate}\` (exit ${gate.exitCode})`)
          .join(', ') +
        '.',
    )
  } else {
    lines.push('No gates were declared for this phase.')
  }

  lines.push(
    facts.attempts <= 1
      ? 'Passed review on the first attempt.'
      : `Took ${facts.attempts} attempts — worth a closer read than a phase that passed first time.`,
  )

  if (facts.conflicts.length > 0) {
    const rounds = facts.conflicts.reduce((sum, conflict) => sum + conflict.rounds, 0)
    const paths = [...new Set(facts.conflicts.flatMap((conflict) => conflict.paths))]
    lines.push(
      '',
      `**${facts.conflicts.length} merge ${facts.conflicts.length === 1 ? 'conflict was' : 'conflicts were'} ` +
        `resolved by an agent** on the way in (${rounds} fix ${rounds === 1 ? 'round' : 'rounds'})` +
        (paths.length === 0 ? '.' : `, in ${paths.map((path) => `\`${path}\``).join(', ')}.`),
      'Nobody has reviewed those resolutions as part of this phase — read them here.',
    )
  }

  return { title: facts.name, body: lines.join('\n'), source: 'composed' }
}

/** What the PR for a multi-dependency phase's `integ-<id>` branch needs to say. */
export interface IntegrationFacts {
  readonly nodeId: string
  readonly name: string
  /** The integration branch, which is this PR's head. */
  readonly branch: string
  /** The run's `base_branch`, which is this PR's base. */
  readonly baseBranch: string
  /** The dependencies it merges, in the order it merged them. */
  readonly dependsOn: readonly string[]
}

/**
 * The PR that takes an `integ-<id>` branch to `base_branch`.
 *
 * **Without it a plan with any multi-dependency phase could not be merged
 * through its PRs.** That phase's PR targets `integ-<id>`, and nothing ever
 * targeted `integ-<id>` itself: it was pushed so the phase PR had a base, and
 * then it sat there. Every PR above it was stacked on a branch with no way to
 * reach `base_branch`, and landing the plan meant someone rebuilding the
 * merges by hand.
 *
 * Based on `base_branch` rather than on any one dependency, because it has
 * several parents and no single one of them is "below" it. Its diff starts as
 * the whole of its dependencies and shrinks, as their own PRs land, to what
 * only this branch carries: the merge commits and any conflict an agent
 * resolved while building it.
 */
export function composeIntegrationPrBody(facts: IntegrationFacts): PrText {
  const deps = facts.dependsOn.map((id) => `\`${id}\``).join(', ')
  const lines = [
    `Integration branch for phase \`${facts.nodeId}\`. It merges that phase's dependencies — ` +
      `${deps} — into one branch, so the phase has a single base. The PR for ` +
      `\`${facts.nodeId}\` targets \`${facts.branch}\`.`,
    '',
    '## Merge order',
    '',
    `1. Merge the PRs for ${deps} first.`,
    `2. Merge this one. By then its diff is only what this branch adds: the merge ` +
      'commits, and any conflict an agent resolved while building it.',
    `3. Retarget the PR for \`${facts.nodeId}\` to \`${facts.baseBranch}\`. GitHub does ` +
      'this by itself when the merged branch is deleted.',
    '',
    'Use merge commits, not squash, all the way down the stack. A squash gives the ' +
      'stacked PRs above it a diff that repeats every change below them.',
  ]
  return { title: `Integrate ${facts.dependsOn.join(' + ')} for ${facts.name}`, body: lines.join('\n'), source: 'composed' }
}

/** One PR in the plan's merge order, as the journal recorded it. */
export interface PlanPrStep {
  readonly kind: 'phase' | 'integration'
  readonly nodeId: string
  readonly head: string
  readonly base: string
  readonly url?: string
}

export interface PlanFacts {
  readonly planId: string
  readonly baseBranch: string
  /** The final wave branch, which carries every phase. This PR's head. */
  readonly head: string
  /** Every PR the run opened or tried to, in an order that merges cleanly. */
  readonly steps: readonly PlanPrStep[]
}

/**
 * The PR that lands the whole plan: the final wave branch into `base_branch`.
 *
 * Phase PRs are review units, and a stack of them only reaches `base_branch`
 * if every link in it does. The wave spine is the one branch that is known to
 * hold the whole plan — every phase, every `integ-` merge, and the conflict
 * resolutions made between sibling phases that nobody depends on both of,
 * which no phase PR carries at all. So this PR is merged last whichever way the
 * team lands the plan, and its diff is always "what is not on the base yet".
 */
export function composePlanPrBody(facts: PlanFacts): PrText {
  const lines: string[] = [
    `Lands plan \`${facts.planId}\` on \`${facts.baseBranch}\`. \`${facts.head}\` is the ` +
      'last wave branch, so it holds every phase and every conflict resolution the run made.',
    '',
    '## How to land the plan',
    '',
    'Pick one. Use merge commits, not squash, either way.',
    '',
    `- **All at once.** Merge this PR. Phase PRs based on \`${facts.baseBranch}\` close ` +
      'as merged by themselves; close the stacked ones.',
    '- **Phase by phase.** Merge the PRs below in order, then this one last. Its diff ' +
      'shrinks to what is not on the base yet — usually the conflict resolutions between ' +
      'sibling phases, which no phase PR carries.',
  ]

  if (facts.steps.length > 0) {
    lines.push('', '## Merge order', '')
    facts.steps.forEach((step, index) => {
      const what =
        step.kind === 'integration'
          ? `integration branch for \`${step.nodeId}\``
          : `phase \`${step.nodeId}\``
      const link = step.url === undefined ? '(no PR — open it by hand)' : step.url
      lines.push(`${index + 1}. ${what}: ${link} — \`${step.head}\` into \`${step.base}\``)
    })
    lines.push(`${facts.steps.length + 1}. This PR.`)
  }

  return { title: `Land plan ${facts.planId}`, body: lines.join('\n'), source: 'composed' }
}
