#!/usr/bin/env node
// @ts-nocheck
/**
 * check-ai-models — nightly freshness check for the plan-feature AI model tier table.
 *
 * Reads the resource at
 *   skills/vinta-derive-skills/resources/foundation-skills/plan-feature/resources/ai-models.yaml
 * collects every model id it cites, and checks them against a FREE, no-key community
 * aggregator (models.dev — vendor-keyed, with release dates + pricing), cross-checked
 * against LiteLLM's price/context JSON. No vendor API keys are needed to detect drift;
 * the script only needs network access.
 *
 * Reports DRIFT (cited ids the aggregator no longer lists) plus NEW candidates (newer
 * ids in a family we already cite but haven't listed, ranked by release date).
 *
 * On drift, when ANTHROPIC_API_KEY is set and --no-llm is not passed, it asks an LLM to
 * propose an updated ai-models.yaml (re-placing tiers + refreshing notes) and, with
 * --write, applies that proposal in place so the caller (the GitHub Action) can open a
 * PR. The LLM key is the ONLY key involved and only powers the proposal — detection is
 * always free. Tier placement is judgement: the LLM proposes, a human reviews the PR.
 *
 * Flags:
 *   --write     apply the LLM proposal to the resource file in place (default: report only)
 *   --no-llm    skip the LLM proposal step; just report drift
 *   --resource <path>  override the resource path (default: the shipped plan-feature copy)
 *
 * Exit codes: 0 = no drift, 1 = drift detected (advisory; the workflow keys off the
 * GITHUB_OUTPUT `drift` value, not the exit code), 2 = hard error (bad resource, both
 * aggregators unreachable, etc.).
 */

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RESOURCE = resolve(
  REPO_ROOT,
  'skills/vinta-derive-skills/resources/foundation-skills/plan-feature/resources/ai-models.yaml',
);
const FALLBACK_PROPOSER_MODEL = 'claude-sonnet-4-6';
const MAX_CANDIDATES = 15;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const RESOURCE = opt('--resource') ? resolve(opt('--resource')) : DEFAULT_RESOURCE;
const DO_WRITE = flag('--write');
const NO_LLM = flag('--no-llm');

// --- aggregator sources ---------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'vinta-ai-workflows check-ai-models' } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

// models.dev: { <vendor>: { models: { <id>: { id, release_date, cost, family, ... } } } }
function liveFromModelsDev(doc, vendors) {
  const byVendor = {};
  for (const v of vendors) {
    const models = doc?.[v]?.models;
    if (!models) continue;
    byVendor[v] = Object.values(models).map((m) => ({
      id: m.id,
      release_date: m.release_date ?? m.last_updated ?? '',
    }));
  }
  return byVendor;
}

// LiteLLM fallback: flat map keyed by model name (provider-prefixed variants included).
// We can't reliably split by vendor, so we expose one global id list used only to confirm
// a cited id still exists somewhere — no candidate mining from this source.
function liveIdsFromLiteLLM(doc) {
  return Object.keys(doc).filter((k) => k !== 'sample_spec');
}

// --- match helpers --------------------------------------------------------------

// A cited id is alive if the aggregator lists it exactly or as a dated/versioned snapshot
// (claude-haiku-4-5 ⊂ claude-haiku-4-5-20251001 / ...@20251001).
function liveMatch(cited, liveId) {
  return (
    liveId === cited ||
    liveId.startsWith(cited + '-') ||
    liveId.startsWith(cited + '@') ||
    liveId.includes(cited)
  );
}

// Family root = alpha/dash prefix up to the first version digit.
// claude-haiku-4-5 -> "claude-haiku-", gpt-5-nano -> "gpt-", gemini-2.5-pro -> "gemini-", o3 -> "o".
function familyRoot(id) {
  const m = String(id).match(/^([a-z]+(?:-[a-z]+)*-?)\d/i);
  return m ? m[1] : String(id).replace(/\d.*$/, '');
}

// Non-coding / preview model kinds we never want to suggest as a tier candidate.
const NOISE = /embedding|tts|audio|whisper|realtime|moderation|image|vision-only|search|computer-use|guard|preview|-exp\b|-exp-|live\b|gemma/i;

