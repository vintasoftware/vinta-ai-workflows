/**
 * Which database a lane gets, and how it is made — expressed in
 * `prepare-worktree`'s terms rather than reinvented.
 *
 * `vinta-ai-maestro` does not own database provisioning; the skill does. What the
 * daemon owns is the pool-level consequence of running N lanes at once: the
 * names must not collide, the template must be built once, and every forked DB
 * must carry the `reset_cmd` that decides whether its lane survives a migration
 * boundary. All of that is a pure function of the project spec and the lane
 * name, which is why the Postgres and compose paths can be checked here without
 * a server or a container anywhere in sight.
 *
 * These strings are *command lines*, recorded in the lane summary and re-run
 * later — by this daemon or by the skill reading that file — so they have to be
 * lines the machine's own shell understands. Which shell that is, how a value
 * is quoted for it, how a file is copied or deleted in it, and which separator
 * the paths inside it are built with all come from `src/platform/platform.ts`;
 * `platform` is a parameter here so both answers are decidable from either kind
 * of machine.
 *
 * Every path this module builds is a *filesystem* path, destined for `cp`,
 * `rm`, `copy` or `del`, so every one of them is joined through `joinPath`.
 * None of them is a git path — those are posix on every platform and are built
 * elsewhere.
 */
import {
  type Platform,
  copyFileCommand,
  joinPath,
  removeFileCommand,
  shellQuote,
} from '../platform/platform.ts'

export type DatabaseRole = 'dev' | 'test'

/** A file-delivered database: the lane gets its own copy of the file. */
export interface SqliteSpec {
  readonly engine: 'sqlite'
  readonly delivery: 'file'
  /** Repo-relative path of the database file, e.g. `db.sqlite3`. */
  readonly path: string
  readonly connectionUrlVar: string
}

/**
 * A Postgres database, either on a server the lane merely connects to
 * (`external`) or one the lane's own compose stack boots (`compose`).
 */
export interface PostgresSpec {
  readonly engine: 'postgres'
  readonly delivery: 'external' | 'compose'
  /** The main checkout's database name; lane names are derived from it. */
  readonly name: string
  /** Server the database lives on, without the database path segment. */
  readonly serverUrl: string
  readonly connectionUrlVar: string
}

export type DatabaseSpec = SqliteSpec | PostgresSpec

/** What one lane's copy of one database is called and how it is (re)made. */
export interface DatabasePlan {
  readonly role: DatabaseRole
  readonly engine: DatabaseSpec['engine']
  readonly delivery: DatabaseSpec['delivery']
  /** Forked database name, or absolute file path for a file-delivered engine. */
  readonly forkedName: string
  readonly connectionUrlVar: string
  readonly connectionUrl: string
  /** Materializes the lane's database from the template. */
  readonly cloneCmd: string | null
  /** Returns it to the template's state. Null means the lane is single-use. */
  readonly resetCmd: string | null
}

/**
 * The pool's one serialization point: built or refreshed once, then cloned per
 * lane. `setupCmd` runs first, then the project's own migrate command with
 * `env` applied, so the template is a migrated but unseeded database.
 */
export interface TemplatePlan {
  readonly role: DatabaseRole
  readonly name: string
  readonly setupCmd: string
  readonly env: Readonly<Record<string, string>>
}

export interface LaneDbContext {
  readonly laneName: string
  readonly lanePath: string
  readonly templatesDir: string
}

/** Quote for whichever shell these commands will reach on this machine. */
const sq = (value: string, platform?: Platform): string => shellQuote(value, platform)

/** Lane names are already kebab-case; database identifiers cannot hold dashes. */
const dbSuffix = (laneName: string): string => laneName.replaceAll('-', '_')

