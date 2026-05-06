// @ts-nocheck
// ^ This file is a TEMPLATE shipped as-is to consumer projects. Type-checking
//   happens in the target repo against its own tsconfig + @types/node +
//   @aws-sdk/client-s3 (optional, dynamic-imported at runtime). Inside this
//   tooling repo the file is content, not source — hence @ts-nocheck. Remove
//   the directive after copying into a consumer project so its tsconfig
//   validates the file properly.

/**
 * BaseOneOffScript — canonical scaffold for a Vinta one-off operational script (TS / Node 20+).
 *
 * Copy this file once into your project at `<scripts_dir>/_base.ts` (default
 * `scripts/one_off/_base.ts`) and reuse from every script. The `Runtime`
 * interface below is what `run-one-off-script-<stack>` skills override to plug
 * the script into a stack-specific surface (Medplum bot, Vercel Function,
 * Lambda, K8s Job, etc). The default `LocalRuntime` covers a plain CLI
 * invocation with filesystem state, PID-file single-instance lease,
 * SIGINT/SIGTERM stop handling, and optional S3 upload.
 *
 * Subclasses override only the per-script hooks:
 *   - describe(): string
 *   - iterTargets(): AsyncIterable<T>
 *   - process(item: T): Promise<void>
 *   - itemId(item: T): string
 *   - tablesTouched(): string[]                                    (destructive scripts only)
 *   - snapshot(item: T): Record<string, Record<string, unknown>>   (destructive scripts only)
 *   - applyRestoreRow(table, row): Promise<void>                   (only if restore needed)
 *
 * Engine methods (run, execute, safeProcess, writeBackup) call into Runtime —
 * DO NOT override them.
 *
 * See `add-one-off-script/SKILL.md` for the full contract this file enforces.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

// ============================================================================
// Configuration
// ============================================================================

export interface ScriptConfig {
  /** Stable identifier — typically the parent folder name (`<YYYY-MM-DD>-<descriptive-kebab>`). */
  name: string;
  /** Parent dir for run state. Per-script files land in `<logDir>/<name>/`. Default `.vinta-ai-workflows/one-off-runs`. */
  logDir?: string;
  /** Rows per chunk in iterTargets. Default 500. */
  batchSize?: number;
  /** Roll over to a new CSV chunk when (rows * cols) would exceed this. Default 1_000_000. */
  csvMaxCells?: number;
  /** fsync the log + processed-items file every N items. Default 50. */
  fsyncEvery?: number;
}

export interface ResolvedConfig extends Required<ScriptConfig> {}

export function resolveConfig(c: ScriptConfig): ResolvedConfig {
  return {
    name: c.name,
    logDir: c.logDir ?? ".vinta-ai-workflows/one-off-runs",
    batchSize: c.batchSize ?? 500,
    csvMaxCells: c.csvMaxCells ?? 1_000_000,
    fsyncEvery: c.fsyncEvery ?? 50,
  };
}

export type LogLevel = "INFO" | "WARN" | "ERROR";

// ============================================================================
// Runtime interface
// ============================================================================

/**
 * Pluggable surface the engine calls into. Default = `LocalRuntime`.
 * Stack-specific runners (Medplum bot, Vercel Function, Lambda, K8s Job)
 * extend this to adapt the contract to their surface.
 */
export abstract class Runtime {
  readonly config: ResolvedConfig;
  readonly runDir: string;

  constructor(config: ScriptConfig) {
    this.config = resolveConfig(config);
    this.runDir = join(this.config.logDir, this.config.name);
    mkdirSync(this.runDir, { recursive: true });
  }

  // ---- lifecycle ----
  abstract acquireLease(): void;
  abstract releaseLease(): void;
  abstract installStopHandler(onStop: (reason: string) => void): void;
  abstract shouldStop(): boolean;

  // ---- logging ----
  abstract log(level: LogLevel, message: string): void;
  abstract fsyncLog(): void;

  // ---- processed-items log (resume) ----
  abstract loadProcessedIds(): Set<string>;
  abstract markProcessed(itemId: string): void;

  // ---- artifact paths ----
  artifactPath(filename: string): string {
    return join(this.runDir, filename);
  }
  abstract listRunArtifacts(): string[];

  // ---- final upload ----
  abstract uploadRunArtifacts(): Promise<void>;
}

// ============================================================================
// LocalRuntime — default for a plain CLI invocation
// ============================================================================

export class LocalRuntime extends Runtime {
  private stop = false;
  private stopCount = 0;
  private logFd: number;
  private logPath: string;
  private processedPath: string;
  private leasePath: string;
  private s3Bucket: string | null;
  private s3Prefix: string;

