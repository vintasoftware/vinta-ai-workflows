/**
 * What removing a lane has to undo outside git, read from its summary.
 *
 * A lane is a worktree *and* whatever was made for it: a forked database on a
 * shared server, a slice of each shared service, a compose stack and the
 * volumes it forked off shared ones. Removing the worktree removes none of
 * those, and they are the expensive part — one observed purge left every
 * forked database and every lane's containers behind for somebody to find by
 * hand. The summary records all of it precisely so that it can be reversed
 * (see `summary.ts`), and this turns that record into the command lines that
 * reverse it.
 *
 * **Only what is provably this lane's.** Every step here destroys something,
 * and each is planned only when the summary names a resource no other lane, run
 * or checkout can be using:
 *
 * - **A database** is dropped only when it is the name the pool would derive
 *   for this lane from the run's own `project` block. A compose-delivered
 *   database records the *main* checkout's name, because the lane's own server
 *   is the isolation; dropping that name on a shared server would be the worst
 *   thing this file could do. A name that does not match is left, and said.
 * - **A service slice** is reset only when its namespace is derived from the
 *   lane's name. An `index` namespace is a slot position — the next run's lane
 *   in the same slot uses it — so it is never this file's to empty.
 * - **A compose stack** is stopped by its project name, which is
 *   `<checkout>_<lane>` and therefore the lane's alone; volumes are removed from
 *   the summary's manifest, never by a pattern, because a volume not on it is
 *   one somebody else is still using.
 *
 * Planning is pure, as in `database.ts`: the steps are decided here, printed by
 * `purge` before anything runs, and executed elsewhere. What `--dry-run` shows
 * is what a real purge then runs.
 *
 * Command lines are printed, so none of them may carry a secret. The ones built
 * here carry names, hosts and users — never a password, which the client tools
 * take from `PGPASSWORD` or `~/.pgpass` (see `serverFlags`). A service's
 * `reset_cmd` is the project's own text and may hold a credential in a URL, so
 * it is described by service and namespace and never echoed.
 */
import type { Platform } from '../platform/platform.ts'
import { shellQuote } from '../platform/platform.ts'
import { dropdbOf, planDatabase, serverFlags, type DatabaseRole } from './database.ts'
import type { ProjectSpec } from './pool.ts'
import { namespaceToken } from './services.ts'
import type { WorktreeSummary } from './summary.ts'

export interface TeardownStep {
  /** What `purge` prints. The command itself where it carries no project text. */
  readonly label: string
  /** The command line, run in the main checkout. */
  readonly command: string
}

export interface TeardownPlan {
  readonly lane: string
  /** In order: stack, volumes, service slices, databases. */
  readonly steps: readonly TeardownStep[]
  /** Resources the summary names that this deliberately does not touch, and why. */
  readonly left: readonly string[]
}

const ROLES: readonly DatabaseRole[] = ['dev', 'test']

/**
 * The steps that undo one lane, from its summary and the `project` block the
 * run provisioned it from — `null` when that block is not known, in which case
 * no database is dropped, because no name can be checked against it.
 */
export function planTeardown(
  summary: WorktreeSummary,
  project: ProjectSpec | null,
  platform?: Platform,
): TeardownPlan {
  const q = (value: string): string => shellQuote(value, platform)
  const steps: TeardownStep[] = []
  const left: string[] = []
  const { compose } = summary.state

  // Stack first: a container still running holds its volumes, and `volume rm`
  // refuses a volume in use. `down` without `-v` — the volumes that go are the
  // manifest's, named one by one below.
  if (compose.override_path !== null || compose.forked_volumes.length > 0) {
    const down = `docker compose -p ${q(compose.project_name)} down`
    steps.push({ label: down, command: down })
  }
  for (const volume of compose.forked_volumes) {
    // `--force` tolerates a volume that is already gone, so a purge that
    // failed halfway can simply be run again.
    const rm = `docker volume rm --force ${q(volume.name)}`
    steps.push({ label: rm, command: rm })
  }

  const own = namespaceToken(summary.name)
  for (const service of summary.state.services) {
    if (service.namespace !== own) {
      left.push(
        `service ${service.id} slot ${service.namespace} — shared by position with other runs' lanes`,
      )
    } else if (service.reset_cmd === null) {
      left.push(`service ${service.id} namespace ${service.namespace} — no reset_cmd to empty it with`)
    } else {
      steps.push({
        label: `reset service ${service.id} namespace ${service.namespace} (its reset_cmd)`,
        command: service.reset_cmd,
      })
    }
  }

  for (const role of ROLES) {
    const db = summary.state[role === 'dev' ? 'dev_db' : 'test_db']
    // A file-delivered database lives inside the worktree and goes with it.
    if (db === null || db.strategy !== 'fork' || db.engine !== 'postgres') continue
    const forked = db.forked_name
    if (forked === null) continue
    const spec = project?.databases[role]
    if (spec === undefined || spec.engine !== 'postgres') {
      left.push(`database ${forked} — the run's project block is gone, so its server is unknown`)
      continue
    }
    // On the lane's own compose server, which the stack's volume carries away.
    if (spec.delivery === 'compose') continue
    const expected = planDatabase(
      role,
      spec,
      { laneName: summary.name, lanePath: summary.path, templatesDir: '' },
      platform,
    ).forkedName
    if (expected !== forked) {
      left.push(`database ${forked} — not the name this lane's database would have; drop it by hand`)
      continue
    }
    const drop = `${dropdbOf(spec)} ${serverFlags(spec.serverUrl, platform)}--if-exists ${q(forked)}`
    steps.push({ label: drop, command: drop })
  }

  return { lane: summary.name, steps, left }
}
