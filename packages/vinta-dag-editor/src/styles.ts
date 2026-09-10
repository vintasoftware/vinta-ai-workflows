/**
 * The shadow root's stylesheet.
 *
 * Everything a host might want to reskin is a `--vdag-*` custom property, which
 * pierces the shadow boundary where a class name would not. The component never
 * reads `prefers-color-scheme`: the app shell owns the theme and sets these.
 * Hit targets grow under a coarse pointer so the same markup is usable on touch.
 */

import { BAND_GAP } from './layout'

/** A label may be as wide as the empty gap it sits in, less a little air. */
const EDGE_LABEL_WIDTH = BAND_GAP - 16

export const STYLES = `
:host {
  --vdag-surface: #ffffff;
  --vdag-canvas: #f4f5f7;
  --vdag-line: #c4c8cf;
  --vdag-text: #1b1f24;
  --vdag-muted: #6b7280;
  --vdag-accent: #3b5bdb;
  --vdag-band: #e9ebef;
  --vdag-radius: 8px;
  --vdag-status-pending: #9ca3af;
  --vdag-status-ready: #2f9e44;
  --vdag-status-waiting_on_capacity: #f08c00;
  --vdag-status-running: #1c7ed6;
  --vdag-status-awaiting_human: #ae3ec9;
  --vdag-status-done: #087f5b;
  --vdag-status-failed: #e03131;
  --vdag-status-blocked: #495057;
  display: flex;
  flex-direction: column;
  min-height: 240px;
  color: var(--vdag-text);
  font: 13px/1.4 system-ui, sans-serif;
}
.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 6px;
  border-bottom: 1px solid var(--vdag-line);
}
.hint { color: var(--vdag-muted); }
button { font: inherit; color: inherit; }
.toolbar button, .inspector button, .view-controls button {
  min-height: 32px;
  padding: 4px 10px;
  border: 1px solid var(--vdag-line);
  border-radius: var(--vdag-radius);
  background: var(--vdag-surface);
  cursor: pointer;
}
.viewport {
  position: relative;
  flex: 1;
  overflow: hidden;
  background: var(--vdag-canvas);
  touch-action: none;
}
.scene { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
.band {
  position: absolute;
  border-radius: var(--vdag-radius);
  background: var(--vdag-band);
}
.band-label { position: absolute; color: var(--vdag-muted); }
.edges { position: absolute; top: 0; left: 0; overflow: visible; pointer-events: none; }
.edges path { fill: none; stroke: var(--vdag-line); stroke-width: 2; }
.node {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--vdag-line);
  border-left: 5px solid var(--vdag-node-color, var(--vdag-status-pending));
  border-radius: var(--vdag-radius);
  background: var(--vdag-surface);
  text-align: left;
  cursor: pointer;
}
.node[aria-pressed='true'], .edge-label[aria-pressed='true'] { outline: 2px solid var(--vdag-accent); }
.node-name { font-weight: 600; }
.node-status { color: var(--vdag-muted); }
.connect {
  position: absolute;
  min-width: 32px;
  min-height: 32px;
  border: 1px solid var(--vdag-line);
  border-radius: 50%;
  background: var(--vdag-surface);
  cursor: crosshair;
}
.edge-label {
  position: absolute;
  /* Centred on the point scene.ts puts it at — the middle of the gap between
     two waves — and never wider than that gap, so a long artifact name is
     truncated instead of being drawn across the card next door. The whole name
     is in the title attribute and in the label a screen reader is given. */
  transform: translate(-50%, -50%);
  max-width: ${EDGE_LABEL_WIDTH}px;
  overflow: hidden;
  padding: 2px 6px;
  border: 1px solid var(--vdag-line);
  border-radius: var(--vdag-radius);
  background: var(--vdag-surface);
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
/* The zoom and fit controls, over the canvas rather than in the edit toolbar,
   so the read-only run view has them too. */
.view-controls {
  position: absolute;
  right: 8px;
  bottom: 8px;
  display: flex;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--vdag-line);
  border-radius: var(--vdag-radius);
  background: var(--vdag-surface);
}
.inspector {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 6px;
  border-top: 1px solid var(--vdag-line);
}
.inspector label { display: flex; gap: 4px; align-items: center; }
.inspector input, .inspector select { min-height: 32px; font: inherit; }
:focus-visible { outline: 2px solid var(--vdag-accent); outline-offset: 2px; }
@media (pointer: coarse) {
  .connect { min-width: 44px; min-height: 44px; }
  .node { padding: 12px 14px; }
}
`
