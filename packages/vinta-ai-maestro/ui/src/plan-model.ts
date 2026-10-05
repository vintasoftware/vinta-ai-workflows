/**
 * The pure half of the review page (§19): a plan, its graph and its review,
 * turned into what the page draws. No DOM, so every rule here is testable on
 * its own — which phase is "red", which section a comment belongs to, what the
 * canvas calls each state.
 */
import type { Dag, DagNodeStatus, DagStringOverrides } from 'vinta-dag-editor/src/index.ts'
import type { PlanIssueResponse } from '../../src/daemon/schemas.ts'
import type { Anchor, Comment, PlanReview, PromptRole } from '../../src/review/document.ts'
import type { Gate, Node, Workflow } from '../../src/types.ts'
import { toDag } from './editor-model.ts'

// ---------------------------------------------------------------------------
// The plan document
// ---------------------------------------------------------------------------

export interface PlanSection {
  /** The heading's slug — the same one a `prompt_ref` anchor matches. */
  readonly id: string
  readonly title: string
  readonly depth: number
  /** The section's own markdown, heading included, up to the next heading. */
  readonly markdown: string
}

export interface SplitPlan {
  /** Whatever comes before the first commentable heading — the title, usually. */
  readonly preamble: string
  readonly sections: readonly PlanSection[]
}

/** Headings this deep and shallower start a commentable section. */
const SECTION_DEPTH = 3

/**
 * The plan cut at every `#`–`###` heading, skipping fenced code — a `# comment`
 * inside a Python block is not a heading, and treating it as one would cut a
 * phase in half on the page.
 */
