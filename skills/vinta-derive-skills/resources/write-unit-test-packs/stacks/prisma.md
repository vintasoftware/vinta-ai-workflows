# Prisma stack pack

Prisma (data layer) testing — DB isolation, real-DB vs mock, seeding. Loaded **only when the project uses Prisma** (`@prisma/client`), alongside the runner pack (Vitest / Jest) and any web-framework stack pack. Read with the skill's universal rules.

## Real test DB over a mocked client

- **Test queries against a real (SQLite/Postgres) test database**, not a mocked `PrismaClient`. Mocking the client (`jest-mock-extended`, `prisma-mock`) means your `where`/relations/constraints/`select` never run — the test passes on a query that would throw in production. Point `DATABASE_URL` at a disposable test DB and apply migrations in global setup (`prisma migrate deploy` / `db push`).
- **Mock only at the port, not the client.** If the unit under test is pure business logic that takes a repository/port, inject a fake repo — don't mock `PrismaClient`. If you're testing the query/persistence itself, use the real DB.

## DB isolation

- **Wrap each test in a transaction rolled back at teardown** — an interactive `$transaction` handle passed to the code, rolled back after (helpers like `@chax-at/transactional-prisma-testing` automate it), or a per-test truncation of the tables touched. Each test starts clean; no manual delete scattered around.
- **`$disconnect()` in teardown** (global) — leaked connections exhaust the pool and hang the suite.
- Never depend on test ordering or on rows another test created.

## Test data

- Seed with small factory helpers that spell out only the fields the assertion needs and let schema defaults fill the rest — not deep nested `create` literals copy-pasted across tests.
- Reset to a known baseline between tests via the rollback/truncate above, not a shared mutable seed.

## Assertions

- **Read the row back and assert its fields by value** (`await prisma.user.findUnique(...)` → assert the object), not `count` alone — a count passes for the wrong row. For relations, `include` them and assert their contents.
- After a write, assert the persisted state from a fresh read, not the in-memory input you passed in.

## Pitfalls

- Mocking `PrismaClient` then asserting the mock was called — tests the mock, not the query.
- `expect(await prisma.x.count()).toBe(1)` as the whole assertion — asserts a count, not the right record.
- No `$disconnect()` / shared client across tests — connection leaks and cross-test bleed.
- Truncating in `beforeEach` as a cleanup crutch instead of transaction rollback — slower and hides ordering bugs.
