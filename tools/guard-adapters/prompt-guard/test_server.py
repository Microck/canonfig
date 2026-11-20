import http.client
import json
import re
import unittest
from pathlib import Path
from threading import Thread

from .server import (
    ENDPOINT,
    FINDINGS_LIMIT,
    REQUEST_LIMIT,
    RESPONSE_LIMIT,
    SCHEMA,
    GuardServer,
    TextFile,
    checker_line_at,
    encode_verdict,
    loopback_host,
    parse_request,
    resolve_positive_label,
    score_file,
)


class WordScorer:
    """One token per word, with fixed probabilities for the test vocabulary."""

    window_size = 4

    def __init__(self):
        self.batches = []

    def tokenize(self, text):
        words = list(re.finditer(r"\S+", text))
        token_ids = [
            {"warn": 50, "block": 90, "strongest": 98}.get(word[0], 2) for word in words
        ]
        return token_ids, [word.span() for word in words]

    def predict(self, windows):
        self.batches.append(windows)
        return [max(window, default=2) / 100 for window in windows]


def request(files=None):
    if files is None:
        files = [{"path": "SKILL.md", "text": "block"}]
    return {
        "schema": SCHEMA,
        "item": {"kind": "skills", "digest": "a" * 64, "files": files},
    }


def verdict(files):
    return json.loads(encode_verdict(files, WordScorer(), 0.5, 0.9))


