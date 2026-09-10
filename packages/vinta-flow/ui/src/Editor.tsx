/**
 * The Editor (§10): open a workflow, change it, see why it is wrong, save it.
 *
 * The two graph surfaces do the graph work — `<vinta-dag>` in edit mode for
 * the plan DAG, `<state-machine-editor>` for the pipelines — so what is left
 * here is the three things a canvas cannot know:
 *
 * - **The fields that are not geometry.** A node carries a `prompt_ref`, gates,
 *   a harness, a model and a fix-round budget, and a dependency carries an
 *   *artifact*. The artifact is what the implementer prompt uses to explain
 *   what the phase builds on (§5.1), so it is a labelled required field beside
 *   its dependency, never a tooltip on an arrow.
 * - **Validation, through the daemon's own validator.** `parseWorkflow` is the
 *   function the executor runs, imported rather than re-implemented, so this
 *   view cannot bless a workflow the run would refuse. Issues are listed at
 *   their paths.
 * - **What a workflow with no `pipelines` means.** It means the executor
 *   supplies the shipped one. Editing it is therefore *authoring an override*,
 *   and that is an explicit button rather than something that happens the
 *   first time someone drags a state.
 *
 * Saving is refused locally when the document is invalid and refused again by
 * the daemon; the second refusal is the boundary, and both are shown.
 *
 * §9's amend — changing a run already in flight — is not this screen. The
 * daemon refuses a save whose workflow has a running run, and the refusal is
 * surfaced verbatim rather than worked around.
 */
import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Dag } from 'vinta-dag-editor/src/index.ts'
import { formatPath, type Issue } from '../../src/daemon/schemas.ts'
import { HARNESS_IDS, type Node, type Pipeline, type Workflow } from '../../src/types.ts'
import { parseWorkflow, type ValidationIssue } from '../../src/validate.ts'
import { WorkflowRefused, type WorkflowClient } from './editor-client.ts'
import {
  addDependency,
  applyDag,
  patchDependency,
  patchNode,
  type NodePatch,
  setPipeline,
  shippedPipeline,
  toDag,
  usesShippedPipeline,
} from './editor-model.ts'
import { EditorDag } from './EditorDag.tsx'
import { EditorPipeline } from './EditorPipeline.tsx'

const REFUSALS: Readonly<Record<string, string>> = {
  self: 'A node cannot depend on itself.',
  duplicate: 'That dependency already exists.',
  cycle: 'That dependency would make a cycle, so the graph would not be a DAG.',
}

/** What the daemon's refusal codes mean to a person. */
const CODES: Readonly<Record<string, string>> = {
  invalid_workflow: 'The daemon refused this workflow.',
  run_in_progress:
    'A run of this workflow is still going. Changing a live run is the amend path, not the editor.',
  unknown_workflow: 'No workflow with that id.',
  unauthorized: 'The daemon refused the request.',
  write_failed: 'The daemon could not write the file.',
}

// ---------------------------------------------------------------------------

