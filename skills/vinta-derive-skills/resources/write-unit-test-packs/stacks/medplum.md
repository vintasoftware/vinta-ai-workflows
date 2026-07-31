# Medplum stack pack

Medplum-specific testing — the mock client, FHIR resources, bots, React providers. Loaded **only when the project uses Medplum** (`@medplum/core` / `@medplum/react`), alongside the runner pack (Vitest / Jest). Read with the skill's universal rules.

## Mock client, never a real server

- **`MockClient` from `@medplum/mock`** stands in for `MedplumClient` — it holds an in-memory FHIR store, so `createResource` / `readResource` / `searchResources` run for real against fake data. Never point tests at a real Medplum server; there is no exception.
- Give each test its own `MockClient` (or reset between tests) so resources one test creates don't leak into the next.
- Seed only the resources the assertion needs; let the mock default the rest.

## Search filtering — indexed once at setup, never per test

- **`MockClient` search filters only work if the FHIR search parameters are indexed in the test process.** Symptom: a resource comes back from an unfiltered `searchResources`, but `searchResources` / `searchOne` **with** a filter (`family=`, `birthdate=`, …) silently returns nothing. That means the index is missing, not that your data is wrong.
- This is wired **once** at bootstrap via two Vitest setup files: `test.globalSetup.ts` (indexes the bundles once in the main process, shares `globalSchema.types` to workers) registered under `test.globalSetup`, and `test.setup.ts` (assigns the shared index at module scope) registered under `test.setupFiles`. **Do not add `indexStructureDefinitionBundle` / `indexSearchParameterBundle` inside a test or a per-test `beforeAll`** — rely on the project-level setup. If filters mysteriously fail, check both files are registered in `vitest.config.*`, not that each test indexes.
- One deliberate exception: `validateResource` (or anything reading @medplum/core's type store) **before any resource is created** throws `Unknown data type` — index structure definitions in that one test if you hit it.
- Version alignment matters: `@medplum/core`, `@medplum/definitions`, `@medplum/mock`, and `@medplum/fhirtypes` must be on **matching versions** — a skew causes confusing index/search failures.

## FHIR resource assertions

- Assert on the **resource fields you care about by value** — `patient.name[0].family`, `observation.valueQuantity.value` — not just `resource.id` truthiness or a search count. A wrong resource with an id still passes a truthiness check.
- When asserting a search result, assert the matched resources' contents, not only `bundle.entry.length`.
- Build resources as typed `@medplum/fhirtypes` objects (or a small factory helper), not loosely-typed literals copied across tests.

## Bots

- A bot's `handler(medplum, event)` is a plain function — unit-test it by calling it with a `MockClient` and a constructed `BotEvent` input, then assert the resources it wrote (read them back from the mock) and the value it returned.
- Mock outbound integrations the bot calls (external HTTP, `sendEmail`) at the boundary; don't mock the `medplum` client — use `MockClient`.

## React components (with `@medplum/react`)

- Wrap rendered components in **`MedplumProvider` with a `MockClient`** (Testing Library). Query by role/text; assert rendered output. See the runner pack's Testing Library notes.
- Let components fetch through the `MockClient`; use `await screen.findBy...` for the async load rather than mocking the fetch.

## Pitfalls

- Sharing one `MockClient` across tests without reset — resources bleed between tests.
- Asserting `resource.id` is defined instead of the fields the code set.
- Mocking `MedplumClient` methods by hand instead of using `MockClient` — you re-implement the store and test the mock.