  constructor(config: ScriptConfig, opts: { s3Bucket?: string; s3Prefix?: string } = {}) {
    super(config);
    this.logPath = join(this.runDir, "run.log");
    this.processedPath = join(this.runDir, "processed.txt");
    this.leasePath = join(this.runDir, "lease.pid");
    this.logFd = openSync(this.logPath, "a");
    this.s3Bucket = opts.s3Bucket ?? process.env.ONE_OFF_S3_BUCKET ?? null;
    const defaultPrefix = process.env.ONE_OFF_S3_PREFIX ?? `one-off-runs/${this.config.name}/`;
    this.s3Prefix = (opts.s3Prefix ?? defaultPrefix).replace(/\/+$/, "") + "/";
  }

  // ---- lease ----

  acquireLease(): void {
    if (existsSync(this.leasePath)) {
      const existing = readFileSync(this.leasePath, "utf8").trim();
      if (/^\d+$/.test(existing) && pidAlive(Number(existing))) {
        throw new Error(
          `lease ${this.leasePath} held by live process ${existing} — ` +
            "another instance is running. Stop it before starting a new run.",
        );
      }
    }
    writeFileSync(this.leasePath, String(process.pid));
  }

  releaseLease(): void {
    try {
      unlinkSync(this.leasePath);
    } catch {
      // already gone
    }
  }

  // ---- stop ----

  installStopHandler(onStop: (reason: string) => void): void {
    const handler = (signal: NodeJS.Signals) => {
      this.stopCount++;
      if (this.stopCount >= 2) {
        this.log("ERROR", `second signal ${signal} received during shutdown — forcing exit`);
        this.releaseLease();
        process.exit(130);
      }
      this.stop = true;
      onStop(`signal ${signal}`);
    };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
  }

  shouldStop(): boolean {
    return this.stop;
  }

  // ---- logging ----

  log(level: LogLevel, message: string): void {
    const line = `${new Date().toISOString()} ${level} ${message}\n`;
    process.stdout.write(line);
    appendFileSync(this.logFd, line);
  }

  fsyncLog(): void {
    try {
      fsyncSync(this.logFd);
    } catch {
      // best effort
    }
  }

  // ---- processed log ----

  loadProcessedIds(): Set<string> {
    if (!existsSync(this.processedPath)) return new Set();
    const out = new Set<string>();
    for (const line of readFileSync(this.processedPath, "utf8").split("\n")) {
      const t = line.trim();
      if (t) out.add(t);
    }
    return out;
  }

