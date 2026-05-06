"""
BaseOneOffScript — canonical scaffold for a Vinta one-off operational script.

Copy this file once into your project at `<scripts_dir>/_base.py` (default
`scripts/one_off/_base.py`) and reuse from every script. The `Runtime`
interface below is what `run-one-off-script-<stack>` skills override to plug
the script into a stack-specific surface (Django mgmt command, Jupyter
notebook, Medplum bot, Vercel Function, K8s Job, etc). The default
`LocalRuntime` covers a plain CLI invocation with filesystem state, PID-file
single-instance lease, SIGINT/SIGTERM stop handling, and optional S3 upload.

Subclasses override only the per-script hooks:
    - describe() -> str
    - iter_targets() -> Iterator[T]
    - process(item: T) -> None
    - item_id(item: T) -> str
    - tables_touched() -> list[str]            (destructive scripts only)
    - snapshot(item: T) -> dict[str, dict]     (destructive scripts only)
    - apply_restore_row(table, row) -> None    (only if restore needed)

Engine methods (run, _safe_process, _write_backup) read from the Runtime —
DO NOT override them.

See `add-one-off-script/SKILL.md` for the full contract this file enforces.
"""

from __future__ import annotations

import abc
import argparse
import csv
import logging
import os
import signal
import sys
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Generic, TypeVar

try:
    import boto3  # type: ignore
    _BOTO3_AVAILABLE = True
except ImportError:
    boto3 = None  # type: ignore
    _BOTO3_AVAILABLE = False


T = TypeVar("T")


# ============================================================================
# Configuration
# ============================================================================


@dataclass
class ScriptConfig:
    """Per-script configuration. Build once in the script's `if __name__ == "__main__"` block."""

    name: str
    """Stable identifier — typically the parent folder name (`<YYYY-MM-DD>-<descriptive-kebab>`)."""

    log_dir: Path = Path(".vinta-ai-workflows/one-off-runs")
    """Parent dir for run state. Per-script files land in `<log_dir>/<name>/`. Must be writable."""

    batch_size: int = 500
    """Rows per chunk in iter_targets. Caps in-memory working set."""

    csv_max_cells: int = 1_000_000
    """Roll over to a new CSV chunk when (rows * cols) would exceed this."""

    fsync_every: int = 50
    """fsync the log + processed-items file every N items."""


# ============================================================================
# Runtime interface
# ============================================================================


class Runtime(abc.ABC):
    """Pluggable surface the engine calls into. Default = `LocalRuntime`.

    Stack-specific runners ship subclasses that adapt the contract to their
    surface. A runtime owns: log emission + flush, single-instance lease,
    stop signal, processed-id persistence, where CSV chunks land, and final
    artifact upload.

    Implementations are NOT thread-safe by default — the engine runs single
    threaded, and subclasses that need pooling are expected to add their
    own locking.
    """

    def __init__(self, config: ScriptConfig) -> None:
        self.config = config
        self.run_dir = config.log_dir / config.name
        self.run_dir.mkdir(parents=True, exist_ok=True)

    # ---- lifecycle ----

    @abc.abstractmethod
    def acquire_lease(self) -> None:
        """Raise RuntimeError if another instance holds the lease."""

    @abc.abstractmethod
    def release_lease(self) -> None:
        """Best-effort release. Must be idempotent."""

    @abc.abstractmethod
    def install_stop_handler(self, on_stop: Callable[[str], None]) -> None:
        """Wire the runtime's interrupt source (signal, bot cancel, function abort)
        to call `on_stop(reason)` exactly once. The engine expects a second
        invocation of the stop source to force-exit."""

    @abc.abstractmethod
    def should_stop(self) -> bool:
        """True once the stop handler has fired."""

    # ---- logging ----

    @abc.abstractmethod
    def log(self, level: str, message: str) -> None:
        """Emit one log line. Required levels: INFO, WARN, ERROR."""

    @abc.abstractmethod
    def fsync_log(self) -> None:
        """Best-effort durable flush of the log sink."""

    # ---- processed-items log (resume) ----

    @abc.abstractmethod
    def load_processed_ids(self) -> set[str]:
        """Return all item ids that previous runs marked complete."""

    @abc.abstractmethod
    def mark_processed(self, item_id: str) -> None:
        """Append + fsync `item_id`. Crash-safe."""

    # ---- artifact paths ----

    def artifact_path(self, filename: str) -> Path:
        """Return the local path to write a per-run artifact (CSV chunk).
        Default lands under `<log_dir>/<name>/`. Subclasses may override
        for runtimes that stream artifacts directly to remote storage."""
        return self.run_dir / filename

    @abc.abstractmethod
    def list_run_artifacts(self) -> list[Path]:
        """Every artifact the engine produced this run — log, processed log,
        CSV chunks. Used by `upload_run_artifacts()`."""

    # ---- final upload ----

    @abc.abstractmethod
    def upload_run_artifacts(self) -> None:
        """Best-effort upload of the run's artifacts to whatever durable
        sink the runtime owns (S3, Blob, none). Failure must be logged but
        not raised — the on-disk copy is authoritative."""


