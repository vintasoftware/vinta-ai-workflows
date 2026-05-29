---
name: create-spec
description: Turn raw feature prompt into structured spec doc at `ai-plans/YYYY-MM-DD-FEATURE_NAME_SPEC.md`. Sections fixed — Business Context, Hypothesis, Objectives, Decisions (Use-cases / State transitions & edge cases / Acceptance scenarios / Negative scope), Alternatives considered (optional), Open questions, Risks assumed. Use when user asks "write a spec", "draft a spec doc", "turn this idea into a spec", or hands one-line / paragraph feature description needing structure before plan. Skill ALWAYS interviews requester before drafting — never turn vague prompt into plausible-sounding spec by guessing.
---

# Spec Document

Spec **frame problem + solution boundaries** before plan. Precedes [plan-feature](../plan-feature/SKILL.md): spec answer *"what + why?"*; plan answer *"how, in what order, with what tests"*. Different artefact, different audience (spec → product + eng leadership; plan → implementer).

Output: `ai-plans/YYYY-MM-DD-FEATURE_NAME_SPEC.md` (uppercase + underscores, today date prefix). Structure fixed; content from interview, not inference.

## Step 0 — Interrogate before drafting (NON-NEGOTIABLE)

Biggest failure: AI take one-liner ("add tags to orders") + confidently produce three pages of plausible-sounding context, hypothesis, acceptance criteria requester didn't say. **Don't.** Even when prompt look self-explanatory, ask. Even when answer feel obvious — your "obvious" is training-data average; theirs is *their* business.

Ask below in batched, numbered chunks. Skip group only when prompt **explicitly** answers it; never because you can plausibly fill in.

For finite-set answers, **list options**. Provide one-sentence **why** so they understand implications.

### Use `AskUserQuestion` for finite-choice questions

Every interview question with discrete answer set — yes/no, named option, finite enum, hypothesis-vs-known-requirement, idempotency mode, concurrency rule — **must** issue via `AskUserQuestion` tool. Use plain prose only when answer genuinely open-ended (problem narrative, walking through journey, free-form motivation, hard deadline date).

Pattern per group:

- One `AskUserQuestion` call per group, batch multiple questions into same call when tool supports (each question carry own option set).
- Short label per option; rationale ("default: per-user — confirm or override") goes in question header, not option label.
- Open-ended sub-questions in same group → fall back to plain prose for those, send closed-form ones via `AskUserQuestion`. Don't force finite list when genuinely free text.

If `AskUserQuestion` in deferred-tool list + not yet schema-loaded, call anyway — tool name fixed + harness surfaces it. **Never** flatten ten questions into one prose paragraph because tool not pre-loaded; that failure mode this skill exists to prevent.

### Clarity loop — keep asking until done

Step 0 isn't one-pass. After each round of answers, **scan for new gaps**: contradictions between answers, follow-ups one answer surfaces, decisions left vague another decision depends on. Open another batch for those. Repeat.

Loop exit conditions (all required):
- Every group A–I either fully answered or explicitly waived.
- Every answer's downstream questions also asked + answered.
- No "we'll figure that out later" — that's **Open questions** material; either has recommended default + owner + unblock condition, or resolved now.
- Can write each **Decisions → Use-cases** entry (actor + trigger + flow + outcome) without inventing.
- Can write **Decisions → Acceptance scenarios** without making up Given/When/Then.

Any condition fails → another `AskUserQuestion` round. Don't shortcut to drafting just because you've done one batch.

After answers stabilize: **read back one-paragraph summary** of every load-bearing decision. Then issue one final `AskUserQuestion` — single question *"Anything I got wrong before I draft?"* with options `Looks good`, `Some corrections (I'll list)`, `More to clarify`, `Stop, rethink`. `More to clarify` → another loop iteration. Only draft when user picks `Looks good`.

User say *"just write the spec, I'll fix it"*: comply but mark every unverified inference under **Open questions** (preferred) or **Risks assumed** (when guess about how world is). Don't let assumptions hide inside Business Context or Decisions.

### A — Problem & customer

1. **Problem we solving — for whom?** Specific actor: tenant admins editing orders, ops staff fixing data, end users in dashboard, external integration partners, internal team.
   *Why: "the customer" rarely single bucket; mixing them = optimize wrong workflow.*
