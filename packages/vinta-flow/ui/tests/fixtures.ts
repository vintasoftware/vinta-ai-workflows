/**
 * Shapes for the stub to serve. Typed as the daemon's own inferred types, so a
 * field the API adds or renames fails to compile here before it can fail in a
 * browser.
 */
import type { AgentEvent } from '../../src/harness/adapter.ts'
import type { NodeDetail, RunSnapshot, RunSummary } from '../../src/daemon/schemas.ts'

export const RUN_ID = 'run-1'

type NodeSummary = RunSnapshot['nodes'][number]
type NodeStatus = NodeSummary['status']
type ResourceState = RunSnapshot['resources'][number]
type HarnessState = RunSnapshot['harnesses'][number]

export function runSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: RUN_ID,
    workflowId: 'add-billing',
    status: 'running',
    baseBranch: 'main',
    startedAt: 1_700_000_000_000,
    endedAt: null,
    ...overrides,
  }
}

export function node(nodeId: string, status: NodeStatus, wave = 0): NodeSummary {
  return {
    nodeId,
    name: nodeId,
    status,
    wave,
    lane: 'lane-1',
    branch: `feature/${nodeId}`,
    baseBranch: 'main',
    harness: 'claude-code',
    sessionId: null,
  }
}

export function resource(id: string, capacity: number, held: number, holders: string[] = []): ResourceState {
  return { id, kind: 'semaphore', capacity, held, holders }
}

export function harness(id: string, ceiling: number, inFlight: number, wakeAt: number | null = null): HarnessState {
  return { id, ceiling, inFlight, wakeAt }
}

export function snapshot(parts: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    run: runSummary(),
    cursor: 0,
    nodes: [],
    edges: [],
    resources: [],
    gateQueue: { waiting: 0, holders: [] },
    harnesses: [],
    ...parts,
  }
}

export function statusEvent(nodeId: string, status: NodeStatus) {
  return { nodeId, type: 'node_status', payload: { status } }
}

/**
 * A transcript entry, typed as the harness's own `AgentEvent`. The journal
 * stores exactly this stream (§5.3) and the API serves it as `unknown`, so
 * typing the fixture is the only place the shape can be held to the source.
 */
export function entry(event: AgentEvent): AgentEvent {
  return event
}

export function nodeDetail(parts: Partial<NodeDetail> = {}): NodeDetail {
  return {
    runId: RUN_ID,
    node: node('impl', 'running'),
    diff: { branch: 'feature/impl', baseBranch: 'main', lane: 'lane-1' },
    transcript: { stream: 'transcript', entries: [] },
    gates: [],
    question: null,
    ...parts,
  }
}