# ============================================================================
# LocalRuntime — default for a plain CLI invocation
# ============================================================================


class LocalRuntime(Runtime):
    """Filesystem + PID-file lease + SIGINT/SIGTERM + optional S3 upload.

    Reads two env vars at construction:
        ONE_OFF_S3_BUCKET — destination bucket. Empty / unset → upload skipped.
        ONE_OFF_S3_PREFIX — key prefix. Default `one-off-runs/<name>/`.
    """

    def __init__(
        self,
        config: ScriptConfig,
        s3_bucket: str | None = None,
        s3_prefix: str | None = None,
    ) -> None:
        super().__init__(config)
        self._stop = threading.Event()
        self._stop_count = 0
        self._setup_logging()
        self._processed_path = self.run_dir / "processed.txt"
        self._lease_path = self.run_dir / "lease.pid"
        self._s3_bucket = s3_bucket if s3_bucket is not None else os.environ.get("ONE_OFF_S3_BUCKET") or None
        default_prefix = os.environ.get("ONE_OFF_S3_PREFIX") or f"one-off-runs/{config.name}/"
        self._s3_prefix = (s3_prefix if s3_prefix is not None else default_prefix).rstrip("/") + "/"

    # ---- lease ----

    def acquire_lease(self) -> None:
        if self._lease_path.exists():
            existing = self._lease_path.read_text().strip()
            if existing.isdigit() and _pid_alive(int(existing)):
                raise RuntimeError(
                    f"lease {self._lease_path} held by live process {existing} — "
                    "another instance is running. Stop it before starting a new run."
                )
        self._lease_path.write_text(str(os.getpid()))

    def release_lease(self) -> None:
        try:
            self._lease_path.unlink()
        except FileNotFoundError:
            pass

    # ---- stop ----

    def install_stop_handler(self, on_stop: Callable[[str], None]) -> None:
        def handler(signum, _frame):
            self._stop_count += 1
            if self._stop_count >= 2:
                self.log("ERROR", f"second signal {signum} received during shutdown — forcing exit")
                self.release_lease()
                os._exit(130)
            self._stop.set()
            on_stop(f"signal {signum}")

        signal.signal(signal.SIGINT, handler)
        signal.signal(signal.SIGTERM, handler)

    def should_stop(self) -> bool:
        return self._stop.is_set()

    # ---- logging ----

    def _setup_logging(self) -> None:
        self._log_path = self.run_dir / "run.log"
        self._logger = logging.getLogger(f"one-off:{self.config.name}")
        self._logger.setLevel(logging.INFO)
        self._logger.handlers.clear()
        fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
        self._file_handler = logging.FileHandler(self._log_path)
        self._file_handler.setFormatter(fmt)
        sh = logging.StreamHandler(sys.stdout)
        sh.setFormatter(fmt)
        self._logger.addHandler(self._file_handler)
        self._logger.addHandler(sh)
        self._logger.propagate = False

    def log(self, level: str, message: str) -> None:
        getattr(self._logger, level.lower(), self._logger.info)(message)

    def fsync_log(self) -> None:
        try:
            self._file_handler.flush()
            os.fsync(self._file_handler.stream.fileno())
        except (OSError, ValueError):
            pass

    # ---- processed log ----

    def load_processed_ids(self) -> set[str]:
        if not self._processed_path.exists():
            return set()
        with self._processed_path.open() as f:
            return {line.strip() for line in f if line.strip()}

    def mark_processed(self, item_id: str) -> None:
        with self._processed_path.open("a") as f:
            f.write(f"{item_id}\n")
            f.flush()
            os.fsync(f.fileno())

    # ---- artifacts ----

    def list_run_artifacts(self) -> list[Path]:
        return [p for p in self.run_dir.iterdir() if p.is_file() and p.name != "lease.pid"]

    def upload_run_artifacts(self) -> None:
        if not self._s3_bucket:
            self.log("INFO", "s3: no bucket configured (ONE_OFF_S3_BUCKET unset), skipping upload")
            return
        if not _BOTO3_AVAILABLE:
            self.log("WARN", "s3: boto3 not installed, skipping upload")
            return
        try:
            client = boto3.client("s3")
            uploaded = 0
            for path in self.list_run_artifacts():
                client.upload_file(str(path), self._s3_bucket, self._s3_prefix + path.name)
                uploaded += 1
            self.log("INFO", f"s3: uploaded {uploaded} file(s) to s3://{self._s3_bucket}/{self._s3_prefix}")
        except Exception as exc:
            self.log("ERROR", f"s3: upload FAILED — filesystem copy at {self.run_dir} is authoritative: {exc!r}")