2. **What customer do today?** Manual workaround, support ticket, doesn't bother, leaves platform — name path + pain.
   *Why: no current pain → no demand to validate. "Leaves platform" different objective than "saves 10 minutes/week".*
3. **Cost today?** Lost revenue, support volume, churn risk, manual hours, compliance risk, integration breakage. Rough estimate fine.
   *Why: becomes success metric in **Objectives**. Without it, "did this work?" has no answer.*
4. **Who else care about this landing?** Other teams, integration partners, support, sales engineering, named stakeholder. Anyone who block rollout if not looped in.
   *Why: surface hidden veto points before plan written.*

### B — Hypothesis (falsifiable)

1. **Change in behavior or metric expected?** State as `if we do X, then Y will improve by Z (within timeframe)`. Metric doesn't move → what tells us we wrong?
   *Why: spec without falsifiable hypothesis = wish list. plan-feature requires this for rollout/soak window.*
2. **Hypothesis or known requirement?**
   - **Hypothesis** — "we think this improves X, but unsure". Validation matter; may roll back.
   - **Known requirement** — "must do for compliance / customer / deadline". Correctness + timing matter, not validation.
   - **Mixed** — both gates apply.
   *Why: hypothesis-driven features need smaller gated rollouts + explicit kill criteria; known requirements need scope discipline + deadline awareness instead.*
3. **What "validated" look like — concrete signal, source, threshold?** *(Hypothesis only.)* E.g. "support ticket volume drops 50% in 60 days, measured in Zendesk tag X".
   *Why: vague "we'll see" doesn't survive contact with reality. Naming source up front prevent post-hoc cherry-picking.*
4. **Failed validation — what then?** Roll back, iterate, accept + move on, deprecate?
   *Why: force commitment to kill criterion before sunk-cost kicks in.*

### C — Use cases

1. **Walk through 1–3 concrete user journeys** end-to-end. Concrete: who initiate, what they click/send, what they see back, what side-effects fire.
   *Why: abstract descriptions miss conditions making features hard. Concrete journeys force decisions about ordering, defaults, error states.*
2. **Integration-driven (no human) flows hitting same path?** Webhook from upstream SaaS, scheduled function, batch import.
   *Why: flows working for humans often break for integrations (omit-vs-empty, retry semantics, idempotency).*
3. **Alternative entry points?** UI button + API + admin + Slack — anywhere same feature reachable.
   *Why: each entry point may need own permissions, validation, audit log.*

### D — State, edges, idempotency

1. **States / lifecycle?** Name them + allowed transitions. Sketch as `Draft → Active → Archived` if unsure.
   *Why: most "small" features turn out to have state machine. Drawing it out reveal forbidden transitions needing explicit handling.*
2. **Edge cases, even half-formed?** Empty inputs, deleted parents, concurrent edits, partial failures, stale data, duplicates, oversized payloads, very-many-of-X.
   *Why: requester know their business; their "weird thing once a month" exactly where bug live.*
3. **Idempotency**: same request twice (retry, double-click, replay)?
   - **Idempotent** — second is no-op, final state matches.
   - **Append/duplicate** — only OK when duplicates are desired semantic (logging clicks).
   - **Reject** — second errors with "already done".
   *Why: most APIs here idempotent by default (bulk-upsert with last_updated_at guard). Drift cause data corruption expensive to recover.*
4. **Concurrency**: two actors hit simultaneously on same entity? Resolution: last-write-wins, first-write-wins, optimistic lock with conflict surfaced?
   *Why: silent last-write-wins eat user work; surface explicitly.*
5. **Time-bounded behavior**: TTL, expiry, soak window, scheduled re-evaluation, "if user doesn't act within X, do Y"?
   *Why: time-based rules need explicit specs or become invisible bugs.*

### E — Acceptance scenarios

1. **3–7 scenarios proving works**, in Given/When/Then form (or close — "if X, then Y"). At minimum:
   - One happy path.
   - One error / negative path (invalid input rejected with useful message).
   - One edge case from D.
   - One integration-driven flow if there is one.
   *Why: become acceptance lines on plan phases + test matrix downstream.*

### F — Negative scope

1. **What might reasonable person assume in scope but you want excluded?** Be petty.
   *Why: non-goals save most time. Without them, scope creep invisible until Phase 6.*
2. **Deferred to v2 / v1.x?** Name each + reason (cost, complexity, no signal, blocked by something else).
   *Why: deferred-with-reason only honest deferral. "Maybe later" usually mean "never, but I don't want to argue".*
