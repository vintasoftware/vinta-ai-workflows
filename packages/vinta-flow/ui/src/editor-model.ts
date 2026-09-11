/**
 * The pure half of the editor: workflow ⇄ the two canvases' own shapes.
 *
 * Both graph surfaces are Web Components with their own data contracts (§10),
 * and neither contract is the workflow schema. Everything that translates
 * between them lives here rather than in a component, for three reasons:
 *
 * - **Nothing mutates its input.** Every function returns a new workflow and
 *   reuses by reference what did not change, which is the same discipline both
 *   components hold themselves to. The editor's undo story — and the run
 *   view's freedom to render the same objects — depends on it.
 * - **It is testable without a DOM.** "Adding a dependency produced a new
 *   workflow with the artifact on it" is a statement about these functions.
 * - **The mismatches are visible.** §5.2 says the pipeline shape is the state
 *   machine editor's own "with no translation layer". At 0.11.0 that is not
 *   quite true, and the exact gaps are named in `toMachine`/`fromMachine`
 *   rather than discovered later as data loss.
 */
import type { Dag, DagEdge, DagNode } from 'vinta-dag-editor/src/index.ts'
import { addEdge } from 'vinta-dag-editor/src/index.ts'
import type {
  JsonObject,
  SideEffect as MachineEffect,
  StateMachine,
  StateNode as MachineState,
  Transition as MachineTransition,
  SideEffectDefinition,
} from 'vinta-state-machine-editor'
import { isStateColor } from 'vinta-state-machine-editor'
import { computeWaves, findCycle } from '../../src/graph.ts'
import { EFFECT_CATALOG } from '../../src/pipeline/effects.ts'
import { BUILT_IN_PIPELINES } from '../../src/pipeline/standard.ts'
import type { Dependency, Node, Pipeline, SideEffect, Workflow } from '../../src/types.ts'

// ---------------------------------------------------------------------------
// The plan graph
// ---------------------------------------------------------------------------

/**
 * A dependency drawn on the canvas seeds an **empty** artifact.
 *
 * The component's own default is the word `artifact`, which is a fine label and
 * a terrible value: it would satisfy the schema's `min(1)` and quietly bless a
 * dependency nobody has explained. Empty fails validation at
 * `nodes[i].depends_on[j].artifact`, which is exactly where the author needs to
 * be sent.
 */
export const NEW_EDGE_ARTIFACT = ''

/** What a fresh node needs before it is runnable — deliberately not filled in. */
export const NEW_NODE_PROMPT_REF = ''

/** The workflow's plan graph, as `<vinta-dag>` draws it. */
export function toDag(workflow: Workflow): Dag {
  const waves = wavesOf(workflow.nodes)
  const nodes: DagNode[] = workflow.nodes.map((node) => ({
    id: node.id,
    name: node.name,
    // The editor edits a workflow that has not started, so every node is
    // pending. Status is run state; it is not in the document being edited.
    status: 'pending',
    wave: waves.get(node.id) ?? 1,
  }))
  const edges: DagEdge[] = workflow.nodes.flatMap((node) =>
    node.depends_on.map((dependency) => ({
      // The same id `addEdge` mints, so an edge drawn on the canvas and one
      // read from the document are the same edge after a round trip.
      id: `${dependency.node}-${node.id}`,
      from: dependency.node,
      to: node.id,
      artifact: dependency.artifact,
    })),
  )
  return { nodes, edges }
}

/**
 * The canvas's new `Dag`, folded back into the workflow.
 *
 * Everything the canvas does not know about a node — `prompt_ref`, gates,
 * harness, model, `touches` — is carried over from the node it already had, so
 * dragging an edge cannot silently drop a phase's brief. A node the canvas
 * added is created with the fields it cannot supply left empty, which makes it
 * invalid until someone fills them in; that is the point.
 */
export function applyDag(workflow: Workflow, dag: Dag): Workflow {
  const existing = new Map(workflow.nodes.map((node) => [node.id, node]))
  const incoming = new Map<string, Dependency[]>()
  for (const edge of dag.edges) {
    const list = incoming.get(edge.to)
    const dependency: Dependency = { node: edge.from, artifact: edge.artifact }
    if (list === undefined) incoming.set(edge.to, [dependency])
    else list.push(dependency)
  }

  const nodes = dag.nodes.map((drawn): Node => {
    const base = existing.get(drawn.id) ?? blankNode(drawn.id, drawn.name)
    return { ...base, name: drawn.name, depends_on: incoming.get(drawn.id) ?? [] }
  })
  return { ...workflow, nodes }
}

/**
 * One node's non-graph fields. `undefined` **removes** the field rather than
 * setting it: `harness` and `model` are overrides of `defaults`, and "inherit"
 * is the absence of the key, not a key holding nothing.
 */
export type NodePatch = {
  readonly [K in keyof Omit<Node, 'id' | 'depends_on'>]?: Node[K] | undefined
}

