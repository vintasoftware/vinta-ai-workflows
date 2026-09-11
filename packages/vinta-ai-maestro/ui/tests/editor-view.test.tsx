/**
 * The Editor on screen, against a real listener.
 *
 * Everything is driven through the components themselves — the toolbar inside
 * `<vinta-dag>`'s shadow root, the connect handle, the state machine editor's
 * own `addState` — rather than by calling the model functions the view uses.
 * A test that reached past the canvas would prove the translations work and
 * say nothing about whether the screen is wired to them.
 */
import { cleanup, fireEvent, render, waitFor, type RenderResult } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import type { StateMachineEditorElement } from 'vinta-state-machine-editor'
import { App } from '../src/App.tsx'
import { createClient } from '../src/client.ts'
import { createWorkflowClient } from '../src/editor-client.ts'
import { EFFECT_CATALOG } from '../../src/pipeline/effects.ts'
import type { Workflow } from '../../src/types.ts'
import { node, RUN_ID, runSummary, snapshot } from './fixtures.ts'
import { startStubDaemon, type StubDaemon } from './stub-daemon.ts'

const WORKFLOW_ID = 'billing'

/** The document under edit. Deliberately declares no `pipelines` (§5.2). */
const WORKFLOW = {
  schema_version: 1,
  id: WORKFLOW_ID,
  base_branch: 'main',
  defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase' },
  resources: { lane: { capacity: 2, kind: 'worktree' } },
  gates: { unit: { cmd: 'pnpm test', requires: [] } },
  nodes: [
    { id: 'p1', name: 'Model', prompt_ref: 'plan.md#p1', gates: ['unit'] },
    {
      id: 'p2',
      name: 'API',
      prompt_ref: 'plan.md#p2',
      depends_on: [{ node: 'p1', artifact: 'the BookmarkFolder model' }],
    },
  ],
}

let daemon: StubDaemon | null = null

afterEach(async () => {
  cleanup()
  window.location.hash = ''
  await daemon?.close()
  daemon = null
})

async function openEditor(hash = `#/editor/${WORKFLOW_ID}`): Promise<RenderResult> {
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [node('p1', 'running')] }) },
    workflows: { [WORKFLOW_ID]: WORKFLOW },
  })
  daemon = stub
  window.location.hash = hash
  const view = render(
    <App
      client={createClient(stub.origin, stub.token)}
      workflows={createWorkflowClient(stub.origin, stub.token)}
    />,
  )
  if (hash.startsWith('#/editor/')) {
    await waitFor(() => expect(view.container.querySelector('.editor')).not.toBe(null))
  }
  return view
}

function shadow(container: HTMLElement): ShadowRoot {
  const host = container.querySelector('vinta-dag')
  if (host?.shadowRoot == null) throw new Error('the canvas did not mount')
  return host.shadowRoot
}

function control(container: HTMLElement, action: string, id?: string): HTMLElement {
  const selector = id === undefined ? `[data-action="${action}"]` : `[data-action="${action}"][data-id="${id}"]`
  const found = shadow(container).querySelector(selector)
  if (!(found instanceof HTMLElement)) throw new Error(`no ${action} control`)
  return found
}

function paths(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-role="issues"] li[data-path]')].map(
    (item) => item.getAttribute('data-path') ?? '',
  )
}

function saveButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector('[data-action="save"]')
  if (!(button instanceof HTMLButtonElement)) throw new Error('no save button')
  return button
}

// ---------------------------------------------------------------------------

test('a workflow loads, renders as a DAG, and the token never reaches the page', async () => {
  const { container } = await openEditor()

  expect(control(container, 'select-node', 'p1').getAttribute('aria-label')).toContain('Model')
  expect(control(container, 'select-edge', 'p1-p2').textContent).toBe('the BookmarkFolder model')
  expect(container.querySelector('[data-role="valid"]')).not.toBe(null)
  expect(container.innerHTML).not.toContain(daemon?.token)
})

