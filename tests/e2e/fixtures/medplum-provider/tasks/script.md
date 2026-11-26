# One-off script request — Export a patient's observations to CSV

Write a one-off script that emits a CSV of all `Observation` values for a given
patient.

- Input: a patient id (default to a seeded fixture patient if none supplied).
- Output: `observations.csv` with columns `code,value,unit,effectiveDateTime`,
  one row per `Observation` for that patient.
- It must run **non-interactively** against a seeded `MockClient` (or a bundled
  fixture bundle) — no live Medplum server, no prompts.

Use `/add-one-off-script`. Success = the script exists in the expected location,
runs to completion without interaction, and produces the CSV with the expected
columns.
