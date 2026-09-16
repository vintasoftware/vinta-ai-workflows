/**
 * Shapes for the stub to serve. Typed as the daemon's own inferred types, so a
 * field the API adds or renames fails to compile here before it can fail in a
 * browser.
 */
import type { TranscriptEntry } from '../../src/journal/transcript.ts'
import type {
  NodeDetail,
  RunSnapshot,
  RunSummary,
  RunUsageResponse,
} from '../../src/daemon/schemas.ts'

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

type Capabilities = HarnessState['capabilities']

/**
 * §7's block, as the daemon serves it. `null` is the wire's "this harness
 * declared nothing" — an out-of-tree adapter or a test double — and is what
 * the node view must degrade on rather than assume through.
 */
export const CLAUDE_CODE_CAPABILITIES = {
  inject: true,
  interrupt: true,
  resume: true,
  pty: true,
  permissionControl: true,
} as const satisfies NonNullable<Capabilities>

/** Codex's, which differs from claude-code's in exactly the field that matters. */
export const CODEX_CAPABILITIES = {
  inject: false,
  interrupt: true,
  resume: true,
  pty: true,
  permissionControl: true,
} as const satisfies NonNullable<Capabilities>

export function harness(
  id: string,
  ceiling: number,
  inFlight: number,
  wakeAt: number | null = null,
  capabilities: Capabilities = CLAUDE_CODE_CAPABILITIES,
): HarnessState {
  return { id, ceiling, inFlight, wakeAt, capabilities }
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
 * A transcript entry, typed as the daemon's own `TranscriptEntry` — the harness
 * events plus the kinds the daemon writes itself, each optionally attributed.
 * The journal stores exactly this stream (§5.3) and the API serves it as
 * `unknown`, so typing the fixture is the only place the shape can be held to
 * the source.
 */
export function entry(event: TranscriptEntry): TranscriptEntry {
  return event
}

/**
 * §15.6's rollup. Defaults to a run that reported everything, because the
 * interesting variations are the *partial* and *unreported* ones and a test
 * should have to ask for them by name.
 */
export function runUsage(parts: Partial<RunUsageResponse> = {}): RunUsageResponse {
  return {
    runId: RUN_ID,
    reuse: {
      turns: 8,
      reused: 5,
      fresh: [
        { reason: 'no_prior_session', count: 2 },
        { reason: 'final_fix_round', count: 1 },
      ],
    },
    // An unstaffed run, for the same reason: a roster is the variation a test
    // should have to ask for.
    crew: {
      members: [],
      asPlanned: 0,
      substituted: 0,
      warmReuse: 0,
      idle: [],
    },
    inputTokens: 12_400,
    outputTokens: 3_100,
    sessions: 8,
    cost: { status: 'complete', usd: 1.42, reportedSessions: 8 },
    cache: {
      status: 'complete',
      readTokens: 61_000,
      writeTokens: 4_000,
      promptTokens: 100_000,
      reportedSessions: 8,
    },
    ...parts,
  }
}

export function nodeDetail(parts: Partial<NodeDetail> = {}): NodeDetail {
  return {
    runId: RUN_ID,
    node: node('impl', 'running'),
    diff: { branch: 'feature/impl', baseBranch: 'main', lane: 'lane-1' },
    transcript: { stream: 'transcript', entries: [] },
    gates: [],
    sessions: [],
    question: null,
    ...parts,
  }
}