3. **What other systems / workflows should NOT change?** Existing endpoints whose contract must hold byte-for-byte, dashboards whose query shapes can't shift, integration payloads locked.
   *Why: changes that look additive often touch shared infra. Calling out hands-off zones set rollback contract.*

### G — Alternatives considered (optional)

1. **What other approaches considered — why rejected?** Cost, risk, scope creep, doesn't solve real problem, regulatory blocker, unproven, vendor change. One sentence each.
   *Why: make spec defensible six months later. No alternatives? Say so: "alternatives considered: none" valid signal.*

### H — Constraints, deadlines, dependencies

1. **Hard deadlines?** Compliance, customer commitments, partner integrations cutting over, regulatory window.
   *Why: change urgency math; may force phases to overlap risk normally sequential.*
2. **Existing systems / data we can't touch?** Frozen table, deprecated endpoint kept alive for one customer, contract under review.
   *Why: usually appear as Phase-3 surprises.*
3. **External dependencies** — integration partners (third-party SaaS APIs), other internal services / repos, other teams' deliverables. Who has to do what before this lands?
   *Why: define deploy ordering. Spec ignoring slowest-moving dep ship late.*

### I — Risks & assumptions

1. **What could go wrong, how bad?** Migration data loss, user confusion, integration regression, perf regression on hot path, breakage of unrelated feature.
   *Why: every spec has risks; question is which team willing to live with.*
2. **What you assuming that might not hold?** "no tenant has more than 200 of these"; "integrations send X within 24h"; "schema can change without multi-step migration".
   *Why: landmines if not surfaced. Once written, team can validate, design around, or accept.*
3. **Reversibility**: roll back if goes badly? At what cost? One-way doors (DB migrations, breaking API changes, customer-visible names)?
   *Why: shape rollout + feature-flag scope.*

After interview: read back load-bearing decisions in one paragraph (problem, customer, hypothesis or known-requirement framing, primary use cases, key states, hard deadlines, biggest risk). Ask *"anything I got wrong before I draft?"*. Only after explicit confirmation, write to disk.

## Spec structure (fixed)

Use these sections in order. No new top-level sections. Skip only when genuinely doesn't apply (rare).

```markdown
# {Feature Name} — Spec

## 1. Business Context
The why. Customer, problem, cost of doing nothing, stakeholder pressure. Plain prose, 5–15 lines. Cite numbers when given; mark estimates as estimates.

## 2. Hypothesis (to be validated)
Falsifiable: "if we do X, we expect Y to improve by Z within T". Known requirement instead? Say so: "Not a hypothesis — known requirement driven by {reason}". Don't skip; framing matters.

## 3. Objectives (and how to validate Hypothesis)
Numbered. For each:
- Metric or signal that proves it.
- Data source.
- Threshold or direction of change.
- Timeframe to evaluate.
- Kill criterion (if hypothesis-mode): what counts as failed + what we do.

Known-requirement: replace "validate hypothesis" with "definition of done" — still concrete + measurable.

## 4. Decisions
Resolved questions go here. Ambiguous → **Open questions** section.

### 4.1 Use-cases
Numbered. Each: actor, trigger, flow (2–6 numbered steps), outcome.

### 4.2 State transitions & edge cases
- State machine if any (lifecycle states, allowed/forbidden transitions).
- Edge cases from interview, each with decided handling.
- Idempotency rule.
- Concurrency rule.
- Time-bounded rules (TTL, expiry, soak windows).

### 4.3 Acceptance scenarios
3–7 Given/When/Then. Minimum: happy, error, edge, integration-driven (when applicable). Become plan's test matrix.

### 4.4 Negative scope
Bulleted, one-line reason each: deferred to v2 (link if exists), unrelated workflow, hands-off contract. Be petty.

## 5. Alternatives considered (optional)
Each: short paragraph, what it was, why rejected. None? Say so: "Alternatives considered: none — only viable path because {reason}." Don't omit silently.

## 6. Open questions
Each: question, recommended default, who can answer, what unblocks if answered.

## 7. Risks assumed
Bulleted. Each: risk, assumption (which if violated makes risk real), mitigation (or "accepted, no mitigation — see **Open questions**"), rough likelihood/severity (low/medium/high).
```

## Filename + date