test('edit mode exposes the edit affordances and read mode does not', async () => {
  const { container } = await openEditor()
  expect(shadow(container).querySelector('[data-action="add-node"]')).not.toBe(null)
  expect(shadow(container).querySelector('[data-action="connect"][data-id="p1"]')).not.toBe(null)

  // The run view is the same component in read mode (§10).
  window.location.hash = `#/runs/${RUN_ID}`
  fireEvent(window, new HashChangeEvent('hashchange'))
  await waitFor(() => expect(container.querySelector('.run')).not.toBe(null))
  await waitFor(() => expect(shadow(container).querySelector('.node')).not.toBe(null))
  expect(shadow(container).querySelector('[data-action="add-node"]')).toBe(null)
  expect(shadow(container).querySelector('[data-action="connect"]')).toBe(null)
})

test('adding a node on the canvas reaches the workflow, unfinished and unsaved', async () => {
  const { container } = await openEditor()

  fireEvent.click(control(container, 'add-node'))
  await waitFor(() => expect(shadow(container).querySelectorAll('.node')).toHaveLength(3))

  // The canvas cannot invent a phase brief, and the editor does not pretend
  // otherwise: the document is invalid, at the field that is missing.
  await waitFor(() => expect(paths(container)).toContain('nodes[2].prompt_ref'))
  expect(saveButton(container).disabled).toBe(true)

  fireEvent.click(saveButton(container))
  expect(daemon?.puts).toHaveLength(0)
})

test('a dependency drawn on the canvas needs an artifact before it can be saved', async () => {
  const { container } = await openEditor()

  fireEvent.click(control(container, 'add-node'))
  await waitFor(() => expect(shadow(container).querySelectorAll('.node')).toHaveLength(3))

  fireEvent.click(control(container, 'connect', 'p1'))
  fireEvent.click(control(container, 'select-node', 'node'))

  // Drawn, and unexplained. The seed is empty on purpose — the component's own
  // default would have passed `min(1)` and blessed a dependency nobody wrote.
  await waitFor(() =>
    expect(paths(container)).toContain('nodes[2].depends_on[0].artifact'),
  )
  expect(saveButton(container).disabled).toBe(true)
})

test('deleting an edge removes the dependency and leaves the rest of the node alone', async () => {
  const { container } = await openEditor()

  fireEvent.click(control(container, 'select-edge', 'p1-p2'))
  await waitFor(() => expect(shadow(container).querySelector('.inspector')).not.toBe(null))
  fireEvent.click(control(container, 'delete-edge', 'p1-p2'))

  await waitFor(() => expect(shadow(container).querySelector('.edge-label')).toBe(null))
  expect(container.querySelector('[data-role="valid"]')).not.toBe(null)

  fireEvent.click(saveButton(container))
  await waitFor(() => expect(daemon?.puts).toHaveLength(1))
  const saved = daemon?.puts[0]?.workflow as Workflow
  expect(saved.nodes[1]?.depends_on).toEqual([])
  expect(saved.nodes[0]?.gates).toEqual(['unit'])
})

test('the dependency form carries the artifact, and refuses a cycle with its reason', async () => {
  const { container } = await openEditor()

  const form = container.querySelector('[data-role="dependency-form"]')
  if (form === null) throw new Error('no dependency form')
  const field = (name: string): HTMLElement => {
    const found = form.querySelector(`[data-field="${name}"]`)
    if (!(found instanceof HTMLElement)) throw new Error(`no ${name}`)
    return found
  }

  // p1 already feeds p2, so p2 → p1 would close a loop. The component refuses
  // it; the view says which rule was hit rather than doing nothing visible.
  fireEvent.change(field('from'), { target: { value: 'p2' } })
  fireEvent.change(field('to'), { target: { value: 'p1' } })
  fireEvent.change(field('artifact'), { target: { value: 'the endpoints' } })
  fireEvent.submit(form)
  await waitFor(() =>
    expect(container.querySelector('[data-role="notice"]')?.textContent).toContain('cycle'),
  )

  // An artifact is required by the form as well as by the schema.
  fireEvent.change(field('from'), { target: { value: 'p1' } })
  fireEvent.change(field('to'), { target: { value: 'p2' } })
  fireEvent.change(field('artifact'), { target: { value: '' } })
  fireEvent.submit(form)
  expect(container.querySelector('[data-role="notice"]')?.textContent).toContain('artifact')
})

