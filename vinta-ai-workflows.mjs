#!/usr/bin/env node
// vinta-ai-workflows.mjs — install vinta-ai-workflows builder skills into a
// target project's per-vendor skill directory (Claude Code, Codex, Cursor,
// VS Code + Copilot). Project scope only; skills are namespaced with the
// `vinta-` prefix so they don't collide with the user's own project skills.
//
// Usage (after `npm i -D vinta-ai-workflows`):
//   npx vinta-ai-workflows install   --tool <name> [opts]
//   npx vinta-ai-workflows update    --tool <name> [opts]   # uninstall + install
//   npx vinta-ai-workflows uninstall --tool <name> [opts]
//   npx vinta-ai-workflows list
//
// Or directly: node vinta-ai-workflows.mjs <cmd> [opts]
//
// Tools:
//   claude-code   .claude/skills/
//   codex         .agents/skills/    (official Codex path; walks up to repo root)
//   cursor        .cursor/skills/
//   copilot       .github/skills/
//   agents        .agents/skills/    universal — covers Codex + Cursor + Copilot
//   all           install into every vendor-specific path above
//
// Common options:
//   --target <dir>            Project root to install into. Defaults to $PWD.
//   --skills <a,b,c>          Subset of skills (default: all skills under ./skills).
//   --copy                    Copy files instead of symlinking. Survives repo
//                             deletion but won't pick up upstream skill updates
//                             without re-running `update`.
//   --dry-run, -n             Show planned changes; touch nothing.
//
// The vinta- skills are one-shot bootstrappers — install, run them once via
// the AI tool, then `uninstall` to clean up. Use `update` to refresh the
// installed skills against the latest source (handy when this repo gets
// pulled with new versions and you copied rather than symlinked). See
// README.md for invocation per tool.

import {
  readdirSync, lstatSync, mkdirSync, rmSync, rmdirSync,
  symlinkSync, unlinkSync, cpSync, writeFileSync, existsSync, realpathSync,
} from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILLS_SRC = resolve(SCRIPT_DIR, 'skills');
const MARKER = '.installed-by-vinta-ai-workflows';

// ── Vendor target paths ──────────────────────────────────────────────────
//
// Sources (verified 2026-05):
//   Claude Code  — .claude/skills/  (native)
//   Codex        — .agents/skills/  (developers.openai.com/codex/skills,
//                                    walks up to repo root)
//   Cursor       — .cursor/skills/ OR .agents/skills/ (cursor.com/docs/skills)
//   Copilot      — .github/skills/, .claude/skills/, .agents/skills/
//                  (code.visualstudio.com/docs/copilot/customization/agent-skills)
//
// `.agents/skills/` is the universal path — recognized by Codex, Cursor, and
// Copilot. We expose it as the `agents` virtual tool for one-shot installs.

const TOOLS = {
  'claude-code': { project: '.claude/skills', label: 'Claude Code' },
  codex:         { project: '.agents/skills', label: 'OpenAI Codex' },
  cursor:        { project: '.cursor/skills', label: 'Cursor' },
  copilot:       { project: '.github/skills', label: 'VS Code + Copilot' },
  agents:        { project: '.agents/skills', label: 'Universal (Codex + Cursor + Copilot)' },
};

const TOOL_ALIASES = {
  'claude-code': 'claude-code',
  claude: 'claude-code',
  codex: 'codex',
  'openai-codex': 'codex',
  cursor: 'cursor',
  copilot: 'copilot',
  vscode: 'copilot',
  'vscode-copilot': 'copilot',
  'github-copilot': 'copilot',
  agents: 'agents',
  universal: 'agents',
};

const ALL_TOOLS = ['claude-code', 'codex', 'cursor', 'copilot'];

// ── CLI parsing ──────────────────────────────────────────────────────────

function printHelp() {
  console.log(`vinta-ai-workflows skills installer

Commands:
  install     Place skills under <target>/.<vendor>/skills/
  update      Re-install (uninstall + install) so latest source content lands
  uninstall   Remove skills (only artifacts created by this script)
  list        List available skills

Options:
  --tool <name>       claude-code | codex | cursor | copilot | agents | all
  --target <dir>      Project root (default: cwd)
  --skills <a,b,c>    Subset of skills
  --copy              Copy instead of symlink (recommended for shared repos
                      where contributors don't have this clone)
  --dry-run, -n       Plan only
  --help, -h          This help

Tip: --tool agents writes to .agents/skills/, which Codex, Cursor, and Copilot
all recognize. Use it to cover three tools with one install.`);
}

