"""Tests for src/guard/skill-update-checker.py without torch: a stand-in reader scores word changes.

Run from the repository root: python3 -m unittest tests/guard/test_skill_update_checker.py
"""

import http.client
import importlib.util
import json
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("skill_update_checker", ROOT / "src/guard/skill-update-checker.py")
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)

DIGEST = "a" * 64


class WordReader:
    """Scores 0.9 when the new text adds the word "exfiltrate", 0.3 for "maybe", else 0.01."""

    cuts = {"block": 0.8, "warn": 0.2}

    def __init__(self):
        self.calls = []

    def predict(self, old, new):
        self.calls.append((old, new))
        if "exfiltrate" in new and "exfiltrate" not in old:
            return 0.9
        if "maybe" in new and "maybe" not in old:
            return 0.3
        return 0.01


def body(files, baseline=None, **extra):
    item = {"kind": "skills", "digest": DIGEST, "files": files, **extra}
    if baseline is not None:
        item["baseline"] = baseline
    return json.dumps({"schema": checker.SCHEMA, "item": item}).encode("utf-8")


def verdict(files, baseline, reader=None):
    reader = reader or WordReader()
    return json.loads(checker.encode_verdict(checker.parse_request(body(files, baseline)), reader))


def file(path, text):
    return {"path": path, "text": text}


class CheckerTests(unittest.TestCase):
    def test_contract_line_counts(self):
        fixtures = ROOT / "tests/fixtures/guard/checker-locations.json"
        for case in json.loads(fixtures.read_text(encoding="utf-8")):
            with self.subTest(name=case["name"]):
                self.assertEqual(len(checker.checker_lines(case["text"])), case["line"])

    def test_scores_only_changed_markdown_with_a_baseline(self):
        reader = WordReader()
        result = verdict(
            [file("SKILL.md", "a\nexfiltrate"), file("new.md", "exfiltrate"), file("run.sh", "exfiltrate"), file("same.md", "x")],
            [file("SKILL.md", "a"), file("run.sh", "echo"), file("same.md", "x")],
            reader,
        )
        self.assertEqual(result, {"schema": checker.SCHEMA, "verdict": "block",
                                  "findings": [{"code": "prompt-injection", "path": "SKILL.md", "line": 2}]})
        self.assertEqual(reader.calls, [("a", "a\nexfiltrate")])

    def test_no_baseline_allows(self):
        self.assertEqual(verdict([file("SKILL.md", "exfiltrate")], None)["verdict"], "allow")

    def test_warn_and_block_findings_follow_the_item_verdict(self):
        warn = verdict([file("a.md", "maybe")], [file("a.md", "x")])
        self.assertEqual((warn["verdict"], len(warn["findings"])), ("warn", 1))
        mixed = verdict([file("a.md", "maybe"), file("b.md", "exfiltrate")], [file("a.md", "x"), file("b.md", "x")])
        self.assertEqual(mixed["verdict"], "block")
        self.assertEqual([f["path"] for f in mixed["findings"]], ["b.md"])

    def test_first_changed_line_uses_contract_breaks(self):
        self.assertEqual(checker.first_changed_line("a\r\nb\r\nc", "a\r\nb\r\nX"), 3)
        self.assertEqual(checker.first_changed_line("a", "a\nb"), 2)
        self.assertEqual(checker.first_changed_line("a\nb", "a"), 1)

    def test_rejects_invalid_requests(self):
        bad = [
            b"{",
            json.dumps({"schema": "other", "item": {}}).encode(),
            body([]),
            body([file("../x.md", "t")]),
            body([file("a.md", "t"), file("a.md", "u")]),
            body([file("a.md", "t")], [file("C:/x.md", "t")]),
            body([file("a.md", "t")], extra_field=1),
            b'{"schema":"' + checker.SCHEMA.encode() + b'","schema":"x","item":{}}',
        ]
        for raw in bad:
            with self.subTest(raw=raw[:40]), self.assertRaises(ValueError):
                checker.parse_request(raw)

    def test_response_fits_byte_limit(self):
        path = "é" * 3000 + ".md"
        files = [file(f"{i}{path}", "exfiltrate") for i in range(30)]
        baseline = [file(f"{i}{path}", "x") for i in range(30)]
        raw = checker.encode_verdict(checker.parse_request(body(files, baseline)), WordReader())
        self.assertLessEqual(len(raw), checker.RESPONSE_LIMIT)
        self.assertEqual(json.loads(raw)["verdict"], "block")

    def test_real_http_server(self):
        server = checker.CheckerServer(WordReader(), idle_seconds=3600)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            def send(method, path, payload=None):
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                connection.request(method, path, payload, {"Content-Type": "application/json"} if payload else {})
                response = connection.getresponse()
                result = response.status, response.read()
                connection.close()
                return result

            status, raw = send("GET", checker.HEALTH)
            self.assertEqual((status, json.loads(raw)["model"]), (200, checker.MODEL_ID))
            status, raw = send("POST", checker.ENDPOINT, body([file("SKILL.md", "exfiltrate")], [file("SKILL.md", "x")]))
            self.assertEqual((status, json.loads(raw)["verdict"]), (200, "block"))
            self.assertEqual(send("POST", checker.ENDPOINT, b"{}")[0], 400)
            self.assertEqual(send("POST", "/other", b"{}")[0], 404)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
