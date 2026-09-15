/**
 * The monitor panel, which had no test at all — the stub served no `/monitor`
 * route, so every call the panel made 404'd into the `catch` that exists to
 * keep a failed history from raising an alarm, and the whole thing rendered
 * empty and green.
 *
 * What is asserted here is the contract that changed: a question is *accepted*
 * rather than answered, and the answer arrives in the conversation, entry by
 * entry, while the panel watches. That is the whole reason the turn moved out
 * of the request — a tab that navigates away, reloads or sleeps used to kill
 * the monitor mid-thought.
 */
import { cleanup, configure, fireEvent, waitFor, type RenderResult } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { node, RUN_ID, runSummary, snapshot } from './fixtures.ts'
import { renderApp, textOf } from './render-app.tsx'
import { startStubDaemon, type StubDaemon } from './stub-daemon.ts'

/**
 * This panel polls once a second while a turn is running, so an assertion about
 * what it has caught up to cannot be made inside `waitFor`'s own one-second
 * default. Stated here rather than assumed, because the number is a fact about
 * the component and not about the machine.
 */
configure({ asyncUtilTimeout: 5_000 })

let daemon: StubDaemon | null = null
let view: RenderResult | null = null

afterEach(async () => {
  view = null
  cleanup()
  sessionStorage.clear()
  await daemon?.close()
  daemon = null
})

async function openRun(): Promise<{ stub: StubDaemon; container: HTMLElement }> {
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [node('impl', 'failed')] }) },
  })
  daemon = stub
  view = renderApp(stub, `#/runs/${RUN_ID}`)
  return { stub, container: view.container }
}

const ask = (container: HTMLElement, question: string): void => {
  const box = container.querySelector('[data-field="question"]') as HTMLTextAreaElement
  fireEvent.change(box, { target: { value: question } })
  fireEvent.click(container.querySelector('[data-action="ask"]') as HTMLElement)
}

const bodies = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-monitor] .entry-body')].map(
    (body) => body.textContent ?? '',
  )

test('a question is accepted, not answered — and the asking is on the wire', async () => {
  const { stub, container } = await openRun()

  await waitFor(() => expect(container.querySelector('[data-monitor]')).not.toBe(null))
  ask(container, 'why did impl fail?')

  // Posted with the daemon's own schema, which the stub validates on the way in.
  await waitFor(() => expect(stub.asked).toEqual([{ runId: RUN_ID, text: 'why did impl fail?' }]))
  // And the panel says it is waiting rather than claiming an answer.
  await waitFor(() => expect(container.querySelector('[data-thinking]')).not.toBe(null))
})

/**
 * The complaint this answers: "when they respond, the full text comes all at
 * once". It used to, because the answer was produced inside the request and
 * journalled in one piece at the end. The monitor writes as it thinks now, and
 * the panel polls while a turn is running.
 */
test('the answer arrives while the panel watches, thinking first', async () => {
  const { stub, container } = await openRun()

  await waitFor(() => expect(container.querySelector('[data-monitor]')).not.toBe(null))
  ask(container, 'why did impl fail?')
  await waitFor(() => expect(stub.asked).toHaveLength(1))

  // The question is in the record before anything answers it.
  await waitFor(() => expect(bodies(container)).toContain('why did impl fail?'))

  stub.monitorSays(RUN_ID, {
    type: 'thinking',
    text: 'impl has no branch, so it never reached a gate.',
    by: { role: 'monitor' },
  })
  await waitFor(() =>
    expect(textOf(container, '[data-monitor]')).toContain('impl has no branch'),
  )
  // Still thinking: nothing has been said yet.
  expect(container.querySelector('[data-monitor] [data-thinking]')).not.toBe(null)

  stub.monitorSays(RUN_ID, {
    type: 'assistant_text',
    text: 'It failed in provisioning.',
    by: { role: 'monitor' },
  })
  stub.monitorDone(RUN_ID)

  await waitFor(() => expect(bodies(container)).toContain('It failed in provisioning.'))
  // The turn ended, so the panel stops polling and stops saying it is waiting.
  await waitFor(() => expect(container.querySelector('[data-thinking]')).toBe(null))
})

