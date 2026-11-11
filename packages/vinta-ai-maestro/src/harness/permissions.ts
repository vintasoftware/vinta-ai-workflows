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

export const AGENT_PERMISSIONS = ['ask', 'auto', 'full', 'judged'] as const

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

/**
 * `judged` — `full`, with a System One classifier asked about every call to a
 * judged tool before it runs (§17.6).
 *
 * The trade is speed for a check: the vendor's own prompt is gone, so nothing
 * stops for a human, and each judged call costs one classifier round trip
 * instead. What it is *not* is a sandbox. A classifier reads one command line
 * and cannot see what a script it names will do, so `judged` narrows `full`
 * rather than approaching `auto`. It needs `--system-one` with a `permission`
 * judge, and only claude-code can host it — the check is a `PreToolUse` hook,
 * which neither codex nor opencode offers — so `doctor` refuses it for a plan
 * that dispatches anywhere else. **Fails closed**: a hook that cannot reach the
 * daemon, a classifier that cannot answer, and a settings file that cannot be
 * written all end in a refusal, never in an unchecked call.
 */

export const DEFAULT_PERMISSION: AgentPermission = 'auto'

/** The harnesses that can host `judged`. */
export const JUDGED_HARNESSES: readonly string[] = ['claude-code']

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
    case 'judged':
      // `judged` runs unprompted too: the check is the hook the settings file
      // installs (`claude-code.ts`), not the vendor's prompt.
      return ['--allow-dangerously-skip-permissions', '--permission-mode', 'bypassPermissions']
  }
}

/**
 * What a codex thread is started — and resumed — under: a sandbox, an
 * approval policy, and who reviews the approvals.
 *
 * The app server takes all three as `thread/start` and `thread/resume`
 * parameters, so they are stated in full on every spawn. Stating them all is
 * deliberate: anything left out falls back to the user's `config.toml`, and a
 * machine whose config routes approvals to `auto_review` would quietly turn
 * `ask` into `auto`.
 *
 * `auto` is the CLI's `--approve-for-me`, spelled out: that flag *is*
 * `approvals_reviewer = "auto_review"` with `approval_policy = "on-request"`
 * under the workspace-write sandbox (it sets exactly those three overrides).
 * Commands inside the lane run; an escalation goes to codex's own reviewer
 * rather than to a person, so an unattended lane neither stalls nor widens
 * without a check.
 *
 * `ask` is the same sandbox with the requests routed to the client, which
 * answers each one by recording a `permission_request` and declining it
 * (`codex.ts`). Under `exec` the CLI forced `never` and the model was not
 * allowed to ask; now it may, and the transcript shows what it asked for —
 * which is what a human watching an `ask` run is there to see. Nothing that
 * was refused before is allowed now.
 *
 * `full` is `--dangerously-bypass-approvals-and-sandbox`: no sandbox, never
 * ask. `judged` has no per-call hook to judge with on codex, and `doctor`
 * refuses the pairing; reaching here anyway gets `ask`, the narrowest policy,
 * rather than the widest — the wrong way round would be silent.
 *
 * `workspace-write` is the sandbox that matches a lane — the agent's own
 * checkout and nothing above it.
 */
export interface CodexThreadPolicy {
  readonly sandbox: 'workspace-write' | 'danger-full-access'
  readonly approvalPolicy: 'on-request' | 'never'
  readonly approvalsReviewer: 'user' | 'auto_review'
}

export function codexThreadPolicy(permission: AgentPermission): CodexThreadPolicy {
  switch (permission) {
    case 'auto':
      return { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' }
    case 'full':
      return { sandbox: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' }
    case 'ask':
    case 'judged':
      return { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' }
  }
}
