/**
 * The fixture project's migration runner — the command the lane manager runs
 * once against the template database.
 *
 * It appends one line per invocation to `$VINTA_FIXTURE_MIGRATE_LOG` when that
 * variable is set. That log is how the test suite counts template creations
 * from outside the pool, rather than trusting a counter the pool keeps itself.
 */
import Database from 'better-sqlite3'
import { appendFileSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The lane manager runs this once per template, with that template's own
// connection variable set — the dev template's and the test template's differ.
const target = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL
if (!target) throw new Error('no database connection variable is set')

const migrations = join(dirname(dirname(fileURLToPath(import.meta.url))), 'migrations')
const db = new Database(target)
db.exec('CREATE TABLE IF NOT EXISTS applied_migrations (name TEXT PRIMARY KEY)')

const already = new Set(db.prepare('SELECT name FROM applied_migrations').pluck().all())
for (const name of readdirSync(migrations).sort()) {
  if (already.has(name)) continue
  db.exec(readFileSync(join(migrations, name), 'utf8'))
  db.prepare('INSERT INTO applied_migrations (name) VALUES (?)').run(name)
}
db.close()

const log = process.env.VINTA_FIXTURE_MIGRATE_LOG
if (log) appendFileSync(log, `${target}\n`)
