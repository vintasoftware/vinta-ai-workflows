# Observability evidence categories (MCP-agnostic)

Reference consumed by [vinta-derive-skills](../SKILL.md) when rendering [systematic-debugging-template.md](systematic-debugging-template.md). The systematic-debugging skill needs evidence from the platform before any hypothesis, but the **specific MCP tool names, function signatures, and parameters change too fast to hardcode**. This file describes the *categories of evidence* the skill demands plus the runtime discovery flow that finds the right calls in whatever MCP servers the project has connected today.

## Render contract

The renderer of [systematic-debugging-template.md](systematic-debugging-template.md) substitutes:

- `{{OBSERVABILITY_MCP_LIST}}` — comma-separated list of the **MCP server identifiers** the project marked as available in `skills.systematic-debugging.observability_mcp_servers` of `.vinta-ai-workflows.yaml`. Free-form strings — whatever the project calls them (e.g. `sentry`, `datadog`, `our-internal-traces`, `grafana-prod`). Falls back to `none configured` when the array is empty.
- `{{OBSERVABILITY_MCP_BLOCK}}` — the verbatim block below ("Phase 0 evidence categories"), prefixed with one paragraph naming the configured servers and instructing the agent to discover the right calls inside them at runtime. When the array is empty, the block is replaced with the no-tools fallback at the end of this file.

The renderer **does not** inline tool-specific function names. The agent runs Phase 0 by listing MCP tools at runtime and picking the ones that match each evidence category.

## Phase 0 evidence categories

The block rendered into the SKILL.md is exactly this:

---

### How to discover the right MCP calls

The cached preflight in the rendered SKILL.md decides which servers to introspect this run (cache-hit servers skip listing; freshly-preflighted servers get listed). For each server cleared by preflight, list every tool it exposes and group them by the evidence categories below — match on tool description and parameter names, not on remembered names from past sessions. MCP servers rename tools and add capabilities frequently; **trust the live tool list, not training data**.

If a server claims to cover a category but no listed tool matches the description, ask the user before falling back to "no evidence available" — the tool may exist under a name the matcher missed.

If a tool call fails mid-session with auth / connection / transport errors, mark the server `dirty` in `.vinta-ai-workflows/cache.yaml` so the next debug run re-runs preflight on it. Do not re-preflight inside the same session — keep moving with the evidence already gathered.

### Categories of evidence the skill requires

For each category: what evidence is needed, what to extract, and what shape of MCP tool typically provides it. Skip a category only when no configured server can supply it; record the skip in the Phase 0 evidence note (*"no metric source available"*).

#### 1. Error tracking — fingerprints, stack traces, occurrence counts

**Why:** identifies the exact failure signature, how many users / tenants / regions hit it, when it started.

**Look for tools that:** search or list errors / issues / events; fetch a single error's full payload (stack trace, breadcrumbs, request context, release tag, environment); group by fingerprint; resolve / mute / link an error.

**Extract into the evidence note:**
- The error's stable id and permalink.
- First-seen and last-seen timestamps in UTC.
- Affected scope: environment, release / build, tenant, route, user count.
- Correlated identifiers (trace id, request id, session id) so the next category can cross-reference.

#### 2. Distributed tracing — span chains, upstream / downstream calls

**Why:** shows the request path across services, which span actually failed, what was upstream of it.

**Look for tools that:** fetch a trace by id; query traces by service + time window; surface the slow / failing span in a trace; list dependencies of a service.

**Extract into the evidence note:**
- The failing span's name, service, and the parent chain leading to it.
- Whether the failure originates in our code or a downstream dependency.
- Latency on each span vs. its baseline (helps tell "slow downstream" from "broken downstream").

#### 3. Logs — raw lines around the incident window

**Why:** error tracking shows the exception, but logs show what the process did *before* and *after*.

**Look for tools that:** filter / search logs by time window + service + free-text or structured query; tail logs around a specific request id or trace id; list log streams for a resource.

**Extract into the evidence note:**
- The log lines before the error (what state the process was in).
- Log lines after the error (did the process recover, restart, crash?).
- Any other error or warning in the same window from the same service — often a precursor.

#### 4. Metrics — RED / USE / saturation signals

**Why:** confirms whether the bug is a one-off, a steady leak, or a step-change tied to a deploy.

**Look for tools that:** query a metric over a time range; list metrics for a service / resource; describe a dashboard or panel.

**Extract into the evidence note:**
- Error rate, request rate, p50 / p95 / p99 latency on the affected operation, around first-seen and over the prior equivalent window.
- Saturation signals where applicable: queue depth, CPU, memory, connection pool, db locks.
- Whether the anomaly is a spike, a step-change, or a slow drift.

#### 5. Alerts / monitors / SLO burn

**Why:** the platform may already have flagged the incident; if it didn't, the skill should leave a note for whoever maintains the alerts.

**Look for tools that:** list firing alerts in a window; describe an alert / monitor's current state; show SLO burn rate.

**Extract into the evidence note:**
- Any alert that fired or recovered in the incident window.
- Any alert that *should have* fired but didn't (gap in coverage to flag in the PR description).
- SLO burn rate if the affected operation has one.

#### 6. Deploys / releases / config changes

**Why:** "what changed" is usually the answer. The platform's deploy timeline beats `git log` because it shows what's actually running.

**Look for tools that:** list recent deploys for a project / service; describe a deploy's commit sha, author, and timestamp; list feature-flag flips; show config-store revisions.

**Extract into the evidence note:**
- The closest deploy / release / flag flip / config push before first-seen.
- Whether the incident first-seen aligns within minutes of that change.
- The commit sha or change id so the implementer can `git show` it during Phase 1.

#### 7. Dashboards — pre-built views the team already trusts

**Why:** SREs and product engineers have curated panels that the systematic-debugging agent should not try to recreate from scratch.

**Look for tools that:** search dashboards by title / tag; render a dashboard URL pinned to a time window; list panels in a dashboard.

**Extract into the evidence note:**
- URL of the most relevant dashboard, pinned to the incident window.
- The panel that visualises the anomaly (so the human reviewer can verify by eye).

### How to use the evidence

Once the categories above are filled in (or explicitly skipped), the Phase 0 evidence note is complete. Carry trace ids and request ids forward — the same id often unlocks deeper queries in a tool the agent already used. Do not move to Phase 1 until the cause's *blast radius and timeline* are written down: which scope is affected, when it started, what changed in the same window.

### When no MCP observability servers are configured

Replace the entire block above with this single paragraph:

> No observability MCP server is wired up for this project. Phase 0 collapses to "read the local logs available to the developer and reproduce the failure deterministically." Write *"no platform evidence available"* at the top of the Phase 0 note so reviewers know the evidence floor was local-only. If the bug is production-only, stop and ask the user to wire up an error-tracking or log MCP server before continuing — production-only bugs without telemetry are a guess factory.

---

## Renderer notes

- The block is emitted verbatim — there is no per-server templating. Tool discovery is a runtime activity, not a generation-time activity.
- `skills.systematic-debugging.observability_mcp_servers` is a free-form list of identifiers the user recognises; the renderer only joins them into `{{OBSERVABILITY_MCP_LIST}}`. It is allowed to be empty (the no-tools fallback above renders) but the bootstrap interview should warn the user that an empty list defeats the skill's purpose.
- If the user adds a new MCP server later, [vinta-ai-workflows-sync](../../vinta-ai-workflows-sync/SKILL.md) just appends it to the list and re-renders — no new catalogue entry needed.