function parseArgs(argv) {
  const opts = {
    cmd: argv[0],
    tool: null,
    target: process.cwd(),
    copy: false,
    skills: null,
    dryRun: false,
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const eq = (k) => a === k || a.startsWith(`${k}=`);
    const val = (k) => (a.startsWith(`${k}=`) ? a.slice(k.length + 1) : argv[++i]);
    if (eq('--tool')) opts.tool = val('--tool');
    else if (eq('--target')) opts.target = resolve(val('--target'));
    else if (a === '--copy') opts.copy = true;
    else if (eq('--skills')) {
      opts.skills = val('--skills').split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--dry-run' || a === '-n') opts.dryRun = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  return opts;
}

function resolveTools(tool) {
  if (!tool) { console.error('--tool required (or use "all")'); process.exit(2); }
  if (tool === 'all') return ALL_TOOLS;
  const canonical = TOOL_ALIASES[tool.toLowerCase()];
  if (!canonical) {
    const allowed = Object.keys(TOOL_ALIASES).sort().concat('all').join(', ');
    console.error(`unknown tool "${tool}". Allowed: ${allowed}`);
    process.exit(2);
  }
  return [canonical];
}

// ── Skill discovery ──────────────────────────────────────────────────────

function listSkills() {
  if (!existsSync(SKILLS_SRC)) {
    console.error(`skills source missing: ${SKILLS_SRC}`);
    process.exit(1);
  }
  return readdirSync(SKILLS_SRC, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(SKILLS_SRC, d.name, 'SKILL.md')))
    .map((d) => d.name)
    .sort();
}

function resolveSkillSet(requested) {
  const all = listSkills();
  if (!requested?.length) return all;
  const missing = requested.filter((s) => !all.includes(s));
  if (missing.length) {
    console.error(`unknown skills: ${missing.join(', ')}`);
    console.error(`available: ${all.join(', ')}`);
    process.exit(2);
  }
  return requested;
}

function targetDir(tool, target) {
  return resolve(target, TOOLS[tool].project);
}

// ── Install ──────────────────────────────────────────────────────────────

function install(opts) {
  const tools = resolveTools(opts.tool);
  const skills = resolveSkillSet(opts.skills);

  // Dedupe by destination directory so `--tool all` + `agents` overlap
  // doesn't double-install (codex and agents both write to .agents/skills/).
  const seenBaseDirs = new Set();

  for (const tool of tools) {
    const baseDir = targetDir(tool, opts.target);
    if (seenBaseDirs.has(baseDir)) {
      console.log(`[${tool}] ${baseDir} already covered — skipping`);
      continue;
    }
    seenBaseDirs.add(baseDir);

    if (!opts.dryRun) mkdirSync(baseDir, { recursive: true });

    for (const skill of skills) {
      const src = join(SKILLS_SRC, skill);
      const dest = join(baseDir, skill);

      if (opts.dryRun) {
        console.log(`[${tool}] would ${opts.copy ? 'copy' : 'symlink'} ${skill} → ${dest}`);
        continue;
      }

      try {
        const st = lstatSync(dest);
        if (st.isSymbolicLink() || st.isFile()) unlinkSync(dest);
        else if (st.isDirectory()) rmSync(dest, { recursive: true, force: true });
      } catch { /* not present */ }

      if (opts.copy) {
        cpSync(src, dest, { recursive: true });
        writeFileSync(
          join(dest, MARKER),
          `Installed by vinta-ai-workflows (vinta-ai-workflows.mjs)\nsource: ${src}\n`,
        );
      } else {
        const rel = relative(dirname(dest), src);
        symlinkSync(rel, dest, 'dir');
      }
      console.log(`[${tool}] installed ${skill} → ${dest}`);
    }
  }
}

// ── Uninstall ────────────────────────────────────────────────────────────
//
// Safety: removes only
//   - symlinks whose realpath is inside SKILLS_SRC (or dangling)
//   - directories containing the MARKER file
// User-authored or hand-edited entries are left alone.

function uninstall(opts) {
  const tools = resolveTools(opts.tool);
  const skills = resolveSkillSet(opts.skills);

  const seenBaseDirs = new Set();

  for (const tool of tools) {
    const baseDir = targetDir(tool, opts.target);
    if (seenBaseDirs.has(baseDir)) continue;
    seenBaseDirs.add(baseDir);

    if (!existsSync(baseDir)) {
      console.log(`[${tool}] ${baseDir} not present — nothing to do`);
      continue;
    }

    for (const skill of skills) {
      const dest = join(baseDir, skill);
      let st;
      try { st = lstatSync(dest); } catch { continue; }

      if (st.isSymbolicLink()) {
        let real;
        try { real = realpathSync(dest); } catch { real = null; }
        if (real === null || real.startsWith(SKILLS_SRC)) {
          if (opts.dryRun) console.log(`[${tool}] would remove symlink ${dest}`);
          else { unlinkSync(dest); console.log(`[${tool}] uninstalled ${skill}`); }
        } else {
          console.warn(`[${tool}] ${dest} symlinks outside skills source — leaving`);
        }
      } else if (st.isDirectory()) {
        if (existsSync(join(dest, MARKER))) {
          if (opts.dryRun) console.log(`[${tool}] would remove ${dest}`);
          else { rmSync(dest, { recursive: true, force: true }); console.log(`[${tool}] uninstalled ${skill}`); }
        } else {
          console.warn(`[${tool}] ${dest} lacks marker (hand-installed?) — leaving`);
        }
      } else {
        console.warn(`[${tool}] ${dest} unexpected entry type — leaving`);
      }
    }

    try {
      const remaining = readdirSync(baseDir);
      if (remaining.length === 0) {
        if (opts.dryRun) console.log(`[${tool}] would remove empty ${baseDir}`);
        else { rmdirSync(baseDir); console.log(`[${tool}] removed empty ${baseDir}`); }
      }
    } catch { /* ignore */ }
  }
}

// ── Update (uninstall then install) ──────────────────────────────────────

function update(opts) {
  console.log('# update — phase 1: uninstall existing');
  uninstall(opts);
  console.log('# update — phase 2: install latest');
  install(opts);
}

// ── List ─────────────────────────────────────────────────────────────────

function list() {
  const skills = listSkills();
  console.log(`Skills available in ${SKILLS_SRC}:`);
  for (const s of skills) console.log(`  ${s}`);
}

// ── Main ─────────────────────────────────────────────────────────────────

const opts = parseArgs(process.argv.slice(2));
switch (opts.cmd) {
  case 'install':   install(opts); break;
  case 'update':    update(opts); break;
  case 'uninstall': uninstall(opts); break;
  case 'list':      list(); break;
  case undefined:
  case '--help':
  case '-h':        printHelp(); break;
  default:
    console.error(`unknown command: ${opts.cmd}`);
    printHelp();
    process.exit(2);
}
