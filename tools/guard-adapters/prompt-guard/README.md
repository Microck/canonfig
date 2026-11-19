# Prompt Guard adapter

This local HTTP adapter runs a prompt injection classifier for Canonfig Guard.
It scores overlapping token windows in each file and uses the highest score
to classify that file. A finding points to the approximate start line of the
highest-scoring window. [Canonfig Guard](../../../docs/guard.md)

## Run locally

The default model is Llama Prompt Guard 2 86M. Both Meta checkpoints are gated
by the Llama 4 Community License. Sign in to Hugging Face, accept the license
and request access on the model page, then set `HF_TOKEN` to a Hugging Face
token with read access to the model. [86M model and license](https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M) · [22M model and license](https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-22M)

Install [uv](https://docs.astral.sh/uv/getting-started/installation/) and run
this command from the repository root.

```sh
uv run tools/guard-adapters/prompt-guard/server.py
```

The adapter uses CPU PyTorch and needs no GPU. Budget about 3 GB of available
RAM for 86M or 2 GB for 22M as a starting point. The initial model download
includes about 1.12 GB of weights for 86M or 283 MB for 22M, plus tokenizer
files and Python dependencies. The adapter loads cached model files at startup
when available and scores requests locally.

Put this in `~/.canonfig/guard.jsonc`.

```jsonc
{
  "version": 1,
  "checker": {
    "kind": "http",
    "endpoint": "http://127.0.0.1:8787/v1/guard"
  }
}
```

Run `canonfig guard scan --json` to check the Canonical Folder. The adapter
binds to loopback by default. Use `--host` and `--port` to change the address.
Non-loopback binds require `--allow-remote`. The adapter serves plain HTTP
without authentication.

## Choose and tune a model

For the smaller Meta checkpoint, run:

```sh
uv run tools/guard-adapters/prompt-guard/server.py --model meta-llama/Llama-Prompt-Guard-2-22M
```

To use an ungated model such as ProtectAI's classifier, pass its model ID.

```sh
uv run tools/guard-adapters/prompt-guard/server.py --model protectai/deberta-v3-base-prompt-injection-v2
```

The adapter uses standard Transformers sequence classifiers with fast
tokenizers that provide source offsets. If the model uses an ambiguous or
generic label, pass its injection label as `--positive-label` using the name
from the model's `id2label` configuration.

The defaults are `--warn-threshold 0.5` and `--block-threshold 0.9`. Scores at
or above each threshold qualify. A blocked item reports files that met the
block threshold. Increase `checker.protocolRevision` in `guard.jsonc` when
you change the model or thresholds so Canonfig discards cached verdicts.

Meta trained Prompt Guard on injections against chat models. Test it on
representative skills and quoted examples and tune both thresholds before
using it to block. The model checks text for prompt injection. Canonfig's
built-in rules check for patterns in malicious code.

## Run tests

Run this command from the repository root.

```sh
python3 -m unittest tools/guard-adapters/prompt-guard/test_server.py
```
