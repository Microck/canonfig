#!/usr/bin/env python3
"""Private local benchmark. Output contains aggregates, never paths or content.

Primary sources are copied into a private directory and deleted on exit. Heavy
strata are sampled with a fixed seed, read in place without writes, and streamed.
Only one compressed output exists at a time. No network access occurs here.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import random
import resource
import shutil
import signal
import stat
import subprocess
import tarfile
import tempfile
import threading
import time

SEED = 279
RESERVE = 2_000_000_000
CONFIG_DIRS = {"instructions", "skills", "rules", "agents", "commands", "hooks", "files", "local", "prompts", "extensions", "plugins"}
CONFIG_SUFFIXES = {".md", ".json", ".jsonc", ".toml", ".yaml", ".yml"}
BINARY_SUFFIXES = {".so", ".node", ".dll", ".exe", ".zip", ".gz", ".xz", ".zst", ".7z", ".png", ".jpg", ".webp", ".woff2", ".pdf", ".sqlite", ".db"}


def category(relative, canonical):
    parts = {part.lower() for part in relative.parts}
    if parts & {"node_modules", ".venv", "venv", "site-packages", "vendor"}:
        return "dependencies"
    if parts & {"sessions", "history", "projects", "session-env", "session-state"} or relative.suffix == ".jsonl":
        return "sessions-history"
    if parts & {"logs", "log", "debug", "telemetry"} or relative.suffix == ".log":
        return "logs"
    if parts & {"cache", "caches", ".cache", ".git", "downloads", "backups", ".backups"}:
        return "caches"
    if relative.suffix in BINARY_SUFFIXES:
        return "binaries"
    if relative.parts[0] in CONFIG_DIRS or len(relative.parts) == 1 and relative.suffix in CONFIG_SUFFIXES:
        return "folder" if canonical else "harness-configuration"
    return "other-runtime"


def inventory(roots):
    groups = {}
    excluded = {"symlinks": 0, "special_files": 0, "unreadable": 0}
    def inaccessible(_):
        excluded["unreadable"] += 1
    for index, root in enumerate(roots):
        if root.is_symlink():
            excluded["symlinks"] += 1
            continue
        for base, dirs, files in os.walk(root, followlinks=False, onerror=inaccessible):
            excluded["symlinks"] += sum(Path(base, name).is_symlink() for name in dirs)
            for name in files:
                path = Path(base, name)
                try:
                    info = path.lstat()
                except OSError:
                    excluded["unreadable"] += 1
                    continue
                if not stat.S_ISREG(info.st_mode):
                    excluded["symlinks" if stat.S_ISLNK(info.st_mode) else "special_files"] += 1
                    continue
                relative = path.relative_to(root)
                group = category(relative, index == 0)
                groups.setdefault(group, []).append((path, info.st_size, info.st_mtime_ns, info.st_ino))
    for entries in groups.values():
        entries.sort(key=lambda item: str(item[0]))
    return groups, excluded


def check_space(scratch, needed=0):
    if shutil.disk_usage(scratch).free - needed < RESERVE:
        raise RuntimeError("disk-reserve")


def copy_primary(groups, scratch):
    copied = {}
    changed = 0
    for group in ("folder", "harness-configuration"):
        copied[group] = []
        for index, (source, _, _, _) in enumerate(groups.get(group, [])):
            destination = scratch / f"{group}-{index}"
            try:
                descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
            except FileNotFoundError:
                changed += 1
                continue
            with os.fdopen(descriptor, "rb") as stream:
                before = os.fstat(stream.fileno())
                check_space(scratch, before.st_size)
                remaining = before.st_size
                with destination.open("xb") as output:
                    while remaining:
                        block = stream.read(min(remaining, 1024 * 1024))
                        if not block:
                            break
                        output.write(block)
                        remaining -= len(block)
                after = os.fstat(stream.fileno())
                if remaining or (after.st_size, after.st_mtime_ns) != (before.st_size, before.st_mtime_ns):
                    destination.unlink()
                    changed += 1
                    continue
            info = destination.stat()
            copied[group].append((destination, info.st_size, info.st_mtime_ns, info.st_ino))
    return copied, changed


def sample_heavy(groups, budget):
    """Proportional byte quotas, fixed random file order and bounded file prefixes.

    Prefix sampling avoids a single large session exceeding its stratum's quota.
    This is explicitly not a statistically independent random-byte sample.
    """
    heavy = {name: entries for name, entries in groups.items() if name not in ("folder", "harness-configuration")}
    total = sum(size for entries in heavy.values() for _, size, _, _ in entries)
    sampled = {}
    for name, entries in sorted(heavy.items()):
        quota = min(sum(item[1] for item in entries), int(budget * sum(item[1] for item in entries) / max(total, 1)))
        shuffled = list(entries)
        random.Random(f"{SEED}:{name}").shuffle(shuffled)
        selected = []
        for path, size, mtime, inode in shuffled:
            if quota <= 0:
                break
            amount = min(size, quota)
            selected.append((path, amount, mtime, inode))
            quota -= amount
        sampled[name] = selected
    return sampled


class DigestWriter:
    def __init__(self, stream):
        self.stream = stream
        self.digest = hashlib.sha256()
        self.count = 0
    def write(self, content):
        self.digest.update(content)
        self.count += len(content)
        return self.stream.write(content)
    def flush(self):
        self.stream.flush()


def tar_stream(entries, output):
    writer = DigestWriter(output)
    with tarfile.open(fileobj=writer, mode="w|", format=tarfile.USTAR_FORMAT) as archive:
        for index, (path, size, mtime, inode) in enumerate(entries):
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(descriptor, "rb") as stream:
                before = os.fstat(stream.fileno())
                if before.st_ino != inode or before.st_mtime_ns != mtime or before.st_size < size:
                    raise RuntimeError("source-changed")
                header = tarfile.TarInfo(f"entry-{index}")
                header.size, header.mode, header.mtime = size, 0o600, 0
                archive.addfile(header, stream)
                after = os.fstat(stream.fileno())
                if (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size):
                    raise RuntimeError("source-changed")
    return writer.digest.digest(), writer.count


def algorithms():
    return {
        "gzip-9": (["gzip", "-9", "-c"], ["gzip", "-d", "-c"]),
        "zstd-1": (["zstd", "-q", "-1", "-T1", "-c"], ["zstd", "-q", "-d", "-c"]),
        "zstd-6": (["zstd", "-q", "-6", "-T1", "-c"], ["zstd", "-q", "-d", "-c"]),
        "zstd-19": (["zstd", "-q", "-19", "-T1", "-c"], ["zstd", "-q", "-d", "-c"]),
        "zstd-22-long31": (["zstd", "-q", "--ultra", "-22", "--long=31", "-T1", "-c"], ["zstd", "-q", "-d", "--long=31", "-c"]),
        "xz-9e": (["xz", "-9e", "-T1", "-c"], ["xz", "-d", "-c"]),
        "brotli-11": (["brotli", "-q", "11", "-c"], ["brotli", "-d", "-c"]),
        "bzip3-32": (["bzip3", "-b", "32", "-j", "1", "-c"], ["bzip3", "-d", "-j", "1", "-c"]),
        "lz4-9": (["lz4", "-q", "-9", "-c"], ["lz4", "-q", "-d", "-c"]),
        "7z-ultra": (["7zz", "a", "-t7z", "-mx=9", "-mmt=1", "-si", "{output}"], ["7zz", "x", "-so", "{output}"]),
        "zpaq-max": (["zpaq-stream", "5"], ["zpaq-stream", "d"]),
    }


def measure(command, scratch, timeout, memory_mib, feed=None, input_file=None, output_file=None):
    metrics = scratch / "metrics"
    metrics.unlink(missing_ok=True)
    def limits():
        limit = memory_mib * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        os.nice(10)
    stdin = subprocess.PIPE if feed is not None else input_file
    stdout = subprocess.PIPE if output_file is None else output_file
    process = subprocess.Popen(["/usr/bin/time", "-f", "%e %M %x", "-o", str(metrics), *command], stdin=stdin, stdout=stdout, stderr=subprocess.DEVNULL, start_new_session=True, preexec_fn=limits)
    stopped = threading.Event()
    failure = []
    def supervise():
        started = time.monotonic()
        while not stopped.wait(0.2):
            if time.monotonic() - started > timeout or shutil.disk_usage(scratch).free < RESERVE + 32 * 1024 * 1024:
                failure.append("timeout" if time.monotonic() - started > timeout else "disk-reserve")
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                return
    guard = threading.Thread(target=supervise)
    guard.start()
    digest, count = None, 0
    started = time.monotonic()
    try:
        if feed is not None:
            digest, count = tar_stream(feed, process.stdin)
            process.stdin.close()
        elif output_file is None:
            checksum = hashlib.sha256()
            while block := process.stdout.read(1024 * 1024):
                checksum.update(block)
                count += len(block)
            digest = checksum.digest()
        status = process.wait()
    except (OSError, RuntimeError) as error:
        failure.append(str(error) if str(error) in {"source-changed", "disk-reserve"} else type(error).__name__)
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        status = process.wait()
    finally:
        stopped.set()
        guard.join()
    elapsed = time.monotonic() - started
    rss = None
    if metrics.exists():
        lines = metrics.read_text().strip().splitlines()
        last = lines[-1].split() if lines else []
        if len(last) == 3 and last[1].isdigit():
            rss = int(last[1])
    return {"seconds": round(elapsed, 6), "peak_rss_kib": rss, "exit_code": status, "failure": failure[0] if failure else None}, digest, count


def run(args):
    os.umask(0o077)
    roots = [Path(args.folder).expanduser(), *(Path(path).expanduser() for path in args.harness)]
    groups, excluded = inventory(roots)
    population = {name: {"files": len(entries), "bytes": sum(entry[1] for entry in entries)} for name, entries in sorted(groups.items())}
    report = {"seed": SEED, "tier": args.tier, "platform": platform.platform(), "memory_limit_mib": args.memory_mib, "timeout_seconds_per_operation": args.timeout, "disk_reserve_bytes": RESERVE, "population": population, "excluded": excluded, "rows": []}
    destination = Path(args.output)
    def save():
        destination.write_text(json.dumps(report, indent=2) + "\n")
    with tempfile.TemporaryDirectory(prefix="canonfig-279-corpus-", dir=args.scratch) as directory:
        scratch = Path(directory)
        if args.tier == "primary":
            copies, changed = copy_primary(groups, scratch)
            report["excluded"]["changed_during_primary_copy"] = changed
            corpora = {"folder": copies["folder"], "folder-and-harness-configuration": copies["folder"] + copies["harness-configuration"]}
        else:
            corpora = sample_heavy(groups, args.sample_bytes)
        save()
        for name, entries in corpora.items():
            if args.corpora and name not in args.corpora:
                continue
            if not entries:
                continue
            for algorithm in args.algorithms:
                check_space(scratch)
                encode, decode = algorithms()[algorithm]
                row = {"corpus": name, "algorithm": algorithm, "sample_files": len(entries), "sample_bytes": sum(entry[1] for entry in entries)}
                executable = shutil.which(encode[0])
                if executable is None:
                    row["status"] = "unavailable"
                    report["rows"].append(row)
                    save()
                    continue
                compressed = scratch / ("compressed.7z" if algorithm == "7z-ultra" else "compressed")
                commands = [[part.replace("{output}", str(compressed)) for part in command] for command in (encode, decode)]
                file_output = "{output}" in encode
                with (open(os.devnull, "wb") if file_output else compressed.open("xb")) as output:
                    compression, original_digest, tar_bytes = measure(commands[0], scratch, args.timeout, args.memory_mib, feed=entries, output_file=output)
                row["compression"] = compression
                row["tar_bytes"] = tar_bytes
                if compression["exit_code"] == 0 and compression["failure"] is None:
                    row["compressed_bytes"] = compressed.stat().st_size
                    row["ratio"] = round(row["compressed_bytes"] / tar_bytes, 8)
                    with compressed.open("rb") as source:
                        decompression, restored_digest, restored_bytes = measure(commands[1], scratch, args.timeout, args.memory_mib, input_file=source)
                    row["decompression"] = decompression
                    row["round_trip"] = decompression["exit_code"] == 0 and restored_digest == original_digest and restored_bytes == tar_bytes
                    row["status"] = "ok" if row["round_trip"] else "round-trip-failed"
                    if args.tier == "heavy" and row["status"] == "ok":
                        factor = population[name]["bytes"] / max(row["sample_bytes"], 1)
                        row["extrapolated_full_category"] = {"compressed_bytes": round(row["compressed_bytes"] * factor), "compression_seconds": round(compression["seconds"] * factor, 3), "decompression_seconds": round(decompression["seconds"] * factor, 3)}
                else:
                    row["status"] = compression["failure"] or "compressor-failed"
                compressed.unlink(missing_ok=True)
                report["rows"].append(row)
                save()
                print(json.dumps(row), flush=True)
                if row["status"] == "disk-reserve":
                    raise RuntimeError("disk-reserve")
    report["private_copies_removed"] = True
    save()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--folder", required=True)
    parser.add_argument("--harness", action="append", default=[])
    parser.add_argument("--scratch", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--tier", choices=["primary", "heavy"], required=True)
    parser.add_argument("--sample-bytes", type=int, default=2_000_000_000)
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--memory-mib", type=int, default=1536)
    parser.add_argument("--algorithms", nargs="+", choices=algorithms(), default=list(algorithms()))
    parser.add_argument("--corpora", nargs="+", help="Run only these corpus names; useful after a recorded interrupted run")
    arguments = parser.parse_args()
    try:
        run(arguments)
    except Exception as error:
        # File-system exceptions may contain private names; never serialize them.
        print(json.dumps({"status": "stopped", "reason": str(error) if str(error) in {"disk-reserve", "primary-source-changed"} else type(error).__name__}), flush=True)
        raise SystemExit(1)