test('a node’s own fields, and each dependency’s artifact, are editable and saved', async () => {
  const { container } = await openEditor()

  fireEvent.click(control(container, 'select-node', 'p2'))
  await waitFor(() => expect(container.querySelector('[data-role="node-fields"]')).not.toBe(null))
  const panel = container.querySelector('[data-role="node-fields"]')
  if (panel === null) throw new Error('no node fields')

  fireEvent.change(panel.querySelector('[data-field="prompt_ref"]') as HTMLInputElement, {
    target: { value: 'plan.md#phase-2' },
  })
  fireEvent.change(panel.querySelector('[data-field="harness"]') as HTMLSelectElement, {
    target: { value: 'codex' },
  })
  fireEvent.change(panel.querySelector('[data-field="max_fix_rounds"]') as HTMLInputElement, {
    target: { value: '4' },
  })
  fireEvent.click(panel.querySelector('input[data-gate="unit"]') as HTMLInputElement)
  fireEvent.change(
    panel.querySelector('[data-dependency="p1"] [data-field="artifact"]') as HTMLInputElement,
    { target: { value: 'the folder model and its migration' } },
  )

  fireEvent.click(saveButton(container))
  await waitFor(() => expect(daemon?.puts).toHaveLength(1))
  const saved = daemon?.puts[0]?.workflow as Workflow
  expect(saved.nodes[1]?.prompt_ref).toBe('plan.md#phase-2')
  expect(saved.nodes[1]?.harness).toBe('codex')
  expect(saved.nodes[1]?.max_fix_rounds).toBe(4)
  expect(saved.nodes[1]?.gates).toEqual(['unit'])
  expect(saved.nodes[1]?.depends_on).toEqual([
    { node: 'p1', artifact: 'the folder model and its migration' },
  ])
  // What the editor saved is what the daemon now holds.
  expect(daemon?.workflow(WORKFLOW_ID)).toEqual(saved)
})

test('an omitted pipeline is the shipped one, and an override is an explicit act', async () => {
  const { container } = await openEditor()

  const block = container.querySelector('[data-pipeline="standard-phase"]')
  expect(block?.querySelector('[data-role="shipped"]')?.textContent).toContain('ships')
  expect(container.querySelector('state-machine-editor')).toBe(null)

  const author = block?.querySelector('[data-action="author-override"]')
  if (!(author instanceof HTMLElement)) throw new Error('no author-override button')
  fireEvent.click(author)

  await waitFor(() => expect(container.querySelector('state-machine-editor')).not.toBe(null))
  expect(container.querySelector('[data-role="override"]')).not.toBe(null)

  fireEvent.click(saveButton(container))
  await waitFor(() => expect(daemon?.puts).toHaveLength(1))
  const saved = daemon?.puts[0]?.workflow as Workflow
  expect(Object.keys(saved.pipelines)).toEqual(['standard-phase'])
  expect(saved.pipelines['standard-phase']?.initialStateIds).toEqual(['implement'])
})

test('the pipeline editor is fed EFFECT_CATALOG and its edits round-trip into the save', async () => {
  const { container } = await openEditor()

  const author = container.querySelector('[data-action="author-override"]')
  if (!(author instanceof HTMLElement)) throw new Error('no author-override button')
  fireEvent.click(author)
  await waitFor(() => expect(container.querySelector('state-machine-editor')).not.toBe(null))

  const editor = container.querySelector('state-machine-editor') as StateMachineEditorElement
  expect(editor.value.states.map((state) => state.id)).toContain('implement')

  // §5.2: the host injects the catalog. It is the daemon's verbs, not a copy.
  const catalog = await editor.sideEffectProvider?.()
  expect(catalog?.map((definition) => definition.id)).toEqual(Object.keys(EFFECT_CATALOG))

  editor.addState({ name: 'Smoke', position: { x: 0, y: 400 } })
  await waitFor(() => expect(saveButton(container).disabled).toBe(false))

  fireEvent.click(saveButton(container))
  await waitFor(() => expect(daemon?.puts).toHaveLength(1))
  const saved = daemon?.puts[0]?.workflow as Workflow
  expect(saved.pipelines['standard-phase']?.states.map((state) => state.name)).toContain('Smoke')
})

test('the workflow list links to each editable document', async () => {
  const { container } = await openEditor('#/editor')
  await waitFor(() => expect(container.querySelector(`li[data-workflow="${WORKFLOW_ID}"]`)).not.toBe(null))
  expect(container.querySelector(`li[data-workflow="${WORKFLOW_ID}"] a`)?.getAttribute('href')).toBe(
    `#/editor/${WORKFLOW_ID}`,
  )
})