export function EditorList({ workflows }: { readonly workflows: WorkflowClient }): ReactElement {
  const [ids, setIds] = useState<readonly string[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    workflows
      .list()
      .then((list) => live && setIds(list))
      .catch((reason: unknown) => live && setError(describe(reason)))
    return () => {
      live = false
    }
  }, [workflows])

  if (error !== null) return <p className="error">{error}</p>
  if (ids === null) return <p className="empty">Loading workflows…</p>
  if (ids.length === 0) return <p className="empty">No workflows to edit.</p>

  return (
    <section className="editor">
      <h2>Workflows</h2>
      <ul>
        {ids.map((id) => (
          <li key={id} data-workflow={id}>
            <a href={`#/editor/${encodeURIComponent(id)}`}>{id}</a>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function EditorView({
  workflows,
  workflowId,
}: {
  readonly workflows: WorkflowClient
  readonly workflowId: string
}): ReactElement {
  const [draft, setDraft] = useState<Workflow | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [refused, setRefused] = useState<{ message: string; issues: readonly Issue[] } | null>(null)
  const [saved, setSaved] = useState(false)
  const [openPipeline, setOpenPipeline] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    workflows
      .load(workflowId)
      .then((workflow) => {
        if (!live) return
        setDraft(workflow)
        setLoadError(null)
      })
      .catch((reason: unknown) => live && setLoadError(describe(reason)))
    return () => {
      live = false
    }
  }, [workflows, workflowId])

  const edit = useCallback((next: Workflow): void => {
    setDraft(next)
    setSaved(false)
    setRefused(null)
  }, [])

  const onDagChange = useCallback(
    (dag: Dag): void => {
      setNotice(null)
      setDraft((current) => (current === null ? current : applyDag(current, dag)))
      setSaved(false)
      setRefused(null)
    },
    [],
  )

  // The daemon's own validator, on every change. `issues` is empty exactly
  // when the executor would accept this document.
  const issues = useMemo<readonly ValidationIssue[]>(() => {
    if (draft === null) return []
    const parsed = parseWorkflow(draft)
    return parsed.ok ? [] : parsed.issues
  }, [draft])

  if (loadError !== null) return <p className="error">{loadError}</p>
  if (draft === null) return <p className="empty">Loading workflow…</p>

  const dag = toDag(draft)
  const node = draft.nodes.find((candidate) => candidate.id === selected) ?? null

  return (
    <section className="editor" data-workflow={workflowId}>
      <header className="run-head">
        <div>
          <h2>{draft.id}</h2>
          <p className="muted">base {draft.base_branch}</p>
        </div>
        <div className="run-meta">
          <button
            type="button"
            data-action="save"
            disabled={issues.length > 0}
            onClick={() => void save(draft)}
          >
            Save
          </button>
          {saved && <span className="muted" data-role="saved">Saved</span>}
        </div>
      </header>

      {notice !== null && (
        <p className="error" data-role="notice">
          {notice}
        </p>
      )}

      <EditorDag dag={dag} selected={selected} onChange={onDagChange} onSelect={setSelected} />

      <DependencyForm
        nodes={draft.nodes}
        onAdd={(from, to, artifact) => {
          const result = addDependency(draft, from, to, artifact)
          if (!result.ok) {
            setNotice(REFUSALS[result.reason] ?? 'That dependency was refused.')
            return
          }
          setNotice(null)
          edit(result.workflow)
        }}
        onRefuse={setNotice}
      />

      {node !== null && (
        <NodeFields
          workflow={draft}
          node={node}
          onPatch={(patch) => edit(patchNode(draft, node.id, patch))}
          onArtifact={(index, artifact) =>
            edit(patchDependency(draft, node.id, index, artifact))
          }
        />
      )}

      <Pipelines
        workflow={draft}
        open={openPipeline}
        onOpen={setOpenPipeline}
        onChange={(id, pipeline) => edit(setPipeline(draft, id, pipeline))}
      />

      <Issues issues={issues} refused={refused} />
    </section>
  )

  async function save(current: Workflow): Promise<void> {
    // Refused here as well as at the daemon. The daemon's refusal is the
    // boundary; this one only spares the round trip and keeps the button
    // honest about what it would do.
    if (issues.length > 0) {
      setRefused({ message: 'This workflow is not valid, so it was not sent.', issues: [] })
      return
    }
    try {
      await workflows.save(workflowId, current)
      setSaved(true)
      setRefused(null)
    } catch (reason: unknown) {
      setSaved(false)
      setRefused(
        reason instanceof WorkflowRefused
          ? { message: CODES[reason.code] ?? describe(reason), issues: reason.issues }
          : { message: describe(reason), issues: [] },
      )
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * Drawing an arrow on the canvas states an order; it does not state *what* the
 * downstream phase needs. This form asks for both at once, which is why the
 * artifact is a required field here rather than something to remember later.
 */
function DependencyForm({
  nodes,
  onAdd,
  onRefuse,
}: {
  readonly nodes: readonly Node[]
  readonly onAdd: (from: string, to: string, artifact: string) => void
  readonly onRefuse: (message: string) => void
}): ReactElement {
  const first = nodes[0]?.id ?? ''
  const [from, setFrom] = useState(first)
  const [to, setTo] = useState(nodes[1]?.id ?? first)
  const [artifact, setArtifact] = useState('')

  return (
    <form
      className="panel"
      data-role="dependency-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (artifact.trim() === '') {
          onRefuse('A dependency needs an artifact — what the downstream phase builds on.')
          return
        }
        onAdd(from, to, artifact)
        setArtifact('')
      }}
    >
      <h3>Add dependency</h3>
      <label>
        Depends on
        <select data-field="from" value={from} onChange={(e) => setFrom(e.target.value)}>
          {nodes.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.id}
            </option>
          ))}
        </select>
      </label>
      <label>
        Node
        <select data-field="to" value={to} onChange={(e) => setTo(e.target.value)}>
          {nodes.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.id}
            </option>
          ))}
        </select>
      </label>
      <label>
        Artifact
        <input
          data-field="artifact"
          value={artifact}
          onChange={(e) => setArtifact(e.target.value)}
        />
      </label>
      <button type="submit" data-action="add-dependency">
        Add dependency
      </button>
    </form>
  )
}