# ============================================================================
# Engine
# ============================================================================


class BaseOneOffScript(Generic[T], abc.ABC):
    """Subclass this. See module docstring for the full contract."""

    # ---- subclass hooks (override these) ----

    @abc.abstractmethod
    def describe(self) -> str:
        """One-paragraph description: what + why. Logged at startup."""

    @abc.abstractmethod
    def iter_targets(self) -> Iterator[T]:
        """Yield work items. MUST be a generator — no .all(), no fetchall()."""

    @abc.abstractmethod
    def process(self, item: T) -> None:
        """Per-item action. MUST check self.dry_run before any write."""

    @abc.abstractmethod
    def item_id(self, item: T) -> str:
        """Stable string id for the item. Used for resume tracking + log lines."""

    def tables_touched(self) -> list[str]:
        """Tables this script writes to. Empty = additive only, no backup."""
        return []

    def snapshot(self, item: T) -> dict[str, dict[str, Any]]:
        """Pre-mutation snapshot of the rows the script is about to change."""
        return {}

    def apply_restore_row(self, table: str, row: dict[str, str]) -> None:
        """Apply one CSV row back to the source table during restore_from_backup()."""
        raise NotImplementedError(f"restore not implemented for table {table!r}")

    # ---- engine (do not override) ----

    def __init__(
        self,
        config: ScriptConfig,
        runtime: Runtime | None = None,
        dry_run: bool = True,
        resume: bool = False,
    ) -> None:
        self.config = config
        self.runtime: Runtime = runtime if runtime is not None else LocalRuntime(config)
        self.dry_run = dry_run
        self.resume = resume
        self._processed_ids: set[str] = set()
        self._csv_writers: dict[str, _CsvChunkWriter] = {}
        self._items_since_fsync = 0

        self.runtime.acquire_lease()
        self.runtime.install_stop_handler(self._on_stop)
        if self.resume:
            self._processed_ids = self.runtime.load_processed_ids()

    def _on_stop(self, reason: str) -> None:
        self.runtime.log("WARN", f"stop signal received ({reason}) — finishing current item then exiting cleanly")

    # ---- public entry point ----

    def execute(self, dry_run: bool | None = None) -> int:
        """Run the script. `dry_run` overrides the constructor default if provided."""
        if dry_run is not None:
            self.dry_run = dry_run
        return self.run()

    def run(self) -> int:
        log = self.runtime.log
        log("INFO", "=" * 72)
        log("INFO", f"script: {self.config.name}")
        log("INFO", f"description: {self.describe()}")
        log("INFO", f"mode: {'DRY-RUN (no writes)' if self.dry_run else 'APPLY (writes enabled)'}")
        log("INFO", f"runtime: {type(self.runtime).__name__}")
        log("INFO", f"started_at: {_utcnow()}")
        if self.resume:
            log("INFO", f"resume: skipping {len(self._processed_ids)} previously-completed items")
        if self.tables_touched():
            log("INFO", f"tables_touched: {', '.join(self.tables_touched())}")

        processed = 0
        skipped = 0
        failed = 0
        try:
            for item in self.iter_targets():
                if self.runtime.should_stop():
                    log("WARN", f"stop flag set; flushing and exiting cleanly after {processed} items")
                    break
                iid = self.item_id(item)
                if self.resume and iid in self._processed_ids:
                    skipped += 1
                    continue
                ok = self._safe_process(item, iid)
                if ok:
                    processed += 1
                else:
                    failed += 1

                self._items_since_fsync += 1
                if self._items_since_fsync >= self.config.fsync_every:
                    self.runtime.fsync_log()
                    self._items_since_fsync = 0
        finally:
            log("INFO", "flushing csv backups + log handlers")
            self._flush()
            log("INFO", f"summary: processed={processed} skipped(resume)={skipped} failed={failed}")
            log("INFO", f"finished_at: {_utcnow()}")
            self.runtime.upload_run_artifacts()
            self.runtime.release_lease()
        return 0 if failed == 0 else 1

    def restore_from_backup(self, backup_dir: Path) -> int:
        """Read every <table>.NNN.csv under backup_dir and apply each row back."""
        log = self.runtime.log
        backup_dir = Path(backup_dir)
        if not backup_dir.is_dir():
            raise FileNotFoundError(f"backup dir not found: {backup_dir}")
        files = sorted(p for p in backup_dir.iterdir() if p.suffix == ".csv")
        if not files:
            raise FileNotFoundError(f"no backup CSV files in {backup_dir}")
        log("INFO", f"restore: applying {len(files)} backup file(s)")
        total = 0
        for path in files:
            # filename pattern: <table>.NNN.csv
            table = path.stem.rsplit(".", 1)[0]
            log("INFO", f"restore: file={path.name} table={table}")
            with path.open(newline="") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    self.apply_restore_row(table, row)
                    total += 1
                    if total % 1000 == 0:
                        log("INFO", f"restore: {total} rows applied")
        log("INFO", f"restore: complete, {total} rows applied")
        return total

    # ---- internals ----

    def _safe_process(self, item: T, iid: str) -> bool:
        log = self.runtime.log
        try:
            if self.tables_touched():
                snap = self.snapshot(item)
                if not snap:
                    log("WARN", f"item {iid} declared tables_touched but snapshot() returned empty — skipping")
                    return False
                if self.dry_run:
                    log("INFO", f"[dry-run] would back up tables {list(snap.keys())} for item {iid}")
                else:
                    self._write_backup(snap)

            if self.dry_run:
                log("INFO", f"[dry-run] would process item {iid}")
                return True

            self.process(item)
            self.runtime.mark_processed(iid)
            return True
        except Exception as exc:
            log("ERROR", f"item {iid} FAILED — left for next --resume run: {exc!r}")
            return False

    def _write_backup(self, snap: dict[str, dict[str, Any]]) -> None:
        for table, row in snap.items():
            writer = self._csv_writers.get(table)
            if writer is None:
                writer = _CsvChunkWriter(
                    runtime=self.runtime,
                    table=table,
                    max_cells=self.config.csv_max_cells,
                )
                self._csv_writers[table] = writer
            writer.write(row)

    def _flush(self) -> None:
        for w in self._csv_writers.values():
            w.close()
        self.runtime.fsync_log()

    # ---- CLI helper ----

    @classmethod
    def main(cls, build_config: Callable[[], ScriptConfig], build_runtime: Callable[[ScriptConfig], Runtime] | None = None) -> int:
        """Convenience CLI entry point used by the local invocation surface.

        Stack-specific runners (Django mgmt command, Jupyter, Medplum bot,
        Vercel Function) call the engine directly — they do NOT use this
        helper. Use this only when invoking the script as a plain Python
        process from a shell.
        """
        parser = argparse.ArgumentParser()
        parser.add_argument("--apply", action="store_true", help="Actually write (default: dry-run).")
        parser.add_argument("--resume", action="store_true", help="Skip items already in the processed log.")
        parser.add_argument("--status", action="store_true", help="Print run status from lease + processed log + tail.")
        parser.add_argument("--restore", metavar="BACKUP_DIR", help="Restore from backup CSVs in BACKUP_DIR.")
        args = parser.parse_args()

        config = build_config()

        if args.status:
            return _print_status(config)

        runtime = build_runtime(config) if build_runtime else LocalRuntime(config)
        instance = cls(config=config, runtime=runtime, dry_run=not args.apply, resume=args.resume)
        if args.restore:
            instance.restore_from_backup(Path(args.restore))
            return 0
        return instance.execute()


