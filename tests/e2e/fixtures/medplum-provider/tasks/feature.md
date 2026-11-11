# Feature request — Patient allergy panel

Add a **patient allergy panel** to the provider app.

- On a patient's detail page, show a panel listing that patient's
  `AllergyIntolerance` resources: the substance (`code.text`), clinical status,
  and criticality.
- Let a provider **add** a new allergy for the patient (substance + criticality),
  which writes a new `AllergyIntolerance` resource referencing the patient.
- The panel reads and writes through the Medplum client (in tests, `MockClient`).

Success = a provider can view a patient's allergies and record a new one, and
the behavior is covered by Vitest tests running offline against `MockClient`.
