/**
 * The `vinta-ai-maestro` command line.
 *
 * Seven subcommands, dispatched by hand. `node:util`'s `parseArgs` does the flag
 * parsing inside each one, and nothing else does any: a framework here would be
 * a dependency, a plugin lifecycle and a help renderer bought to replace a
 * switch statement over seven strings.
 *
 * `main` returns an exit code rather than calling `process.exit`. That is what
 * makes the commands testable without a built binary, and it keeps the one
 * place that ends the process — `bin.ts` — down to a single line. Commands use
 * three codes so a script can tell the cases apart: `0` success, `1` the
 * command ran and the answer was no, `2` the command line itself was wrong.
 * `with` and `gate` are the exceptions: both pass through the exit code of the
 * thing they ran, because a caller asking whether the gate passed wants the
 * gate's answer and not this process's opinion of how the request went.
 */
import { OK, USAGE, processIo, type Io } from './io.ts'
import { DOCTOR_USAGE, doctorCommand } from './doctor.ts'
import { GATE_USAGE, gateCommand } from './gate.ts'
import { PURGE_USAGE, purgeCommand } from './purge.ts'
import { RUN_USAGE, runCommand } from './run.ts'
import { SERVE_USAGE, serveCommand } from './serve.ts'
import { SIMULATE_USAGE, simulateCommand } from './simulate.ts'
import { WITH_USAGE, withCommand } from './with.ts'

export const HELP = `vinta-ai-maestro — code-orchestrated parallel execution of a plan.

usage: vinta-ai-maestro <command> [options]

  doctor <workflow.json>     Preflight every check a run depends on, and exit
                             non-zero if a run cannot start.
  simulate <workflow.json>   Project the schedule without running it: wall
                             clock, critical path and pool contention.
  serve                      Start the daemon and print the URL to open.
  run <workflow.json>        Start the daemon and execute the workflow.
  purge [run-id]             Delete run state under .vinta-ai-maestro/ — transcripts
                             and gate logs hold repository contents verbatim.
  with <resource> -- <cmd>   Run a command while holding a live run's resource.
  gate <gate-id>             Run one of a live run's declared gates against this
                             turn's lane, leased and cached by the daemon.

  -h, --help                 Print this.

Run \`vinta-ai-maestro <command> --help\` for a command's own options.`

/**
 * Each command's own usage text, so `--help` is answered before `parseArgs`
 * ever sees it. Left to `parseArgs`, `--help` is an unknown option and exits
 * 2 — technically a usage error, and exactly the wrong answer to someone
 * asking what the options are.
 */
const USAGES: Readonly<Record<string, string>> = {
  doctor: DOCTOR_USAGE,
  simulate: SIMULATE_USAGE,
  serve: SERVE_USAGE,
  run: RUN_USAGE,
  purge: PURGE_USAGE,
  with: WITH_USAGE,
  gate: GATE_USAGE,
}

export async function main(argv: readonly string[], io: Io = processIo()): Promise<number> {
  const [command, ...rest] = argv

  if (command === undefined) {
    // No command is a usage error, not a request for help: exiting zero here
    // would let `vinta-ai-maestro` succeed having done nothing.
    io.err(HELP)
    return USAGE
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    io.out(HELP)
    return OK
  }

  const usage = USAGES[command]
  if (usage !== undefined && rest.some((arg) => arg === '--help' || arg === '-h')) {
    io.out(usage)
    return OK
  }

  switch (command) {
    case 'doctor':
      return await doctorCommand(rest, io)
    case 'simulate':
      return await simulateCommand(rest, io)
    case 'serve':
      return await serveCommand(rest, io)
    case 'run':
      return await runCommand(rest, io)
    case 'purge':
      return await purgeCommand(rest, io)
    case 'with':
      return await withCommand(rest, io)
    case 'gate':
      return await gateCommand(rest, io)
    default:
      // The unknown word is echoed back because a typo is the likely cause and
      // seeing it is how the reader spots one. It is an argument, never a path
      // read from disk, so nothing from the repository is in this line.
      io.err(`vinta-ai-maestro: unknown command "${command}"`)
      io.err('')
      io.err(HELP)
      return USAGE
  }
}

export { OK, FAILED, USAGE, processIo, type Io } from './io.ts'
export { doctorCommand } from './doctor.ts'
export { simulateCommand } from './simulate.ts'
export { serveCommand, announce, type ServeDeps } from './serve.ts'
export { runCommand, type RunDeps } from './run.ts'
export { purgeCommand } from './purge.ts'
export { withCommand, type WithDeps } from './with.ts'
export { gateCommand, type GateDeps } from './gate.ts'
export { laneRootFor, runsRootFor, storeFor } from './paths.ts'
