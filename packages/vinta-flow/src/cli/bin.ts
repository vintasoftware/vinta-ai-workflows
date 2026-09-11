#!/usr/bin/env -S node --experimental-transform-types --disable-warning=ExperimentalWarning
/**
 * The executable. One job: turn `main`'s exit code into the process's.
 *
 * The shebang asks for `--experimental-transform-types`, not the cheaper
 * `--experimental-strip-types`: this package's harness adapters use TypeScript
 * parameter properties (`constructor(readonly id: string)`), which strip-only
 * mode refuses outright. Vitest transpiles, so the suite never notices; a
 * shipped binary would notice immediately. The alternative is a build step,
 * which this package does not have yet — `tsconfig.json` is `noEmit`.
 *
 * `process.exit` rather than `process.exitCode` because `serve` and `run` bring
 * up a daemon, and even after `close()` a stray keep-alive socket or a SQLite
 * handle can hold the event loop open long enough for the shell to look hung.
 * The commands have already awaited their own teardown by the time this runs,
 * so there is nothing left to flush but a decision.
 */
import { FAILED, main } from './index.ts'

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  () => {
    // Nothing above this frame should throw — every command turns its failures
    // into an exit code. If one escapes, the stack is not the operator's
    // problem and may quote a path or a file's contents; the code is enough.
    process.stderr.write('vinta-flow: internal error\n')
    process.exit(FAILED)
  },
)
