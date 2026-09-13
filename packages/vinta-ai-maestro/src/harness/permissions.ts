/**
 * How much an agent may do without being asked, and who decides.
 *
 * Every adapter declared `permissionControl: true` and passed no policy at all.
 * claude-code's invocation was `-p --output-format stream-json …` with no
 * `--permission-mode`; codex's was `exec --json` with no `--sandbox` and no
 * approval flag, under a comment saying it takes both on the command line. The
 * result was a headless run in which the agent asks, a `permission_request`
 * event is emitted, the transcript renders it — and nothing anywhere answers.
 * Every write is refused and the phase fails reporting a permission system it
 * cannot see.
 *
 * **The operator chooses this, not the plan.** It is passed at invocation
 * rather than read out of the workflow document, and that is deliberate: the
 * document is committed and shared, and a file in a repository should not be
 * able to tell someone else's machine to run agents without approvals. What a
 * plan may safely say is which model writes a phase; what it may not say is how
 * much of a stranger's filesystem that model may have.
 *
 * The vocabulary is ours, not any vendor's. Each adapter translates it into its
 * own flags, because the two CLIs disagree about almost everything here: one
 * has a permission *mode* and the other a *sandbox* plus an approval policy.
 */

export const AGENT_PERMISSIONS = ['ask', 'auto', 'full'] as const

export type AgentPermission = (typeof AGENT_PERMISSIONS)[number]

/**
 * `ask` — every tool use needs approval.
 *
 * The CLIs' own defaults, and the only setting that is safe when a human is
 * watching and wrong when nobody is. Kept because `serve` with an operator at
 * the browser is a real mode, and because it is what the adapters did before
 * this existed — a run that used to hang now at least hangs by request.
 */

/**
 * `auto` — the default. The agent works unattended inside its lane.
 *
 * A lane is a disposable worktree with its own branch and its own databases, so
 * writing in it freely is the thing the whole design is for. This is the
 * narrowest setting under which an unattended run can actually finish.
 */

/**
 * `full` — no checks at all.
 *
 * Both vendors describe their equivalent as being for sandboxes with no
 * internet access, and a lane is not that: it has the network and whatever
 * credentials the machine holds. Available because an externally sandboxed CI
 * box is a real place to want it, never a default, and never selectable from a
 * committed document.
 */

export const DEFAULT_PERMISSION: AgentPermission = 'auto'

export function isAgentPermission(value: unknown): value is AgentPermission {
  return (AGENT_PERMISSIONS as readonly unknown[]).includes(value)
}

/**
 * claude-code's `--permission-mode`, plus the opt-in its blunt setting needs.
 *
 * **`auto` is not the mode named "auto".** The vendor's `auto` still routes a
 * write to a permission prompt, and in `-p` there is nobody to answer one, so
 * every `Write` came back denied with no reason attached — the same dead end
 * this file was written to close, wearing the word that made it look closed.
 * `acceptEdits` is the mode that actually lets an unattended agent write, and
 * the pair was run against the CLI rather than read from its help text: under
 * `auto` a write to the agent's own working directory is refused, under
 * `acceptEdits` it succeeds.
 *
 * The lesson is the naming: our vocabulary and the vendor's collide on a word
 * and mean different things by it, which is exactly why this file translates
 * instead of passing ours through.
 *
 * `bypassPermissions` is refused by the CLI unless the session was started with
 * `--allow-dangerously-skip-permissions`, so `full` has to pass both — asking
 * for the mode without enabling it is a spawn that fails at the vendor rather
 * than a policy that applies.
 */
export function claudeCodeArgs(permission: AgentPermission): readonly string[] {
  switch (permission) {
    case 'ask':
      return ['--permission-mode', 'manual']
    case 'auto':
      return ['--permission-mode', 'acceptEdits']
    case 'full':
      return ['--allow-dangerously-skip-permissions', '--permission-mode', 'bypassPermissions']
  }
}

/**
 * codex's sandbox, or its automatic-approval mode — never both.
 *
 * `--approve-for-me` and `--sandbox` are mutually exclusive: the CLI refuses
 * the pair outright ("the argument '--sandbox <SANDBOX_MODE>' cannot be used
 * with '--approve-for-me'"), because `--approve-for-me` *is* automatic review
 * running under the workspace-write sandbox. Passing both looks like belt and
 * braces and is a spawn that dies before the model is reached.
 *
 * `workspace-write` is the sandbox that matches a lane — the agent's own
 * checkout and nothing above it.
 */
export function codexArgs(permission: AgentPermission): readonly string[] {
  switch (permission) {
    case 'ask':
      return ['--sandbox', 'workspace-write']
    case 'auto':
      // Implies the workspace-write sandbox; naming it too is refused.
      return ['--approve-for-me']
    case 'full':
      return ['--dangerously-bypass-approvals-and-sandbox']
  }
}

/**
 * The same policy for `codex exec resume`, which takes a different set.
 *
 * `resume` accepts neither `--sandbox` nor `--approve-for-me` — it rejects them
 * as unexpected arguments — and accepts only the bypass flag. So `ask` and
 * `auto` pass nothing and the resumed thread keeps the policy it was created
 * under, which is the behaviour the subcommand's argument list implies.
 *
 * `full` is still passed, because it is the one whose absence would be a
 * surprise: a run told to skip every check would otherwise silently start
 * asking again the moment a session was continued.
 */
export function codexResumeArgs(permission: AgentPermission): readonly string[] {
  return permission === 'full' ? ['--dangerously-bypass-approvals-and-sandbox'] : []
}