class ServerTests(unittest.TestCase):
    def test_window_overlap_and_tail(self):
        cases = [
            ("", [[]]),
            ("one two three", [[2, 2, 2]]),
            ("one two three four", [[2, 2, 2, 2]]),
            ("one two warn four block", [[2, 2, 50, 2], [50, 2, 90]]),
            ("one two warn four block six", [[2, 2, 50, 2], [50, 2, 90, 2]]),
            (
                "one two warn four block six strongest",
                [[2, 2, 50, 2], [50, 2, 90, 2], [90, 2, 98]],
            ),
        ]
        for text, expected in cases:
            with self.subTest(text=text):
                scorer = WordScorer()
                score_file(text, scorer)
                self.assertEqual(scorer.batches, [expected])

    def test_batch_size_and_worst_window_across_batches(self):
        scorer = WordScorer()
        self.assertEqual(score_file("word\n" * 19 + "strongest", scorer), (0.98, 17))
        self.assertEqual([len(batch) for batch in scorer.batches], [8, 1])

    def test_line_uses_window_start_and_keeps_first_tied_window(self):
        text = "é one\r\nthree\rfour\nblock blocker"
        self.assertEqual(score_file(text, WordScorer()), (0.9, 2))
        self.assertEqual(
            score_file("one\nblock\nthree\nfour\nblock", WordScorer()), (0.9, 1)
        )
        self.assertEqual(score_file("", WordScorer()), (0.02, 1))

    def test_contract_locations(self):
        fixtures = Path(__file__).resolve().parents[3] / "tests/fixtures/guard/checker-locations.json"
        for case in json.loads(fixtures.read_text(encoding="utf-8")):
            with self.subTest(name=case["name"]):
                text = case["text"]
                self.assertEqual(checker_line_at(text, len(text)), case["line"])

    def test_thresholds_are_inclusive_and_findings_match_the_item_verdict(self):
        self.assertEqual(
            verdict([TextFile("safe.md", "ordinary")]),
            {"schema": SCHEMA, "verdict": "allow", "findings": []},
        )
        self.assertEqual(
            verdict([TextFile("review.md", "warn")]),
            {
                "schema": SCHEMA,
                "verdict": "warn",
                "findings": [
                    {"code": "prompt-injection", "path": "review.md", "line": 1}
                ],
            },
        )
        self.assertEqual(
            verdict([TextFile("review.md", "warn"), TextFile("SKILL.md", "block")]),
            {
                "schema": SCHEMA,
                "verdict": "block",
                "findings": [
                    {"code": "prompt-injection", "path": "SKILL.md", "line": 1}
                ],
            },
        )

    def test_findings_count_keeps_the_strongest_files(self):
        files = [
            TextFile(f"ref-{index}.md", "block") for index in range(FINDINGS_LIMIT + 1)
        ]
        files.append(TextFile("strongest.md", "one\ntwo\rthree\r\nfour\nstrongest"))
        result = verdict(files)
        self.assertEqual(result["verdict"], "block")
        self.assertEqual(len(result["findings"]), FINDINGS_LIMIT)
        self.assertEqual(
            result["findings"][0],
            {"code": "prompt-injection", "path": "strongest.md", "line": 3},
        )
        self.assertTrue(
            {finding["path"] for finding in result["findings"]}
            <= {file.path for file in files}
        )

    def test_response_fits_byte_limit_with_multibyte_paths(self):
        paths = [character * 4500 for character in ("é", "比")]
        files = [TextFile(path, "block") for path in paths]
        body = encode_verdict(files, WordScorer(), 0.5, 0.9)
        self.assertLessEqual(len(body), RESPONSE_LIMIT)
        self.assertEqual(
            json.loads(body)["findings"],
            [{"code": "prompt-injection", "path": paths[0], "line": 1}],
        )

        result = verdict([TextFile("比" * 6000, "block")])
        self.assertEqual(
            result,
            {
                "schema": SCHEMA,
                "verdict": "block",
                "findings": [{"code": "prompt-injection"}],
            },
        )

    def test_resolves_label_by_name(self):
        self.assertEqual(resolve_positive_label({0: "MALICIOUS", 1: "BENIGN"}, None), 0)
        self.assertEqual(
            resolve_positive_label({0: "SAFE", 1: "Prompt_Injection"}, None), 1
        )
        self.assertEqual(
            resolve_positive_label({0: "LABEL_0", 1: "LABEL_1"}, "label_0"), 0
        )
        for labels, override in [
            ({0: "LABEL_0", 1: "LABEL_1"}, None),
            ({0: "INJECTION", 1: "JAILBREAK"}, None),
            ({0: "INJECTION"}, "MALICIOUS"),
        ]:
            with (
                self.subTest(labels=labels, override=override),
                self.assertRaisesRegex(ValueError, "--positive-label"),
            ):
                resolve_positive_label(labels, override)

    def test_validates_request_shape_and_types(self):
        valid = request([{"path": "references/résumé.md", "text": ""}])
        self.assertEqual(
            parse_request(json.dumps(valid).encode()),
            [TextFile("references/résumé.md", "")],
        )
        invalid = [
            [],
            {"schema": SCHEMA},
            {"schema": SCHEMA, "item": []},
            {**valid, "extra": 1},
            {**valid, "schema": "v0"},
            {"schema": SCHEMA, "item": {**valid["item"], "extra": 1}},
        ]
        for field, value in [
            ("kind", 1),
            ("kind", ""),
            ("digest", "not-a-digest"),
            ("files", []),
            ("files", {}),
            ("files", [{"path": "SKILL.md", "text": 4}]),
            ("files", [{"path": "SKILL.md", "text": "fine", "extra": 1}]),
            ("files", request()["item"]["files"] * 2),
        ]:
            invalid.append({**valid, "item": {**valid["item"], field: value}})
        for path in (
            "",
            "/abs",
            "../secret",
            "dir/./test.md",
            "dir//a",
            r"dir\file.md",
            "C:drive.md",
            "x\0y",
        ):
            invalid.append(request([{"path": path, "text": "fine"}]))
        invalid.extend(
            request([{"path": "SKILL.md", "text": text}]) for text in ("\0", "\ud800")
        )
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                parse_request(json.dumps(payload).encode())

    def test_rejects_invalid_json_and_duplicate_fields(self):
        for body in (
            b"{",
            b"\xff",
            b'{"schema":"canonfig.guard/v1","schema":"canonfig.guard/v1"}',
        ):
            with self.subTest(body=body), self.assertRaises(ValueError):
                parse_request(body)

    def test_literal_loopback_hosts(self):
        self.assertTrue(loopback_host("127.0.0.1"))
        self.assertTrue(loopback_host("::1"))
        self.assertFalse(loopback_host("0.0.0.0"))
        self.assertFalse(loopback_host("192.0.2.1"))

    def test_real_http_server_with_stand_in(self):
        with GuardServer(("127.0.0.1", 0), WordScorer(), 0.5, 0.9) as server:
            worker = Thread(target=server.serve_forever)
            worker.start()
            try:

                def send(method, path, body=None, headers=None):
                    conn = http.client.HTTPConnection(
                        "127.0.0.1", server.server_port, timeout=5
                    )
                    try:
                        conn.request(method, path, body=body, headers=headers or {})
                        reply = conn.getresponse()
                        return (
                            reply.status,
                            reply.getheader("Content-Type"),
                            reply.read(),
                        )
                    finally:
                        conn.close()

                payload = json.dumps(request()).encode()
                self.assertEqual(send("GET", ENDPOINT)[0], 405)
                self.assertEqual(send("POST", "/wrong", payload)[0], 404)
                self.assertEqual(send("POST", ENDPOINT, b"{")[0], 400)
                self.assertEqual(
                    send("POST", ENDPOINT, b"", {"Transfer-Encoding": "chunked"})[0],
                    400,
                )
                self.assertEqual(
                    send(
                        "POST",
                        ENDPOINT,
                        b"",
                        {"Content-Length": str(REQUEST_LIMIT + 1)},
                    )[0],
                    413,
                )
                payload += b" " * (REQUEST_LIMIT - len(payload))
                status, content_type, body = send(
                    "POST", ENDPOINT, payload, {"Content-Type": "application/json"}
                )
                self.assertEqual((status, content_type), (200, "application/json"))
                self.assertEqual(
                    json.loads(body),
                    {
                        "schema": SCHEMA,
                        "verdict": "block",
                        "findings": [
                            {"code": "prompt-injection", "path": "SKILL.md", "line": 1}
                        ],
                    },
                )
            finally:
                server.shutdown()
                worker.join()


if __name__ == "__main__":
    unittest.main()
