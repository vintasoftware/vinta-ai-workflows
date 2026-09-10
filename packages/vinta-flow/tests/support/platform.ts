/**
 * One flag, one reason, one thing to grep for.
 *
 * A large part of this suite is written in POSIX shell. It stands a CLI up by
 * writing a `#!/bin/sh` script and handing its path to an adapter as `bin`, and
 * it drives the gate runner with lines like `sleep 60 & echo $!`. Both are the
 * right fixture on POSIX — they are what the real thing is — and neither can
 * run on Windows: `CreateProcess` does not read shebangs, and `cmd.exe` shares
 * no syntax worth the name with `sh`. The tests that use one are therefore
 * skipped there rather than failed, through this constant rather than through
 * a scattering of `process.platform` checks, so `POSIX_SHELL_FIXTURES` is the
 * exact list of what the Windows CI job does not yet cover.
 *
 * This is a gap in the fixtures, **not** a statement that the code under them
 * is POSIX-only. Closing it means making the fixtures declarative — a spec the
 * helper renders as an `sh` script or a `.cmd` batch file — at which point this
 * constant and every `runIf` that reads it come out.
 *
 * Nothing else in the suite may skip by platform. Behaviour that genuinely
 * differs is decided by `src/platform/platform.ts`, which takes the platform as
 * a parameter, and is asserted on both branches from either kind of machine in
 * `tests/platform.test.ts`.
 */
export const POSIX_SHELL_FIXTURES = process.platform !== 'win32'
