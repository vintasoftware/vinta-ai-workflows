/**
 * The lane pool: N worktrees plus one integration worktree, provisioned once
 * per run and reused across phases.
 *
 * Two properties do all the work here. The template database is built exactly
 * once and cloned per lane — that is what makes the Nth lane cost a file copy
 * rather than a database server, and it is the pool's only serialization point.
 * And a lane is only reusable if every forked database it carries knows how to
 * return to that template; a lane that does not is re-provisioned instead,
 * because reusing it across a migration boundary would run the next phase
 * against the previous one's schema.
 *
 * That a lane is *derived* rather than discovered is what makes resume cheap:
 * the compose project, the env map, the database plans and the service plans
 * all fall out of `(name, kind, index, project, repoPath)`, so a worktree left
 * on disk by a killed run can be adopted — see `PoolOptions.adopt` — without
 * anyone having to remember what it was. Only the steps that write into the
 * working tree are skipped, and they are skipped because the agents'
 * uncommitted work is in there.
 *
 * Teardown is never automatic. A finished run leaves its worktrees, branches
 * and databases in place — they are the evidence a human reads when something
 * went wrong, and the skill's teardown steps reverse them from the summary.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { isWindows, shellInvocation, spawnOptionsFor } from '../platform/platform.ts'
import {
  type ComposeConfig,
  type ComposeIsolation,
  findComposeFile,
  planComposeIsolation,
  readComposeConfig,
} from './compose.ts'
import {
  type DatabasePlan,
  type DatabaseRole,
  type DatabaseSpec,
  planDatabase,
  planTemplate,
} from './database.ts'
import { DiskProbeError, measureBytes, probePoolDisk } from './disk.ts'
import { planService, type ServicePlan, type ServiceSpec } from './services.ts'
import { readSummary, resetPlan, writeSummary, type WorktreeSummary } from './summary.ts'

const run = promisify(execFile)

/**
 * A project's own command line — a database setup, a clone, a reset, the
 * project's migrate command. The shell it runs under is the platform's answer,
 * not this module's: these are the same kind of text a gate's `cmd` is.
 */
const sh = async (
  command: string,
  cwd: string,
  env: Readonly<Record<string, string>>,
): Promise<void> => {
  const shell = shellInvocation(command)
  await run(shell.file, [...shell.args], {
    cwd,
    env: { ...process.env, ...env },
    ...spawnOptionsFor(shell),
  })
}

/** Who the rescue commit is by. Never the agent: it did not write this commit. */
const WIP_AUTHOR = 'vinta-ai-maestro'
const WIP_EMAIL = 'vinta-ai-maestro@localhost'

/**
 * Where a rescued tree is kept. Outside `refs/heads`, so it is reachable and
 * mergeable by hand and reaches nothing on its own.
 */
export const WIP_REFS = 'refs/vinta-ai-maestro/wip'

/** How many paths a failed rescue names before it stops listing. */
const PRESERVE_PATH_LIMIT = 20

/** git, in a lane rather than in the main checkout. */
const gitIn = async (cwd: string, args: readonly string[]): Promise<void> => {
  await run('git', [...args], { cwd })
}

/** Newline-delimited git output as a list. */
const gitLines = async (cwd: string, args: readonly string[]): Promise<string[]> => {
  const { stdout } = await run('git', [...args], { cwd })
  return stdout.split('\n').filter((line) => line.length > 0)
}

/**
 * A lane that could not be handed on. Carries the lane name and which half of
 * the recycle failed, and nothing else: a reset command's own output is the
 * project's data — rows, paths, migration names — and §11 keeps it out of
 * error messages the same way it keeps it out of log fields.
 *
 * `preserve` is the exception, and it names paths. It is the stage that fires
 * when work was about to be destroyed and could not be saved, so the list of
 * what is at stake is the entire content of the message — an operator told only
 * "could not be recycled (preserve)" has been warned about nothing they can
 * act on. Bounded, and paths only: never a line of any file.
 */
export class LaneRecycleError extends Error {
  constructor(
    readonly lane: string,
    readonly stage: 'preserve' | 'worktree' | 'database' | 'reprovision',
    readonly paths: readonly string[] = [],
  ) {
    const at =
      paths.length === 0
        ? ''
        : `\nuncommitted, and still on disk in this lane:\n${paths
            .slice(0, PRESERVE_PATH_LIMIT)
            .map((path) => `  ${path}`)
            .join('\n')}${paths.length > PRESERVE_PATH_LIMIT ? `\n  … and ${paths.length - PRESERVE_PATH_LIMIT} more` : ''}`
    super(`lane "${lane}" could not be recycled (${stage})${at}`)
    this.name = 'LaneRecycleError'
  }
}

/**
 * A declared env file the main checkout does not have.
 *
 * Fail-closed, and deliberately so: the alternative is a lane that provisions
 * cleanly and then cannot boot its stack, which is a failure four steps and one
 * agent turn further along, wearing a completely unrelated error message.
 *
 * The *path* is named because it comes from the workflow document and is the
 * one thing that makes this actionable. Nothing of the file's content is.
 */
export class LaneEnvFileError extends Error {
  constructor(
    readonly lane: string,
    readonly file: string,
  ) {
    super(`lane "${lane}": the main checkout has no "${file}" to copy`)
    this.name = 'LaneEnvFileError'
  }
}

/**
 * A directory standing where a lane's worktree should be that this run cannot
 * take over.
 *
 * Raised only by a resume, and it refuses rather than falling through to a
 * fresh provision on purpose. `worktree add` fails on a path that already
 * exists whatever is in it, so the fall-through would reach the operator as
 * git's own sentence about a path — naming no lane, and reading like a bug in
 * the pool rather than like something on disk that needs a decision. And the
 * one thing that must never happen here is the other resolution: adopting a
 * directory that is *not* this lane's worktree hands the phase somebody else's
 * tree, and the first thing it does with it is commit.
 *
 * The path is named, and nothing from inside it is. §11 is about repository
 * contents; a directory this tool chose the name of is not that, and without it
 * the message says nothing an operator can go and look at.
 */
