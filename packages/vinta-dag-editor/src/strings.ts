/**
 * Every user-visible label the canvas can produce.
 *
 * No string reaches the DOM from anywhere else, so a host translating the
 * component only has to fill this record — and a test can prove the rule by
 * substituting every entry and finding nothing else on screen. Entries that
 * interpolate are functions with named parameters rather than a `{placeholder}`
 * mini-language, so a translator cannot get an argument name wrong silently.
 *
 * `newNodeName` and `newEdgeArtifact` are seeds: unlike the rest they are
 * written *into* the graph, not rendered from it.
 */

import type { DagNodeStatus } from './types'

export interface DagStrings {
  readonly canvas: string
  readonly addNode: string
  readonly deleteNode: string
  readonly deleteEdge: string
  readonly connect: string
  readonly connectHint: (params: { readonly name: string }) => string
  readonly zoomIn: string
  readonly zoomOut: string
  readonly nameField: string
  readonly statusField: string
  readonly waveField: string
  readonly artifactField: string
  readonly wave: (params: { readonly wave: number }) => string
  readonly node: (params: { readonly name: string; readonly status: string }) => string
  readonly edge: (params: {
    readonly from: string
    readonly to: string
    readonly artifact: string
  }) => string
  readonly newNodeName: string
  readonly newEdgeArtifact: string
  readonly status: Readonly<Record<DagNodeStatus, string>>
}

export const DEFAULT_STRINGS: DagStrings = {
  canvas: 'Plan graph',
  addNode: 'Add node',
  deleteNode: 'Delete node',
  deleteEdge: 'Delete dependency',
  connect: 'Draw dependency from this node',
  connectHint: ({ name }) => `Choose the node that depends on ${name}`,
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  nameField: 'Name',
  statusField: 'Status',
  waveField: 'Wave',
  artifactField: 'Artifact',
  wave: ({ wave }) => `Wave ${wave}`,
  node: ({ name, status }) => `${name}, ${status}`,
  edge: ({ from, to, artifact }) => `${to} depends on ${from} for ${artifact}`,
  newNodeName: 'New node',
  newEdgeArtifact: 'artifact',
  status: {
    pending: 'Pending',
    ready: 'Ready',
    waiting_on_capacity: 'Waiting on capacity',
    running: 'Running',
    awaiting_human: 'Awaiting human',
    done: 'Done',
    failed: 'Failed',
    blocked: 'Blocked',
  },
}

/** A host may name one status without restating the other seven. */
export type DagStringOverrides = Partial<Omit<DagStrings, 'status'>> & {
  readonly status?: Partial<Readonly<Record<DagNodeStatus, string>>>
}

/** A partial override replaces only the keys it names, statuses included. */
export function mergeStrings(
  overrides: DagStringOverrides | undefined,
  base: DagStrings = DEFAULT_STRINGS,
): DagStrings {
  if (!overrides) return base
  return { ...base, ...overrides, status: { ...base.status, ...overrides.status } }
}