function citedIdsByVendor(doc) {
  const out = {};
  for (const tier of doc.tiers ?? []) {
    for (const [vendor, models] of Object.entries(tier.models ?? {})) {
      (out[vendor] ??= new Set());
      for (const entry of models) out[vendor].add(entry.id);
    }
  }
  return out;
}

// --- LLM proposal ---------------------------------------------------------------

async function proposeUpdatedYaml({ key, model, currentYaml, liveByVendor, drift }) {
  const liveLines = Object.entries(liveByVendor)
    .map(([v, list]) => {
      const ids = list.map((m) => (m.release_date ? `${m.id} (${m.release_date})` : m.id));
      return `### ${v}\n${ids.slice(0, 120).join('\n')}`;
    })
    .join('\n\n');
  const driftLines = Object.entries(drift)
    .map(([v, d]) => `${v}: dead=[${d.dead.join(', ') || '—'}] newer_available=[${d.newer.join(', ') || '—'}]`)
    .join('\n');

  const prompt = `You maintain a YAML file that recommends AI coding models per difficulty tier for a software-planning skill. Vendors ship and retire models constantly, so the file drifts.

Here is the CURRENT file:

\`\`\`yaml
${currentYaml}
\`\`\`

Here is the DRIFT detected against a model aggregator (models.dev):

${driftLines}

Here are the model ids the aggregator currently lists per vendor, newest-ish first, with release dates:

${liveLines}

Produce an UPDATED version of the YAML file that:
- replaces every dead model id with the closest current equivalent of the same capability class,
- considers promoting strong new candidates into the appropriate tier (cheapest model that one-shots the tier's work — do NOT over-upgrade),
- keeps the exact same top-level structure, keys, comment style, \`source:\` block, and tier numbering,
- keeps the leading comment block and the \`# yaml-language-server\` directive,
- updates \`last_verified\` to today's date if you know it; otherwise leave it,
- preserves \`note:\` caveats where still accurate, edits them where not.

Return ONLY the full updated YAML between <yaml> and </yaml> tags. No prose.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, max_tokens: 4096, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`anthropic messages ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const text = (body.content ?? []).map((c) => c.text ?? '').join('');
  const m = text.match(/<yaml>([\s\S]*?)<\/yaml>/);
  if (!m) throw new Error('LLM response had no <yaml> block');
  return m[1].trim() + '\n';
}

// --- output helpers -------------------------------------------------------------

const out = (line) => process.stdout.write(line + '\n');
const ghOutput = (k, v) =>
  process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
const ghSummary = (md) =>
  process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');

// --- main -----------------------------------------------------------------------

