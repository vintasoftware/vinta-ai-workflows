# Canned answers — bug (systematic-debugging interview)

Answer every question with the following; do not ask for anything else.

- **Repro command**: `npx vitest run src/pages/patient/allergies/AllergyPanel.test.tsx`
- **Expected**: the created allergy's substance is returned when reading the
  patient's allergies.
- **Actual**: read returns nothing — the written `AllergyIntolerance.patient`
  reference is malformed.
- **Constraint**: fix the write path under `src/pages/patient/allergies/`. Do NOT
  modify or weaken the test to make it pass.
- **No regressions**: the full `npx vitest run` suite must stay green.
- **Root cause over patch**: correct the reference construction, don't special-case
  the test input.
- **Commit**: a single `fix(...)` conventional commit touching the create path.