export class LaneAdoptError extends Error {
  constructor(
    readonly lane: string,
    readonly path: string,
    readonly reason: string,
  ) {
    super(
      `lane "${lane}": ${path} is ${reason}, so this run cannot resume into it — ` +
        `move it aside or reap the lane, then run again`,
    )
    this.name = 'LaneAdoptError'
  }
}

/** How much of a failing setup command's stderr is carried. */
const STDERR_LIMIT = 500

/**
 * The project's own `setup_cmd` failed, with enough to act on.
 *
 * The first version carried the lane name and nothing else, on a §11 reading
 * that turned out to be the wrong one. An operator whose `setup_cmd` died saw
 * only "could not provision the lane pool under …" — no exit code, no reason —
 * and had to replay the command by hand with the lane's environment
 * reconstructed to discover a missing settings module. That is an afternoon to
 * learn one line.
 *
 * §11 keeps repository *contents* out of the record: diffs, file bodies, gate
 * output. A command's exit code is not that, and the tail of its stderr is the
 * same class of thing as a harness refusal's own explanation — which this
 * package already decided to carry, for exactly this reason, after a permission
 * wall cost an afternoon for the same shape of reason. Bounded, and the tail
 * rather than the head, because a stack trace puts the cause last.
 */
export class LaneSetupError extends Error {
  constructor(
    readonly lane: string,
    readonly exitCode: number | null,
    readonly detail: string,
  ) {
    const code = exitCode === null ? 'was killed' : `exited ${exitCode}`
    super(
      `lane "${lane}": the project's setup_cmd ${code}` +
        (detail === '' ? '' : `\n${detail}`),
    )
    this.name = 'LaneSetupError'
  }
}

/** The project's `prepare_cmd` failed, with the same detail a setup failure has. */
export class LanePrepareError extends Error {
  constructor(
    readonly exitCode: number | null,
    readonly detail: string,
  ) {
    const code = exitCode === null ? 'was killed' : `exited ${exitCode}`
    super(
      `the project's prepare_cmd ${code} — the shared servers this run needs are not up` +
        (detail === '' ? '' : `\n${detail}`),
    )
    this.name = 'LanePrepareError'
  }
}

/**
 * Makes the shared servers a run depends on reachable, before anything needs
 * them.
 *
 * A project whose databases are `delivery: external` and whose services point
 * at one Redis has no long-lived containers of its own — which is the shape the
 * schema recommends, and it makes some *other* stack a hard dependency of every
 * run. Nothing in this package could bring that up or check it.
 *
 * `setup_cmd` looks like the place and is not: it runs per lane, and by then
 * the template database has already been created on a server that had to be up
 * for `createdb` to work. So this runs earlier than everything — earlier even
 * than the preflight, so that `doctor`'s reachability check is checking the
 * world this command just made rather than the one before it.
 *
 * Standalone rather than a method, because its first caller needs it before a
 * pool exists. `LanePool.recycle` calls it too: a server that died mid-run is
 * then restored at the next lane hand-off instead of failing every phase after
 * it.
 */
export async function prepareInfrastructure(
  project: Pick<ProjectSpec, 'prepareCmd'>,
  repoPath: string,
): Promise<void> {
  if (project.prepareCmd === undefined) return
  try {
    await sh(project.prepareCmd, repoPath, {})
  } catch (error) {
    throw new LanePrepareError(exitCodeOf(error), stderrTail(error))
  }
}

/** The last of a failed child's stderr, bounded, or '' where it said nothing. */
function stderrTail(error: unknown): string {
  const raw = (error as { stderr?: unknown } | null)?.stderr
  const text = typeof raw === 'string' ? raw.trimEnd() : ''
  return text.length <= STDERR_LIMIT ? text : `…${text.slice(-STDERR_LIMIT)}`
}

/** A failed child's exit code, or null where it was killed by a signal. */
function exitCodeOf(error: unknown): number | null {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'number' ? code : null
}

export interface ProjectSpec {
  readonly databases: { readonly dev?: DatabaseSpec; readonly test?: DatabaseSpec }
  /** The project's own migrate command, run once per template. */
  readonly migrateCmd: string
  /**
   * Repo-relative ignored files each lane gets its own copy of. Copied rather
   * than linked, because lane provisioning *appends* to them.
   */
  readonly envFiles?: readonly string[]
  /** The project's own idempotent lane-setup command, run inside the lane. */
  readonly setupCmd?: string
  /**
   * Run in the repository root before anything a run creates, to make the
   * shared servers reachable. See `prepareInfrastructure`.
   */
  readonly prepareCmd?: string
  /** False points the lane at an empty `core.hooksPath`. Defaults to running them. */
  readonly hooks?: boolean
  /**
   * How the lane's compose stack is isolated past `COMPOSE_PROJECT_NAME`.
   * Absent means the pool does not go looking for a compose file at all.
   */
  readonly compose?: {
    readonly publish?: readonly string[]
    readonly sharedVolumes?: readonly string[]
  }
  /** Shared servers each lane gets its own namespace inside. */
  readonly services?: readonly ServiceSpec[]
}

