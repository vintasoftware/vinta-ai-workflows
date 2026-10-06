/**
 * The two directories every command agrees on.
 *
 * `.vinta-ai-maestro/` is §5.3's store, and §11 is emphatic that it stays *inside the
 * project* — transcripts and gate logs hold repository contents verbatim, so a
 * global cache directory would move a client repo's source into a location the
 * project's own retention policy does not reach. Both paths are derived here so
 * no command can quietly disagree about where that store is, which is what
 * `purge` depends on to know what it is allowed to delete.
 */
import { join } from 'node:path'

/** §5.3's store, inside the project and gitignored. */
export const storeFor = (repoPath: string): string => join(repoPath, '.vinta-ai-maestro')

/** Run directories: `.vinta-ai-maestro/runs/<run-id>`. The only thing `purge` removes. */
export const runsRootFor = (repoPath: string): string => join(storeFor(repoPath), 'runs')

/** Where lane worktrees are provisioned — `LanePool`'s `poolRoot`. */
export const laneRootFor = (repoPath: string): string => join(storeFor(repoPath), 'lanes')