/**
 * Where one role's template file lives.
 *
 * The repo-relative `spec.path` is flattened into a single filename rather than
 * recreated as a tree, so one flat directory holds every template and a spec
 * naming `data/db.sqlite3` needs no `mkdir -p` before the setup line runs.
 * That flattening is the only `/` here that is *not* a separator, which is why
 * the join around it goes through `joinPath`: `templatesDir` is native, and an
 * interpolated `/` would mix separators on Windows and hand `copy` an argument
 * beginning with a switch character.
 */
const templatePath = (
  role: DatabaseRole,
  spec: SqliteSpec,
  templatesDir: string,
  platform?: Platform,
): string => joinPath([templatesDir, `${role}-${spec.path.replaceAll('/', '-')}`], platform)

/**
 * Returns null for compose-delivered databases: those are not cloned from a
 * template, they are a server the lane boots on its own forked volume. That is
 * also why they have no reset — see `planDatabase`.
 */
export function planTemplate(
  role: DatabaseRole,
  spec: DatabaseSpec,
  templatesDir: string,
  platform?: Platform,
): TemplatePlan | null {
  if (spec.engine === 'sqlite') {
    const name = templatePath(role, spec, templatesDir, platform)
    return {
      role,
      name,
      setupCmd: removeFileCommand(name, platform),
      env: { [spec.connectionUrlVar]: name },
    }
  }
  if (spec.delivery === 'compose') return null

  const name = `${spec.name}_wt_template`
  // `&&` means the same thing in both shells; only the quoting differs.
  return {
    role,
    name,
    setupCmd: `dropdb --if-exists ${sq(name, platform)} && createdb ${sq(name, platform)}`,
    env: { [spec.connectionUrlVar]: `${spec.serverUrl}/${name}` },
  }
}

export function planDatabase(
  role: DatabaseRole,
  spec: DatabaseSpec,
  ctx: LaneDbContext,
  platform?: Platform,
): DatabasePlan {
  if (spec.engine === 'sqlite') {
    const template = templatePath(role, spec, ctx.templatesDir, platform)
    // `spec.path` is repo-relative and written posix-style whatever the machine,
    // so it carries its own separators into the lane's absolute path; joining
    // through the seam is what turns `data/db.sqlite3` into `data\db.sqlite3`
    // under a native `lanePath` instead of leaving the two mixed.
    const forkedName = joinPath([ctx.lanePath, spec.path], platform)
    const copy = copyFileCommand(template, forkedName, platform)
    return {
      role,
      engine: 'sqlite',
      delivery: 'file',
      forkedName,
      connectionUrlVar: spec.connectionUrlVar,
      connectionUrl: forkedName,
      cloneCmd: copy,
      resetCmd: copy,
    }
  }

  if (spec.delivery === 'compose') {
    // The lane boots its own server on its own forked volume, so the database
    // name never needs namespacing — `COMPOSE_PROJECT_NAME` is the isolation
    // key. There is no template to clone from and therefore nothing to reset
    // to: the lane is single-use, and the pool re-provisions it instead.
    return {
      role,
      engine: 'postgres',
      delivery: 'compose',
      forkedName: spec.name,
      connectionUrlVar: spec.connectionUrlVar,
      connectionUrl: `${spec.serverUrl}/${spec.name}`,
      cloneCmd: null,
      resetCmd: null,
    }
  }

  const template = `${spec.name}_wt_template`
  const forkedName = `${spec.name}_wt_${dbSuffix(ctx.laneName)}`
  return {
    role,
    engine: 'postgres',
    delivery: 'external',
    forkedName,
    connectionUrlVar: spec.connectionUrlVar,
    // application_name makes a runaway lane greppable in pg_stat_activity.
    connectionUrl: `${spec.serverUrl}/${forkedName}?application_name=wt-${ctx.laneName}`,
    cloneCmd: `createdb -T ${sq(template, platform)} ${sq(forkedName, platform)}`,
    resetCmd:
      `dropdb --if-exists ${sq(forkedName, platform)} && ` +
      `createdb -T ${sq(template, platform)} ${sq(forkedName, platform)}`,
  }
}
