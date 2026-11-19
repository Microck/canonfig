# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = [
#   "torch==2.8.0",
#   "transformers==4.57.6",
#   "sentencepiece==0.2.1",
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
"""Serve an in-process prompt injection classifier over the Canonfig Guard API."""

import argparse
import ipaddress
import json
import math
import os
import re
import socket
from bisect import bisect_right
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Protocol

SCHEMA = "canonfig.guard/v1"
ENDPOINT = "/v1/guard"
DEFAULT_MODEL = "meta-llama/Llama-Prompt-Guard-2-86M"

# Guard enforces these limits in src/guard/guard.ts.
REQUEST_LIMIT = 32 * 1024
RESPONSE_LIMIT = 16 * 1024
FINDINGS_LIMIT = 20


@dataclass(frozen=True)
class TextFile:
    path: str
    text: str


class Scorer(Protocol):
    window_size: int  # Content token capacity after reserving special tokens.

    def tokenize(self, text: str) -> tuple[list[int], list[tuple[int, int]]]: ...

    def predict(self, windows: Sequence[list[int]]) -> list[float]: ...


def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    fields = dict(pairs)
    if len(fields) != len(pairs):
        raise ValueError("Duplicate JSON field")
    return fields


def parse_request(body: bytes) -> list[TextFile]:
    data = json.loads(body.decode("utf-8"), object_pairs_hook=unique_object)
    if (
        not isinstance(data, dict)
        or data.keys() != {"schema", "item"}
        or data["schema"] != SCHEMA
    ):
        raise ValueError("Invalid request envelope")
    item = data["item"]
    if not isinstance(item, dict) or item.keys() != {"kind", "digest", "files"}:
        raise ValueError("Invalid item")
    kind, digest, files = item["kind"], item["digest"], item["files"]
    if not isinstance(kind, str) or not kind.strip() or "\0" in kind:
        raise ValueError("Invalid item kind")
    kind.encode("utf-8")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("Invalid item digest")
    if not isinstance(files, list) or not files:
        raise ValueError("Expected at least one file")

    parsed = []
    paths = set()
    for file in files:
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
        # Reject escaped lone surrogates, which JSON can decode but the tokenizer cannot use.
        path.encode("utf-8")
        text.encode("utf-8")
        paths.add(path)
        parsed.append(TextFile(path, text))
    return parsed


def resolve_positive_label(labels: Mapping[int, str], override: str | None) -> int:
    def normalize(label: str) -> str:
        return re.sub(r"[\s_-]+", " ", label.strip().casefold())

    positive_names = {
        "injection",
        "prompt injection",
        "malicious",
        "jailbreak",
        "attack",
        "unsafe",
    }
    accepted = {normalize(override)} if override is not None else positive_names
    matches = [index for index, label in labels.items() if normalize(label) in accepted]
    if len(matches) != 1:
        raise ValueError(
            "Select one label from the model's id2label with --positive-label"
        )
    return matches[0]


class TransformersScorer:
    def __init__(self, model_name: str, positive_label: str | None):
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        self.torch = torch
        torch.set_num_threads(min(4, os.cpu_count() or 1))

        def load(loader, **options):
            try:
                return loader.from_pretrained(
                    model_name, local_files_only=True, **options
                )
            except OSError:
                return loader.from_pretrained(model_name, **options)

        self.tokenizer = load(AutoTokenizer, use_fast=True)
        if not self.tokenizer.is_fast:
            raise ValueError("The model needs a fast tokenizer for source line offsets")

        self.model = load(AutoModelForSequenceClassification).eval()
        config = self.model.config
        self.positive_index = resolve_positive_label(config.id2label, positive_label)
        self.independent_labels = (
            config.num_labels == 1
            or config.problem_type == "multi_label_classification"
        )
        max_tokens = min(
            512,
            self.tokenizer.model_max_length,
            getattr(config, "max_position_embeddings", 512),
        )
        self.window_size = max_tokens - self.tokenizer.num_special_tokens_to_add(
            pair=False
        )
        if self.window_size < 1:
            raise ValueError("The model has no room for content tokens")

    def tokenize(self, text: str) -> tuple[list[int], list[tuple[int, int]]]:
        encoded = self.tokenizer(
            text,
            add_special_tokens=False,
            truncation=False,
            return_offsets_mapping=True,
            verbose=False,
        )
        return encoded["input_ids"], encoded["offset_mapping"]

    def predict(self, windows: Sequence[list[int]]) -> list[float]:
        inputs = [
            self.tokenizer.prepare_for_model(ids, return_attention_mask=False)
            for ids in windows
        ]
        batch = self.tokenizer.pad(inputs, padding=len(inputs) > 1, return_tensors="pt")
        with self.torch.inference_mode():
            logits = self.model(**batch).logits.float()
            probabilities = (
                logits.sigmoid() if self.independent_labels else logits.softmax(dim=-1)
            )
        return probabilities[:, self.positive_index].tolist()