/**
 * A reply does not arrive as one event. The daemon journals each as the harness
 * produces it, so without grouping one answer would render as several
 * paragraphs with a divider ruled between each.
 */
test('a reply streamed in pieces is one row', async () => {
  const { stub, container } = await openRun()

  await waitFor(() => expect(container.querySelector('[data-monitor]')).not.toBe(null))
  ask(container, 'and now?')
  await waitFor(() => expect(stub.asked).toHaveLength(1))

  for (const text of ['It failed in provisioning.', 'Re-run it after the stack is up.']) {
    stub.monitorSays(RUN_ID, { type: 'assistant_text', text, by: { role: 'monitor' } })
  }
  stub.monitorDone(RUN_ID)

  await waitFor(() => expect(textOf(container, '[data-monitor]')).toContain('after the stack is up'))
  // One question, one answer: two rows, not three.
  expect(container.querySelectorAll('[data-monitor] li[data-entry]')).toHaveLength(2)
  expect(bodies(container).at(-1)).toContain('It failed in provisioning.')
  expect(bodies(container).at(-1)).toContain('Re-run it after the stack is up.')
})

/** §7 again, on the panel: the question is the operator's, the answer is not. */
test('the conversation says who is speaking', async () => {
  const { stub, container } = await openRun()

  await waitFor(() => expect(container.querySelector('[data-monitor]')).not.toBe(null))
  ask(container, 'why?')
  await waitFor(() => expect(stub.asked).toHaveLength(1))
  stub.monitorSays(RUN_ID, { type: 'assistant_text', text: 'because', by: { role: 'monitor' } })
  stub.monitorDone(RUN_ID)

  await waitFor(() => expect(bodies(container)).toContain('because'))
  expect(
    [...container.querySelectorAll('[data-monitor] [data-turn]')].map(
      (band) => (band as HTMLElement).dataset['turn'],
    ),
  ).toEqual(['operator', 'monitor'])
})

/** Pressing Ask twice means "I am still waiting", not "answer it twice". */
test('a second question cannot start while one is running', async () => {
  const { stub, container } = await openRun()

  await waitFor(() => expect(container.querySelector('[data-monitor]')).not.toBe(null))
  ask(container, 'first')
  await waitFor(() => expect(stub.asked).toHaveLength(1))

  await waitFor(() => {
    const button = container.querySelector('[data-action="ask"]') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('Asking')
  })

  stub.monitorDone(RUN_ID)
  await waitFor(() => expect(container.querySelector('[data-thinking]')).toBe(null))
  expect(stub.asked).toHaveLength(1)
})

/**
 * The case the whole change exists for: the operator navigates away mid-turn.
 * The turn belongs to the daemon now, so coming back shows the answer rather
 * than a question that was abandoned.
 */
test('an answer that arrived while the panel was gone is there when it returns', async () => {
  const { stub, container } = await openRun()

  await waitFor(() => expect(container.querySelector('[data-monitor]')).not.toBe(null))
  ask(container, 'why did impl fail?')
  await waitFor(() => expect(stub.asked).toHaveLength(1))

  view?.unmount()
  stub.monitorSays(RUN_ID, {
    type: 'assistant_text',
    text: 'It failed in provisioning.',
    by: { role: 'monitor' },
  })
  stub.monitorDone(RUN_ID)

  view = renderApp(stub, `#/runs/${RUN_ID}`)
  await waitFor(() =>
    expect(textOf(view?.container as HTMLElement, '[data-monitor]')).toContain(
      'It failed in provisioning.',
    ),
  )
  // And the question it answers is still there with it — the conversation is
  // the journal's, so remounting reads back the whole exchange.
  expect(textOf(view?.container as HTMLElement, '[data-monitor]')).toContain('why did impl fail?')
})
