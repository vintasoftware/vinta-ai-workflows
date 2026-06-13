#!/usr/bin/env node
// Setup script: wire ai-tools/{AGENTS.md,skills,agents/*.yaml} into every supported vendor.
//
// Source of truth:
//   - ai-tools/AGENTS.md           — universal project conventions (markdown).
//   - ai-tools/skills/<name>/      — universal skills (SKILL.md format converges across
//                                    Claude Code, Cursor, Codex, VS Code Copilot — symlinked).
//   - ai-tools/agents/<name>.yaml  — vendor-agnostic sub-agent definitions. This script
//                                    reads the YAML and emits per-vendor target files in the
//                                    format each tool expects (markdown, .agent.md, .toml).
//
// What this script does:
//   1. Symlinks ai-tools/AGENTS.md + ai-tools/skills/ into each vendor's expected paths.
//   2. Reads each ai-tools/agents/<name>.yaml.
//   3. For every supported vendor, generates a target file with vendor-specific frontmatter
//      / format. Vendor-specific overrides come from the YAML's `overrides:<vendor>:` block;
//      otherwise sensible defaults are derived from the YAML's `access` field
//      (read-only vs read-write).
//
// Idempotent: re-run after editing ai-tools/agents/*.yaml and the vendor copies regenerate.
//
// Usage:
//   pnpm setup:ai-tools                              # all four vendors
//   node ai-tools/scripts/setup-ai-tools.mjs
//   node ai-tools/scripts/setup-ai-tools.mjs --only claude-code,cursor
//   node ai-tools/scripts/setup-ai-tools.mjs --only codex
//
// `--only` accepts a comma-separated list of vendor ids or aliases:
//   claude     (aliases: claude-code)
//   cursor
//   copilot    (aliases: vscode, vscode-copilot, github-copilot)
//   codex      (aliases: openai-codex)
// Vendors not listed are left untouched: their existing generated files / symlinks remain
// in place; this script does not delete or rewrite them.

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  lstatSync,
  rmSync,
  unlinkSync,
  existsSync,
  appendFileSync,
} from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as YAML from 'yaml';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
process.chdir(REPO_ROOT);

const AGENTS_SRC = 'ai-tools/agents';

// ── CLI: --only <comma-separated vendors> ────────────────────────────────

const ALL_VENDORS = ['claude', 'cursor', 'copilot', 'codex'];
const VENDOR_ALIASES = {
  claude: 'claude',
  'claude-code': 'claude',
  cursor: 'cursor',
  copilot: 'copilot',
  vscode: 'copilot',
  'vscode-copilot': 'copilot',
  'github-copilot': 'copilot',
  codex: 'codex',
  'openai-codex': 'codex',
};

function parseOnly(argv) {
  const idx = argv.findIndex((a) => a === '--only' || a.startsWith('--only='));
  if (idx === -1) return new Set(ALL_VENDORS);
  const raw = argv[idx].startsWith('--only=')
    ? argv[idx].slice('--only='.length)
    : argv[idx + 1];
  if (!raw) {
    console.error('--only requires a comma-separated value, e.g. --only claude-code,cursor');
    process.exit(2);
  }
  const requested = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const resolved = new Set();
  for (const id of requested) {
    const canonical = VENDOR_ALIASES[id.toLowerCase()];
    if (!canonical) {
      console.error(
        `unknown vendor "${id}". Allowed: ${Object.keys(VENDOR_ALIASES).sort().join(', ')}`
      );
      process.exit(2);
    }
    resolved.add(canonical);
  }
  return resolved;
}

const SELECTED = parseOnly(process.argv.slice(2));

// ── Vendor defaults derived from `access` ────────────────────────────────

