/**
 * The workflow document's `project` block, in the terms the pool and the
 * doctor use.
 *
 * The two shapes differ only in casing, which is deliberate: the document is
 * snake_case like every other field a skill writes, and the package's own is
 * camelCase. `delivery: 'file'` is not a field a workflow may state — it is
 * what a SQLite database *is*, and offering the choice would only let a
 * document say something untrue.
 *
 * **It lives here so `run` and `doctor` share one conversion.** They did not.
 * `doctor` assembled its options without a project at all, so `needsCompose`
 * was handed `undefined` on every invocation and reported "docker compose: not
 * required by this project" for a workflow with a compose-delivered Postgres —
 * and `run`'s own preflight did the same. The check was right and nothing ever
 * reached it. One conversion in one place is what stops that recurring.
 */
import type { DatabaseSpec } from '../lanes/database.ts'
import type { ProjectSpec } from '../lanes/pool.ts'
import type { Project, ProjectDatabase } from '../types.ts'

export function projectSpec(project: Project | undefined): ProjectSpec {
  // Compose isolation even here. A workflow with no `project` block is one
  // whose lanes are "a worktree and nothing else" — which is a statement about
  // databases and dependencies, and never a request to let six lanes publish
  // the same host port and mount the same data volume. It costs nothing in a
  // project with no compose file, which is what "nothing else" usually means.
  if (project === undefined) return { databases: {}, migrateCmd: 'true', compose: {} }
  const { dev, test } = project.databases
  return {
    migrateCmd: project.migrate_cmd,
    databases: {
      ...(dev === undefined ? {} : { dev: databaseSpec(dev) }),
      ...(test === undefined ? {} : { test: databaseSpec(test) }),
    },
    envFiles: project.env_files,
    ...(project.setup_cmd === undefined ? {} : { setupCmd: project.setup_cmd }),
    services: Object.entries(project.services).map(([id, service]) => ({
      id,
      namespace: service.namespace,
      ...(service.url === undefined ? {} : { url: service.url }),
      urlVar: service.url_var,
      capacity: service.capacity,
      ...(service.create_cmd === undefined ? {} : { createCmd: service.create_cmd }),
      ...(service.reset_cmd === undefined ? {} : { resetCmd: service.reset_cmd }),
    })),
    ...(project.compose.enabled
      ? {
          compose: {
            publish: project.compose.publish,
            sharedVolumes: project.compose.shared_volumes,
          },
        }
      : {}),
  }
}

function databaseSpec(database: ProjectDatabase): DatabaseSpec {
  if (database.engine === 'sqlite') {
    return {
      engine: 'sqlite',
      delivery: 'file',
      path: database.path,
      connectionUrlVar: database.connection_url_var,
    }
  }
  return {
    engine: 'postgres',
    delivery: database.delivery,
    name: database.name,
    serverUrl: database.server_url,
    connectionUrlVar: database.connection_url_var,
  }
}