  markProcessed(itemId: string): void {
    const fd = openSync(this.processedPath, "a");
    try {
      writeFileSync(fd, `${itemId}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  // ---- artifacts ----

  listRunArtifacts(): string[] {
    if (!existsSync(this.runDir)) return [];
    return readdirSync(this.runDir)
      .filter((n) => n !== "lease.pid")
      .map((n) => join(this.runDir, n))
      .filter((p) => statSync(p).isFile());
  }

  async uploadRunArtifacts(): Promise<void> {
    if (!this.s3Bucket) {
      this.log("INFO", "s3: no bucket configured (ONE_OFF_S3_BUCKET unset), skipping upload");
      return;
    }
    let S3Client: any, PutObjectCommand: any;
    try {
      const mod = await import("@aws-sdk/client-s3");
      S3Client = mod.S3Client;
      PutObjectCommand = mod.PutObjectCommand;
    } catch {
      this.log("WARN", "s3: @aws-sdk/client-s3 not installed, skipping upload");
      return;
    }
    const client = new S3Client({});
    let uploaded = 0;
    for (const path of this.listRunArtifacts()) {
      try {
        const body = readFileSync(path);
        const key = this.s3Prefix + path.split("/").pop()!;
        await client.send(new PutObjectCommand({ Bucket: this.s3Bucket, Key: key, Body: body }));
        uploaded++;
      } catch (err) {
        this.log(
          "ERROR",
          `s3: upload FAILED for ${path} — filesystem copy at ${this.runDir} is authoritative: ${(err as Error).message}`,
        );
        return;
      }
    }
    this.log("INFO", `s3: uploaded ${uploaded} file(s) to s3://${this.s3Bucket}/${this.s3Prefix}`);
  }
}

// ============================================================================
// Engine
// ============================================================================

export abstract class BaseOneOffScript<T> {
  readonly config: ResolvedConfig;
  readonly runtime: Runtime;
  dryRun: boolean;
  readonly resume: boolean;

  private processedIds = new Set<string>();
  private csvWriters = new Map<string, CsvChunkWriter>();
  private itemsSinceFsync = 0;

  constructor(
    config: ScriptConfig,
    opts: { runtime?: Runtime; dryRun?: boolean; resume?: boolean } = {},
  ) {
    this.config = resolveConfig(config);
    this.runtime = opts.runtime ?? new LocalRuntime(config);
    this.dryRun = opts.dryRun ?? true;
    this.resume = opts.resume ?? false;

    this.runtime.acquireLease();
    this.runtime.installStopHandler((reason) => {
      this.runtime.log("WARN", `stop signal received (${reason}) — finishing current item then exiting cleanly`);
    });
    if (this.resume) this.processedIds = this.runtime.loadProcessedIds();
  }

  // ---- subclass hooks ----

  abstract describe(): string;
  abstract iterTargets(): AsyncIterable<T>;
  abstract process(item: T): Promise<void>;
  abstract itemId(item: T): string;

  tablesTouched(): string[] {
    return [];
  }
  snapshot(_item: T): Record<string, Record<string, unknown>> {
    return {};
  }
  async applyRestoreRow(table: string, _row: Record<string, string>): Promise<void> {
    throw new Error(`restore not implemented for table ${JSON.stringify(table)}`);
  }

  // ---- public entry point ----

  async execute(dryRun?: boolean): Promise<number> {
    if (typeof dryRun === "boolean") this.dryRun = dryRun;
    return this.run();
  }

  async run(): Promise<number> {
    const log = this.runtime.log.bind(this.runtime);
    log("INFO", "=".repeat(72));
    log("INFO", `script: ${this.config.name}`);
    log("INFO", `description: ${this.describe()}`);
    log("INFO", `mode: ${this.dryRun ? "DRY-RUN (no writes)" : "APPLY (writes enabled)"}`);
    log("INFO", `runtime: ${this.runtime.constructor.name}`);
    log("INFO", `started_at: ${new Date().toISOString()}`);
    if (this.resume) log("INFO", `resume: skipping ${this.processedIds.size} previously-completed items`);
    const tables = this.tablesTouched();
    if (tables.length) log("INFO", `tables_touched: ${tables.join(", ")}`);

    let processed = 0;
    let skipped = 0;
    let failed = 0;

    try {
      for await (const item of this.iterTargets()) {
        if (this.runtime.shouldStop()) {
          log("WARN", `stop flag set; flushing and exiting cleanly after ${processed} items`);
          break;
        }
        const iid = this.itemId(item);
        if (this.resume && this.processedIds.has(iid)) {
          skipped++;
          continue;
        }
        const ok = await this.safeProcess(item, iid);
        if (ok) processed++;
        else failed++;

        this.itemsSinceFsync++;
        if (this.itemsSinceFsync >= this.config.fsyncEvery) {
          this.runtime.fsyncLog();
          this.itemsSinceFsync = 0;
        }
      }
    } finally {
      log("INFO", "flushing csv backups + log");
      this.flush();
      log("INFO", `summary: processed=${processed} skipped(resume)=${skipped} failed=${failed}`);
      log("INFO", `finished_at: ${new Date().toISOString()}`);
      await this.runtime.uploadRunArtifacts();
      this.runtime.releaseLease();
    }
    return failed === 0 ? 0 : 1;
  }

  async restoreFromBackup(backupDir: string): Promise<number> {
    const log = this.runtime.log.bind(this.runtime);
    backupDir = resolve(backupDir);
    if (!existsSync(backupDir) || !statSync(backupDir).isDirectory()) {
      throw new Error(`backup dir not found: ${backupDir}`);
    }
    const files = readdirSync(backupDir).filter((n) => n.endsWith(".csv")).sort();
    if (files.length === 0) throw new Error(`no backup CSV files in ${backupDir}`);

    log("INFO", `restore: applying ${files.length} backup file(s)`);
    let total = 0;
    for (const fname of files) {
      const table = fname.replace(/\.\d+\.csv$/, "");
      log("INFO", `restore: file=${fname} table=${table}`);
      const rows = parseCsv(readFileSync(join(backupDir, fname), "utf8"));
      for (const row of rows) {
        await this.applyRestoreRow(table, row);
        total++;
        if (total % 1000 === 0) log("INFO", `restore: ${total} rows applied`);
      }
    }
    log("INFO", `restore: complete, ${total} rows applied`);
    return total;
  }

  // ---- internals ----

  private async safeProcess(item: T, iid: string): Promise<boolean> {
    const log = this.runtime.log.bind(this.runtime);
    try {
      const tables = this.tablesTouched();
      if (tables.length > 0) {
        const snap = this.snapshot(item);
        if (Object.keys(snap).length === 0) {
          log("WARN", `item ${iid} declared tablesTouched but snapshot() returned empty — skipping`);
          return false;
        }
        if (this.dryRun) {
          log("INFO", `[dry-run] would back up tables ${Object.keys(snap).join(", ")} for item ${iid}`);
        } else {
          this.writeBackup(snap);
        }
      }

      if (this.dryRun) {
        log("INFO", `[dry-run] would process item ${iid}`);
        return true;
      }

      await this.process(item);
      this.runtime.markProcessed(iid);
      return true;
    } catch (err) {
      log("ERROR", `item ${iid} FAILED — left for next --resume run: ${(err as Error).stack ?? err}`);
      return false;
    }
  }

  private writeBackup(snap: Record<string, Record<string, unknown>>): void {
    for (const [table, row] of Object.entries(snap)) {
      let writer = this.csvWriters.get(table);
      if (!writer) {
        writer = new CsvChunkWriter(this.runtime, table, this.config.csvMaxCells);
        this.csvWriters.set(table, writer);
      }
      writer.write(row);
    }
  }

  private flush(): void {
    for (const w of this.csvWriters.values()) w.close();
    this.runtime.fsyncLog();
  }

  // ---- CLI helper ----

  static async cliMain<S extends BaseOneOffScript<unknown>>(
    factory: (opts: { dryRun: boolean; resume: boolean; runtime?: Runtime }) => S,
    config: ScriptConfig,
  ): Promise<number> {
    const { values } = parseArgs({
      options: {
        apply: { type: "boolean", default: false },
        resume: { type: "boolean", default: false },
        status: { type: "boolean", default: false },
        restore: { type: "string" },
      },
    });
    if (values.status) return printStatus(resolveConfig(config));
    const instance = factory({ dryRun: !values.apply, resume: !!values.resume });
    if (values.restore) {
      await instance.restoreFromBackup(values.restore);
      return 0;
    }
    return instance.execute();
  }
}

// ============================================================================
// helpers
// ============================================================================

class CsvChunkWriter {
  runtime: Runtime;
  table: string;
  maxCells: number;
  files: string[] = [];
  private chunkIdx = 0;
  private fd: number | null = null;
  private cellsInChunk = 0;
  private fieldnames: string[] | null = null;

  constructor(runtime: Runtime, table: string, maxCells: number) {
    this.runtime = runtime;
    this.table = table;
    this.maxCells = maxCells;
  }

  write(row: Record<string, unknown>): void {
    if (this.fieldnames === null) this.fieldnames = Object.keys(row);
    const cols = this.fieldnames.length;
    if (this.fd === null || this.cellsInChunk + cols > this.maxCells) this.roll();
    const line = this.fieldnames.map((k) => csvEscape(row[k])).join(",") + "\n";
    appendFileSync(this.fd!, line);
    this.cellsInChunk += cols;
  }

  close(): void {
    if (this.fd !== null) {
      try {
        fsyncSync(this.fd);
      } catch {
        // ignore
      }
      closeSync(this.fd);
      this.fd = null;
    }
  }

  private roll(): void {
    this.close();
    this.chunkIdx++;
    const path = this.runtime.artifactPath(`${this.table}.${String(this.chunkIdx).padStart(3, "0")}.csv`);
    this.files.push(path);
    this.fd = openSync(path, "w");
    const header = (this.fieldnames ?? []).map(csvEscape).join(",") + "\n";
    appendFileSync(this.fd, header);
    this.cellsInChunk = (this.fieldnames ?? []).length;
  }
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (c !== "\r") {
        field += c;
      }
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows
    .slice(1)
    .filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""))
    .map((r) => {
      const o: Record<string, string> = {};
      headers.forEach((h, i) => {
        o[h] = r[i] ?? "";
      });
      return o;
    });
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function printStatus(config: ResolvedConfig): number {
  const runDir = join(config.logDir, config.name);
  const lease = join(runDir, "lease.pid");
  const logPath = join(runDir, "run.log");
  const processed = join(runDir, "processed.txt");

  console.log(`script: ${config.name}`);
  console.log(`run_dir: ${runDir}`);
  if (existsSync(lease)) {
    const pid = readFileSync(lease, "utf8").trim();
    const alive = /^\d+$/.test(pid) && pidAlive(Number(pid));
    console.log(`lease: ${pid} (${alive ? "running" : "STALE — process gone"})`);
  } else {
    console.log("lease: (no lease file — script not running)");
  }
  if (existsSync(processed)) {
    const count = readFileSync(processed, "utf8").split("\n").filter((l) => l.trim()).length;
    console.log(`processed items: ${count}`);
  } else {
    console.log("processed items: 0 (no resume log yet)");
  }
  if (existsSync(logPath)) {
    const tail = readFileSync(logPath, "utf8").trim().split("\n").slice(-20);
    console.log(`log tail (${logPath}):`);
    for (const line of tail) console.log(`  ${line}`);
  } else {
    console.log("(no log file yet)");
  }
  return 0;
}
