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
 * Teardown is never automatic. A finished run leaves its worktrees, branches
 * and databases in place — they are the evidence a human reads when something
 * went wrong, and the skill's teardown steps reverse them from the summary.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, symlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { isWindows, shellInvocation, spawnOptionsFor } from '../platform/platform.ts'
import {
  type DatabasePlan,
  type DatabaseRole,
  type DatabaseSpec,
  planDatabase,
  planTemplate,
} from './database.ts'
import { DiskProbeError, measureBytes, probePoolDisk } from './disk.ts'
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

/**
 * A lane that could not be handed on. Carries the lane name and which half of
 * the recycle failed, and nothing else: a reset command's own output is the
 * project's data — rows, paths, migration names — and §11 keeps it out of
 * error messages the same way it keeps it out of log fields.
 */
export class LaneRecycleError extends Error {
  constructor(
    readonly lane: string,
    readonly stage: 'worktree' | 'database' | 'reprovision',
  ) {
    super(`lane "${lane}" could not be recycled (${stage})`)
    this.name = 'LaneRecycleError'
  }
}

export interface ProjectSpec {
  readonly databases: { readonly dev?: DatabaseSpec; readonly test?: DatabaseSpec }
  /** The project's own migrate command, run once per template. */
  readonly migrateCmd: string
}

export interface PoolOptions {
  /** The main checkout every lane is a worktree of. */
  readonly repoPath: string
  /** Directory the lane worktrees are created under. */
  readonly poolRoot: string
  readonly runId: string
  readonly laneCount: number
  readonly baseRef: string
  readonly project: ProjectSpec
  /** Overrides the measured per-lane disk estimate the N× probe uses. */
  readonly perLaneBytes?: number
}

export interface Lane {
  readonly name: string
  readonly kind: 'lane' | 'integration'
  readonly path: string
  readonly branch: string
  readonly composeProject: string
  readonly databases: readonly DatabasePlan[]
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
    await pool.#probeDisk()
    await pool.#buildTemplates()

    const names: [string, Lane['kind']][] = [
      ...Array.from({ length: options.laneCount }, (_, i): [string, Lane['kind']] => [
        `${options.runId}-lane-${i + 1}`,
        'lane',
      ]),
      [`${options.runId}-integ`, 'integration'],
    ]
    // Lanes share nothing but the source repo, so past the template they are
    // provisioned concurrently.
    pool.#all = await Promise.all(names.map(([name, kind]) => pool.#provisionWorktree(name, kind)))
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
    if (plan.reusable) {
      await this.#restoreWorktree(lane, summary)
      try {
        for (const command of plan.commands) await sh(command, lane.path, lane.env)
      } catch {
        throw new LaneRecycleError(name, 'database')
      }
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

    const fresh = await this.#provisionWorktree(lane.name, lane.kind)
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
    try {
      await this.#git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
      return true
    } catch {
      return false
    }
  }

  #git(args: readonly string[]): Promise<unknown> {
    const turn = this.#gitTurn.then(() =>
      run('git', [...args], { cwd: this.#options.repoPath }),
    )
    this.#gitTurn = turn.catch(() => undefined)
    return turn
  }

  async #probeDisk(): Promise<void> {
    const { repoPath, poolRoot, laneCount, perLaneBytes } = this.#options
    const perLane = perLaneBytes ?? (await measureBytes(repoPath))
    // The integration worktree is a lane in every way that costs disk.
    const probe = await probePoolDisk(poolRoot, perLane, laneCount + 1)
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

  async #provisionWorktree(name: string, kind: Lane['kind']): Promise<Lane> {
    const { repoPath, poolRoot, baseRef, project } = this.#options
    const path = join(poolRoot, name)
    const branch = `wt/${name}`

    await mkdir(poolRoot, { recursive: true })
    await this.#git(['worktree', 'add', '-b', branch, path, baseRef])
    await this.#linkDeps(path)

    const databases: DatabasePlan[] = []
    for (const role of ROLES) {
      const spec = project.databases[role]
      if (!spec) continue
      const plan = planDatabase(role, spec, {
        laneName: name,
        lanePath: path,
        templatesDir: this.#templatesDir,
      })
      if (plan.cloneCmd) await sh(plan.cloneCmd, path, {})
      databases.push(plan)
    }

    // Set unconditionally: it is the isolation key for every `docker compose`
    // any project command might reach for, and it costs nothing when unused.
    const composeProject = `${basename(repoPath)}_${name}`
    const env: Record<string, string> = { COMPOSE_PROJECT_NAME: composeProject }
    for (const db of databases) env[db.connectionUrlVar] = db.connectionUrl

    const lane: Lane = {
      name,
      kind,
      path,
      branch,
      composeProject,
      databases,
      env,
      reusable: databases.every((db) => db.resetCmd !== null),
    }
    await this.#writeSummary(lane)
    return lane
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
        compose: { project_name: lane.composeProject },
      },
    })
  }
}
