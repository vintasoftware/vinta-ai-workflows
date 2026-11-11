// artifacts.mjs — artifact presence + section/schema graders (PLAN §7).
//
// Deterministic. Two families:
//   - Spec/Plan markdown exist at the fixture's ai-plans dir with required
//     sections (section-presence check; LLMs vary wording so we check headings,
//     not prose).
//   - Generated config / sub-agents validate against schemas/*.schema.json via
//     the minimal validator (schema.mjs).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walk, REPO_ROOT } from '../runner/lib.mjs';
import { validateFile, frontmatter } from './schema.mjs';

const SPEC_SECTIONS = ['overview', 'acceptance'];
const PLAN_SECTIONS = ['phase', 'testing'];

function findByGlob(cwd, dir, suffixRe) {
  const base = join(cwd, dir);
  return walk(base).filter((p) => suffixRe.test(p));
}

function sectionCheck(text, needles) {
  const lower = text.toLowerCase();
  const missing = needles.filter((n) => !lower.includes(n));
  return { ok: missing.length === 0, missing };
}

export function artifactsSpec(ctx) {
  const plansDir = ctx.fixture?.commands?.ai_plans_dir || 'ai-plans';
  const files = findByGlob(ctx.cwd, plansDir, /_SPEC\.md$/i);
  const details = [];
  let pass = true;
  if (files.length === 0) {
    return { id: 'artifacts-spec', tier: 'deterministic', pass: false,
      details: [`✗ no *_SPEC.md under ${plansDir}/`] };
  }
  for (const f of files) {
    const { ok, missing } = sectionCheck(readFileSync(f, 'utf8'), SPEC_SECTIONS);
    if (ok) details.push(`✓ ${rel(ctx.cwd, f)} has required sections`);
    else { pass = false; details.push(`✗ ${rel(ctx.cwd, f)} missing sections: ${missing.join(', ')}`); }
  }
  return { id: 'artifacts-spec', tier: 'deterministic', pass, details };
}

export function artifactsPlan(ctx) {
  const plansDir = ctx.fixture?.commands?.ai_plans_dir || 'ai-plans';
  const files = findByGlob(ctx.cwd, plansDir, /_PLAN\.md$/i);
  const details = [];
  let pass = true;
  if (files.length === 0) {
    return { id: 'artifacts-plan', tier: 'deterministic', pass: false,
      details: [`✗ no *_PLAN.md under ${plansDir}/`] };
  }
  for (const f of files) {
    const { ok, missing } = sectionCheck(readFileSync(f, 'utf8'), PLAN_SECTIONS);
    if (ok) details.push(`✓ ${rel(ctx.cwd, f)} has required sections`);
    else { pass = false; details.push(`✗ ${rel(ctx.cwd, f)} missing sections: ${missing.join(', ')}`); }
  }
  return { id: 'artifacts-plan', tier: 'deterministic', pass, details };
}

// S0/S1: bootstrap/sync must leave AGENTS.md + schema-valid sub-agents + config.
export function artifactsBootstrap(ctx) {
  const details = [];
  let pass = true;
  const fail = (m) => { pass = false; details.push(`✗ ${m}`); };
  const ok = (m) => details.push(`✓ ${m}`);

  if (existsSync(join(ctx.cwd, 'AGENTS.md'))) ok('AGENTS.md present');
  else fail('AGENTS.md missing');

  // Validate any generated sub-agent yaml against sub-agent.v1 schema.
  const agentFiles = walk(join(ctx.cwd, 'ai-tools', 'agents')).filter((p) => /\.ya?ml$/.test(p));
  if (agentFiles.length === 0) {
    details.push('· no ai-tools/agents/*.yaml to validate');
  }
  for (const f of agentFiles) {
    const data = parseSimpleYaml(readFileSync(f, 'utf8'));
    const { ok: valid, errors } = validateFile(
      join(REPO_ROOT, 'schemas', 'sub-agent.v1.schema.json'), data);
    if (valid) ok(`${rel(ctx.cwd, f)} validates against sub-agent.v1`);
    else fail(`${rel(ctx.cwd, f)} schema errors: ${errors.join('; ')}`);
  }

  // Config file present + schema-valid.
  const cfg = join(ctx.cwd, '.vinta-ai-workflows.yaml');
  if (existsSync(cfg)) {
    const data = parseSimpleYaml(readFileSync(cfg, 'utf8'));
    const { ok: valid, errors } = validateFile(
      join(REPO_ROOT, 'schemas', 'vinta-ai-workflows-config.v1.schema.json'), data);
    if (valid) ok('.vinta-ai-workflows.yaml validates against config.v1');
    else fail(`config schema errors: ${errors.slice(0, 5).join('; ')}`);
  } else {
    fail('.vinta-ai-workflows.yaml missing');
  }

  return { id: 'artifacts-bootstrap', tier: 'deterministic', pass, details };
}

const rel = (cwd, f) => f.slice(cwd.length + 1);

// Tiny YAML → object parser for the flat/one-level configs our fixtures emit.
// Not a general YAML parser (the repo's `yaml` dep is dev-only and not a
// harness runtime dep); handles scalars, one level of nesting, and `key: |`
// block scalars enough for schema-shape validation.
function parseSimpleYaml(text) {
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^\s*/)[0].length;
    const line = raw.trim();
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, rest] = m;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (rest === '' || rest === '|' || rest === '>') {
      if (rest === '|' || rest === '>') {
        // consume block scalar
        const block = [];
        while (i + 1 < lines.length && (lines[i + 1].match(/^\s*/)[0].length > indent || !lines[i + 1].trim())) {
          block.push(lines[++i]);
        }
        parent[key] = block.join('\n').trim();
      } else {
        const child = {};
        parent[key] = child;
        stack.push({ indent, obj: child });
      }
    } else {
      parent[key] = coerce(rest);
    }
  }
  return root;
  function coerce(v) {
    v = v.replace(/^["']|["']$/g, '');
    if (/^-?\d+$/.test(v)) return Number(v);
    if (v === 'true') return true;
    if (v === 'false') return false;
    return v;
  }
}

export { frontmatter };
