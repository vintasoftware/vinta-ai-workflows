import { render, type RenderResult } from '@testing-library/react'
import { App } from '../src/App.tsx'
import { createClient } from '../src/client.ts'
import type { StubDaemon } from './stub-daemon.ts'

/** Mounts the whole app against a stub daemon, at a fragment route. */
export function renderApp(stub: StubDaemon, hash: string): RenderResult {
  window.location.hash = hash
  return render(<App client={createClient(stub.origin, stub.token)} />)
}

/** The tone the roster gives a node — the meaning, not the colour. */
export function toneOf(container: HTMLElement, nodeId: string): string | null {
  const chip = container.querySelector(`tr[data-node="${nodeId}"] .chip`)
  return chip?.getAttribute('data-tone') ?? null
}

export function labelOf(container: HTMLElement, nodeId: string): string {
  return container.querySelector(`tr[data-node="${nodeId}"] .chip`)?.textContent ?? ''
}

/** The colour the canvas gives a node, read from inside its shadow root. */
export function cardColorOf(container: HTMLElement, nodeId: string): string {
  const card = container
    .querySelector('vinta-dag')
    ?.shadowRoot?.querySelector(`button[data-action="select-node"][data-id="${nodeId}"]`)
  return card instanceof HTMLElement ? card.style.getPropertyValue('--vdag-node-color') : ''
}

export function cardLabelOf(container: HTMLElement, nodeId: string): string {
  const card = container
    .querySelector('vinta-dag')
    ?.shadowRoot?.querySelector(`button[data-action="select-node"][data-id="${nodeId}"]`)
  return card?.getAttribute('aria-label') ?? ''
}

export function textOf(container: HTMLElement, selector: string): string {
  return container.querySelector(selector)?.textContent ?? ''
}