export interface PoolOptions {
  /** The main checkout every lane is a worktree of. */
  readonly repoPath: string
  /** Directory the lane worktrees are created under. */
  readonly poolRoot: string
  readonly runId: string
  readonly laneCount: number
  /**
   * Lane slot names, when the caller wants its own.
   *
   * A staffed run names one worktree per crew member and pins each member to
   * theirs for the whole run, because a member whose directory moves between
   * phases cannot keep a session across them. `laneCount` still governs how
   * many are provisioned; this only decides what they are called, and the
   * scheduler derives the same names from the same roster.
   */
  readonly laneNames?: readonly string[]
  readonly baseRef: string
  readonly project: ProjectSpec
  /**
   * Take over lane worktrees already on disk instead of creating them — what a
   * resumed run needs, and nothing else should set.
   *
   * A run whose process was killed leaves its worktrees standing with whatever
   * the agents had not committed still in them. Re-creating those is not a
   * slower route to the same place: it is exactly the destruction `reap`
   * refuses to perform, carried out by the step meant to get the run going
   * again. Off by default, because for a first run every one of these paths
   * being absent is the only correct expectation and a surprise there should
   * fail rather than be absorbed.
   *
   * Decided per worktree rather than per pool. A run that died partway through
   * provisioning left some lanes standing and never reached the others, so a
   * path that is not there is provisioned exactly as a first run would.
   */
  readonly adopt?: boolean
  /** Overrides the measured per-lane disk estimate the N× probe uses. */
  readonly perLaneBytes?: number
  /**
   * Overrides how the project's compose config is read — the same kind of seam
   * as `perLaneBytes`, and for the same reason. The real one shells out to
   * `docker compose config`, so without this the wiring around it (where the
   * override lands, what `COMPOSE_FILE` is set to, what the summary records)
   * would be testable only on a machine with docker running.
   */
  readonly readCompose?: (
    repoPath: string,
  ) => Promise<{ config: ComposeConfig; baseFile: string } | null>
}

export interface Lane {
  readonly name: string
  readonly kind: 'lane' | 'integration'
  readonly path: string
  readonly branch: string
  readonly composeProject: string
  /**
   * The lane's slot in the pool. Stable across a re-provision, because it is
   * what an `index`-namespaced service resolves to and a lane whose redis
   * database moved between phases is a lane that lost its own state.
   */
  readonly index: number
  /** What the lane's compose override does, or null where there is no compose. */
  readonly compose: ComposeIsolation | null
  readonly databases: readonly DatabasePlan[]
  /** This lane's slice of each shared service. */
  readonly services: readonly ServicePlan[]
  /** Gates and agents in this lane must run with this environment applied. */
  readonly env: Readonly<Record<string, string>>
  /** False when a forked database has no reset — the lane is single-use. */
  readonly reusable: boolean
}

const ROLES: readonly DatabaseRole[] = ['dev', 'test']

/**
 * Runs an operation until it stops losing to a handle somebody else still
 * holds. Linear backoff, a handful of attempts, and the last failure is
 * rethrown so a genuinely stuck path still reports as one.
 */
async function retrying<T>(operation: () => Promise<T>, attempts = 8, delayMs = 150): Promise<T> {
  let last: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      last = error
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw last
}

export class LanePool {
  readonly #options: PoolOptions
  readonly #templatesDir: string
  readonly #summaryDir: string
  #all: Lane[] = []
  /** Read once per pool. `undefined` is "not asked yet", `null` is "no compose". */
  #compose: { config: ComposeConfig; baseFile: string } | null | undefined
  /**
   * git rewrites `.git/worktrees/` for every `worktree add`, and concurrent
   * adds corrupt each other's metadata. It is a second serialization point,
   * forced by git rather than chosen — everything a lane costs real time for
   * still happens concurrently around it.
   */
  #gitTurn: Promise<unknown> = Promise.resolve()

  private constructor(options: PoolOptions) {
    this.#options = options
    this.#templatesDir = join(options.poolRoot, '.templates')
    this.#summaryDir = join(options.repoPath, '.vinta-ai-workflows', 'worktrees')
  }

