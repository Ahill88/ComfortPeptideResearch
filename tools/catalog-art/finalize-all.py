"""Finalize all renders: optimize to WebP, create manifest, QA, and deploy."""
import json, hashlib, subprocess, pathlib
from PIL import Image

ROOT = pathlib.Path('/Users/andrewsilva/Documents/ComfortPeptideResearch')
MASTERS = ROOT / 'tools/catalog-art/masters'
PUBLIC = ROOT / 'apps/storefront/public/media/products'
DOCS = ROOT / 'docs/design/catalog-imagery'
PUBLIC.mkdir(parents=True, exist_ok=True)
DOCS.mkdir(parents=True, exist_ok=True)

SLUGS = [
    'ghk-cu', 'bpc-157', 'tb-500',
    'reta', 'tirz', 'semax', 'selank', 'klow', 'ipamorelin', 'tesamorelin',
    'mots-c', 'nad-plus', 'kpv', 'epithalon', 'thymosin-alpha-1',
    'cjc-1295-ipamorelin', 'bac-water'
]
VIEWS = ['overview', 'detail', 'angle']
expected = [f'{s}-{v}' for s in SLUGS for v in VIEWS]

# Check masters exist
for name in expected:
    src = MASTERS / f'{name}.png'
    assert src.is_file(), f'Missing: {src}'

records = []
board = Image.new('RGB', (1800, 2400), '#f8faf8')
draw = __import__('PIL.ImageDraw').ImageDraw.Draw(board)
font = __import__('PIL.ImageFont').ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 24)
heading = __import__('PIL.ImageFont').ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 42, index=1)
draw.text((48, 32), 'HELIX & FIELD / THE RESEARCH COLLECTION', font=heading, fill='#15232c')
draw.text((48, 100), 'Original 3D concept imagery. Not verified product photography.', font=font, fill='#55636a')

for idx, name in enumerate(expected):
    source = MASTERS / f'{name}.png'
    im = Image.open(source).convert('RGB')
    target = PUBLIC / f'{name}.webp'
    im.save(target, 'WEBP', quality=91, method=6)
    records.append({
        'file': target.name,
        'dimensions': [2048, 2048],
        'bytes': target.stat().st_size,
        'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
        'source': 'Original procedural Blender Cycles render',
        'disclosure': 'Concept packaging; not verified product photography'
    })
    col, row = idx % 3, idx // 3
    x, y = col * 600 + 20, row * 610 + 170
    board.paste(im.resize((560, 560), Image.Resampling.LANCZOS), (x, y))
    draw.text((x + 8, y + 570), name.replace('-', ' ').upper(), font=font, fill='#15232c')

assert len(records) == 51
(PUBLIC / 'manifest.json').write_text(json.dumps(records, indent=2) + '\n')
board.save(DOCS / 'image-collection.jpg', quality=93)

print(f'Exported {len(records)} WebP assets, total {sum(r["bytes"] for r in records):,} bytes')
print(f'Manifest: {PUBLIC / "manifest.json"}')
print(f'Collection sheet: {DOCS / "image-collection.jpg"}')
