"""Export verified 2048px masters as optimized local WebP assets."""
from pathlib import Path
import json
import hashlib
import zipfile
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
MASTERS = ROOT / 'tools/catalog-art/masters'
PUBLIC = ROOT / 'apps/storefront/public/media/products'
DOCS = ROOT / 'docs/design/catalog-imagery'
PUBLIC.mkdir(parents=True, exist_ok=True)
DOCS.mkdir(parents=True, exist_ok=True)
slugs = ['ghk-cu', 'bpc-157', 'tb-500']
views = ['overview', 'detail', 'angle']
expected = [f'{slug}-{view}' for slug in slugs for view in views]
records = []
board = Image.new('RGB', (1800, 2040), '#f8faf8')
draw = ImageDraw.Draw(board)
font_path = '/System/Library/Fonts/Helvetica.ttc'
font = ImageFont.truetype(font_path, 24)
heading = ImageFont.truetype(font_path, 42, index=1)
draw.text((48, 32), 'HELIX & FIELD / THE RESEARCH COLLECTION', font=heading, fill='#15232c')
draw.text((48, 100), 'Original 3D concept imagery. Not verified product photography.', font=font, fill='#55636a')
for idx, name in enumerate(expected):
    source = MASTERS / f'{name}.png'
    assert source.is_file(), f'Missing required render: {source}'
    im = Image.open(source).convert('RGB')
    assert im.size == (2048, 2048), (source, im.size)
    im.verify() if hasattr(im, 'verify') else None
    target = PUBLIC / f'{name}.webp'
    im.save(target, 'WEBP', quality=91, method=6)
    records.append({'file': target.name, 'dimensions': [2048, 2048], 'bytes': target.stat().st_size, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'source': 'Original procedural Blender Cycles render', 'disclosure': 'Concept packaging; not verified product photography'})
    col, row = idx % 3, idx // 3
    x, y = col * 600 + 20, row * 610 + 170
    board.paste(im.resize((560, 560), Image.Resampling.LANCZOS), (x, y))
    draw.text((x + 8, y + 570), name.replace('-', ' ').upper(), font=font, fill='#15232c')
assert len(records) == 9
(PUBLIC / 'manifest.json').write_text(json.dumps(records, indent=2) + '\n')
board.save(DOCS / 'image-collection.jpg', quality=93)
with zipfile.ZipFile(DOCS / 'helix-field-hq-images.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in expected:
        archive.write(MASTERS / f'{name}.png', f'{name}.png')
    archive.writestr('README.txt', 'Nine original 2048 x 2048 PNG concept renders for Helix & Field.\nOverview, label detail, and alternate angle for GHK-Cu, BPC-157, TB-500.\nImages depict concept packaging, not verified products or actual contents.\nNo claim of purity, dosage, quantity, certification, or availability is made.\n')
print(json.dumps({'count': len(records), 'webpTotalBytes': sum(r['bytes'] for r in records), 'assets': records, 'contactSheet': str(DOCS / 'image-collection.jpg'), 'download': str(DOCS / 'helix-field-hq-images.zip')}, indent=2))
