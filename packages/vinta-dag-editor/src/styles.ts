/**
 * The shadow root's stylesheet.
 *
 * Everything a host might want to reskin is a `--vdag-*` custom property, which
 * pierces the shadow boundary where a class name would not. The component never
 * reads `prefers-color-scheme`: the app shell owns the theme and sets these.
 * Hit targets grow under a coarse pointer so the same markup is usable on touch.
 *
 * The inspector's fields and the chrome around the canvas are exposed as
 * `part`s (`toolbar`, `viewport`, `view-controls`, `inspector`, `field`,
 * `field-name`, `field-status`, `field-wave`, `field-artifact`, `delete`), so a
 * host that owns one of those fields itself — the workflow editor keeps status
 * and wave out of the document — can hide it with `::part()` rather than fork
 * the inspector.
 */

import { BAND_GAP } from './layout'

/** A label may be as wide as the empty gap it sits in, less a little air. */
const EDGE_LABEL_WIDTH = BAND_GAP - 24

export const STYLES = `
:host {
  --vdag-surface: #ffffff;
  --vdag-canvas: #f4f5f7;
  --vdag-line: #c4c8cf;
  --vdag-text: #1b1f24;
  --vdag-muted: #6b7280;
  --vdag-accent: #3b5bdb;
  --vdag-danger: #e03131;
  --vdag-band: #e9ebef;
  --vdag-radius: 8px;
  --vdag-shadow: 0 1px 2px rgba(16, 24, 40, 0.06);
  --vdag-status-pending: #9ca3af;
  --vdag-status-ready: #2f9e44;
  --vdag-status-waiting_on_capacity: #f08c00;
  --vdag-status-running: #1c7ed6;
  --vdag-status-awaiting_human: #ae3ec9;
  --vdag-status-done: #087f5b;
  --vdag-status-failed: #e03131;
  --vdag-status-blocked: #495057;
  /* Derived once, so the rules below never repeat a mix. */
  --vdag-accent-soft: color-mix(in oklch, var(--vdag-accent) 18%, transparent);
  --vdag-accent-line: color-mix(in oklch, var(--vdag-accent) 55%, var(--vdag-line));
  display: flex;
  flex-direction: column;
  min-height: 240px;
  color: var(--vdag-text);
  font: 13px/1.4 system-ui, sans-serif;
  /* A drag is a pan or a dependency, never a text selection. */
  user-select: none;
  -webkit-user-select: none;
}
*, *::before, *::after { box-sizing: border-box; }
input, select { user-select: text; -webkit-user-select: text; }
button { font: inherit; color: inherit; }
svg { display: block; }

/* ---- Chrome: toolbar, view controls, inspector ------------------------- */
.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  min-height: 44px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--vdag-line);
  background: var(--vdag-surface);
}
.tool, .view-controls button, .inspector button, .inspector input, .inspector select {
  min-height: 30px;
  padding: 4px 10px;
  border: 1px solid var(--vdag-line);
  border-radius: calc(var(--vdag-radius) - 2px);
  background: var(--vdag-surface);
  color: inherit;
}
.tool, .view-controls button, .inspector button { cursor: pointer; }
.tool { display: inline-flex; align-items: center; gap: 6px; font-weight: 500; }
.tool:hover, .view-controls button:hover, .inspector button:hover {
  border-color: var(--vdag-accent-line);
  background: color-mix(in oklch, var(--vdag-accent) 6%, var(--vdag-surface));
}
.icon { width: 1em; height: 1em; font-size: 15px; flex: none; }

/* The zoom and fit controls, over the canvas rather than in the edit toolbar,
   so the read-only run view has them too. */
.view-controls {
  position: absolute;
  right: 10px;
  bottom: 10px;
  display: flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--vdag-line);
  border-radius: var(--vdag-radius);
  background: var(--vdag-surface);
  box-shadow: var(--vdag-shadow);
}
.view-controls button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  min-height: 30px;
  padding: 0;
  border-color: transparent;
}
.view-controls button:hover { border-color: transparent; }

.inspector, .details {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  align-items: center;
  padding: 8px 12px;
  border-top: 1px solid var(--vdag-line);
  background: var(--vdag-surface);
}
.inspector-title {
  flex: 1 1 200px;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.field { display: inline-flex; gap: 6px; align-items: center; color: var(--vdag-muted); }
.field input, .field select { color: var(--vdag-text); }
.field input[type='number'] { width: 5em; }
.inspector .delete {
  display: inline-flex;
  flex: none;
  gap: 6px;
  align-items: center;
  margin-left: auto;
  border-color: transparent;
  color: var(--vdag-danger);
  white-space: nowrap;
}
.inspector .delete:hover {
  border-color: color-mix(in oklch, var(--vdag-danger) 40%, transparent);
  background: color-mix(in oklch, var(--vdag-danger) 8%, var(--vdag-surface));
}

/* ---- The canvas -------------------------------------------------------- */
.viewport {
  position: relative;
  flex: 1;
  overflow: hidden;
  background: var(--vdag-canvas);
  touch-action: none;
  cursor: grab;
}
.viewport.panning { cursor: grabbing; }
.viewport.panning * { cursor: grabbing !important; }
.scene { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
.empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  margin: 0;
  color: var(--vdag-muted);
  pointer-events: none;
}
.tooltip {
  position: absolute;
  z-index: 5;
  max-width: 320px;
  padding: 5px 9px;
  border: 1px solid var(--vdag-line);
  border-radius: calc(var(--vdag-radius) - 2px);
  background: var(--vdag-surface);
  color: var(--vdag-text);
  font-size: 12px;
  line-height: 1.4;
  box-shadow: var(--vdag-shadow);
  transform: translateX(-50%);
  overflow-wrap: anywhere;
  pointer-events: none;
}
.tooltip[hidden] { display: none; }
.details .field { color: var(--vdag-muted); }
.hint {
  position: absolute;
  top: 10px;
  left: 50%;
  margin: 0;
  padding: 6px 12px;
  border: 1px solid var(--vdag-accent-line);
  border-radius: 999px;
  background: var(--vdag-surface);
  color: var(--vdag-text);
  box-shadow: var(--vdag-shadow);
  transform: translateX(-50%);
  white-space: nowrap;
  pointer-events: none;
}

.band {
  position: absolute;
  border-radius: var(--vdag-radius);
  background: var(--vdag-band);
}
.band-label {
  position: absolute;
  color: var(--vdag-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

/* ---- Edges ------------------------------------------------------------- */
.edges { position: absolute; top: 0; left: 0; overflow: visible; pointer-events: none; }
.edge {
  fill: none;
  stroke: var(--vdag-line);
  stroke-width: 1.5;
  marker-end: url(#vdag-arrow);
  transition: opacity 0.15s, stroke 0.15s;
}
.arrow { fill: var(--vdag-line); }
.arrow-hot { fill: var(--vdag-accent); }
/* A node in hand — selected or under the pointer — pulls its own edges forward
   and lets the rest recede, which is what makes a dense wave readable. */
.edge.hot, .edge[data-linked] {
  stroke: var(--vdag-accent);
  stroke-width: 2;
  marker-end: url(#vdag-arrow-hot);
}
.scene[data-focus] .edge:not([data-linked]):not(.hot) { opacity: 0.35; }
.edge.preview {
  stroke: var(--vdag-accent);
  stroke-dasharray: 6 4;
  marker-end: none;
}

.edge-label {
  position: absolute;
  /* Centred on the point scene.ts puts it at — the middle of the gap between
     two waves — and never wider than that gap, so a long artifact name is
     truncated instead of being drawn across the card next door. The whole name
     is in the title attribute, in the label a screen reader is given, and on
     screen the moment the edge or either of its nodes is picked. */
  transform: translate(-50%, -50%);
  max-width: ${EDGE_LABEL_WIDTH}px;
  overflow: hidden;
  padding: 1px 7px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: var(--vdag-canvas);
  color: var(--vdag-muted);
  font-size: 11px;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  transition: opacity 0.15s;
}
/* An edge in hand is lifted, but stays the width of its gap: a label that
   grew to its full text would lie across the cards on either side. The full
   text is one deliberate step away — the label under the pointer, or the one
   that is selected, does grow, over whatever is beside it. */
.edge-label.hot, .edge-label[data-linked] {
  z-index: 2;
  border-color: var(--vdag-accent-line);
  background: var(--vdag-surface);
  color: var(--vdag-text);
}
.edge-label:hover, .edge-label[aria-pressed='true'] {
  z-index: 3;
  max-width: none;
  border-color: var(--vdag-accent-line);
  background: var(--vdag-surface);
  color: var(--vdag-text);
}
.edge-label[aria-pressed='true'] { box-shadow: 0 0 0 3px var(--vdag-accent-soft); }
.scene[data-focus] .edge-label:not([data-linked]):not(.hot):not([aria-pressed='true']) { opacity: 0.45; }

/* ---- Nodes ------------------------------------------------------------- */
.node {
  position: absolute;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 5px;
  align-items: flex-start;
  padding: 9px 12px 9px 13px;
  border: 1px solid var(--vdag-line);
  border-left: 4px solid var(--vdag-node-color, var(--vdag-status-pending));
  border-radius: var(--vdag-radius);
  background: var(--vdag-surface);
  box-shadow: var(--vdag-shadow);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s, opacity 0.15s;
}
.node:hover, .node[data-linked] { border-color: var(--vdag-accent-line); }
.node[aria-pressed='true'] {
  border-color: var(--vdag-accent);
  box-shadow: 0 0 0 3px var(--vdag-accent-soft), var(--vdag-shadow);
}
/* The two statuses that ask a person for something carry a tint of their
   colour across the whole card, so they read from across the room. */
.node[data-status='failed'], .node[data-status='awaiting_human'] {
  background: color-mix(in oklch, var(--vdag-node-color) 8%, var(--vdag-surface));
}
.node-name {
  display: -webkit-box;
  overflow: hidden;
  font-weight: 600;
  line-height: 1.3;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow-wrap: anywhere;
}
.node-status {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  color: var(--vdag-muted);
  font-size: 11px;
}
.node-status::before {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--vdag-node-color, var(--vdag-status-pending));
}
.node[data-status='running'] .node-status::before { animation: vdag-pulse 1.6s ease-in-out infinite; }
@keyframes vdag-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in oklch, var(--vdag-node-color) 45%, transparent); }
  60% { box-shadow: 0 0 0 5px transparent; }
}
@media (prefers-reduced-motion: reduce) {
  .node[data-status='running'] .node-status::before { animation: none; }
}

/* Drawing a dependency: the source is ringed, every legal target invites the
   drop, and a target the graph would refuse — a cycle, a duplicate, the source
   itself — says so before the gesture is spent on it. */
.node[data-target='source'] { border-color: var(--vdag-accent); box-shadow: 0 0 0 3px var(--vdag-accent-soft); }
.node[data-target='ok'] { cursor: crosshair; }
.node[data-target='ok']:hover { border-color: var(--vdag-accent); border-style: dashed; }
.node[data-target='refused'] { opacity: 0.4; cursor: not-allowed; }

.connect {
  position: absolute;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--vdag-line);
  border-radius: 50%;
  background: var(--vdag-surface);
  color: var(--vdag-muted);
  box-shadow: var(--vdag-shadow);
  cursor: crosshair;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.connect .icon { font-size: 13px; }
.connect:hover, .connect[aria-pressed='true'] {
  border-color: var(--vdag-accent);
  background: var(--vdag-accent);
  color: #fff;
}

:focus-visible { outline: 2px solid var(--vdag-accent); outline-offset: 2px; }
@media (pointer: coarse) {
  .connect { width: 40px; height: 40px; }
  .node { padding: 12px 14px; }
}
`