  static async provision(options: PoolOptions): Promise<LanePool> {
    const pool = new LanePool(options)
    // Capacity is a property of the requested pool, not of one worktree. Check
    // it before the disk probe creates `poolRoot`, before templates run the
    // project's setup, and before git sees a branch. The integration worktree
    // gets its own namespace too, so it consumes the slot after the last lane.
    for (const service of options.project.services ?? []) {
      if (service.namespace === 'index') {
        planService(service, {
          laneName: `${options.runId}-integ`,
          laneIndex: options.laneCount,
        })
      }
    }
    const laneNames =
      options.laneNames ??
      Array.from({ length: options.laneCount }, (_, i) => `${options.runId}-lane-${i + 1}`)
    const names: [string, Lane['kind']][] = [
      ...laneNames.map((name): [string, Lane['kind']] => [name, 'lane']),
      [`${options.runId}-integ`, 'integration'],
    ]

    // Which worktrees are already there, settled before anything is created or
    // measured. Every question `#adoptable` asks is a read — `existsSync`, a
    // `stat`, two `rev-parse`s — so this stays on the near side of the line the
    // disk probe draws: a pool that refuses still leaves the filesystem exactly
    // as it found it, which is what the probe's own test asserts.
    const adopting = await Promise.all(
      names.map(([name]) => (options.adopt === true ? pool.#adoptable(name) : false)),
    )

    // Sized for the worktrees that will really be created, not for the ones
    // asked for. An adopted lane's bytes were spent by the run that died; still
    // charging the probe for them refuses a resume that needs almost no new
    // space, on a filesystem already holding every worktree it is about to
    // reuse — a refusal that gets stranger the closer the pool is to correct,
    // because the more lanes survived the more disk the probe demands.
    await pool.#probeDisk(adopting.filter((adopt) => !adopt).length)
    // `run` has already done this, before its preflight — earlier than a pool
    // can, and the right place for it. Repeated here so a host that drives the
    // pool directly still gets a reachable server before `createdb` needs one;
    // the command is required to be idempotent, so twice costs nothing.
    await prepareInfrastructure(options.project, options.repoPath)
    // Built even when every lane is adopted, and the wasted migrate run is the
    // price of a correct one. The template is not only what a lane is cloned
    // from — it is what a lane is *reset to*, so the first recycle after a
    // resume reads it, and a resumed run recycles a lane at every phase
    // boundary it crosses. Rebuilding also settles what a leftover template
    // from the dead run cannot be trusted about: this one is migrated from the
    // base ref this run was given. Nothing here touches a lane — the setup
    // drops and recreates the template alone, never a lane's own fork.
    await pool.#buildTemplates()

    // Lanes share nothing but the source repo, so past the template they are
    // provisioned concurrently.
    // The index is the lane's slot, and it is what an `index`-namespaced
    // service is derived from — so the integration worktree takes the one after
    // the last lane rather than sharing a lane's.
    pool.#all = await Promise.all(
      names.map(([name, kind], index) =>
        pool.#provisionWorktree(name, kind, index, adopting[index] === true),
      ),
    )
    return pool
  }

  get lanes(): readonly Lane[] {
    return this.#all.filter((lane) => lane.kind === 'lane')
  }

  get integration(): Lane {
    const integration = this.#all.find((lane) => lane.kind === 'integration')
    if (!integration) throw new Error('pool has no integration worktree')
    return integration
  }

  lane(name: string): Lane {
    const lane = this.#all.find((candidate) => candidate.name === name)
    if (!lane) throw new Error(`unknown lane "${name}"`)
    return lane
  }

  /**
   * Hands a lane back fresh for the next phase, re-provisioning it when it is
   * single-use. The decision comes from the summary on disk, not from this
   * object: that file is the contract, and it outlives the process.
   *
   * A lane is its worktree *and* its databases, so both go back: the previous
   * phase's branch, staged edits and untracked leftovers are as much of it as
   * its rows are, and the re-provisioning branch already returns both. The
   * worktree goes first — a `git clean` run after the reset would delete the
   * database file the reset had just restored.
   */
  async recycle(name: string): Promise<Lane> {
    const lane = this.lane(name)
    const summary = await readSummary(this.#summaryDir, name)
    const plan = resetPlan(summary)
    // The shared servers first: a recycle resets databases and may re-run the
    // project's own setup against them, and a server that fell over mid-run
    // would otherwise fail every phase after it rather than this one hand-off.
    await prepareInfrastructure(this.#options.project, this.#options.repoPath)
    // Before either path, because both destroy the working tree: one cleans it,
    // the other deletes the directory outright.
    await this.#preserveWork(lane)
    if (plan.reusable) {
      await this.#restoreWorktree(lane, summary)
      // Both halves of "a working checkout" are put back, not just the rows.
      // The clean above is `-e node_modules` and nothing more, so a copied env
      // file the previous phase edited — or one it deleted — is restored here
      // from the main checkout rather than inherited. And the project's own
      // hook runs again, which is why its contract says idempotent.
      await this.#copyEnvFiles(name, lane.path)
      try {
        for (const command of plan.commands) await sh(command, lane.path, lane.env)
        // Same stage, because it is the same kind of thing: state the previous
        // phase left behind that the next one must not read.
        for (const service of lane.services) {
          if (service.resetCmd !== null) await sh(service.resetCmd, lane.path, lane.env)
        }
      } catch {
        throw new LaneRecycleError(name, 'database')
      }
      await this.#setup(lane)
      return lane
    }

    try {
      // The whole teardown is retried, not just its first step. Windows refuses
      // to delete a file anything still holds open, and a process that has just
      // exited — an agent, a gate, a database — can keep a handle for a beat
      // after it is gone, as can a scanner reading what was written. `--force`
      // does not help: it is about git's own reluctance, not the filesystem's.
      //
      // `prune` between the two git calls is what makes the retry converge. A
      // removal that only partly succeeded leaves the worktree still registered,
      // and git then refuses to delete a branch it believes is checked out —
      // so the second step fails for a reason the first one caused, and
      // retrying the second alone would never clear it.
      await retrying(async () => {
        // **Each step skips work it has already done**, or the retry could not
        // converge: a second `worktree remove` of a path that is gone fails,
        // and the attempt that was meant to finish the job would fail on its
        // first line every time.
        if (existsSync(lane.path)) {
          await this.#git(['worktree', 'remove', '--force', lane.path])
        }
        // Between the two, and load-bearing. A removal that only partly
        // succeeded leaves the worktree registered, and git then refuses to
        // delete a branch it believes is checked out — the second step failing
        // for a reason the first one caused.
        await this.#git(['worktree', 'prune'])
        // git can let go of a worktree and still leave the directory standing:
        // on Windows a delete of a file something briefly holds open fails, and
        // git does not treat that as its own failure. `worktree add` then
        // refuses the path for already existing, which is a re-provision that
        // cannot happen and a node that fails for a directory nobody wanted.
        await rm(lane.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        if (await this.#hasBranch(lane.branch)) {
          await this.#git(['branch', '-D', lane.branch])
        }
      })
      await rm(join(this.#summaryDir, `${name}.yaml`), {
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      })
    } catch {
      throw new LaneRecycleError(name, 'reprovision')
    }

    // Inside its own guard, so a re-provision that fails says which half of the
    // recycle it was. It used to sit outside every `try` here, and reached the
    // scheduler as a bare `Error` — the reason a Windows failure could say only
    // "could not be recycled" while naming neither a stage nor a cause.
    let fresh: Lane
    try {
      fresh = await this.#provisionWorktree(lane.name, lane.kind, lane.index)
    } catch {
      throw new LaneRecycleError(name, 'reprovision')
    }
    this.#all = this.#all.map((candidate) => (candidate.name === name ? fresh : candidate))
    return fresh
  }

  /**
   * The worktree back on its own branch at its own base, with nothing of the
   * previous phase left in it. The phase branch itself survives — it is a ref,
   * and integration still has to merge it.
   *
   * Read from the summary rather than from `lane`, for the same reason the
   * reset decision is: the file is the contract, so a lane the skill
   * provisioned and a lane the pool provisioned recycle identically. The linked
   * dependency tree is excluded from the clean because it is state a lane
   * cannot run a gate without and never a leftover of the phase.
   */
  async #restoreWorktree(lane: Lane, summary: WorktreeSummary): Promise<void> {
    try {
      const git = (args: readonly string[]) => run('git', [...args], { cwd: lane.path })
      await git(['checkout', '--force', summary.branch])
      await git(['reset', '--hard', summary.base_ref])
      await git(['clean', '-fd', '-e', 'node_modules'])
    } catch {
      throw new LaneRecycleError(lane.name, 'worktree')
    }
  }

  /** Whether the ref is there. A missing branch is an answer, not a failure. */
  async #hasBranch(branch: string): Promise<boolean> {
    return (await this.#revParse(`refs/heads/${branch}`)) !== null
  }

  /** What a ref points at in the main checkout, or null where it is not there. */
  async #revParse(ref: string): Promise<string | null> {
    try {
      const { stdout } = (await this.#git(['rev-parse', '--verify', '--quiet', ref])) as {
        stdout: string
      }
      return stdout.trim()
    } catch {
      return null
    }
  }

  /**
   * Whether this lane's worktree is already on disk and is really *this lane's*
   * — the question a resume asks before reusing a directory instead of making
   * one.
   *
   * Three answers, and the third is why this is not a boolean in disguise. A
   * path nothing was ever provisioned at is `false`, and the lane is created
   * exactly as a first run would create it: a run that died between its second
   * and third `worktree add` left two lanes standing and never reached the
   * third, and refusing the whole resume over that would mean destroying the
   * two that survived to get going again. A path holding this lane's worktree
   * is `true`. Anything else throws — see `LaneAdoptError`.
   *
   * **A phase branch checked out here is not "anything else".** The obvious
   * identity check is that HEAD is on `wt/<name>`, and it is wrong in the one
   * case this whole capability is for: the integrator puts every lane on
   * `plan/<id>/phase-<n>` for the duration of a phase, so a run killed *during*
   * a phase — the kill that leaves uncommitted work — is never on the lane
   * branch, and a run killed between phases is only because `recycle` put it
   * back. That check would therefore adopt exactly the lanes with nothing in
   * them to save and refuse the ones with work.
   *
   * So identity is the lane *branch existing in this repository*, which the
   * worktree agrees about, and not whatever HEAD happens to be mid-phase. The
   * two sides are compared by the commit the ref resolves to rather than by
   * matching `git worktree list`'s paths against this one: git prints posix
   * paths on every platform while Node hands back the platform's, so on Windows
   * that comparison loses to drive-letter case, separators and 8.3 short names
   * — silently, and in the direction that calls every lane unadoptable.
   */
  async #adoptable(name: string): Promise<boolean> {
    const path = join(this.#options.poolRoot, name)
    const branch = `wt/${name}`
    if (!existsSync(path)) return false

    // A linked worktree carries a `.git` **file** where an ordinary checkout
    // has a directory. The filesystem is asked rather than git, for the reason
    // `reap` gives: the pool root can sit inside the repository, and a plain
    // subdirectory of it answers every git question perfectly well while being
    // no worktree at all.
    const linked = await stat(join(path, '.git')).then(
      (entry) => entry.isFile(),
      () => false,
    )
    if (!linked) throw new LaneAdoptError(name, path, 'not a linked git worktree')

    const mine = await this.#revParse(`refs/heads/${branch}`)
    if (mine === null) {
      throw new LaneAdoptError(name, path, `a worktree, but this checkout has no "${branch}"`)
    }
    const theirs = await gitLines(path, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
      .then((lines) => lines[0] ?? null)
      .catch(() => null)
    if (theirs !== mine) {
      throw new LaneAdoptError(name, path, 'a worktree of some other repository')
    }
    return true
  }

  #git(args: readonly string[]): Promise<unknown> {
    const turn = this.#gitTurn.then(() =>
      run('git', [...args], { cwd: this.#options.repoPath }),
    )
    this.#gitTurn = turn.catch(() => undefined)
    return turn
  }

  /**
   * Refuses the pool that will not fit, before a byte of it exists.
   *
   * Counted in worktrees this call is about to create — the lanes plus the
   * integration worktree, which is a lane in every way that costs disk, less
   * any a resume is adopting. Zero of them is not a probe that trivially
   * passes but one that is not run: `measureBytes` walks the whole main
   * checkout, and a resume that creates nothing has nothing to weigh it
   * against.
   */
  async #probeDisk(worktreeCount: number): Promise<void> {
    if (worktreeCount === 0) return
    const { repoPath, poolRoot, perLaneBytes } = this.#options
    const perLane = perLaneBytes ?? (await measureBytes(repoPath))
    const probe = await probePoolDisk(poolRoot, perLane, worktreeCount)
    if (!probe.fits) throw new DiskProbeError(probe)
  }

  async #buildTemplates(): Promise<void> {
    const { project, repoPath } = this.#options
    await mkdir(this.#templatesDir, { recursive: true })

    for (const role of ROLES) {
      const spec = project.databases[role]
      if (!spec) continue
      const template = planTemplate(role, spec, this.#templatesDir)
      if (!template) continue

      await sh(template.setupCmd, repoPath, {})
      await sh(project.migrateCmd, repoPath, template.env)
    }
  }

  /**
   * One worktree, and the `Lane` that describes it.
   *
   * `adopt` is a resume taking over a worktree that is already there, and the
   * steps it skips are the ones that would **write into a lane an agent is
   * still mid-phase in**. `worktree add` is the obvious one. The other two are
   * what make this a resume rather than a restart: `#copyEnvFiles` would put
   * the main checkout's `.env` over the one the phase edited, and a database's
   * `cloneCmd` would return the lane's rows to the template — which to a phase
   * being resumed is the same loss as deleting its files, arriving as a test
   * suite that suddenly sees an empty database.
   *
   * Everything else runs, because everything else derives the lane rather than
   * building it. `#configureHooks` and `#isolateCompose` are idempotent and
   * write outside the working tree; the descriptor below is a pure function of
   * `(name, kind, index, project, repoPath)`. So an adopted lane is
   * indistinguishable from a provisioned one to every caller, which is what
   * lets the scheduler, the executor and `recycle` stay unaware that resume
   * exists at all.
   *
   * `#linkDeps` is the one skipped-looking step that is not skipped, and it is
   * deliberate: it already swallows "there is one there", so on an adopted lane
   * it costs a failed `symlink` — and on the lane that died *between* its
   * `worktree add` and its link it is the difference between a resumed phase
   * and one whose every gate cannot resolve a dependency.
   */
  async #provisionWorktree(
    name: string,
    kind: Lane['kind'],
    index: number,
    adopt = false,
  ): Promise<Lane> {
    const { repoPath, poolRoot, baseRef, project } = this.#options
    const path = join(poolRoot, name)
    const branch = `wt/${name}`

    await mkdir(poolRoot, { recursive: true })
    if (!adopt) await this.#git(['worktree', 'add', '-b', branch, path, baseRef])
    await this.#linkDeps(path)
    await this.#configureHooks(path)
    if (!adopt) await this.#copyEnvFiles(name, path)

    const databases: DatabasePlan[] = []
    for (const role of ROLES) {
      const spec = project.databases[role]
      if (!spec) continue
      const plan = planDatabase(role, spec, {
        laneName: name,
        lanePath: path,
        templatesDir: this.#templatesDir,
      })
      if (plan.cloneCmd && !adopt) await sh(plan.cloneCmd, path, {})
      databases.push(plan)
    }

    // Set unconditionally, and *necessary but nowhere near sufficient*: it
    // namespaces containers, networks and auto-named volumes, and leaves a
    // pinned volume and a fixed host port exactly as shared as they were.
    // `#isolateCompose` below is what closes those.
    const composeProject = `${basename(repoPath)}_${name}`
    const env: Record<string, string> = { COMPOSE_PROJECT_NAME: composeProject }
    for (const db of databases) env[db.connectionUrlVar] = db.connectionUrl

    // One shared server, a namespace per lane. The whole pool's capacity was
    // checked before provisioning began; this derives the already-valid slice.
    //
    // Planned here and *created further down*, once the lane's environment is
    // complete. The first version ran each `create_cmd` in this loop with an
    // empty overlay, which `reset_cmd` never did — so a `create_cmd` that
    // reached for `docker compose` ran against the lane's own compose file with
    // no project name and no override, booting a stack on the project's fixed
    // host ports. That is the exact collision the override exists to prevent,
    // caused by the step that sets a lane up.
    const services = (project.services ?? []).map((spec) =>
      planService(spec, { laneName: name, laneIndex: index }),
    )
    for (const service of services) env[service.urlVar] = service.url

    const compose = await this.#isolateCompose(name, composeProject)
    if (compose !== null) {
      Object.assign(env, compose.isolation.env)
      // The base file stays relative — the lane carries its own tracked copy —
      // while the override is absolute, because it lives outside the worktree
      // and a bare name would not resolve from the compose project directory.
      env['COMPOSE_FILE'] = [compose.baseFile, compose.overridePath].join(delimiter)
    }

    const lane: Lane = {
      name,
      kind,
      path,
      branch,
      composeProject,
      index,
      compose: compose?.isolation ?? null,
      databases,
      services,
      env,
      // Services deliberately do not vote here. A database without a reset
      // cannot be handed to the next phase — it would run against the previous
      // one's schema — while a shared service without one merely keeps what the
      // last phase left in it, which for a cache is usually right. Declaring a
      // `reset_cmd` is how a project says its queue is not a cache; forcing a
      // whole worktree re-provision on a service that has nothing to reset
      // would be a large cost for a `S3_PREFIX`.
      reusable: databases.every((db) => db.resetCmd !== null),
    }
    // With the lane's own environment, exactly as `reset_cmd` gets it: the
    // compose project, the override, the forked connection strings and every
    // service namespace. A command that creates a vhost needs the address it is
    // creating it on, and one that reaches for compose needs the isolation.
    //
    // Run for an adopted lane too, unlike the database clone above, and the
    // difference is what each command is *defined* to do. A clone overwrites —
    // that is the whole of it. A `create_cmd` makes a namespace exist, and
    // already runs a second time against one it made whenever a single-use lane
    // is re-provisioned mid-run, so a project whose `create_cmd` cannot survive
    // that has a lane it cannot recycle today, resume or no resume.
    for (const service of services) {
      if (service.createCmd !== null) await sh(service.createCmd, path, env)
    }

    // Written before the project's own hook runs, so a lane whose setup failed
    // still leaves the record a human tears it down from. Rewritten for an
    // adopted lane rather than trusted: the summary is what `recycle` reads to
    // decide whether the lane can be handed on and how to reset it, and a run
    // that was killed is precisely the one that may have left half a file.
    await this.#writeSummary(lane)
    await this.#setup(lane)
    return lane
  }

  /**
   * Points the lane at an empty `core.hooksPath` when the project asks.
   *
   * A lane is a worktree that has never been committed in, and a `language:
   * system` pre-commit chain treats that as a fresh machine: one project's
   * hooks built a 510 MB virtualenv before they would let the first commit
   * through, and the agent spent four attempts and a two-minute timeout getting
   * past them. Per lane. Committing is not optional — the phase is judged on
   * commits — so a hook chain that makes committing expensive makes the whole
   * design expensive.
   *
   * Set per worktree rather than on the repository: the operator's own checkout
   * keeps its hooks. And it is opt-in, because hooks are usually there for a
   * reason and the gates that would catch what they catch are the project's own
   * to declare.
   */
  async #configureHooks(lanePath: string): Promise<void> {
    if (this.#options.project.hooks !== false) return
    const empty = join(lanePath, '.git-hooks-disabled')
    await mkdir(empty, { recursive: true })
    // A worktree's `.git` is a file, and `--worktree` needs `extensions
    // .worktreeConfig`; `--local` on a worktree reaches the shared config,
    // which would disable hooks for the main checkout too. The env var form is
    // not available here because the agent runs its own git. So: worktree
    // config, with the extension enabled first.
    //
    // **The extension goes through `#git`, which serializes; the `--worktree`
    // write does not need to.** `extensions.worktreeConfig` is a
    // repository-wide key, so enabling it writes the *shared* `.git/config` —
    // one file, whichever worktree asks — and git takes `.git/config.lock` to
    // do it. Called per lane out of the provisioning `Promise.all`, the lanes
    // collided on that lock: `could not lock config file …: File exists`, and
    // the pool refused. A fresh provision never showed it, because
    // `worktree add` goes through the same turn and staggered the lanes apart
    // — so this was a bug only on the path that skips `worktree add`, which is
    // `adopt`, which is every resume of a project with `hooks: false`. The
    // second write lands in `.git/worktrees/<name>/config.worktree`, a
    // different file per lane, and stays parallel.
    await this.#git(['config', 'extensions.worktreeConfig', 'true'])
    await gitIn(lanePath, ['config', '--worktree', 'core.hooksPath', empty])
  }

  /**
   * Whatever the last phase left uncommitted, kept as a commit **off to one
   * side**, before the recycle destroys it.
   *
   * A recycle hands a clean lane on, and both of its paths do that by throwing
   * the working tree away — `git clean` on a reusable lane, `rm -rf` on one that
   * has to be re-provisioned. A phase whose commits survive and whose in-flight
   * edits do not is still a phase that lost work, and the deliverables of a real
   * phase have been deleted this way: four sessions, a `SUCCESS` report, and
   * every file untracked.
   *
   * **It does not move the branch, and the first version did.** Committing onto
   * the checked-out phase branch is the obvious implementation and it is wrong:
   * a lane's dirty tree holds gate artifacts and scratch files as often as it
   * holds deliverables, and a phase branch is the *base of its dependents*. The
   * test that caught this had a gate write `left-behind.txt`; committing it onto
   * phase `a` put it in phase `b`'s base and failed `b`'s gate, which is a
   * failure nothing in `b` caused. So the tree is committed with plumbing —
   * a temporary index, `write-tree`, `commit-tree` — and only a ref under
   * `refs/vinta-ai-maestro/wip/` points at the result. Nothing is merged,
   * nothing reaches a dependent, and nothing is lost:
   *
   *     git -C <lane> checkout <ref> -- <path>
   *
   * This is the floor, not the fix. The fix is that the prompts now require
   * committing and the reviewer reads the working tree, so work that matters
   * should be on the branch before anything gets here.
   *
   * Identity is supplied for exactly this commit. A machine with no
   * `user.email` must not be the reason work is lost, and `commit-tree` touches
   * neither hooks nor the real index, so there is nothing else to opt out of.
   */
  async #preserveWork(lane: Lane): Promise<void> {
    let dirty: string[]
    try {
      dirty = await gitLines(lane.path, ['status', '--porcelain'])
    } catch {
      // No worktree, or no git. Nothing to preserve and nothing to report.
      return
    }
    if (dirty.length === 0) return

    try {
      // A scratch index, so the lane's own staged state is untouched — the
      // same seam `GateCache` uses to hash a tree without disturbing one.
      const index = join(lane.path, '.git-wip-index')
      const scratch = { ...process.env, GIT_INDEX_FILE: index }
      await run('git', ['read-tree', 'HEAD'], { cwd: lane.path, env: scratch })
      await run('git', ['add', '--all'], { cwd: lane.path, env: scratch })
      const { stdout: tree } = await run('git', ['write-tree'], { cwd: lane.path, env: scratch })
      await rm(index, { force: true })

      const { stdout: commit } = await run(
        'git',
        [
          'commit-tree',
          tree.trim(),
          '-p',
          'HEAD',
          '-m',
          `wip: ${lane.name} — uncommitted work, set aside before the lane was recycled`,
        ],
        {
          cwd: lane.path,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: WIP_AUTHOR,
            GIT_AUTHOR_EMAIL: WIP_EMAIL,
            GIT_COMMITTER_NAME: WIP_AUTHOR,
            GIT_COMMITTER_EMAIL: WIP_EMAIL,
          },
        },
      )
      // One ref per rescue: a lane is recycled once per phase it serves, and a
      // single ref per lane would let the second rescue delete the first.
      await gitIn(lane.path, [
        'update-ref',
        `${WIP_REFS}/${lane.name}/${Date.now()}`,
        commit.trim(),
      ])
    } catch {
      // Fail-closed, like every other stage of a recycle. The lane goes back on
      // the free list dirty, the next node to take it fails the same way, and
      // the work is still on disk for whoever reads the message — which is the
      // whole point of refusing rather than cleaning. The paths are the message.
      throw new LaneRecycleError(
        lane.name,
        'preserve',
        dirty.map((line) => line.slice(3)),
      )
    }
  }