async function main() {
  let rawYaml, doc;
  try {
    rawYaml = readFileSync(RESOURCE, 'utf8');
    doc = parseYaml(rawYaml);
  } catch (e) {
    out(`ERROR: cannot read/parse resource at ${RESOURCE}: ${e.message}`);
    process.exit(2);
  }

  const cited = citedIdsByVendor(doc);
  const vendors = Object.keys(cited);

  // Detection source: models.dev primary, LiteLLM fallback. No keys.
  let liveByVendor = {};
  let sourceUsed = '';
  try {
    liveByVendor = liveFromModelsDev(await fetchJson(doc.source.primary), vendors);
    sourceUsed = doc.source.primary;
    if (Object.keys(liveByVendor).length === 0) throw new Error('no tracked vendors present');
  } catch (ePrimary) {
    out(`Primary source failed (${ePrimary.message}); trying fallback…`);
    if (!doc.source.fallback) {
      out('No fallback configured. Cannot verify.');
      process.exit(2);
    }
    try {
      const ids = liveIdsFromLiteLLM(await fetchJson(doc.source.fallback));
      // Fallback gives one global id pool; attribute it to every vendor for dead-check only.
      for (const v of vendors) liveByVendor[v] = ids.map((id) => ({ id, release_date: '' }));
      sourceUsed = `${doc.source.fallback} (fallback — dead-check only, no candidates)`;
    } catch (eFallback) {
      out(`Fallback source also failed (${eFallback.message}). Aborting.`);
      process.exit(2);
    }
  }

  const drift = {};
  for (const v of vendors) {
    const live = liveByVendor[v] ?? [];
    const liveIds = live.map((m) => m.id);
    const citedList = [...cited[v]];

    const dead = citedList.filter((c) => !liveIds.some((l) => liveMatch(c, l)));

    // Newest release date among our cited models (looked up in the live data).
    const citedDates = live
      .filter((m) => citedList.some((c) => liveMatch(c, m.id)) && m.release_date)
      .map((m) => m.release_date);
    const newestCited = citedDates.sort().at(-1) ?? '';

    // A "newer" candidate = same-family, not cited, not a noise variant, released after
    // the newest model we already cite. That is the real "you're behind" signal — a new
    // flagship can ship without anything we cite going dead.
    const citedFamilies = new Set(citedList.map(familyRoot));
    const newer = live
      .filter(
        (m) =>
          citedFamilies.has(familyRoot(m.id)) &&
          !citedList.some((c) => liveMatch(c, m.id)) &&
          !NOISE.test(m.id) &&
          m.release_date &&
          newestCited &&
          m.release_date > newestCited,
      )
      .sort((a, b) => String(b.release_date).localeCompare(String(a.release_date)))
      .slice(0, MAX_CANDIDATES);

    drift[v] = {
      dead,
      newer: newer.map((m) => m.id),
      newerVerbose: newer.map((m) => `${m.id} (${m.release_date})`),
    };
  }

  const hasDrift = vendors.some((v) => drift[v].dead.length > 0 || drift[v].newer.length > 0);

  // Report
  const report = ['# AI model freshness check\n'];
  report.push(`Resource: \`${RESOURCE.replace(REPO_ROOT + '/', '')}\``);
  report.push(`Source: ${sourceUsed}`);
  report.push(`Vendors: ${vendors.join(', ')}\n`);
  for (const v of vendors) {
    const d = drift[v];
    report.push(`## ${v}`);
    report.push(d.dead.length ? `- **Dead (cited, no longer listed): ${d.dead.join(', ')}**` : '- Dead: none ✅');
    report.push(d.newerVerbose.length ? `- **Newer available (same family, released after our newest): ${d.newerVerbose.join(', ')}**` : '- Newer available: none ✅');
    report.push('');
  }
  const reportMd = report.join('\n');
  out(reportMd);
  ghSummary(reportMd);
  ghOutput('drift', hasDrift ? 'true' : 'false');

  if (!hasDrift) {
    out('\nNo drift. All cited model ids still listed.');
    ghOutput('has_proposal', 'false');
    process.exit(0);
  }

  if (NO_LLM || !process.env.ANTHROPIC_API_KEY) {
    out(`\nDrift detected. LLM proposal skipped (${NO_LLM ? '--no-llm' : 'no ANTHROPIC_API_KEY'}).`);
    ghOutput('has_proposal', 'false');
    process.exit(1);
  }

  const proposerModel =
    doc.tiers?.find((t) => t.tier === 3)?.models?.anthropic?.[0]?.id ?? FALLBACK_PROPOSER_MODEL;
  out(`\nDrift detected. Requesting LLM proposal via ${proposerModel}…`);

  let proposed;
  try {
    proposed = await proposeUpdatedYaml({
      key: process.env.ANTHROPIC_API_KEY,
      model: proposerModel,
      currentYaml: rawYaml,
      liveByVendor,
      drift,
    });
    const reparsed = parseYaml(proposed);
    if (!Array.isArray(reparsed.tiers) || !reparsed.source) {
      throw new Error('proposal lost required top-level keys (tiers/source)');
    }
  } catch (e) {
    out(`LLM proposal failed: ${e.message}`);
    ghOutput('has_proposal', 'false');
    process.exit(1);
  }

  if (DO_WRITE) {
    writeFileSync(RESOURCE, proposed, 'utf8');
    out(`\nWrote LLM proposal to ${RESOURCE}.`);
  } else {
    out('\n--- proposed ai-models.yaml (not written; pass --write to apply) ---\n');
    out(proposed);
  }
  ghOutput('has_proposal', 'true');
  process.exit(1);
}

main().catch((e) => {
  out(`FATAL: ${e.stack || e.message}`);
  process.exit(2);
});
