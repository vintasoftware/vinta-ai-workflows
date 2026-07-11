---
name: handoff-to-client
description: Generate a markdown API-change handoff document for the client teams consuming {{PROJECT_NAME}}'s {{API_STYLE}} API ({{CLIENT_PLATFORMS_LIST}}). Documents every endpoint/operation added, changed, deprecated, or removed on the current branch relative to `{{DEFAULT_BRANCH}}` — request/response shapes, auth, errors, breaking-change flags, and per-platform migration notes — so client implementers can adopt the changes without reading this repo's source. Use when the user says "write the client handoff", "document the API changes for the clients", "hand off to the frontend/mobile team", or before merging an API-changing branch.
---

# Handoff to client

{{PROJECT_NAME}} ({{STACK_SUMMARY}}) is an API-only repo — its consumers live in separate codebases: {{CLIENT_PLATFORMS_LIST}}. Client implementers cannot read this repo's diff; this skill turns an API-changing branch into a self-contained markdown document they implement against.

The document is a contract description, not a changelog: every change carries enough shape detail (fields, types, nullability, examples) that a client engineer can code against it without opening this repo.

## Step 0 — Resolve the scope

Default scope is the **current branch vs `{{DEFAULT_BRANCH}}`**:

```
git fetch origin {{DEFAULT_BRANCH}}
git diff origin/{{DEFAULT_BRANCH}}...HEAD --stat
```

Overrides, when the user asks: an explicit commit range (`<from>..<to>`), a merged PR, or a whole feature plan (enumerate the plan's phase branches/commits from its tracking file and union their diffs). State the resolved scope in the output doc's header.

If the resolved diff touches no API surface at all, say so and stop — do not fabricate a document.

## Step 1 — Enumerate the API surface changes

Work from the diff, never from memory:

1. List changed files in the scope and keep the API-relevant ones: route/URL declarations, controllers/views/resolvers, serializers/schemas/DTOs, auth/permission code, error handlers, API versioning config.
2. For each, read the changed hunks and map them to concrete operations (method + path for REST; query/mutation/subscription for GraphQL; service/rpc for gRPC).
3. Classify every operation touched: **added**, **changed**, **deprecated**, or **removed**.
4. For each **changed** operation, diff the request and response shapes field by field: added fields, removed fields, type changes, nullability changes, renamed fields, default changes, new/changed validation rules, pagination or filtering changes.
5. Flag **breaking** vs **non-breaking**. Breaking = anything an existing client call could fail or misbehave on: removed/renamed field or endpoint, narrowed type, newly-required request field, changed status code or error shape, auth/permission tightening. Additive-and-optional is non-breaking.

{{API_SPEC_BLOCK}}

Also sweep for non-endpoint contract changes clients still feel: auth flows (token lifetimes, scopes, header names), rate limits, webhooks/event payloads, websocket messages, file-upload conventions, and deprecation timelines.

## Step 2 — Write the document

Path: `{{CLIENT_HANDOFF_DIR}}/{YYYY-MM-DD}-{branch-or-feature-slug}.md`. Create the directory if missing.

```markdown
# API changes: {feature / branch title}

- **Date:** {YYYY-MM-DD}
- **Scope:** {branch} vs {{DEFAULT_BRANCH}} ({short-sha range})
- **Audience:** {{CLIENT_PLATFORMS_LIST}}
- **Breaking changes:** {count, or "none"}

## Summary
2–5 sentences: what shipped and why clients care. Lead with breaking changes.

## Breaking changes  ← omit section if none; never bury these
Per change: what breaks, which operations, what the client must do, and the
deadline/version after which the old behavior disappears.

## {Operation-by-operation sections, grouped added / changed / deprecated / removed}

### {METHOD /path}  or  {operationName}
- **Status:** added | changed | deprecated | removed — {breaking? yes/no}
- **Auth:** {scheme, required scopes/permissions}
- **Request:** field table or annotated example — name, type, required?,
  constraints, default. For *changed*: call out exactly what differs from before.
- **Response:** per status code — annotated example JSON with field meanings,
  nullability, enum values spelled out.
- **Errors:** status codes + error body shape + when each fires.
- **Example:** one complete request/response pair with realistic (fake) data.
- **Client migration notes:** what each platform ({{CLIENT_PLATFORMS_LIST}})
  concretely changes — omit platforms unaffected by this operation.

## Other contract changes
Auth flow / rate limits / webhooks / versioning changes from the Step 1 sweep.

## Rollout
Is the change live, behind a flag, or awaiting deploy? Environment availability
(staging first?), and the sequencing clients must respect.
```

Rules for the body:

- **Examples over prose.** Every operation gets at least one realistic request/response example. Use plausible fake data — never real user data, tokens, or secrets copied from fixtures or logs.
- **Shape from code, not intent.** Derive field names, types, and nullability from the serializer/schema/resolver code in the diff (or the regenerated spec), not from the plan document or commit messages.
- **Self-contained.** No links into this repo's source as the primary explanation; the audience may not have repo access. Citing paths as *provenance* is fine.
- **Neutral tone for migration notes.** Describe what the client must handle; don't prescribe their internal architecture.

## Step 3 — Verify before handing off

1. Re-read each documented operation against the actual code one final time — signatures drift during writing.
2. Grep the diff for API-relevant files you did NOT document and confirm each is genuinely client-invisible (internal refactor, tests, comments).
3. Confirm every **breaking** flag: would an unmodified existing client call still succeed? If unsure, mark it breaking — false alarms are cheaper than silent breakage.
4. Exercise at least one added/changed endpoint against a locally running instance when feasible, and paste the real (redacted) response into the doc's example.
5. Report the doc path to the user, flag the breaking-change count, and remind them `{{CLIENT_HANDOFF_DIR}}` may be gitignored — share or commit the file deliberately so it actually reaches the client teams.

## Pitfalls

- **Documenting the plan instead of the code.** Plans drift during implementation; the diff is the truth. Always derive shapes from what actually merged into the branch.
- **Missing error-shape changes.** Clients parse error bodies too. A changed error envelope breaks clients just as hard as a changed success payload.
- **"Non-breaking" by wishful thinking.** A field that changed from `string` to `string | null` breaks any client that never null-checks. Judge breakage from the strictest plausible client, not the friendliest.
- **Serializer-level changes hidden behind unchanged routes.** A diff can change a response shape without touching any route file — sweep serializers/schemas/DTOs even when the route list looks untouched.
- **Stale doc after review fixes.** If review feedback changes the API after the handoff was written, regenerate the doc — a superseded handoff to clients is worse than none.

## Verification

- The doc exists under `{{CLIENT_HANDOFF_DIR}}/`, is scoped-and-dated, and every API-relevant file in the diff is either documented or consciously excluded.
- Every breaking change appears in the **Breaking changes** section, not only in its per-operation entry.
- A client engineer with zero access to this repo could implement every documented change from the doc alone.