def score_file(text: str, scorer: Scorer) -> tuple[float, int]:
    token_ids, offsets = scorer.tokenize(text)
    width = scorer.window_size
    stride = width - min(128, width // 2)
    # Start a new window only if the previous window left tokens uncovered.
    starts = range(0, max(0, len(token_ids) - width) + stride, stride)
    batch_size = 8
    best_score, best_start = -1.0, 0
    for batch in range(0, len(starts), batch_size):
        positions = starts[batch : batch + batch_size]
        probabilities = scorer.predict(
            [token_ids[start : start + width] for start in positions]
        )
        for start, score in zip(positions, probabilities, strict=True):
            if not math.isfinite(score):
                raise ValueError("The model returned a non-finite score")
            if score > best_score:
                best_score, best_start = score, start

    # Match Guard's CRLF, CR and LF line boundaries against original text offsets.
    line_ends = [ending.end() for ending in re.finditer(r"\r\n|\r|\n", text)]
    offset = offsets[best_start][0] if offsets else 0
    return best_score, bisect_right(line_ends, offset) + 1


def encode_verdict(
    files: Sequence[TextFile], scorer: Scorer, warn: float, block: float
) -> bytes:
    flagged = []
    for file in files:
        score, line = score_file(file.text, scorer)
        if score >= warn:
            flagged.append((score, file.path, line))
    flagged.sort(key=lambda file: file[0], reverse=True)
    verdict = "allow"
    if flagged:
        verdict = "block" if flagged[0][0] >= block else "warn"

    findings = []
    threshold = block if verdict == "block" else warn
    for score, path, line in flagged[:FINDINGS_LIMIT]:
        if score < threshold:
            break
        findings.append({"code": "prompt-injection", "path": path, "line": line})
    response = {"schema": SCHEMA, "verdict": verdict, "findings": findings}
    while True:
        body = json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        if len(body) <= RESPONSE_LIMIT:
            return body
        # Keep the strongest findings when an unusually long path exhausts the wire budget.
        if len(findings) > 1:
            findings.pop()
        else:
            findings[0] = {"code": "prompt-injection"}


class GuardServer(HTTPServer):
    def __init__(
        self, address: tuple[str, int], scorer: Scorer, warn: float, block: float
    ):
        self.scorer = scorer
        self.warn = warn
        self.block = block
        if ":" in address[0]:
            self.address_family = socket.AF_INET6
        super().__init__(address, GuardHandler)

    def get_request(self):
        connection, peer = super().get_request()
        connection.settimeout(10)
        return connection, peer


class GuardHandler(BaseHTTPRequestHandler):
    server: GuardServer

    def log_message(self, format, *args):
        # HTTP request lines can contain caller data.
        pass

    def parse_request(self):
        if not super().parse_request():
            return False
        if self.command != "POST":
            self.send_response(405)
            self.send_header("Allow", "POST")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return False
        return True

    def do_POST(self):
        if self.path != ENDPOINT:
            self.send_error(404)
            return
        lengths = self.headers.get_all("Content-Length", [])
        if not lengths and "Transfer-Encoding" not in self.headers:
            self.send_error(411)
            return
        if (
            len(lengths) != 1
            or "Transfer-Encoding" in self.headers
            or not re.fullmatch(r"[0-9]+", lengths[0])
        ):
            self.send_error(400)
            return
        length = lengths[0].lstrip("0") or "0"
        count = (
            int(length) if len(length) <= len(str(REQUEST_LIMIT)) else REQUEST_LIMIT + 1
        )
        if count > REQUEST_LIMIT:
            self.send_error(413)
            return

        try:
            body = self.rfile.read(count)
            if len(body) != count:
                raise ValueError("Incomplete request body")
            files = parse_request(body)
        except TimeoutError:
            self.send_error(408)
            return
        except (ValueError, RecursionError):
            self.send_error(400)
            return

        try:
            response = encode_verdict(
                files, self.server.scorer, self.server.warn, self.server.block
            )
        except (RuntimeError, ValueError):
            self.send_error(500, "Model scoring failed")
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)


def loopback_host(host: str) -> bool:
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--allow-remote", action="store_true")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument(
        "--positive-label", help="Name of the injection label in the model's id2label"
    )
    parser.add_argument("--warn-threshold", type=float, default=0.5)
    parser.add_argument("--block-threshold", type=float, default=0.9)
    args = parser.parse_args()
    # Resolve localhost to a literal instead of trusting the host's name resolution.
    host = "127.0.0.1" if args.host == "localhost" else args.host
    if not loopback_host(host) and not args.allow_remote:
        parser.error("--allow-remote is required for a non-loopback host")
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    if not 0 <= args.warn_threshold <= args.block_threshold <= 1:
        parser.error("thresholds must satisfy 0 <= warn <= block <= 1")

    scorer = TransformersScorer(args.model, args.positive_label)
    with GuardServer(
        (host, args.port), scorer, args.warn_threshold, args.block_threshold
    ) as server:
        url_host = f"[{host}]" if ":" in host else host
        print(
            f"Listening on http://{url_host}:{server.server_port}{ENDPOINT}", flush=True
        )
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
