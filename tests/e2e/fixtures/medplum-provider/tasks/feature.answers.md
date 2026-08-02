# Canned answers — feature (create-spec / plan-feature interview)

Answer every interview question these skills ask with the following. Do not ask
for anything else; if something is genuinely missing, state the assumption and
proceed.

- **Scope**: read + create only. No edit/delete of allergies in this iteration.
- **Where it lives**: patient detail page, a new `AllergyPanel` component under
  `src/pages/patient/allergies/`.
- **Data model**: FHIR `AllergyIntolerance`, `patient` reference to the current
  patient, substance in `code.text`, `criticality`, `clinicalStatus`.
- **FHIR/server behavior**: MockClient only — no access policies, subscriptions,
  or server-only operations. Everything must be provable offline.
- **Testing**: Vitest against `MockClient`, wrapped in `MedplumProvider`. Assert
  on resource field values (`code.text`, `patient` reference), never on
  unfiltered search counts (MockClient ships pre-seeded resources).
- **Auth / tenancy**: single-tenant fixture; no `meta.account` tenant scoping.
- **UI framework**: Mantine components, consistent with the existing app.
- **Out of scope**: reactions/manifestations, onset dates, notes, i18n.
- **Branching**: stacked `plan/<feature>/phase-N` branches per the plan.
- **Commits**: conventional commits; keep spec, plan, and code in separate commits.
