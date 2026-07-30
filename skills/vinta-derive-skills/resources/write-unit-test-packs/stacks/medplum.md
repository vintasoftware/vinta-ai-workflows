# Medplum stack pack

Medplum-specific testing — the mock client, FHIR resources, bots, React providers. Loaded **only when the project uses Medplum** (`@medplum/core` / `@medplum/react`), alongside the runner pack (Vitest / Jest). Read with the skill's universal rules.

## Mock client, never a real server

- **`MockClient` from `@medplum/mock`** stands in for `MedplumClient` — it holds an in-memory FHIR store, so `createResource` / `readResource` / `searchResources` run for real against fake data. Never point tests at a real Medplum server; there is no exception.
- Give each test its own `MockClient` (or reset between tests) so resources one test creates don't leak into the next.
- Seed only the resources the assertion needs; let the mock default the rest.

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
