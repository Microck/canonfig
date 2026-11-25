# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = [
#   "torch==2.8.0",
#   "transformers==5.10.2",
#   "safetensors==0.8.0",
#   "numpy==2.4.6",
#   "tokenizers==0.22.2",
# ]
#
# [tool.uv.sources]
# torch = [{ index = "pytorch-cpu", marker = "sys_platform == 'linux' or sys_platform == 'win32'" }]
#
# [[tool.uv.index]]
# name = "pytorch-cpu"
# url = "https://download.pytorch.org/whl/cpu"
# explicit = true
# ///
"""Serve the Skill Update 396M model over the Canonfig Guard checker contract.

Canonfig ships this script, downloads the model into its cache and starts the
script with `uv run --script` when a Guard check needs it. The model compares a
proposed file with the approved version of the same file, so only files that
arrive with a baseline of the same path are scored. Everything else is allowed
here and stays covered by Guard's built-in rules.

Pinned versions match the model card's tested CPU setup. The scorer itself
(`encoder_scan.EncoderReader`) ships with the model and verifies its weights.
"""

import argparse
import difflib
import json
import re
import sys
import threading
import time
from collections.abc import Sequence
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Protocol

# The wire contract is shared with the CLI. It sits next to this script in
# src/guard and in the packaged dist/guard.
_CONTRACT = json.loads((Path(__file__).resolve().parent / "checker-wire.json").read_text(encoding="utf-8"))
SCHEMA = _CONTRACT["schema"]
REQUEST_LIMIT = _CONTRACT["requestBytes"]
RESPONSE_LIMIT = _CONTRACT["responseBytes"]
FINDINGS_LIMIT = _CONTRACT["maximumFindings"]
LINE_BREAK = re.compile("|".join(re.escape(value) for value in _CONTRACT["lineBreaks"]))
ENDPOINT = "/v1/guard"
HEALTH = "/v1/health"
MODEL_ID = "skill-update-396m"
# The model was trained on Markdown instruction files.
SCORED = re.compile(r"\.(?:md|mdx|txt)$", re.IGNORECASE)


@dataclass(frozen=True)
class TextFile:
    path: str
    text: str


@dataclass(frozen=True)
class Item:
    files: list[TextFile]
    baseline: list[TextFile]


class Reader(Protocol):
    cuts: dict[str, float]

    def predict(self, old: str, new: str) -> float: ...


def checker_lines(text: str) -> list[str]:
    """Lines as Guard counts them, so a reported line always validates."""
    return LINE_BREAK.split(text)


def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    fields = dict(pairs)
    if len(fields) != len(pairs):
        raise ValueError("Duplicate JSON field")
    return fields


def parse_files(value: object, *, allow_empty: bool) -> list[TextFile]:
    if not isinstance(value, list) or (not value and not allow_empty):
        raise ValueError("Expected a file list")
    parsed, paths = [], set()
    for file in value:
        if not isinstance(file, dict) or file.keys() != {"path", "text"}:
            raise ValueError("Invalid file")
        path, text = file["path"], file["text"]
        if (
            not isinstance(path, str)
            or re.search(r"^[a-zA-Z]:|[\\\x00]", path)
            or any(part in {"", ".", ".."} for part in path.split("/"))
            or path in paths
        ):
            raise ValueError("Invalid or repeated file path")
        if not isinstance(text, str) or "\0" in text:
            raise ValueError("Invalid file text")
        # Reject escaped lone surrogates, which JSON decodes but UTF-8 cannot encode.
        path.encode("utf-8")
        text.encode("utf-8")
        paths.add(path)
        parsed.append(TextFile(path, text))
    return parsed


def parse_request(body: bytes) -> Item:
    data = json.loads(body.decode("utf-8"), object_pairs_hook=unique_object)
    if not isinstance(data, dict) or data.keys() != {"schema", "item"} or data["schema"] != SCHEMA:
        raise ValueError("Invalid request envelope")
    item = data["item"]
    if not isinstance(item, dict) or not {"kind", "digest", "files"} <= item.keys() <= {"kind", "digest", "files", "baseline"}:
        raise ValueError("Invalid item")
    kind, digest = item["kind"], item["digest"]
    if not isinstance(kind, str) or not kind.strip() or "\0" in kind:
        raise ValueError("Invalid item kind")
    kind.encode("utf-8")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("Invalid item digest")
    return Item(parse_files(item["files"], allow_empty=False), parse_files(item.get("baseline", []), allow_empty=True))


