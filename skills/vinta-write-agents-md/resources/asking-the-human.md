# Canonical `## Asking the human` section

[vinta-write-agents-md](../SKILL.md) renders the block between the markers below **verbatim** into the target project's root `AGENTS.md`. Every vendor loads that file on every session, so this one section governs every skill, sub-agent, and ad-hoc conversation in the project. [vinta-sync-ai-tools](../../vinta-sync-ai-tools/SKILL.md) adds it to projects bootstrapped before it existed.

The `vinta-*` bootstrap skills follow the same protocol while they run. They run before the target's `AGENTS.md` exists, so they link here instead.

Skills name the tool `AskUserQuestion`, which is Claude Code's name for it. The table maps that name to each harness.

<!-- asking-the-human:start -->
## Asking the human

When you need a decision or an answer from the human, ask with your harness's **structured question tool**. The tool renders the question as clickable options with a free-text field, so the human can answer in one click without searching the transcript. Never end a turn with a question buried in prose.

| Harness | Tool | Notes |
|---|---|---|
| Claude Code | `AskUserQuestion` | Main session only. Sub-agents cannot call it. |
| OpenCode | `question` | On for the `build` and `plan` agents. Other agents need `"permission": { "question": "allow" }` in `opencode.json`. |
| OpenAI Codex | `request_user_input` | Plan mode by default. To use it in Default mode, set `[features] default_mode_request_user_input = true` in `~/.codex/config.toml`. Not available in `codex exec`. Sub-agents cannot call it. |
| Cursor | `AskQuestion` | Reliable in Plan mode. In Agent mode it may be missing. |
| VS Code Copilot | `askQuestions` (`#tool:vscode/askQuestions`) | Built in. |
| Gemini CLI | `ask_user` | Interactive mode. |

Skills in this repo call the tool `AskUserQuestion`. Read that as "my harness's structured question tool" and use the matching name above.

**Shape every question so it can be answered from the prompt alone:**

1. **Lead with the context.** The question says what is blocked and gives the evidence needed to decide, such as `file:line`, the package name, or the failing command. Put long detail in the message above the question, not in the options.
2. **Give 2–4 concrete options.** Each option is an action. Its label has 1–5 words, and its description says what happens if it is picked. Put the recommended option first and end its label with ` (Recommended)`. Codex accepts 3 options at most, so keep the most useful 3 first.
3. **Do not add an "Other" option.** Every harness adds a free-text field. That field is the escape hatch for any answer you did not list.
4. **Keep the header short.** It is a 12-character label for the chip, such as `License`, `Plan file`, or `Next step`.
5. **Batch independent questions.** Put up to 4 questions in one call (3 on Codex). Ask a dependent question only after the answer it depends on.
6. **Offer candidates for open answers too.** For a path, a name, or a plan file, list the 2–4 most likely candidates you found, and the free-text field covers the rest. Use plain prose only when you cannot propose a single candidate, such as "describe the problem in your words". Ask that prose question alone, as the last line of the message.
7. **Turn confirmation gates into questions.** Never write "reply *go* to continue". Ask instead, with options such as `Start`, `Change options`, and `Cancel`.
8. **Don't ask what you can find.** Check the code, the config, the plan, and earlier answers first. Ask only for decisions the human owns.

**Sub-agents cannot reach the human.** A question written into a sub-agent's report is lost in the transcript. When a sub-agent hits a decision it should not make alone, it stops at a clean point and returns `status: NEEDS_INPUT` with a `questions:` block in the same shape as the tool input:

```yaml
status: NEEDS_INPUT
blocked_on: <one line: the decision needed>
done_so_far: <one line: what is finished, and which files it touched>
questions:
  - header: License
    question: "`left-pad` declares no license (npm `license` field is empty). How should I proceed?"
    multi_select: false
    options:
      - label: Find alternative (Recommended)
        description: Skip left-pad and use an MIT or Apache-2.0 package instead.
      - label: Treat as forbidden
        description: Do not install it. Implement the helper inline.
```

The orchestrator that spawned the sub-agent passes the `questions:` block to the structured question tool unchanged. Then it resumes the same sub-agent with the answers, or spawns a new one whose prompt adds an `## Answers from the human` section. It never answers on the human's behalf.

**No tool available?** This happens in a headless run, in a harness without the tool, or when a call errors. Then end the message with the same questions as a numbered list, one option per line with the recommended option first, followed by "Reply with the option number, or type your own answer." In a headless run with no human at all, stop and report `NEEDS_INPUT` instead of guessing.
<!-- asking-the-human:end -->