`ai-plans/YYYY-MM-DD-FEATURE_NAME_SPEC.md`. Today's date ISO. `FEATURE_NAME` `UPPERCASE_WITH_UNDERSCORES`. Matching plan file use same prefix with `_IMPLEMENTATION_PLAN.md` so spec/plan pair groupable in `ls`.

## Style rules

- **Plain English over jargon.** Read by product, design, sales engineering, on-call. Acronyms expanded on first use.
- **No code.** No SQL, migration snippets, class skeletons, JSON contracts beyond what customer literally agreed to. Code lives in plan. Exception: typed interface client team committed to (Bookmarks spec's `IBookmarkBarFolderItem` TypeScript) belongs in **Decisions → Use-cases** or **Decisions → Acceptance scenarios** — as literal contract, not implementation guidance.
- **No file paths or app names.** "We'll add this to `core/sales/models/order.py`" plan-level.
- **No estimates.** Sizing belongs in plan.
- **No marketing language.** "Seamlessly", "robust", "best-in-class", "delightful" — strike.
- **Decisions decided; assumptions flagged.** Solid-feeling but unverified → move to **Open questions** or **Risks assumed**.
- **One feature per spec.** Multiple loosely-coupled features → multiple specs.
- **Illustrate with examples + diagrams, not prose.** "For example, if tenant admin clicks 'Add tag' button on order details page, then..." better than "tenant admins should be able to add tags to orders in UI". State machine diagram better than "orders have lifecycle states: Draft, Active, Archived". Diagrams must use mermaidjs syntax to ensure stay up to date with reality.

## Will not

- **Generate spec from one-liner without interviewing.** Even with 200 words pasted, interview still runs. Only override is explicit *"just write the spec, I'll fix it"*; then every assumption goes in **Open questions** or **Risks assumed**.
- **Use existing spec files in `ai-plans/` as structural templates.** Prior-art prompts, not specs in this skill's form. Read only if user explicitly asks.
- **Pre-decide implementation strategy.** Storage shape, partitioning, API surface, feature-flag mechanics — plan-level. Spec stops at "what" + "why".
- **Skip Open questions when real unknowns exist.** Spec with no open questions on non-trivial feature suspicious.
- **Pretty up rough thinking.** "I dunno, maybe we add tags" → don't paraphrase as "to enable tenants to enrich order metadata for downstream routing decisions". Either ask for the why or quote them: "Stated motivation: 'I dunno, maybe we add tags' — see **Open questions**, item 1."
- **Never use `§N` shorthand for section references.** Use section names verbatim — `Business Context`, `Hypothesis`, `Objectives`, `Decisions`, `Decisions → Use-cases`, `Decisions → Acceptance scenarios`, `Decisions → Negative scope`, `Alternatives considered`, `Open questions`, `Risks assumed`. `§4.3` makes the reader count headings and breaks when the spec evolves.

## Checklist

- [ ] Step 0 interview run; load-bearing decisions echoed back; user confirmed before drafting.
- [ ] Filename: `ai-plans/{YYYY-MM-DD}-{FEATURE_NAME}_SPEC.md`.
- [ ] All seven sections in order.
- [ ] **Business Context** cites stakeholders + rough cost-of-doing-nothing.
- [ ] **Hypothesis** falsifiable — or known-requirement with driver named. Not silently both.
- [ ] **Objectives** has metric, source, threshold, timeframe, kill criterion (when hypothesis-mode).
- [ ] **Decisions → Use-cases** each: actor + trigger + step-by-step flow + outcome.
- [ ] **Decisions → State transitions & edge cases** covers state machine, edge cases, idempotency, concurrency, time-bounded rules where applicable.
- [ ] **Decisions → Acceptance scenarios** has 3–7 scenarios covering happy / error / edge / integration paths.
- [ ] **Decisions → Negative scope** exhaustive enough to surprise user.
- [ ] **Alternatives considered** present (or explicit "none" with reason).
- [ ] **Open questions** lists every unresolved item with default, owner, unblocks-on.
- [ ] **Risks assumed** has assumption + mitigation + likelihood/severity.
- [ ] Body has no code, no file paths, no app names, no time estimates, no marketing language.
- [ ] Every unverified inference in **Open questions** or **Risks assumed** — not in **Business Context** through **Decisions**.
- [ ] No `§N` section references anywhere in the spec body. Use section names.