export function patchNode(workflow: Workflow, nodeId: string, patch: NodePatch): Workflow {
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      if (node.id !== nodeId) return node
      const next: Record<string, unknown> = { ...node }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete next[key]
        else next[key] = value
      }
      return next as Node
    }),
  }
}

/** The artifact on one dependency — the field the implementer prompt reads. */
export function patchDependency(
  workflow: Workflow,
  nodeId: string,
  index: number,
  artifact: string,
): Workflow {
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) =>
      node.id === nodeId
        ? {
            ...node,
            depends_on: node.depends_on.map((dependency, i) =>
              i === index ? { ...dependency, artifact } : dependency,
            ),
          }
        : node,
    ),
  }
}

export type EdgeRefusal = 'self' | 'duplicate' | 'cycle'

/**
 * Why `addEdge` said no.
 *
 * The component refuses a self-loop, a duplicate and a cycle by returning
 * `null` and emitting nothing — correct for a canvas, useless for a person, who
 * is left with a gesture that did nothing. The refusal is re-derived here from
 * the same function, so the editor can say which rule was hit without a second
 * opinion about what a legal edge is.
 */
export function edgeRefusal(dag: Dag, from: string, to: string): EdgeRefusal | null {
  if (addEdge(dag, from, to, NEW_EDGE_ARTIFACT) !== null) return null
  if (from === to) return 'self'
  if (dag.edges.some((edge) => edge.from === from && edge.to === to)) return 'duplicate'
  return 'cycle'
}

/** `addEdge`'s result folded straight into the workflow, or the refusal. */
export function addDependency(
  workflow: Workflow,
  from: string,
  to: string,
  artifact: string,
): { readonly ok: true; readonly workflow: Workflow } | { readonly ok: false; readonly reason: EdgeRefusal } {
  const dag = toDag(workflow)
  const next = addEdge(dag, from, to, artifact)
  if (next === null) {
    return { ok: false, reason: edgeRefusal(dag, from, to) ?? 'duplicate' }
  }
  return { ok: true, workflow: applyDag(workflow, next) }
}

function blankNode(id: string, name: string): Node {
  return {
    id,
    name,
    depends_on: [],
    prompt_ref: NEW_NODE_PROMPT_REF,
    touches: [],
    gates: [],
    max_fix_rounds: 2,
  }
}