const DEFAULTS = {
  claude: {
    'read-only': { tools: 'Read, Bash, Glob, Grep' },
    'read-write': { tools: 'Read, Write, Edit, Bash, Glob, Grep, NotebookEdit' },
  },
  cursor: {
    'read-only': { model: 'inherit', readonly: true },
    'read-write': { model: 'inherit', readonly: false },
  },
  copilot: {
    'read-only': { tools: ['codebase', 'search', 'terminal', 'usages'] },
    'read-write': {
      tools: ['codebase', 'editFiles', 'runCommands', 'runTasks', 'search', 'terminal', 'usages'],
    },
  },
  codex: {
    'read-only': { sandbox_mode: 'read-only' },
    'read-write': { sandbox_mode: 'workspace-write' },
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────

function ensureSymlink(target, linkPath) {
  mkdirSync(dirname(linkPath), { recursive: true });
  let existing;
  try {
    existing = lstatSync(linkPath);
  } catch {
    existing = null;
  }
  if (existing) {
    if (existing.isSymbolicLink()) {
      unlinkSync(linkPath);
    } else {
      console.warn(`[setup-ai-tools] ${linkPath} exists and is not a symlink — leaving as-is`);
      return;
    }
  }
  symlinkSync(target, linkPath);
}

function resetDir(path) {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
}

function resolveVendorConfig(doc, vendor) {
  // Merge: derived defaults from `access` + everything `doc` declares directly
  // (e.g. `claude-tools` for backwards compat) + per-vendor `overrides`.
  const access = doc.access ?? 'read-write';
  const base = { ...DEFAULTS[vendor]?.[access] };
  // Convenience: top-level `claude-tools` maps to claude.tools
  if (vendor === 'claude' && doc['claude-tools']) {
    base.tools = doc['claude-tools'];
  }
  const overrides = doc.overrides?.[vendor] ?? {};
  return { ...base, ...overrides };
}

function escapeTomlBasic(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeTomlMultiline(body) {
  // TOML triple-quoted multiline strings: only conflict is the literal `"""`
  // sequence inside the body. Replace with escaped triple-quotes.
  return body.replace(/"""/g, '\\"\\"\\"');
}

// ── .gitignore management ────────────────────────────────────────────────
//
// `.vinta-ai-workflows/` holds durable working state that is per-developer
// machine, not committed history:
//   - prs-context/{feature}/{phase}.md — implement-plan / amend-plan PR drafts
//   - cache.yaml — systematic-debugging MCP preflight state
// Single umbrella entry covers everything. Append on first run if not present.

function ensureGitignoreEntries(entries) {
  const path = '.gitignore';
  let current = '';
  try { current = readFileSync(path, 'utf8'); } catch { current = ''; }
  const lines = new Set(current.split('\n').map((l) => l.trim()));

  const missing = entries.filter((e) => !lines.has(e) && !lines.has(e.replace(/\/$/, '')));
  if (missing.length === 0) return [];

  const block = (current && !current.endsWith('\n') ? '\n' : '')
    + (current ? '\n' : '')
    + '# vinta-ai-workflows / implement-plan working notes\n'
    + missing.join('\n') + '\n';

  if (existsSync(path)) appendFileSync(path, block);
  else writeFileSync(path, block.trimStart());
  return missing;
}

function autoGenHeader(srcPath, comment = '#') {
  return [
    `${comment} AUTO-GENERATED by ai-tools/scripts/setup-ai-tools.mjs from ${srcPath}.`,
    `${comment} Edit ${srcPath}, then run: pnpm setup:ai-tools.`,
  ].join('\n');
}

// ── Vendor emitters ──────────────────────────────────────────────────────

// Fold a (possibly multi-line) value into a YAML-safe single-line scalar.
// The agent `description` in the source YAML is authored as multi-line prose;
// interpolated raw into markdown frontmatter it produces invalid YAML
// (unindented continuation lines + embedded colons), so the harness silently
// skips the agent. A JSON string is also a valid YAML double-quoted flow
// scalar, so JSON.stringify gives correct escaping for free.
function yamlInlineScalar(value) {
  return JSON.stringify(String(value).replace(/\s+/g, ' ').trim());
}

function emitClaude(name, doc, body) {
  const cfg = resolveVendorConfig(doc, 'claude');
  const lines = [
    '---',
    autoGenHeader(`ai-tools/agents/${name}.yaml`),
    `name: ${doc.name}`,
    `description: ${yamlInlineScalar(doc.description)}`,
  ];
  if (cfg.tools) lines.push(`tools: ${cfg.tools}`);
  if (cfg.model) lines.push(`model: ${cfg.model}`);
  lines.push('---', body);
  writeFileSync(`.claude/agents/${name}.md`, lines.join('\n') + '\n');
}

function emitCursor(name, doc, body) {
  const cfg = resolveVendorConfig(doc, 'cursor');
  const lines = [
    '---',
    autoGenHeader(`ai-tools/agents/${name}.yaml`),
    `name: ${doc.name}`,
    `description: ${yamlInlineScalar(doc.description)}`,
  ];
  if (cfg.model) lines.push(`model: ${cfg.model}`);
  if (cfg.readonly !== undefined) lines.push(`readonly: ${cfg.readonly}`);
  if (cfg.is_background !== undefined) lines.push(`is_background: ${cfg.is_background}`);
  lines.push('---', body);
  writeFileSync(`.cursor/agents/${name}.md`, lines.join('\n') + '\n');
}

function emitCopilot(name, doc, body) {
  const cfg = resolveVendorConfig(doc, 'copilot');
  const lines = [
    '---',
    autoGenHeader(`ai-tools/agents/${name}.yaml`),
    `description: ${yamlInlineScalar(doc.description)}`,
  ];
  if (cfg.tools) lines.push(`tools: ${JSON.stringify(cfg.tools)}`);
  if (cfg.model) lines.push(`model: ${cfg.model}`);
  if (cfg['user-invocable'] !== undefined) lines.push(`user-invocable: ${cfg['user-invocable']}`);
  if (cfg['disable-model-invocation'] !== undefined) {
    lines.push(`disable-model-invocation: ${cfg['disable-model-invocation']}`);
  }
  lines.push('---', body);
  writeFileSync(`.github/agents/${name}.agent.md`, lines.join('\n') + '\n');
}

function emitCodex(name, doc, body) {
  const cfg = resolveVendorConfig(doc, 'codex');
  const lines = [
    autoGenHeader(`ai-tools/agents/${name}.yaml`, '#'),
    `name = "${escapeTomlBasic(doc.name)}"`,
    `description = "${escapeTomlBasic(doc.description)}"`,
  ];
  if (cfg.sandbox_mode) lines.push(`sandbox_mode = "${cfg.sandbox_mode}"`);
  if (cfg.model) lines.push(`model = "${cfg.model}"`);
  if (cfg.model_reasoning_effort) {
    lines.push(`model_reasoning_effort = "${cfg.model_reasoning_effort}"`);
  }
  lines.push(
    'developer_instructions = """',
    escapeTomlMultiline(body.trimEnd()),
    '"""',
    ''
  );
  writeFileSync(`.codex/agents/${name}.toml`, lines.join('\n'));
}

// ── Stage 0: gitignore ───────────────────────────────────────────────────

const gitignoreAdded = ensureGitignoreEntries(['.vinta-ai-workflows/']);

// ── Stage 1: stable symlinks (skills + AGENTS.md) ────────────────────────

// Universal anchors — always set up regardless of --only selection.
ensureSymlink('ai-tools/AGENTS.md', 'AGENTS.md');
ensureSymlink('../ai-tools/skills', '.agents/skills');

// Vendor-specific symlinks — gated on SELECTED.
if (SELECTED.has('claude')) {
  ensureSymlink('../ai-tools/skills', '.claude/skills');
}
if (SELECTED.has('cursor')) {
  ensureSymlink('../ai-tools/skills', '.cursor/skills');
}
if (SELECTED.has('copilot')) {
  ensureSymlink('../ai-tools/AGENTS.md', '.github/copilot-instructions.md');
  ensureSymlink('../ai-tools/skills', '.github/skills');
}
// Codex shares `.agents/skills` (already linked above) — no extra symlink needed.

// ── Stage 2: regenerate per-vendor sub-agent files ───────────────────────

const VENDOR_AGENT_DIRS = {
  claude: '.claude/agents',
  cursor: '.cursor/agents',
  copilot: '.github/agents',
  codex: '.codex/agents',
};
const VENDOR_EMITTERS = {
  claude: emitClaude,
  cursor: emitCursor,
  copilot: emitCopilot,
  codex: emitCodex,
};

// Reset only selected vendors' agent dirs; leave the rest untouched.
for (const vendor of SELECTED) {
  resetDir(VENDOR_AGENT_DIRS[vendor]);
}

const generated = [];
for (const file of readdirSync(AGENTS_SRC)) {
  if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
  const name = basename(file, file.endsWith('.yaml') ? '.yaml' : '.yml');
  const src = join(AGENTS_SRC, file);
  const text = readFileSync(src, 'utf8');
  const doc = YAML.parse(text);

  // Schema: schemas/sub-agent.v1.schema.json (in vinta-ai-workflows package).
  if (doc?.schema_version !== 1) {
    throw new Error(`${src}: missing or unsupported 'schema_version' (expected: 1; see schemas/sub-agent.v1.schema.json)`);
  }
  if (!doc?.name) throw new Error(`${src}: missing required field 'name'`);
  if (!doc?.description) throw new Error(`${src}: missing required field 'description'`);
  if (!doc?.access) throw new Error(`${src}: missing required field 'access' (read-only | read-write)`);
  if (typeof doc.body !== 'string' || !doc.body.trim()) {
    throw new Error(`${src}: missing required field 'body' (markdown content as YAML literal block)`);
  }

  for (const vendor of SELECTED) {
    VENDOR_EMITTERS[vendor](name, doc, doc.body);
  }

  generated.push({ name, access: doc.access });
}

// ── Report ───────────────────────────────────────────────────────────────

const selectedList = [...SELECTED];
const skipped = ALL_VENDORS.filter((v) => !SELECTED.has(v));

console.log(`Selected vendors: ${selectedList.join(', ')}`);
if (skipped.length) {
  console.log(`Skipped (left untouched): ${skipped.join(', ')}`);
}
console.log('');

if (gitignoreAdded.length) {
  console.log(`.gitignore: appended ${gitignoreAdded.join(', ')}`);
  console.log('');
}

console.log('Symlinks ensured:');
console.log('  AGENTS.md                          → ai-tools/AGENTS.md');
console.log('  .agents/skills                     → ../ai-tools/skills');
if (SELECTED.has('claude')) {
  console.log('  .claude/skills                     → ../ai-tools/skills');
}
if (SELECTED.has('cursor')) {
  console.log('  .cursor/skills                     → ../ai-tools/skills');
}
if (SELECTED.has('copilot')) {
  console.log('  .github/skills                     → ../ai-tools/skills');
  console.log('  .github/copilot-instructions.md    → ../ai-tools/AGENTS.md');
}
console.log('');

console.log(
  `Generated ${generated.length * selectedList.length} sub-agent file(s) from ai-tools/agents/*.yaml across ${selectedList.length} vendor(s):`
);
const VENDOR_TARGET_DESC = {
  claude: '.claude/agents/<name>.md            (markdown)',
  cursor: '.cursor/agents/<name>.md            (markdown)',
  copilot: '.github/agents/<name>.agent.md     (markdown)',
  codex: '.codex/agents/<name>.toml            (TOML)',
};
for (const vendor of selectedList) {
  console.log(`  ${vendor.padEnd(8)} → ${VENDOR_TARGET_DESC[vendor]}`);
}
console.log('');
for (const { name, access } of generated) {
  console.log(`  ${name.padEnd(20)} ${access}`);
}
console.log('');
console.log('Re-run `pnpm setup:ai-tools` after editing ai-tools/agents/*.yaml.');
console.log('Limit to specific vendors: --only claude-code,cursor,copilot,codex');
