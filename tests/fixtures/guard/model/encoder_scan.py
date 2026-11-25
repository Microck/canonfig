"""CPU scorer for one update: fine-tuned encoder over the approved file and the diff. Plugs into update_scan's server."""
from hashlib import file_digest
import json
from pathlib import Path

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

from fmt import SHAPES, encode


class EncoderReader:
    """predict(old, new) -> probability the update is outside the approved scope; 0 for an unchanged file."""

    def __init__(self, folder, threads=2):
        folder = Path(folder)
        self.settings = json.loads((folder / "settings.json").read_bytes())
        with (folder / "model.safetensors").open("rb") as stream:
            if file_digest(stream, "sha256").hexdigest() != self.settings["weights_sha256"]:
                raise ValueError("Unexpected update checkpoint")
        torch.set_num_threads(threads)
        self.tokenizer = AutoTokenizer.from_pretrained(folder, local_files_only=True)
        self.model = AutoModelForSequenceClassification.from_pretrained(folder, local_files_only=True).eval()
        assert self.model.config.num_labels == 2
        self.cuts = self.settings["thresholds"]
        self.shape = SHAPES[self.settings["shape"]]

    @torch.inference_mode()
    def predict(self, old, new):
        if old == new:
            return 0.
        ids = torch.tensor([encode(self.settings["arm"], old, new, self.tokenizer, self.shape)])
        return self.model(input_ids=ids, attention_mask=torch.ones_like(ids)).logits.float().softmax(-1)[0, 1].item()
