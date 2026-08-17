# Bug report — Allergy panel writes the wrong patient reference field

The allergy panel's "add allergy" path saves an `AllergyIntolerance` whose
patient linkage is wrong, so the new allergy doesn't come back when we read the
patient's allergies.

There is a **currently-failing** Vitest test that reproduces it:

    src/pages/patient/allergies/AllergyPanel.test.tsx

It creates an allergy for a patient, then reads the patient's allergies and
asserts the created substance is present. The read returns nothing because the
written resource's `patient` reference is malformed.

Debug it with `/systematic-debugging`, find the root cause in the write path
under `src/pages/patient/allergies/`, fix it, and make the failing test pass
without breaking any other test.

The planted defect is the ground truth: the fix must correct the
`AllergyIntolerance.patient` reference in the create path — not weaken the test.