def first_changed_line(old: str, new: str) -> int:
    new_lines = checker_lines(new)
    for tag, _, _, start, _ in difflib.SequenceMatcher(None, checker_lines(old), new_lines, autojunk=False).get_opcodes():
        if tag != "equal":
            return max(1, min(len(new_lines), start + 1))
    return 1


def encode_verdict(item: Item, reader: Reader) -> bytes:
    approved = {file.path: file.text for file in item.baseline}
    scored = []
    for file in item.files:
        old = approved.get(file.path)
        if old is None or old == file.text or not SCORED.search(file.path):
            continue
        score = reader.predict(old, file.text)
        if score >= reader.cuts["warn"]:
            scored.append((score, file.path, first_changed_line(old, file.text)))
    scored.sort(key=lambda entry: entry[0], reverse=True)
    verdict = "allow"
    if scored:
        verdict = "block" if scored[0][0] >= reader.cuts["block"] else "warn"
    threshold = reader.cuts["block"] if verdict == "block" else reader.cuts["warn"]
    findings = [
        {"code": "prompt-injection", "path": path, "line": line}
        for score, path, line in scored[:FINDINGS_LIMIT]
        if score >= threshold
    ]
    response = {"schema": SCHEMA, "verdict": verdict, "findings": findings}
    while True:
        body = json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(body) <= RESPONSE_LIMIT:
            return body
        # Keep the strongest findings when unusually long paths exhaust the wire budget.
        if len(findings) > 1:
            findings.pop()
        else:
            findings[0] = {"code": "prompt-injection"}


class CheckerServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, reader: Reader, idle_seconds: float):
        self.reader = reader
        self.idle_seconds = idle_seconds
        self.last_request = time.monotonic()
        # One model, one request at a time: torch already uses several threads.
        self.scoring = threading.Lock()
        super().__init__(("127.0.0.1", 0), CheckerHandler)

    def get_request(self):
        connection, peer = super().get_request()
        connection.settimeout(10)
        self.last_request = time.monotonic()
        return connection, peer

    def watch_idle(self):
        while True:
            time.sleep(min(30.0, self.idle_seconds))
            if time.monotonic() - self.last_request >= self.idle_seconds and self.scoring.acquire(blocking=False):
                self.shutdown()
                return


class CheckerHandler(BaseHTTPRequestHandler):
    server: CheckerServer

    def log_message(self, format, *args):
        # Request lines can contain caller data.
        pass

    def reply(self, status: int, body: bytes):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path != HEALTH:
            self.send_error(404)
            return
        self.reply(200, json.dumps({"schema": SCHEMA, "model": MODEL_ID}).encode("utf-8"))

    def do_POST(self):
        if self.path != ENDPOINT:
            self.send_error(404)
            return
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1 or "Transfer-Encoding" in self.headers or not re.fullmatch(r"[0-9]{1,9}", lengths[0]):
            self.send_error(400)
            return
        count = int(lengths[0])
        if count > REQUEST_LIMIT:
            self.send_error(413)
            return
        try:
            body = self.rfile.read(count)
            if len(body) != count:
                raise ValueError("Incomplete request body")
            item = parse_request(body)
        except TimeoutError:
            self.send_error(408)
            return
        except (ValueError, RecursionError):
            self.send_error(400)
            return
        try:
            with self.server.scoring:
                response = encode_verdict(item, self.server.reader)
        except (RuntimeError, ValueError):
            self.send_error(500, "Model scoring failed")
            return
        self.server.last_request = time.monotonic()
        self.reply(200, response)


def load_reader(model_dir: Path, threads: int) -> Reader:
    # encoder_scan and fmt ship with the model revision Canonfig pinned.
    sys.path.insert(0, str(model_dir))
    from encoder_scan import EncoderReader  # noqa: E402

    return EncoderReader(model_dir / "checkpoint", threads=threads)


def main(argv: Sequence[str] | None = None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--threads", type=int, choices=(1, 2, 4), default=4)
    parser.add_argument("--idle-seconds", type=float, default=900)
    parser.add_argument("--check", action="store_true", help="Load the model, score one pair and exit")
    args = parser.parse_args(argv)
    reader = load_reader(args.model_dir, args.threads)
    # Fault the weights into memory before the first Guard request arrives.
    reader.predict("Prepare a glossary of the supplied terms.", "Prepare a concise glossary of the supplied terms.")
    if args.check:
        print(json.dumps({"ready": True}), flush=True)
        return
    with CheckerServer(reader, args.idle_seconds) as server:
        threading.Thread(target=server.watch_idle, daemon=True).start()
        # Canonfig reads this one line to learn the port.
        print(json.dumps({"ready": True, "port": server.server_port}), flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
