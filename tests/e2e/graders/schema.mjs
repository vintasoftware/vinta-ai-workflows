// schema.mjs — a *minimal* JSON-Schema-subset validator + schema graders.
//
// The harness must be dependency-free (the repo ships with only `yaml` as a
// dev dep), so rather than pull in ajv we implement just the keywords our
// sample payloads and generated artifacts actually use: type, required,
// properties, additionalProperties (bool), enum, const, pattern, minLength,
// items, minItems. This is deliberately small — it validates the shapes this
// repo produces, not arbitrary Draft 2020-12.

import { loadJson, readText } from '../runner/lib.mjs';

const TYPE_CHECKS = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === 'string',
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === 'number',
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
};

export function validate(schema, data, path = '') {
  const errors = [];
  const at = path || '(root)';

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => TYPE_CHECKS[t]?.(data))) {
      errors.push(`${at}: expected type ${types.join('|')}, got ${describe(data)}`);
      return errors; // no point checking further against the wrong type
    }
  }

  if ('const' in schema && !deepEqual(schema.const, data)) {
    errors.push(`${at}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(data)}`);
  }

  if (schema.enum && !schema.enum.some((e) => deepEqual(e, data))) {
    errors.push(`${at}: ${JSON.stringify(data)} not in enum ${JSON.stringify(schema.enum)}`);
  }

  if (typeof data === 'string') {
    if (schema.minLength != null && data.length < schema.minLength) {
      errors.push(`${at}: string shorter than minLength ${schema.minLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) {
      errors.push(`${at}: string does not match pattern ${schema.pattern}`);
    }
  }

  if (Array.isArray(data)) {
    if (schema.minItems != null && data.length < schema.minItems) {
      errors.push(`${at}: array shorter than minItems ${schema.minItems}`);
    }
    if (schema.items) {
      data.forEach((item, i) => errors.push(...validate(schema.items, item, `${at}[${i}]`)));
    }
  }

  if (TYPE_CHECKS.object(data) && (schema.properties || schema.required || 'additionalProperties' in schema)) {
    for (const key of schema.required || []) {
      if (!(key in data)) errors.push(`${at}: missing required property "${key}"`);
    }
    const props = schema.properties || {};
    for (const [key, val] of Object.entries(data)) {
      if (props[key]) {
        errors.push(...validate(props[key], val, path ? `${path}.${key}` : key));
      } else if (schema.additionalProperties === false) {
        errors.push(`${at}: additional property "${key}" not allowed`);
      }
    }
  }

  return errors;
}

function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    const ka = Object.keys(a); const kb = Object.keys(b);
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

// Validate a data object against a schema file on disk. Returns {ok, errors}.
export function validateFile(schemaPath, data) {
  const schema = loadJson(schemaPath);
  const errors = validate(schema, data);
  return { ok: errors.length === 0, errors };
}

// Parse YAML frontmatter (--- ... ---) from a markdown file body. Returns the
// raw frontmatter block string, or null. We only need presence + a couple of
// scalar keys, so a tiny line parser beats pulling in a YAML dep here.
export function frontmatter(text) {
  if (!text) return null;
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const obj = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (mm) obj[mm[1]] = mm[2].replace(/^["']|["']$/g, '').trim();
  }
  return { raw: m[1], fields: obj };
}

export { readText };