# ============================================================================
# helpers
# ============================================================================


class _CsvChunkWriter:
    """Streaming CSV writer that rolls over to a new file when cells > max_cells."""

    def __init__(self, runtime: Runtime, table: str, max_cells: int) -> None:
        self.runtime = runtime
        self.table = table
        self.max_cells = max_cells
        self.files: list[Path] = []
        self._chunk_idx = 0
        self._fp: Any = None
        self._writer: Any = None
        self._cells_in_chunk = 0
        self._fieldnames: list[str] | None = None

    def write(self, row: dict[str, Any]) -> None:
        if self._fieldnames is None:
            self._fieldnames = list(row.keys())
        cols = len(self._fieldnames)
        if self._writer is None or self._cells_in_chunk + cols > self.max_cells:
            self._roll()
        self._writer.writerow(row)  # type: ignore[union-attr]
        self._cells_in_chunk += cols

    def close(self) -> None:
        if self._fp is not None:
            self._fp.flush()
            try:
                os.fsync(self._fp.fileno())
            except (OSError, ValueError):
                pass
            self._fp.close()
            self._fp = None
            self._writer = None

    def _roll(self) -> None:
        self.close()
        self._chunk_idx += 1
        path = self.runtime.artifact_path(f"{self.table}.{self._chunk_idx:03d}.csv")
        self.files.append(path)
        self._fp = path.open("w", newline="")
        self._writer = csv.DictWriter(self._fp, fieldnames=self._fieldnames or [])
        self._writer.writeheader()
        self._cells_in_chunk = len(self._fieldnames or [])


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _print_status(config: ScriptConfig) -> int:
    run_dir = config.log_dir / config.name
    lease = run_dir / "lease.pid"
    log_path = run_dir / "run.log"
    processed = run_dir / "processed.txt"

    print(f"script: {config.name}")
    print(f"run_dir: {run_dir}")
    if lease.exists():
        pid = lease.read_text().strip()
        alive = _pid_alive(int(pid)) if pid.isdigit() else False
        print(f"lease: {pid} ({'running' if alive else 'STALE — process gone'})")
    else:
        print("lease: (no lease file — script not running)")

    if processed.exists():
        with processed.open() as f:
            done = sum(1 for _ in f)
        print(f"processed items: {done}")
    else:
        print("processed items: 0 (no resume log yet)")

    if log_path.exists():
        print(f"log tail ({log_path}):")
        with log_path.open() as f:
            tail = f.readlines()[-20:]
        for line in tail:
            print(f"  {line.rstrip()}")
    else:
        print("(no log file yet)")
    return 0
