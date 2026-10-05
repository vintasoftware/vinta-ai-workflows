---
name: interview-ui
description: Run an agent interview as a full-screen browser form instead of a chat exchange. The agent writes one round at a time as JSON (`interview-round.v1`) plus Markdown/Mermaid or HTML explainer docs; the bundled zero-dependency Node server (`scripts/interview-ui.mjs`) serves the shell (`resources/index.html`), the user answers one decision per screen with context, diagrams, and per-option consequences in view, and the server writes the answers back as JSON (`interview-answers.v1`) and unblocks the agent. The chat panel inside the UI is for questions to the agent, not decisions. Used by `create-spec` for its Step 0 interview when the user prefers the browser; reusable by any skill with a decision-heavy interview. Use when a user says "open the interview in the browser", "I want to see the options properly", "walk me through the decisions in a UI", or when a skill delegates its interview here.
---

# Interview UI

Chat is a poor surface for deciding. Options arrive as one-line labels, the context that makes them meaningful scrolled away three messages ago, and a diagram is impossible. This skill moves the **decisions** of an interview into a browser form where each decision owns the whole screen: what the agent already knows, an explanation with diagrams, the options as cards with their consequences, and the agent's recommended default marked. The chat that remains inside the UI is for **questions** — the user asks, the agent answers in the next round.

The protocol is round-based and file-based, so it works identically under Claude Code, Codex, Cursor, and Copilot: nothing in the browser talks to the agent directly. The agent writes a round, blocks on a `wait` command, and resumes when the answers file lands.

```
<interview-dir>/
├── rounds/round-01.json     ← agent writes   (interview-round.v1)
├── answers/round-01.json    ← browser writes (interview-answers.v1), via the server
├── docs/**.md | **.html     ← agent writes explainer docs the round references
└── server.json              ← pid + url of the running server (managed by the script)
```

Default `<interview-dir>`: `.vinta-ai-workflows/interviews/<slug>/` — the gitignored per-machine state dir the toolchain already uses. The durable artefact is whatever the calling skill produces (the spec, the plan); the interview files are the working trail. Keep them until the artefact is written and confirmed, then leave them — they are cheap and useful when the artefact is questioned later.

## Requirements

- Node ≥ 18 on the machine running the agent. The server imports only `node:*` modules.
- A browser on the same machine. The server binds `127.0.0.1` only and never accepts remote connections.
- Network access from the browser for the shell's renderer libraries (`marked`, `DOMPurify`, `mermaid` from cdnjs). Offline, the shell still renders every decision and option; Markdown falls back to preformatted text and diagrams show their source.

## Protocol

### 0. Decide the surface

Only when the calling skill hasn't already decided. `AskUserQuestion`: *"Where do you want to make the interview decisions?"* with options `In the browser (one decision per screen, with diagrams)` and `Here in chat`. Browser requires the agent to be able to run Node and the user to have a browser on this machine; if either is in doubt, say so and default to chat.

### 1. Start the server once per interview

```bash
node ai-tools/skills/interview-ui/scripts/interview-ui.mjs start --dir .vinta-ai-workflows/interviews/<slug>
```

Prints the URL and tries to open the default browser (`--no-open` to skip). Re-running `start` on a live server is a no-op that reprints the URL. Tell the user the URL in chat as well — the browser may not open in a sandboxed session. `--port N` pins a port; default is random.

### 2. Write a round

