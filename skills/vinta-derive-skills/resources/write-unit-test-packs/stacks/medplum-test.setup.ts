// @ts-nocheck
// Bundled verbatim from vintasoftware/medplum-snippet-catalog → TestSetup/test.setup.ts
// Source: https://github.com/vintasoftware/medplum-snippet-catalog/tree/main/TestSetup
// Retrieved: 2026-07-31. The catalog is canonical — if it has advanced past this copy, prefer it.
// Install as (e.g.) `src/test.setup.ts` and register in Vitest config `test.setupFiles`.
// Requires its companion `test.globalSetup.ts` in `test.globalSetup` (it provides globalSchemaTypes).

// Assert that the versions of @medplum/core, @medplum/definitions, @medplum/mock and
// @medplum/fhirtypes match.
import { globalSchema } from '@medplum/core';
import { inject } from 'vitest';

// This runs at module scope on purpose, not inside beforeAll. Vitest runs setup files once per
// test file, but a test file's own module body is evaluated *before* any beforeAll hook
// registered here. Fixtures built at module scope would otherwise search against an empty
// schema and silently match nothing:
//
//   const medplum = new MockClient();
//   await medplum.createResource({ resourceType: 'Patient', ... });
//   const preloaded = await medplum.searchResources('Patient', 'family=Xu'); // 0 results
const globalSchemaTypes = inject('globalSchemaTypes');

if (!globalSchemaTypes) {
  throw new Error(
    'globalSchemaTypes was not provided. Add test.globalSetup.ts to `globalSetup` in your Vitest config.'
  );
}

// Search parameters were indexed once by test.globalSetup.ts. `globalSchema.types` holds
// nothing but plain data, so it survives the trip from the main process to this worker.
// This is what MockClient's search matching reads, and it is the whole reason this file
// exists: without it, filters like `family=` or `birthdate=` silently match nothing.
globalSchema.types = globalSchemaTypes;

// Structure definitions are deliberately *not* indexed here. MockClient indexes them itself
// on its first write, so doing it up front only moves the same ~35 MB parse earlier.
// The one exception: calling validateResource (or anything else that reads @medplum/core's
// internal type store) before any resource has been created throws "Unknown data type".
// Index them in that individual test if you need it.