/** Wave banding, or a flat graph while the document still has a cycle in it. */
function wavesOf(nodes: readonly Node[]): Map<string, number> {
  return findCycle(nodes) === null ? computeWaves(nodes) : new Map()
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

/**
 * The side-effect catalog, in the shape the state machine editor's palette
 * wants (§5.2: "hosts inject the side-effect catalog"). Derived from
 * `EFFECT_CATALOG` rather than restated, so a verb added to the daemon appears
 * in the palette without a second list to keep in step.
 */
export const EFFECT_DEFINITIONS: readonly SideEffectDefinition[] = Object.values(
  EFFECT_CATALOG,
).map((definition) => ({
  id: definition.id,
  name: definition.id,
  description: definition.description,
}))

/** True when the workflow authors no pipeline of its own — the shipped one runs. */
export function usesShippedPipeline(workflow: Workflow, id: string): boolean {
  return workflow.pipelines[id] === undefined && BUILT_IN_PIPELINES[id] !== undefined
}

/** The shipped pipeline behind an id, for the "author an override" action. */
export function shippedPipeline(id: string): Pipeline | undefined {
  return BUILT_IN_PIPELINES[id]
}

/**
 * A workflow pipeline as `<state-machine-editor>` wants it.
 *
 * §5.2 says the two shapes are the same and at 0.11.0 three of them are not,
 * so the differences are handled here and nowhere else:
 *
 * - **Ordered hooks.** The editor splits every effect list into `before` and
 *   `after`; the workflow schema has one list. It maps to `before`, and
 *   `fromMachine` concatenates the two back in order — so an author who uses
 *   `after` keeps their effects and their order, and loses only the phase
 *   distinction the executor has no meaning for.
 * - **Triggers are objects.** `{ id, name }` there, an opaque string here.
 * - **Required where we allow absent.** `name`, `description`, `color` and
 *   `data` are optional in the workflow schema and mandatory there, so the
 *   defaults are filled in on the way out and dropped again on the way back.
 *
 * `labelOffset` and `requiredPermission` have no workflow counterpart and do
 * not survive a save. Neither has runtime meaning to the interpreter.
 */
export function toMachine(pipeline: Pipeline): StateMachine {
  return {
    states: pipeline.states.map(
      (state): MachineState => ({
        id: state.id,
        name: state.name,
        position: state.position,
        onEnter: { before: state.onEnter.map(toMachineEffect), after: [] },
        onLeave: { before: state.onLeave.map(toMachineEffect), after: [] },
        color: isStateColor(state.color) ? state.color : 'neutral',
        description: state.description ?? '',
        data: (state.data ?? {}) as JsonObject,
      }),
    ),
    transitions: pipeline.transitions.map(
      (transition): MachineTransition => ({
        id: transition.id,
        name: transition.name ?? transition.id,
        from: transition.from,
        to: transition.to,
        trigger:
          transition.trigger === undefined
            ? null
            : { id: transition.trigger, name: transition.trigger },
        guard: transition.guard ?? '',
        requiredPermission: '',
        description: '',
        labelOffset: { x: 0, y: 0 },
        effects: { before: transition.effects.map(toMachineEffect), after: [] },
        data: (transition.data ?? {}) as JsonObject,
      }),
    ),
    initialStateIds: pipeline.initialStateIds,
    finalStateIds: pipeline.finalStateIds,
    data: (pipeline.data ?? {}) as JsonObject,
  }
}

/**
 * The inverse. A creation transition's absent source becomes an invalid id.
 *
 * Ids are normalised on the way back. The editor mints `state_<uuid>`, and the
 * workflow schema's ids are kebab-case with no underscore — so a state added
 * on the canvas would otherwise fail validation at
 * `pipelines.<id>.states[n].id` with nothing the author could do about it.
 * The rename is deterministic and applied to every reference at once, so an id
 * that is already legal — everything the package ships — is left exactly as it
 * is and the round trip stays the identity.
 */
export function fromMachine(machine: StateMachine): Pipeline {
  const states = legalIds(machine.states.map((state) => state.id))
  const transitions = legalIds(machine.transitions.map((transition) => transition.id))
  const stateId = (id: string): string => states.get(id) ?? id

  return {
    states: machine.states.map((state) => ({
      id: stateId(state.id),
      name: state.name,
      position: state.position,
      onEnter: hookEffects(state.onEnter),
      onLeave: hookEffects(state.onLeave),
      ...(state.color === 'neutral' ? {} : { color: state.color }),
      ...(state.description === '' ? {} : { description: state.description }),
      ...(isEmpty(state.data) ? {} : { data: state.data }),
    })),
    transitions: machine.transitions.map((transition) => ({
      id: transitions.get(transition.id) ?? transition.id,
      // The editor requires a name and the schema does not, so the id it was
      // filled in with on the way out is dropped again on the way back. A
      // round trip through this pair is the identity.
      ...(transition.name === transition.id ? {} : { name: transition.name }),
      // The workflow schema has no creation transitions: every edge leaves a
      // state. An empty source is left in place so validation names the
      // transition rather than the editor dropping the edge behind the author.
      from: transition.from === null ? '' : stateId(transition.from),
      to: stateId(transition.to),
      ...(transition.trigger === null ? {} : { trigger: transition.trigger.id }),
      ...(transition.guard === '' ? {} : { guard: transition.guard }),
      effects: hookEffects(transition.effects),
      ...(isEmpty(transition.data) ? {} : { data: transition.data }),
    })),
    initialStateIds: machine.initialStateIds.map(stateId),
    finalStateIds: machine.finalStateIds.map(stateId),
    ...(isEmpty(machine.data) ? {} : { data: machine.data }),
  }
}

/** Replaces one pipeline, or removes it when `pipeline` is null. */
export function setPipeline(
  workflow: Workflow,
  id: string,
  pipeline: Pipeline | null,
): Workflow {
  const pipelines = { ...workflow.pipelines }
  if (pipeline === null) delete pipelines[id]
  else pipelines[id] = pipeline
  return { ...workflow, pipelines }
}

/**
 * The workflow schema's id rule, applied to whatever the canvas minted. The
 * mapping is returned rather than applied, because every reference to a
 * renamed id has to move with it in the same pass.
 */
function legalIds(values: readonly string[]): Map<string, string> {
  const taken = new Set<string>()
  const mapping = new Map<string, string>()
  for (const value of values) {
    const base =
      value
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^[^a-z0-9]+/, '') || 'id'
    let unique = base
    for (let n = 2; taken.has(unique); n += 1) unique = `${base}-${n}`
    taken.add(unique)
    mapping.set(value, unique)
  }
  return mapping
}

function toMachineEffect(effect: SideEffect): MachineEffect {
  return {
    id: effect.id,
    definitionId: effect.definitionId,
    name: effect.name ?? effect.definitionId,
    params: effect.params as JsonObject,
    enabled: effect.enabled,
    description: effect.description ?? '',
    data: (effect.data ?? {}) as JsonObject,
  }
}

function hookEffects(hooks: {
  readonly before: readonly MachineEffect[]
  readonly after: readonly MachineEffect[]
}): SideEffect[] {
  const ids = legalIds([...hooks.before, ...hooks.after].map((effect) => effect.id))
  return [...hooks.before, ...hooks.after].map((effect) => ({
    id: ids.get(effect.id) ?? effect.id,
    definitionId: effect.definitionId as SideEffect['definitionId'],
    ...(effect.name === effect.definitionId ? {} : { name: effect.name }),
    params: effect.params,
    enabled: effect.enabled,
    ...(effect.description === '' ? {} : { description: effect.description }),
    ...(isEmpty(effect.data) ? {} : { data: effect.data }),
  }))
}

function isEmpty(value: Readonly<Record<string, unknown>> | undefined): boolean {
  return value === undefined || Object.keys(value).length === 0
}