Author `rounds/round-NN.json` against [`interview-round.v1`](https://github.com/vintasoftware/vinta-ai-workflows/blob/main/schemas/interview-round.v1.schema.json). `NN` is two-digit, 1-based. A round is the unit the user submits; keep each round to what you can ask without the answers to it (the create-spec groups A–C in round 1, D–F in round 2 once the journeys are known, and so on). Never put every question in one round — the form makes that tempting and it is worse than chat.

Per decision, fill in:

- **`title`** — the question as a full sentence. **`short`** — rail label.
- **`why`** — one sentence on why it matters. For create-spec this is the `*Why:*` line of the question bank.
- **`context`** — Markdown. Quote back the user's earlier answers that bear on this decision ("Your journey in A2 has tags edited from the order page **and** the bulk import"). Add repo facts you found. Use a Mermaid fence when the situation is a flow or a state machine.
- **`explainer`** — when the options need more than a sentence each to be chosen well. Inline Markdown for a few paragraphs; `{ "path": "docs/<id>-<topic>.md" }` for a comparison table plus a sequence diagram; `{ "path": "docs/<id>.html" }` only when Markdown cannot express the layout (rendered in a sandboxed iframe).
- **`input.options[]`** — every option carries `label`, `description`, and **`consequences`**: what picking it implies downstream — a new plan phase, a one-way door, a dependency on another team, a cost. Mark the default with `recommended: true` (at most one). Use `tags` for the one-glance signal (`{label: "One-way door", tone: "warn"}`). Set `allow_other: true` when the list might be incomplete.
- **`input.type`** — `single`, `multi`, `text`, or `confirm`. Use `text` only for genuinely open answers (the problem narrative, a journey walk-through). Everything with a finite answer set gets options, same rule as `AskUserQuestion` in chat.
- **`waivable`** — leave on (default) so the user can mark a decision not applicable; the answer comes back as `waived`, which is an explicit out-of-scope signal, not an unknown.

Round-level: **`intro`** says what this round is about and what changed. **`replies[]`** answers every question the user asked in the previous round's `questions[]` — quote the question, answer in Markdown, set `decision_id` so it shows next to the decision. If an answer could change a decision already made, re-ask that decision in this round with the new information in its `context`.

See [resources/examples/round-01.json](resources/examples/round-01.json) and [resources/examples/docs/D4-concurrency.md](resources/examples/docs/D4-concurrency.md) for a complete round with an explainer document.

### 3. Block until the round is submitted

```bash
node ai-tools/skills/interview-ui/scripts/interview-ui.mjs wait --dir .vinta-ai-workflows/interviews/<slug> --round NN --timeout 3600
```

Exits `0` and prints the answers path when `answers/round-NN.json` appears; `124` on timeout (default one hour — raise it for long rounds, or re-run `wait`); `1` when the round file is missing or the server is not running. Say in chat, before waiting: *"Round NN is ready at `<url>`. I'll continue when you submit it."* Nothing else — the decisions happen in the browser.

The shell saves drafts in the browser, so a reload or a closed tab loses nothing before submission.

### 4. Read the answers and loop

Read `answers/round-NN.json` ([`interview-answers.v1`](https://github.com/vintasoftware/vinta-ai-workflows/blob/main/schemas/interview-answers.v1.schema.json)). Then apply the calling skill's clarity loop exactly as it would in chat:

- `answered` → a decision. `values` holds option values; `other` holds free text from "Something else"; `text` holds free-form answers; `note` holds nuance the user attached — quote it, don't paraphrase it away.
- `waived` → explicitly not applicable. Record it as negative scope or "n/a", never as an open question.
- `skipped` → left open. Only `required: false` decisions can come back this way. Treat as **Open questions** material or re-ask.
- `questions[]` → every one gets a `replies[]` entry in the next round. A question is often a signal that the options or the context were not enough; improve the explainer, don't just answer in a sentence.
- `general_note` → carry into the artefact.

Scan for gaps (contradictions, follow-ups one answer surfaces, decisions another decision depends on) and write the next round. Repeat until the calling skill's exit conditions hold.

### 5. Read-back round

The last round has `"kind": "readback"`: a `summary` in Markdown of every load-bearing decision, plus one `confirm` decision with the options the calling skill uses (for create-spec: `Looks good`, `Some corrections (I'll list)`, `More to clarify`, `Stop, rethink`) and `allow_other: true` so corrections can be typed in place. Only draft when the confirm comes back as the "go" option.

### 6. Stop the server

```bash
node ai-tools/skills/interview-ui/scripts/interview-ui.mjs stop --dir .vinta-ai-workflows/interviews/<slug>
```

After the artefact is written. `status` prints the server state and which rounds are answered, useful when resuming an interrupted interview: start the server again, and `wait` on the first unanswered round.

## Shell behaviour the agent can rely on

- One decision per screen; the left rail lists every group and decision with done / waived / open state and lets the user go back and change an earlier answer before submitting.
- Submit is refused while a `required` decision is neither answered nor waived; the shell jumps to the first open one.
- Submitted rounds stay viewable read-only; the shell switches to the next round on its own when the agent writes it (server-sent events, with polling as fallback).
- Markdown renders with GitHub-flavoured tables and Mermaid fences; HTML explainers render in a sandboxed iframe (`allow-scripts`, no same-origin). Everything passes through DOMPurify.
- Light and dark themes follow the OS.

## Pitfalls

- **Dumping the whole question bank into round 1.** The form removes the friction that kept chat rounds small; keep them small anyway. Later groups depend on earlier answers, and the context you quote back is what makes the screens worth having.
- **Options without consequences.** A card that says only "Optimistic lock" is the chat experience with more pixels. The `consequences` line is the point.
- **Answering a user question in one sentence when the explainer was the problem.** If they had to ask, the screen did not explain enough. Fix the screen and re-ask.
- **Treating `waived` as unknown.** It is the user saying "not applicable". Put it in negative scope.
- **Writing `round-2.json`.** Two digits: `round-02.json`. The server lists only `round-NN.json`.
- **Explainer paths outside `docs/`.** The server refuses them. Keep docs under `<interview-dir>/docs/` and reference them as `docs/<file>`.
- **Forgetting to tell the user the URL.** In headless or sandboxed sessions the browser does not open on its own.
- **Leaving the server running across interviews.** One server per interview dir; `stop` when the artefact is written.

## Verification

- `node ai-tools/skills/interview-ui/scripts/interview-ui.mjs status --dir <interview-dir>` shows `alive: true` and the expected rounds with `answered` flags.
- `curl -s http://127.0.0.1:<port>/api/rounds/1 | head` returns the round JSON you wrote; a `404` means the filename is wrong.
- The answers file validates against `interview-answers.v1` (`ajv validate -s schemas/interview-answers.v1.schema.json -d answers/round-01.json` when `ajv-cli` is available).
