/**
 * Registration, separate from the class so importing the types or the model
 * helpers does not touch the custom element registry.
 */

import { VintaDagElement } from './element'

export const DAG_EDITOR_TAG = 'vinta-dag'

/** Re-defining an already-registered tag throws, so this is safe to call twice. */
export function defineDagEditor(): void {
  if (customElements.get(DAG_EDITOR_TAG)) return
  customElements.define(DAG_EDITOR_TAG, VintaDagElement)
}