/** Everything about a node the canvas has no opinion about. */
function NodeFields({
  workflow,
  node,
  onPatch,
  onArtifact,
}: {
  readonly workflow: Workflow
  readonly node: Node
  readonly onPatch: (patch: NodePatch) => void
  readonly onArtifact: (index: number, artifact: string) => void
}): ReactElement {
  const gates = Object.keys(workflow.gates)
  return (
    <section className="panel" data-role="node-fields" data-node={node.id}>
      <h3>{node.id}</h3>
      <label>
        Name
        <input
          data-field="name"
          value={node.name}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
      </label>
      <label>
        Prompt ref
        <input
          data-field="prompt_ref"
          value={node.prompt_ref}
          onChange={(e) => onPatch({ prompt_ref: e.target.value })}
        />
      </label>
      <label>
        Harness
        <select
          data-field="harness"
          value={node.harness ?? ''}
          onChange={(e) =>
            onPatch(
              e.target.value === ''
                ? { harness: undefined }
                : { harness: e.target.value as Node['harness'] },
            )
          }
        >
          <option value="">inherit ({workflow.defaults.harness})</option>
          {HARNESS_IDS.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
      <label>
        Model
        <input
          data-field="model"
          value={node.model ?? ''}
          placeholder={workflow.defaults.model}
          onChange={(e) =>
            onPatch(e.target.value === '' ? { model: undefined } : { model: e.target.value })
          }
        />
      </label>
      <label>
        Max fix rounds
        <input
          data-field="max_fix_rounds"
          type="number"
          min={0}
          value={node.max_fix_rounds}
          onChange={(e) => onPatch({ max_fix_rounds: Number.parseInt(e.target.value, 10) })}
        />
      </label>

      <fieldset data-field="gates">
        <legend>Gates</legend>
        {gates.length === 0 ? (
          <p className="empty">This workflow declares no gates.</p>
        ) : (
          gates.map((gate) => (
            <label key={gate}>
              <input
                type="checkbox"
                data-gate={gate}
                checked={node.gates.includes(gate)}
                onChange={(e) =>
                  onPatch({
                    gates: e.target.checked
                      ? [...node.gates, gate]
                      : node.gates.filter((held) => held !== gate),
                  })
                }
              />
              {gate}
            </label>
          ))
        )}
      </fieldset>

      <fieldset data-field="depends_on">
        <legend>Dependencies</legend>
        {node.depends_on.length === 0 ? (
          <p className="empty">No dependencies — this node branches from the base.</p>
        ) : (
          node.depends_on.map((dependency, index) => (
            <label key={dependency.node} data-dependency={dependency.node}>
              {dependency.node} provides
              <input
                data-field="artifact"
                value={dependency.artifact}
                onChange={(e) => onArtifact(index, e.target.value)}
              />
            </label>
          ))
        )}
      </fieldset>
    </section>
  )
}

/**
 * §5.2's point, on screen: a pipeline is machinery, not plan data. A workflow
 * that names `standard-phase` and declares nothing is *using the shipped one*,
 * and the editor says so instead of materialising a copy of it the moment
 * somebody looks at the canvas. Authoring an override is a button press, and
 * from then on the copy is the workflow's own.
 */
function Pipelines({
  workflow,
  open,
  onOpen,
  onChange,
}: {
  readonly workflow: Workflow
  readonly open: string | null
  readonly onOpen: (id: string | null) => void
  readonly onChange: (id: string, pipeline: Pipeline | null) => void
}): ReactElement {
  const referenced = [
    ...new Set([
      workflow.defaults.pipeline,
      ...workflow.nodes.flatMap((node) => (node.pipeline === undefined ? [] : [node.pipeline])),
      ...Object.keys(workflow.pipelines),
    ]),
  ]
  const opened = open === null ? undefined : workflow.pipelines[open]

  return (
    <section className="panel" data-role="pipelines">
      <h3>Pipelines</h3>
      {referenced.map((id) => {
        const shipped = usesShippedPipeline(workflow, id)
        const declared = workflow.pipelines[id] !== undefined
        return (
          <div key={id} data-pipeline={id}>
            <strong>{id}</strong>
            {shipped && (
              <>
                <p className="muted" data-role="shipped">
                  Uses the pipeline the package ships. The executor supplies it at run time; this
                  workflow authors no override.
                </p>
                <button
                  type="button"
                  data-action="author-override"
                  onClick={() => {
                    const base = shippedPipeline(id)
                    if (base === undefined) return
                    onChange(id, base)
                    onOpen(id)
                  }}
                >
                  Author an override
                </button>
              </>
            )}
            {declared && (
              <>
                <p className="muted" data-role="override">
                  This workflow authors its own copy, which shadows any shipped pipeline of the
                  same name.
                </p>
                <button type="button" data-action="open-pipeline" onClick={() => onOpen(id)}>
                  Edit
                </button>
                <button
                  type="button"
                  data-action="drop-override"
                  onClick={() => {
                    onChange(id, null)
                    if (open === id) onOpen(null)
                  }}
                >
                  Drop the override
                </button>
              </>
            )}
            {!shipped && !declared && (
              <p className="error" data-role="unknown-pipeline">
                Nothing declares or ships a pipeline with this name.
              </p>
            )}
          </div>
        )
      })}
      {open !== null && opened !== undefined && (
        <EditorPipeline
          key={open}
          pipeline={opened}
          onChange={(pipeline) => onChange(open, pipeline)}
        />
      )}
    </section>
  )
}

/** Every issue at its path — the validator's location, not a paraphrase. */
function Issues({
  issues,
  refused,
}: {
  readonly issues: readonly ValidationIssue[]
  readonly refused: { readonly message: string; readonly issues: readonly Issue[] } | null
}): ReactElement {
  return (
    <section className="panel" data-role="issues">
      <h3>Validation</h3>
      {issues.length === 0 ? (
        <p className="empty" data-role="valid">
          This workflow is valid.
        </p>
      ) : (
        <ul>
          {issues.map((issue) => {
            const path = formatPath(issue.path)
            return (
              <li key={`${path}:${issue.message}`} data-path={path}>
                <code>{path === '' ? '(root)' : path}</code>: {issue.message}
              </li>
            )
          })}
        </ul>
      )}
      {refused !== null && (
        <div data-role="refused">
          <p className="error">{refused.message}</p>
          <ul>
            {refused.issues.map((issue) => (
              <li key={`${issue.path}:${issue.message}`} data-server-path={issue.path}>
                <code>{issue.path === '' ? '(root)' : issue.path}</code>: {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/** A reason, never a body: the daemon's codes and statuses carry no contents. */
function describe(reason: unknown): string {
  if (reason instanceof WorkflowRefused) return CODES[reason.code] ?? `Refused: ${reason.code}`
  return reason instanceof Error ? reason.message : 'The daemon could not be reached.'
}
