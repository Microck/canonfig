#!/usr/bin/env python3
"""Subset the pinned phase-1 fonts. Requires fonttools[woff] 4.62.1 (pyftsubset).

Run from any directory: python3 ui/scripts/subset-fonts.py
Original inputs stay in Git at 2039144, not in the released package. The output
keeps Latin, UI punctuation/symbols, layout features and the OFL metadata.
"""
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
FONTS = ROOT / "ui/public/fonts"
BASE = "2039144"
NAMES = ["Manrope", "IoskeleyMono-Regular", "IoskeleyMono-Medium", "IoskeleyMono-SemiBold", "IoskeleyMono-Bold"]
characters = set(range(0x20, 0x250))
for source in sorted((ROOT / "ui/src").rglob("*")):
    if source.suffix in {".ts", ".tsx", ".css"}:
        characters.update(map(ord, source.read_text()))
unicodes = ",".join(f"U+{value:X}" for value in sorted(characters) if value >= 0x20)
with tempfile.TemporaryDirectory(prefix="canonfig-fonts-") as directory:
    for name in NAMES:
        relative = f"ui/public/fonts/{name}.woff2"
        original = subprocess.check_output(["git", "show", f"{BASE}:{relative}"], cwd=ROOT)
        source = pathlib.Path(directory) / f"{name}.woff2"
        source.write_bytes(original)
        destination = FONTS / source.name
        subprocess.run([
            "pyftsubset", str(source), f"--output-file={destination}",
            "--flavor=woff2", f"--unicodes={unicodes}", "--layout-features=*",
            "--name-IDs=*", "--name-languages=*", "--name-legacy", "--no-recalc-timestamp",
        ], check=True)
        print(f"{name}: {len(original)} -> {destination.stat().st_size} bytes")
