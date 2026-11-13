"""Export the film's top-facing logo geometry. Requires Pillow; no browser/WebGL.

Usage: python extract-logos.py /path/to/canonfig.glb ui/src/proto/map-harnesses/logos
The film also lights these meshes. These flat exports retain its materials and geometry.
"""
import json
import struct
import sys
from pathlib import Path
from PIL import Image, ImageDraw

source, destination = map(Path, sys.argv[1:])
raw = source.read_bytes()
json_size = struct.unpack_from('<I', raw, 12)[0]
model = json.loads(raw[20:20 + json_size])
binary_start = 28 + json_size


def accessor(index):
    entry = model['accessors'][index]
    view = model['bufferViews'][entry['bufferView']]
    component = {5123: 'H', 5125: 'I', 5126: 'f'}[entry['componentType']]
    dimensions = {'SCALAR': 1, 'VEC3': 3}[entry['type']]
    fmt = '<' + component * dimensions
    stride = view.get('byteStride', struct.calcsize(fmt))
    offset = binary_start + view.get('byteOffset', 0) + entry.get('byteOffset', 0)
    return [struct.unpack_from(fmt, raw, offset + i * stride) for i in range(entry['count'])]


names = {'codex': '54 · Codex', 'claude': '55 · Claude', 'cursor': '47 · Cursor',
         'opencode': '51 · OpenCode', 'omp': '53 · Oh My Pi', 'droid': '48 · Factory Droid',
         'grok': '37 · Grok', 'copilot': '28 · GitHub Copilot', 'amp': '44 · Amp',
         'pi': '45 · Pi', 'kimi': '41 · Kimi', 'qwen': '43 · Qwen'}
destination.mkdir(parents=True, exist_ok=True)
for slug, name in names.items():
    node = next(n for n in model['nodes'] if n.get('name') == name)
    mesh = model['meshes'][node['mesh']]
    triangles = []
    for primitive in mesh['primitives']:
        points = accessor(primitive['attributes']['POSITION'])
        indices = [n[0] for n in accessor(primitive['indices'])]
        linear = model['materials'][primitive['material']]['pbrMetallicRoughness']['baseColorFactor']
        color = tuple(round(255 * (12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055)) for c in linear[:3]) + (255,)
        for i in range(0, len(indices), 3):
            triangles.append(([points[j] for j in indices[i:i + 3]], color))
    points = [p for triangle, _ in triangles for p in triangle]
    x0, x1 = min(p[0] for p in points), max(p[0] for p in points)
    z0, z1 = min(p[2] for p in points), max(p[2] for p in points)
    scale = 464 / max(x1 - x0, z1 - z0)
    image = Image.new('RGBA', (512, 512))
    draw = ImageDraw.Draw(image)
    for triangle, color in sorted(triangles, key=lambda item: sum(p[1] for p in item[0])):
        draw.polygon([(256 + (p[0] - (x0 + x1) / 2) * scale,
                       256 + (p[2] - (z0 + z1) / 2) * scale) for p in triangle], fill=color)
    image.resize((96, 96), Image.Resampling.LANCZOS).save(destination / f'{slug}.png')
    print(f'{slug}: {len(triangles)} triangles')
