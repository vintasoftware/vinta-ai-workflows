// lib.mjs — shared utilities for the e2e harness (no external deps).
//
// Everything here is pure Node so the deterministic layers (Phase 1) run
// without installing anything beyond what the fixture app already needs.

import {
  readFileSync, writeFileSync, mkdirSync, existsSync,
  readdirSync, statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(E2E_DIR, '..', '..');

// ── JSONC ──────────────────────────────────────────────────────────────────
// Scenario specs are `.jsonc` (JSON + // and /* */ comments + trailing commas).
// We strip comments outside of strings, then drop trailing commas, then JSON.parse.

export function parseJsonc(text, label = '<jsonc>') {
  let out = '';
  let inString = false;
  let quote = '';
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inString) {
      out += c;
      if (c === '\\') { out += n; i++; continue; }
      if (c === quote) inString = false;
      continue;
    }
    if (c === '"' || c === "'") { inString = true; quote = c; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  // Drop trailing commas before } or ]
  out = out.replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(out);
  } catch (e) {
    throw new Error(`failed to parse ${label}: ${e.message}`);
  }
}

export function loadJsonc(path) {
  return parseJsonc(readFileSync(path, 'utf8'), path);
}

export function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ── fs helpers ───────────────────────────────────────────────────────────────

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

export function writeJson(path, obj) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
}

export function readText(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

export function walk(dir, { skip = ['.git', 'node_modules'] } = {}) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (skip.includes(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, { skip }));
    else out.push(p);
  }
  return out;
}

// ── process ─────────────────────────────────────────────────────────────────

// Run a command, capturing stdout/stderr/exit + wall time. Never throws on a
// non-zero exit — the caller inspects `.code`.
export function run(cmd, args, { cwd, env, input, timeoutMs } = {}) {
  const started = hrms();
  const res = spawnSync(cmd, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: res.status == null ? (res.signal ? 124 : 1) : res.status,
    signal: res.signal || null,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    timedOut: res.error?.code === 'ETIMEDOUT' || res.signal === 'SIGTERM',
    wallSec: round((hrms() - started) / 1000, 2),
    error: res.error ? String(res.error.message || res.error) : null,
  };
}

export function git(cwd, args, opts = {}) {
  return run('git', args, { cwd, ...opts });
}

export function hasCommand(cmd) {
  const which = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [cmd] : ['-v', cmd];
  const res = spawnSync(which, args, { encoding: 'utf8', shell: process.platform !== 'win32' });
  return res.status === 0;
}

// ── misc ─────────────────────────────────────────────────────────────────────

export function hrms() {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
}

export function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function pct(n) {
  return `${round(n * 100, 1)}%`;
}

export const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

export function log(...a) { console.log(...a); }
export function warn(...a) { console.warn(`${C.yellow}${a.join(' ')}${C.reset}`); }
export function err(...a) { console.error(`${C.red}${a.join(' ')}${C.reset}`); }
