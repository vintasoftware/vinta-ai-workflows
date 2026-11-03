#!/usr/bin/env node
// @ts-nocheck
/**
 * Validates every JSON Schema under `schemas/`, and the payloads meant to
 * exercise them.
 *
 * Two checks:
 *
 * 1. **Every schema compiles** under Ajv's strict Draft 2020-12 mode. A typo'd
 *    keyword (`requried`), a `$ref` that points nowhere or an `if` with no
 *    `then` is silently ignored by a lenient validator, which is how a schema
 *    stops checking the thing it was written to check.
 * 2. **Every fixture validates the way its directory says it should.**
 *    `tests/schema-fixtures/<schema-file-stem>/valid/*` must pass and
 *    `.../invalid/*` must fail. Fixtures are `.json`, `.yaml` / `.yml`, or a
 *    `.md` file whose YAML frontmatter is the payload (the shape the
 *    prs-context files take). A schema's conditional rules are only as good as
 *    the fixture that proves each branch.
 *
 * Usage:
 *   node scripts/validate-schemas.mjs            # everything
 *   node scripts/validate-schemas.mjs <file>...  # validate payloads against
 *                                                # the schema their `$schema`
 *                                                # comment / key names
 *
 * Exit 0 when clean, 1 on any failure, 2 on a usage error.
 *
 * Source-side only: never shipped (excluded by `files`), so it may use the
 * root devDependencies `ajv`, `ajv-formats` and `yaml`.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { parse as parseYaml } from 'yaml'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCHEMAS = join(ROOT, 'schemas')
const FIXTURES = join(ROOT, 'tests', 'schema-fixtures')

/** Every `*.schema.json`, keyed by file name (`foo.v1.schema.json`). */
function loadSchemas() {
  const schemas = new Map()
  for (const file of readdirSync(SCHEMAS).sort()) {
    if (!file.endsWith('.schema.json')) continue
    schemas.set(file, JSON.parse(readFileSync(join(SCHEMAS, file), 'utf8')))
  }
  return schemas
}

function makeAjv() {
  // Strict, minus two lints that refuse valid 2020-12: `allowUnionTypes` for
  // `"type": ["string", "null"]`, and `strictRequired` for a `required` inside
  // `if` / `then` naming a property the enclosing object declares — the shape
  // every conditional rule in these schemas takes.
  const ajv = new Ajv2020({
    strict: true,
    strictRequired: false,
    allErrors: true,
    allowUnionTypes: true,
  })
  addFormats(ajv)
  return ajv
}

/** The payload a fixture file holds. */
function readPayload(path) {
  const raw = readFileSync(path, 'utf8')
  switch (extname(path)) {
    case '.json':
      return JSON.parse(raw)
    case '.yaml':
    case '.yml':
      return parseYaml(raw)
    case '.md': {
      const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
      if (match === null) throw new Error('no YAML frontmatter')
      return parseYaml(match[1])
    }
    default:
      throw new Error(`unsupported fixture extension ${extname(path)}`)
  }
}

/** The schema a payload file names, via `$schema` or a yaml-language-server comment. */
function schemaNamedBy(path, payload) {
  const named =
    (payload && typeof payload === 'object' && payload.$schema) ||
    /yaml-language-server:\s*\$schema=(\S+)/.exec(readFileSync(path, 'utf8'))?.[1]
  return named ? basename(named) : null
}

function formatErrors(errors) {
  return (errors ?? [])
    .map((error) => `      ${error.instancePath || '/'} ${error.message}`)
    .join('\n')
}

function run(argv) {
  const schemas = loadSchemas()
  const ajv = makeAjv()
  const failures = []
  let checked = 0

  for (const [file, schema] of schemas) {
    try {
      ajv.addSchema(schema, file)
      ajv.getSchema(file)
      checked += 1
    } catch (error) {
      failures.push(`${file}: does not compile — ${error.message}`)
    }
  }

  const check = (path, schemaFile, expectValid) => {
    const validate = ajv.getSchema(schemaFile)
    const where = relative(ROOT, path)
    if (validate === undefined) {
      failures.push(`${where}: no schema ${schemaFile}`)
      return
    }
    let payload
    try {
      payload = readPayload(path)
    } catch (error) {
      failures.push(`${where}: unreadable — ${error.message}`)
      return
    }
    // A `$schema` key is an editor pointer, not payload — unless the schema
    // itself declares it, as `workflow.v1` does.
    const declares = schemas.get(schemaFile)?.properties?.$schema !== undefined
    if (!declares && payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const { $schema: _, ...rest } = payload
      payload = rest
    }
    checked += 1
    const valid = validate(payload)
    if (valid && !expectValid) failures.push(`${where}: expected invalid, but it passed ${schemaFile}`)
    if (!valid && expectValid) {
      failures.push(`${where}: fails ${schemaFile}\n${formatErrors(validate.errors)}`)
    }
  }

  if (argv.length > 0) {
    for (const arg of argv) {
      const path = resolve(arg)
      if (!existsSync(path)) {
        console.error(`no such file: ${arg}`)
        return 2
      }
      let schemaFile
      try {
        schemaFile = schemaNamedBy(path, readPayload(path))
      } catch (error) {
        failures.push(`${arg}: unreadable — ${error.message}`)
        continue
      }
      if (schemaFile === null) {
        failures.push(`${arg}: names no schema ($schema key or yaml-language-server comment)`)
        continue
      }
      check(path, schemaFile, true)
    }
  } else if (existsSync(FIXTURES)) {
    for (const dir of readdirSync(FIXTURES).sort()) {
      const schemaFile = `${dir}.schema.json`
      if (!schemas.has(schemaFile)) {
        failures.push(`tests/schema-fixtures/${dir}: no schemas/${schemaFile}`)
        continue
      }
      for (const [sub, expectValid] of [['valid', true], ['invalid', false]]) {
        const folder = join(FIXTURES, dir, sub)
        if (!existsSync(folder) || !statSync(folder).isDirectory()) continue
        for (const file of readdirSync(folder).sort()) check(join(folder, file), schemaFile, expectValid)
      }
    }
  }

  for (const failure of failures) console.error(`ERROR ${failure}`)
  console.log(`${checked} schemas + payloads checked — ${failures.length} errors.`)
  return failures.length === 0 ? 0 : 1
}

process.exitCode = run(process.argv.slice(2))
