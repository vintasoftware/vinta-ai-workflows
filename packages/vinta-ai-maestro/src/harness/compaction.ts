/**
 * Context compaction: keeping a long phase alive when its window fills.
 *
 * The thing worth knowing before reading any of this is that **all three
 * vendors already compact by default**, and the investigation that produced
 * this file expected the opposite. There is no flag to switch it on, because
 * there is nothing to switch on:
 *
 * - claude-code compacts unless something turns it off. Its own kill switches
 *   are what prove the default — `DISABLE_AUTO_COMPACT` and `DISABLE_COMPACT`
 *   are environment variables and `autoCompactEnabled` a setting, all three
 *   phrased as ways to *stop* it. Verified against the shipped 2.1.236 binary,
 *   which carries every one of those identifiers.
 * - codex compacts unless something turns it off, and ships no way to turn it
 *   off at all: no flag, no environment variable, and the only related config
 *   key sets a *threshold* rather than a switch. Its own system prompt tells
 *   the model "when you run out of context, the conversation is automatically
 *   summarized for you", which is the vendor stating the default outright.
 * - opencode compacts unless `compaction.auto` is `false` in its config or
 *   `OPENCODE_DISABLE_AUTOCOMPACT` is set in its environment.
 *
 * So this module is not an enabler. **It is a guard against inheriting a
 * machine's decision to turn the feature off**, which is a different and much
 * narrower job. A daemon that runs unattended for hours is exactly the caller
 * that cannot afford to find out at hour three that the operator's shell had
 * `DISABLE_AUTO_COMPACT=1` exported from some unrelated afternoon of debugging.
 * Every child this package spawns inherits `process.env` (`shared.ts`'s
 * `childEnv`), so without the lists below that variable reaches every agent in
 * every lane, and the only symptom is a phase that dies of a full context
 * window with nothing in the record explaining why.
 *
 * **What is deliberately not here is a threshold.** Each vendor's default
 * window tracks the model's own context size, and a number written down in
 * this repository does not: pinning claude-code's `--autocompact` or codex's
 * `model_auto_compact_token_limit` to a constant would make compaction fire at
 * the wrong point on every model but the one the constant was chosen for. The
 * vendors' defaults are better informed than ours can be, and the failure this
 * package is protecting against is compaction *not happening*, never
 * compaction happening at a slightly different token count than we would pick.
 *
 * Nothing here carries prompt text, repository content or a credential. These
 * are variable names and one boolean (§11).
 */

/**
 * claude-code's compaction kill switches, removed from every child's
 * environment.
 *
 * Two variables rather than one because they are not the same switch and
 * stripping only the obvious one would leave the hole open.
 * `DISABLE_AUTO_COMPACT` stops automatic compaction and leaves the manual
 * `/compact` available; `DISABLE_COMPACT` stops compaction entirely. A headless
 * turn has nobody to type `/compact`, so under either one a full window is a
 * dead phase, and the second is the one a reader is most likely to forget.
 *
 * Stripped rather than overridden to an "off" value: `childEnv` deletes keys,
 * and an absent variable is what the vendor's own default reads.
 */
export const CLAUDE_CODE_COMPACTION_ENV = ['DISABLE_AUTO_COMPACT', 'DISABLE_COMPACT'] as const

/**
 * opencode's single compaction kill switch.
 *
 * Its config file can also say `compaction.auto: false`, and that one is *not*
 * covered here — see `OPENCODE_CONFIG_CAVEAT`. This variable is the half the
 * adapter can actually reach, because it owns the environment it starts the
 * server in and does not own the project's `opencode.json`.
 */
export const OPENCODE_COMPACTION_ENV = ['OPENCODE_DISABLE_AUTOCOMPACT'] as const

/**
 * The settings claude-code's per-lane policy file asserts, beyond permissions.
 *
 * `autoCompactEnabled` is reasserted rather than left to the default because
 * the default is the one thing a user's own `settings.json` can quietly
 * contradict, and the adapter already passes a `--settings` file that layers
 * on top of it. Stripping the environment variables closes one of the two ways
 * compaction gets turned off on a machine; this closes the other.
 *
 * It is a boolean and not a window, for the reason the module docstring gives:
 * a user who narrowed their window compacts *earlier*, which cannot cause the
 * failure this is guarding against, so overriding that choice would cost them
 * something and buy nothing.
 *
 * **What was checked, and what was not.** Two things were run against the real
 * 2.1.236 binary. The key is genuinely one the CLI reads — the identifier is in
 * the shipped binary, where an invented one is not. And adding it cannot break
 * the rest of the file: a settings file carrying an unrecognised top-level key
 * is still honoured in full, confirmed by giving one a deliberately nonsense
 * key alongside `permissions.allow: ["Bash"]` and watching the shell command
 * run anyway. That last point mattered more than it looks, because `-p` ignores
 * an invalid settings file *silently*, and a key that had invalidated the file
 * would have taken this adapter's permission rules down with it.
 *
 * What was not checked is the only thing that cannot be: that `false` here
 * actually suppresses a compaction, which would need a context window filled on
 * purpose to observe. So the tolerance above cuts both ways — if the vendor
 * ever renames this key, nothing will fail, and this line will quietly stop
 * doing anything. It is the belt, not the braces: the environment strip is the
 * mechanism with a test that fails when it regresses.
 */
export const CLAUDE_CODE_COMPACTION_SETTINGS = { autoCompactEnabled: true } as const

/**
 * What the `autoCompact` capability does not promise for opencode.
 *
 * opencode reads `compaction.auto` from `opencode.json` in the project or
 * `~/.config/opencode/`, and this adapter writes neither file — the same
 * boundary that already makes its `permissionControl` false. A project that
 * has explicitly set `compaction.auto: false` gets that, and the daemon cannot
 * see it, let alone override it. Stated as an exported constant rather than a
 * comment so the test that pins this honesty has something to name.
 */
export const OPENCODE_CONFIG_CAVEAT =
  'opencode reads compaction.auto from its own config files, which this adapter does not write'
