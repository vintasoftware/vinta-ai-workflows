// @ts-nocheck
// Bundled verbatim from vintasoftware/medplum-snippet-catalog → TestSetup/test.globalSetup.ts
// Source: https://github.com/vintasoftware/medplum-snippet-catalog/tree/main/TestSetup
// Retrieved: 2026-07-31. The catalog is canonical — if it has advanced past this copy, prefer it.
// Install as (e.g.) `src/test.globalSetup.ts` and register in Vitest config `test.globalSetup`.

// Assert that the versions of @medplum/core, @medplum/definitions, @medplum/mock and
// @medplum/fhirtypes match.
import type { IndexedStructureDefinition } from '@medplum/core';
import type { Bundle, SearchParameter } from '@medplum/fhirtypes';
import type { TestProject } from 'vitest/node';

export default async function setup(project: TestProject): Promise<void> {
  // @medplum/core v5 references WebSocket at module-load time. This file runs in the Vitest
  // main process, where WebSocket is only guaranteed as a global on Node >= 22.4. It has to be
  // polyfilled *before* @medplum/core is loaded, which is why the imports below are dynamic and
  // only the (erased) type imports sit at the top of the file.
  if (typeof globalThis.WebSocket === 'undefined') {
    try {
      const ws = await import('ws');
      (globalThis as Record<string, unknown>).WebSocket = ws.default ?? ws.WebSocket;
    } catch {
      throw new Error(
        '@medplum/core needs a global WebSocket. Upgrade to Node >= 22.4, or add "ws" as a dev dependency.'
      );
    }
  }

  const { globalSchema, indexSearchParameterBundle, indexStructureDefinitionBundle } = await import('@medplum/core');
  const { readJson, SEARCH_PARAMETER_BUNDLE_FILES } = await import('@medplum/definitions');

  // Initialize FHIR
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-medplum.json') as Bundle);
  for (const filename of SEARCH_PARAMETER_BUNDLE_FILES) {
    indexSearchParameterBundle(readJson(filename) as Bundle<SearchParameter>);
  }

  // `globalSchema.types` is plain JSON-serializable data, so it can be handed to every test
  // worker instead of each one re-reading and re-indexing the search parameter bundles.
  // See test.setup.ts for the consuming side.
  project.provide('globalSchemaTypes', globalSchema.types);
}

export function teardown(): void {
  // Nothing to do.
}

declare module 'vitest' {
  export interface ProvidedContext {
    globalSchemaTypes: IndexedStructureDefinition['types'];
  }
}