  /**
   * The project's compose config, read **once per pool**.
   *
   * Once, because `docker compose config` is slow and the answer is the same
   * for every lane — they are all worktrees of one base ref. It is also the
   * bound on this: the config is the base branch's, so a phase that *adds* a
   * compose service mid-run publishes a port this override does not know to
   * strip. That is a narrower gap than the one it closes, and closing it would
   * mean re-planning ports a running executor has already been handed.
   */
  async #composeConfig(): Promise<{ config: ComposeConfig; baseFile: string } | null> {
    if (this.#options.project.compose === undefined) return null
    if (this.#compose === undefined) {
      const read =
        this.#options.readCompose ??
        ((repoPath: string) => readComposeConfig(repoPath, findComposeFile(repoPath)))
      this.#compose = await read(this.#options.repoPath)
    }
    return this.#compose
  }

  /**
   * The lane's override, written where the phase's diff cannot see it.
   *
   * Out of tree — under the already-ignored `.vinta-ai-workflows/` umbrella —
   * rather than as a `docker-compose.override.yml` at the worktree root. That
   * path is auto-loaded, which is convenient, and it is also frequently a
   * *tracked* file: writing a generated override there would put the lane's
   * isolation into the phase's commit, and from there into the merge.
   */
  async #isolateCompose(
    name: string,
    composeProject: string,
  ): Promise<{ isolation: ComposeIsolation; baseFile: string; overridePath: string } | null> {
    const found = await this.#composeConfig()
    if (found === null) return null

    const settings = this.#options.project.compose ?? {}
    const isolation = await planComposeIsolation(found.config, {
      composeProject,
      ...(settings.publish === undefined ? {} : { publish: settings.publish }),
      ...(settings.sharedVolumes === undefined ? {} : { sharedVolumes: settings.sharedVolumes }),
    })

    const overridePath = join(this.#summaryDir, `${name}.docker-compose.override.yml`)
    await mkdir(this.#summaryDir, { recursive: true })
    await writeFile(overridePath, isolation.overrideYaml, 'utf8')
    return { isolation, baseFile: found.baseFile, overridePath }
  }

  /**
   * The project's ignored-but-required files, copied into the lane.
   *
   * Copied rather than linked, and the distinction is load-bearing rather than
   * stylistic: lane provisioning *appends* to these files — a connection
   * string, a `COMPOSE_FILE` pointing at the lane's own override — and through
   * a symlink every one of those lines would land in the main checkout's
   * `.env` instead, where it would then be wrong for every lane at once.
   */
  async #copyEnvFiles(name: string, lanePath: string): Promise<void> {
    for (const file of this.#options.project.envFiles ?? []) {
      const source = join(this.#options.repoPath, file)
      if (!existsSync(source)) throw new LaneEnvFileError(name, file)
      const destination = join(lanePath, file)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(source, destination)
    }
  }

  /**
   * The project's own setup hook, with the lane's environment applied — which
   * is the whole point of it running here rather than being something the
   * operator remembers to do. It sees `COMPOSE_PROJECT_NAME`, the forked
   * connection strings and every service namespace, because a hook that had to
   * re-derive those would be a second implementation of this file.
   */
  async #setup(lane: Lane): Promise<void> {
    const { setupCmd } = this.#options.project
    if (setupCmd === undefined) return
    try {
      await sh(setupCmd, lane.path, lane.env)
    } catch (error) {
      throw new LaneSetupError(lane.name, exitCodeOf(error), stderrTail(error))
    }
  }

  /**
   * The dependency tree is symlinked rather than copied: no phase in a run adds
   * a dependency without the plan saying so, and N copies of `node_modules` is
   * the single largest thing a pool can waste.
   *
   * The link type is the one place this differs by platform, and it is not
   * cosmetic. Node defaults to a *file* symlink on Windows, which for a
   * directory produces a link nothing can traverse; and a real directory
   * symlink needs `SeCreateSymbolicLinkPrivilege`, which means Developer Mode
   * or an elevated shell. A junction needs neither and behaves like the
   * directory link POSIX gives for free. It is only valid for an absolute local
   * path, which `source` is.
   */
  async #linkDeps(lanePath: string): Promise<void> {
    const source = join(this.#options.repoPath, 'node_modules')
    try {
      await symlink(source, join(lanePath, 'node_modules'), isWindows() ? 'junction' : undefined)
    } catch {
      // No dependency tree in the main checkout, or one already linked in.
    }
  }

  async #writeSummary(lane: Lane): Promise<void> {
    const db = (role: DatabaseRole) => {
      const plan = lane.databases.find((candidate) => candidate.role === role)
      if (!plan) return null
      return {
        engine: plan.engine,
        // Compose-delivered databases are forked at the volume, not the name.
        strategy: 'fork' as const,
        forked_name: plan.forkedName,
        connection_url_var: plan.connectionUrlVar,
        reset_cmd: plan.resetCmd,
      }
    }

    await writeSummary(this.#summaryDir, {
      name: lane.name,
      path: lane.path,
      branch: lane.branch,
      base_ref: this.#options.baseRef,
      created_at: new Date().toISOString(),
      state: {
        deps: { strategy: 'symlink', paths: ['node_modules'] },
        dev_db: db('dev'),
        test_db: db('test'),
        services: lane.services.map((service) => ({
          id: service.id,
          namespace: service.namespace,
          connection_url_var: service.urlVar,
          reset_cmd: service.resetCmd,
        })),
        compose: {
          project_name: lane.composeProject,
          override_path: lane.env['COMPOSE_FILE']?.split(delimiter)[1] ?? null,
          base_compose_file: lane.env['COMPOSE_FILE']?.split(delimiter)[0] ?? null,
          // The teardown manifest, and the reason each entry is on it.
          forked_volumes: (lane.compose?.volumes ?? []).map(({ key, name, reason }) => ({
            key,
            name,
            reason,
          })),
          ports_stripped_from: [...(lane.compose?.portsStrippedFrom ?? [])],
          published_ports: (lane.compose?.published ?? []).map((port) => ({
            service: port.service,
            target: port.target,
            published: port.published,
            env_var: port.envVar,
          })),
        },
      },
    })
  }
}
