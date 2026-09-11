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
 *
 * Layout: the canvas and the forms that act on the whole workflow on the
 * left; the selected node's fields in an inspector column on the right, where
 * they stay beside the graph they describe.
 */
import { ChevronRightIcon, PlusIcon, SaveIcon } from 'lucide-react'
import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Dag } from 'vinta-dag-editor/src/index.ts'
import {
  HStack,
  PageHeader,
  PageHeaderActions,
  PageHeaderHeading,
  PageHeaderMeta,
  PageHeaderTitle,
} from 'vinta-design-system/layout'
import { Badge } from 'vinta-design-system/ui/badge'
import { Button } from 'vinta-design-system/ui/button'
import { Input } from 'vinta-design-system/ui/input'
import { Label } from 'vinta-design-system/ui/label'
import { NativeSelect, NativeSelectOption } from 'vinta-design-system/ui/native-select'
import { formatPath, type Issue } from '../../src/daemon/schemas.ts'
import { HARNESS_IDS, type Node, type Pipeline, type Workflow } from '../../src/types.ts'
import { parseWorkflow, type ValidationIssue } from '../../src/validate.ts'
import { Chip } from './Chip.tsx'
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
import { EmptyNote, ErrorNote, Hint, Panel } from './Panel.tsx'

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

  return (
    <section className="editor flex flex-col gap-5">
      <PageHeader>
        <PageHeaderHeading>
          <PageHeaderTitle>Workflows</PageHeaderTitle>
          <PageHeaderMeta>
            <span>Each is a committed workflow.json; a save rewrites it in place.</span>
          </PageHeaderMeta>
        </PageHeaderHeading>
      </PageHeader>
      {error !== null && <ErrorNote>{error}</ErrorNote>}
      {error === null && ids === null && <EmptyNote>Loading workflows…</EmptyNote>}
      {error === null && ids !== null && ids.length === 0 && (
        <EmptyNote>No workflows to edit.</EmptyNote>
      )}
      {error === null && ids !== null && ids.length > 0 && (
        <Panel title="Open a workflow" contentClassName="px-0">
          <ul className="divide-y">
            {ids.map((id) => (
              <li key={id} data-workflow={id}>
                <a
                  href={`#/editor/${encodeURIComponent(id)}`}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm font-medium text-foreground no-underline hover:bg-muted/60 hover:no-underline"
                >
                  <span className="font-mono">{id}</span>
                  <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        </Panel>
      )}
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

  const onDagChange = useCallback((dag: Dag): void => {
    setNotice(null)
    setDraft((current) => (current === null ? current : applyDag(current, dag)))
    setSaved(false)
    setRefused(null)
  }, [])

  // The daemon's own validator, on every change. `issues` is empty exactly
  // when the executor would accept this document.
  const issues = useMemo<readonly ValidationIssue[]>(() => {
    if (draft === null) return []
    const parsed = parseWorkflow(draft)
    return parsed.ok ? [] : parsed.issues
  }, [draft])

  if (loadError !== null) return <ErrorNote>{loadError}</ErrorNote>
  if (draft === null) return <EmptyNote>Loading workflow…</EmptyNote>

  const dag = toDag(draft)
  const node = draft.nodes.find((candidate) => candidate.id === selected) ?? null

  return (
    <section className="editor flex flex-col gap-5" data-workflow={workflowId}>
      <PageHeader className="run-head">
        <PageHeaderHeading>
          <PageHeaderTitle>{draft.id}</PageHeaderTitle>
          <PageHeaderMeta>
            <span>{draft.id}.workflow.json</span>
            <span>base {draft.base_branch}</span>
            <span>
              {draft.nodes.length} {draft.nodes.length === 1 ? 'node' : 'nodes'}
            </span>
          </PageHeaderMeta>
        </PageHeaderHeading>
        <PageHeaderActions className="run-meta">
          {issues.length === 0 ? (
            <Chip tone="ok">valid</Chip>
          ) : (
            <Chip tone="error">
              {issues.length} {issues.length === 1 ? 'issue' : 'issues'}
            </Chip>
          )}
          {saved && (
            <span className="muted text-[13px] text-muted-foreground" data-role="saved">
              Saved
            </span>
          )}
          <Button
            type="button"
            size="sm"
            data-action="save"
            disabled={issues.length > 0}
            onClick={() => void save(draft)}
          >
            <SaveIcon />
            Save
          </Button>
        </PageHeaderActions>
      </PageHeader>

      {notice !== null && <ErrorNote data-role="notice">{notice}</ErrorNote>}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
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

          <Pipelines
            workflow={draft}
            open={openPipeline}
            onOpen={setOpenPipeline}
            onChange={(id, pipeline) => edit(setPipeline(draft, id, pipeline))}
          />
        </div>

        <div className="flex flex-col gap-4">
          {node !== null ? (
            <NodeFields
              workflow={draft}
              node={node}
              onPatch={(patch) => edit(patchNode(draft, node.id, patch))}
              onArtifact={(index, artifact) =>
                edit(patchDependency(draft, node.id, index, artifact))
              }
            />
          ) : (
            <Panel title="Node" description="Everything the canvas has no opinion about.">
              <EmptyNote>Select a node on the canvas to edit its fields.</EmptyNote>
            </Panel>
          )}
          <Issues issues={issues} refused={refused} />
        </div>
      </div>
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

/** A labelled control: the label above, the control full width. */
function Field({
  label,
  htmlFor,
  children,
}: {
  readonly label: string
  readonly htmlFor: string
  readonly children: ReactElement
}): ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor} className="text-[13px]">
        {label}
      </Label>
      {children}
    </div>
  )
}

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
    <Panel
      title="Add dependency"
      description="An arrow states an order; the artifact says what the downstream phase builds on."
    >
      <form
        className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_2fr_auto]"
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
        <Field label="Depends on" htmlFor="dependency-from">
          <NativeSelect
            id="dependency-from"
            size="sm"
            className="w-full"
            data-field="from"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          >
            {nodes.map((candidate) => (
              <NativeSelectOption key={candidate.id} value={candidate.id}>
                {candidate.id}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Node" htmlFor="dependency-to">
          <NativeSelect
            id="dependency-to"
            size="sm"
            className="w-full"
            data-field="to"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          >
            {nodes.map((candidate) => (
              <NativeSelectOption key={candidate.id} value={candidate.id}>
                {candidate.id}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Artifact" htmlFor="dependency-artifact">
          <Input
            id="dependency-artifact"
            className="h-8"
            data-field="artifact"
            placeholder="what the downstream phase builds on"
            value={artifact}
            onChange={(e) => setArtifact(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="outline" size="sm" data-action="add-dependency">
          <PlusIcon />
          Add dependency
        </Button>
      </form>
    </Panel>
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
    <Panel
      title={<span className="font-mono">{node.id}</span>}
      description="Everything the canvas has no opinion about."
      data-role="node-fields"
      data-node={node.id}
      contentClassName="gap-3.5"
    >
      <Field label="Name" htmlFor="node-name">
        <Input
          id="node-name"
          className="h-8"
          data-field="name"
          value={node.name}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
      </Field>
      <Field label="Prompt ref" htmlFor="node-prompt-ref">
        <Input
          id="node-prompt-ref"
          className="h-8 font-mono text-xs"
          data-field="prompt_ref"
          value={node.prompt_ref}
          onChange={(e) => onPatch({ prompt_ref: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Harness" htmlFor="node-harness">
          <NativeSelect
            id="node-harness"
            size="sm"
            className="w-full"
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
            <NativeSelectOption value="">inherit ({workflow.defaults.harness})</NativeSelectOption>
            {HARNESS_IDS.map((id) => (
              <NativeSelectOption key={id} value={id}>
                {id}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Max fix rounds" htmlFor="node-max-fix-rounds">
          <Input
            id="node-max-fix-rounds"
            className="h-8 font-mono"
            data-field="max_fix_rounds"
            type="number"
            min={0}
            value={node.max_fix_rounds}
            onChange={(e) => onPatch({ max_fix_rounds: Number.parseInt(e.target.value, 10) })}
          />
        </Field>
      </div>
      <Field label="Model" htmlFor="node-model">
        <Input
          id="node-model"
          className="h-8 font-mono text-xs"
          data-field="model"
          value={node.model ?? ''}
          placeholder={workflow.defaults.model}
          onChange={(e) =>
            onPatch(e.target.value === '' ? { model: undefined } : { model: e.target.value })
          }
        />
      </Field>

      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0" data-field="gates">
        <legend className="mb-1.5 text-[13px] font-medium">Gates</legend>
        {gates.length === 0 ? (
          <EmptyNote>This workflow declares no gates.</EmptyNote>
        ) : (
          <HStack gap={4} wrap>
            {gates.map((gate) => (
              <label key={gate} className="flex items-center gap-2 text-sm">
                {/* A real checkbox: form semantics, keyboard, and a test's click. */}
                <input
                  type="checkbox"
                  className="size-4 rounded-[4px] accent-primary"
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
                <span className="font-mono text-xs">{gate}</span>
              </label>
            ))}
          </HStack>
        )}
      </fieldset>

      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0" data-field="depends_on">
        <legend className="mb-1.5 text-[13px] font-medium">Dependencies</legend>
        {node.depends_on.length === 0 ? (
          <EmptyNote>No dependencies — this node branches from the base.</EmptyNote>
        ) : (
          node.depends_on.map((dependency, index) => (
            <label
              key={dependency.node}
              data-dependency={dependency.node}
              className="flex items-center gap-2 text-xs"
            >
              <span className="shrink-0 font-mono text-muted-foreground">
                {dependency.node} provides
              </span>
              <Input
                className="h-8 text-xs"
                aria-label={`Artifact ${dependency.node} provides`}
                data-field="artifact"
                value={dependency.artifact}
                onChange={(e) => onArtifact(index, e.target.value)}
              />
            </label>
          ))
        )}
      </fieldset>
    </Panel>
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
    <Panel title="Pipelines" data-role="pipelines">
      <ul className="divide-y">
        {referenced.map((id) => {
          const shipped = usesShippedPipeline(workflow, id)
          const declared = workflow.pipelines[id] !== undefined
          return (
            <li
              key={id}
              data-pipeline={id}
              className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="flex items-center gap-2">
                  <strong className="font-mono text-[13px] font-semibold">{id}</strong>
                  {shipped && <Badge variant="outline">shipped</Badge>}
                  {declared && <Chip tone="active">override</Chip>}
                </span>
                {shipped && (
                  <Hint className="muted text-xs" data-role="shipped">
                    Uses the pipeline the package ships. The executor supplies it at run time;
                    this workflow authors no override.
                  </Hint>
                )}
                {declared && (
                  <Hint className="muted text-xs" data-role="override">
                    This workflow authors its own copy, which shadows any shipped pipeline of the
                    same name.
                  </Hint>
                )}
                {!shipped && !declared && (
                  <ErrorNote data-role="unknown-pipeline">
                    Nothing declares or ships a pipeline with this name.
                  </ErrorNote>
                )}
              </div>
              <HStack gap={2} wrap>
                {shipped && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-action="author-override"
                    onClick={() => {
                      const base = shippedPipeline(id)
                      if (base === undefined) return
                      onChange(id, base)
                      onOpen(id)
                    }}
                  >
                    Author an override
                  </Button>
                )}
                {declared && (
                  <>
                    <Button
                      type="button"
                      variant={open === id ? 'secondary' : 'outline'}
                      size="sm"
                      data-action="open-pipeline"
                      onClick={() => onOpen(id)}
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-action="drop-override"
                      onClick={() => {
                        onChange(id, null)
                        if (open === id) onOpen(null)
                      }}
                    >
                      Drop the override
                    </Button>
                  </>
                )}
              </HStack>
            </li>
          )
        })}
      </ul>
      {open !== null && opened !== undefined && (
        <EditorPipeline
          key={open}
          pipeline={opened}
          onChange={(pipeline) => onChange(open, pipeline)}
        />
      )}
    </Panel>
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
    <Panel
      title="Validation"
      data-role="issues"
      action={issues.length === 0 ? <Chip tone="ok">valid</Chip> : <Chip tone="error">invalid</Chip>}
    >
      {issues.length === 0 ? (
        <EmptyNote data-role="valid">
          This workflow is valid. The daemon runs the same validator before it accepts a save.
        </EmptyNote>
      ) : (
        <ul className="flex flex-col gap-1.5 text-sm">
          {issues.map((issue) => {
            const path = formatPath(issue.path)
            return (
              <li key={`${path}:${issue.message}`} data-path={path}>
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                  {path === '' ? '(root)' : path}
                </code>{' '}
                {issue.message}
              </li>
            )
          })}
        </ul>
      )}
      {refused !== null && (
        <div className="flex flex-col gap-1.5 border-t pt-3" data-role="refused">
          <ErrorNote>{refused.message}</ErrorNote>
          <ul className="flex flex-col gap-1.5 text-sm">
            {refused.issues.map((issue) => (
              <li key={`${issue.path}:${issue.message}`} data-server-path={issue.path}>
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                  {issue.path === '' ? '(root)' : issue.path}
                </code>{' '}
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  )
}

/** A reason, never a body: the daemon's codes and statuses carry no contents. */
function describe(reason: unknown): string {
  if (reason instanceof WorkflowRefused) return CODES[reason.code] ?? `Refused: ${reason.code}`
  return reason instanceof Error ? reason.message : 'The daemon could not be reached.'
}