export function splitPlan(markdown: string): SplitPlan {
  const lines = markdown.split('\n')
  const sections: PlanSection[] = []
  const preamble: string[] = []
  let current: { id: string; title: string; depth: number; lines: string[] } | null = null
  let fence: string | null = null
  const seen = new Map<string, number>()

  for (const line of lines) {
    const fenceMark = /^\s*(```+|~~~+)/.exec(line)?.[1]
    if (fenceMark !== undefined) {
      if (fence === null) fence = fenceMark[0] as string
      else if (fenceMark.startsWith(fence)) fence = null
    }
    const heading = fence === null ? /^(#{1,6})\s+(.*)$/.exec(line) : null
    if (heading !== null && (heading[1] as string).length <= SECTION_DEPTH) {
      if (current !== null) sections.push(close(current))
      const title = (heading[2] as string).trim()
      // Two headings with one slug would be one anchor on the page; the second
      // gets a suffix the way GitHub's renderer does it.
      const base = slug(title)
      const count = seen.get(base) ?? 0
      seen.set(base, count + 1)
      current = {
        id: count === 0 ? base : `${base}-${count}`,
        title,
        depth: (heading[1] as string).length,
        lines: [line],
      }
      continue
    }
    if (current === null) preamble.push(line)
    else current.lines.push(line)
  }
  if (current !== null) sections.push(close(current))
  return { preamble: preamble.join('\n').trim(), sections }

  function close(section: { id: string; title: string; depth: number; lines: string[] }): PlanSection {
    return {
      id: section.id,
      title: section.title,
      depth: section.depth,
      markdown: section.lines.join('\n').trim(),
    }
  }
}

/** `src/prompts/prompts.ts`'s slug, so a section and a `prompt_ref` anchor agree. */
export function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

/** The section a reference's anchor names, by the scheduler's own matching rule. */
export function sectionForRef(sections: readonly PlanSection[], ref: string): PlanSection | null {
  const hash = ref.lastIndexOf('#')
  if (hash === -1) return null
  const anchor = ref.slice(hash + 1)
  const target = slug(anchor)
  return (
    sections.find(
      (section) =>
        slug(section.title) === target ||
        slug(section.title).startsWith(`${target}-`) ||
        section.title.includes(`{#${anchor}}`),
    ) ?? null
  )
}

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

/** One string per anchor, for equality and for keys. */
export function anchorKey(anchor: Anchor): string {
  switch (anchor.kind) {
    case 'plan':
      return 'plan'
    case 'section':
      return `section:${anchor.section}`
    case 'phase':
      return `phase:${anchor.node}`
    case 'prompt':
      return `prompt:${anchor.node}:${anchor.role}`
    case 'gate':
      return anchor.node === undefined ? `gate:${anchor.gate}` : `gate:${anchor.gate}@${anchor.node}`
  }
}

export const ROLE_LABELS: Readonly<Record<PromptRole, string>> = {
  implementer: 'Implementer prompt',
  reviewer: 'Reviewer prompt',
  fixer: 'Fixer prompt',
}

/** What a comment is about, in words a person scans. */
export function anchorLabel(anchor: Anchor, workflow: Workflow | null): string {
  const name = (id: string): string => {
    const node = workflow?.nodes.find((candidate) => candidate.id === id)
    return node === undefined ? id : `${id} · ${node.name}`
  }
  switch (anchor.kind) {
    case 'plan':
      return 'Whole plan'
    case 'section':
      return anchor.heading ?? anchor.section
    case 'phase':
      return `Phase ${name(anchor.node)}`
    case 'prompt':
      return `${ROLE_LABELS[anchor.role]} · ${anchor.node}`
    case 'gate':
      return anchor.node === undefined ? `Gate ${anchor.gate}` : `Gate ${anchor.gate} · ${anchor.node}`
  }
}

/** The phase a comment is about, when it is about one. */
export function anchorNode(anchor: Anchor, sectionToNode: ReadonlyMap<string, string>): string | null {
  switch (anchor.kind) {
    case 'phase':
    case 'prompt':
      return anchor.node
    case 'gate':
      return anchor.node ?? null
    case 'section':
      return sectionToNode.get(anchor.section) ?? null
    case 'plan':
      return null
  }
}

/** Which section each phase's brief is, by section id. */
export function sectionsByNode(
  workflow: Workflow | null,
  sections: readonly PlanSection[],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>()
  for (const node of workflow?.nodes ?? []) {
    const section = sectionForRef(sections, node.prompt_ref)
    if (section !== null) map.set(section.id, node.id)
  }
  return map
}

// ---------------------------------------------------------------------------
// The review graph
// ---------------------------------------------------------------------------

/**
 * A phase's review state, as the canvas colours it. The canvas has run
 * statuses, not review ones, so four of them are borrowed for their tone — and
 * relabelled below, so nobody reads "Failed" on a plan that has not run.
 */
export type PhaseReviewState = 'clean' | 'commented' | 'resolved' | 'issues'

const STATE_STATUS: Readonly<Record<PhaseReviewState, DagNodeStatus>> = {
  clean: 'pending',
  commented: 'awaiting_human',
  resolved: 'done',
  issues: 'failed',
}

export const REVIEW_DAG_STRINGS: DagStringOverrides = {
  status: {
    pending: 'No comments',
    awaiting_human: 'Open comments',
    done: 'Comments resolved',
    failed: 'Has issues',
  },
}

/** `nodes[2].prompt_ref` → the third node's id. */
export function issueNode(issue: PlanIssueResponse, workflow: Workflow | null): string | null {
  const index = /^nodes\[(\d+)\]/.exec(issue.path)?.[1]
  if (index === undefined) return null
  return workflow?.nodes[Number(index)]?.id ?? null
}

export interface PhaseCounts {
  readonly open: number
  readonly resolved: number
  readonly issues: number
}

export function phaseCounts(
  workflow: Workflow | null,
  review: PlanReview | null,
  issues: readonly PlanIssueResponse[],
  sectionToNode: ReadonlyMap<string, string>,
): ReadonlyMap<string, PhaseCounts> {
  const counts = new Map<string, { open: number; resolved: number; issues: number }>()
  for (const node of workflow?.nodes ?? []) counts.set(node.id, { open: 0, resolved: 0, issues: 0 })
  for (const comment of review?.comments ?? []) {
    const node = anchorNode(comment.anchor, sectionToNode)
    const entry = node === null ? undefined : counts.get(node)
    if (entry === undefined) continue
    if (comment.status === 'open') entry.open += 1
    else entry.resolved += 1
  }
  for (const issue of issues) {
    const node = issueNode(issue, workflow)
    const entry = node === null ? undefined : counts.get(node)
    if (entry !== undefined) entry.issues += 1
  }
  return counts
}

export function phaseState(counts: PhaseCounts | undefined): PhaseReviewState {
  if (counts === undefined) return 'clean'
  if (counts.issues > 0) return 'issues'
  if (counts.open > 0) return 'commented'
  if (counts.resolved > 0) return 'resolved'
  return 'clean'
}

/** The editor's graph, with each node coloured by its review state. */
export function toReviewDag(workflow: Workflow, counts: ReadonlyMap<string, PhaseCounts>): Dag {
  const dag = toDag(workflow)
  return {
    ...dag,
    nodes: dag.nodes.map((node) => ({
      ...node,
      status: STATE_STATUS[phaseState(counts.get(node.id))],
    })),
  }
}

// ---------------------------------------------------------------------------
// Gates and comments
// ---------------------------------------------------------------------------

export interface NodeGate {
  readonly id: string
  readonly gate: Gate | null
}

/** A phase's gates in its own order, with the declaration each id resolves to. */
export function gatesOf(workflow: Workflow, node: Node): NodeGate[] {
  return node.gates.map((id) => ({ id, gate: workflow.gates[id] ?? null }))
}

/** Every gate id any phase runs, in first-use order, then the declared-but-unused ones. */
export function gateColumns(workflow: Workflow): string[] {
  const order: string[] = []
  for (const node of workflow.nodes) for (const id of node.gates) if (!order.includes(id)) order.push(id)
  for (const id of Object.keys(workflow.gates)) if (!order.includes(id)) order.push(id)
  return order
}

export type CommentFilter = 'open' | 'resolved' | 'all'

export function filterComments(comments: readonly Comment[], filter: CommentFilter): Comment[] {
  return comments.filter((comment) => filter === 'all' || comment.status === filter)
}

/** Comments whose anchor is exactly this one. */
export function commentsAt(review: PlanReview | null, anchor: Anchor): Comment[] {
  const key = anchorKey(anchor)
  return (review?.comments ?? []).filter((comment) => anchorKey(comment.anchor) === key)
}

/** A person's comment the agent has not been sent. */
export function isUnsent(comment: Comment): boolean {
  return (
    comment.author.kind === 'human' &&
    (comment.sent_at === undefined ||
      comment.replies.some((reply) => reply.author.kind === 'human' && reply.sent_at === undefined))
  )
}
