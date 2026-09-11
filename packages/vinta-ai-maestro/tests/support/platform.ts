/**
 * One flag, one reason, one thing to grep for — and it now guards exactly one
 * test.
 *
 * This constant used to be called `POSIX_SHELL_FIXTURES` and stood in front of
 * sixteen `describe` blocks, because most of this suite's fixtures were written
 * in `sh`: a CLI stood up as a `#!/bin/sh` script, a gate driven with
 * `sleep 60 & echo $!`. Eighty tests were skipped on Windows, which is to say
 * the adapters, the gate runner, `doctor`, the composed `run` and the whole of
 * takeover were unverified on a platform this package claims to support.
 *
 * That is gone. Fixtures are declared as data and rendered for whichever
 * platform is running — `support/fake-cli.ts` for a stand-in executable,
 * `support/gate-script.ts` for a gate command line — so every one of those
 * blocks is unconditional.
 *
 * What is left is not a fixture problem, which is why the name changed. A fake
 * CLI on Windows can only be a `.cmd` shim: that is the executable form a Node
 * program takes, and it is what npm itself generates for a package `bin`.
 * Every spawn in this package routes through `commandInvocation`
 * (`src/platform/platform.ts`) so a `.cmd` works — **except**
 * `openPullRequest`, which hands `ghPath` to `execFile` directly. Since
 * CVE-2024-27980 Node refuses to spawn a `.bat` or `.cmd` without `shell`, so
 * on Windows there is no way to point that function at a fixture.
 *
 * It is not a bug in the product as shipped: a real `gh` is `gh.exe` there and
 * resolves without a shell. And the obvious repair — route it through the seam
 * like everything else — is worse than the gap, for the reason spelled out
 * above the test itself in `integration.test.ts`: one of `gh`'s arguments is
 * the pull request body, `shellQuote` refuses `"` and `%` because `cmd.exe`
 * cannot escape either, and a spawn that cannot be broken by its own payload
 * would become one that can.
 *
 * Nothing else in the suite may skip by platform. Behaviour that genuinely
 * differs is decided by `src/platform/platform.ts`, which takes the platform as
 * a parameter, and is asserted on both branches from either kind of machine in
 * `tests/platform.test.ts`.
 */
export const FAKE_BIN_VIA_EXECFILE = process.platform !== 'win32'
