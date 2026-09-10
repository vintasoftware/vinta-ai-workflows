/**
 * The fixture project's whole test suite: it proves the lane it runs in has a
 * migrated, empty test database of its own. Exits non-zero when it does not,
 * so a gate runner reading the exit code sees a real pass/fail.
 *
 * Deliberately not named `*.test.mjs`: this file belongs to the fixture project,
 * and vinta-flow's own vitest run must not collect it.
 */
import Database from 'better-sqlite3'
import assert from 'node:assert/strict'

const target = process.env.TEST_DATABASE_URL
assert.ok(target, 'TEST_DATABASE_URL is not set')

const db = new Database(target, { readonly: true })
const count = db.prepare('SELECT count(*) FROM widgets').pluck().get()
db.close()

assert.equal(count, 0, 'test database is not empty — a sibling lane is sharing it')
