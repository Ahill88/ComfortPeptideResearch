"""Create original print-sharp concept labels for the studio render scene."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'tools/catalog-art/labels'
OUT.mkdir(parents=True, exist_ok=True)
FONT = '/System/Library/Fonts/Helvetica.ttc'
INK = '#15232c'
PALETTES = {
    'ghk-cu': ('GHK-Cu', 'HF-GHK-005', '#779b90'),
    'bpc-157': ('BPC-157', 'HF-BPC-005', '#b6a185'),
    'tb-500': ('TB-500', 'HF-TB5-005', '#9e94b4'),
    'reta': ('Reta', 'HF-RET-010', '#c06b7d'),
    'tirz': ('Tirz', 'HF-TIR-010', '#6493af'),
    'semax': ('Semax', 'HF-SEM-010', '#af9364'),
    'selank': ('Selank', 'HF-SEL-010', '#64a593'),
    'klow': ('KLOW', 'HF-KLO-080', '#c88764'),
    'ipamorelin': ('Ipamorelin', 'HF-IPA-010', '#8296b4'),
    'tesamorelin': ('Tesamorelin', 'HF-TES-010', '#8c7daf'),
    'mots-c': ('MOTS-c', 'HF-MOT-010', '#91a573'),
    'nad-plus': ('NAD+', 'HF-NAD-500', '#b4a06e'),
    'kpv': ('KPV', 'HF-KPV-010', '#a58291'),
    'epithalon': ('Epithalon', 'HF-EPI-010', '#739baa'),
    'thymosin-alpha-1': ('Thymosin Alpha-1', 'HF-TA1-010', '#9baf9b'),
    'cjc-1295-ipamorelin': ('CJC-1295 + Ipamorelin', 'HF-CJC010', '#7d8caa'),
    'bac-water': ('BAC Water', 'HF-BAC-030', '#b4afa5'),
}
for slug, (name, sku, accent) in PALETTES.items():
    im = Image.new('RGB', (2400, 1600), '#fafbf8')
    d = ImageDraw.Draw(im)
    def text(y, value, size, color=INK):
        font = ImageFont.truetype(FONT, size, index=1 if size >= 70 else 0)
        d.text((1200, y), value, font=font, fill=color, anchor='mt')
    d.rectangle((0, 0, 2399, 24), fill=accent)
    text(160, 'HELIX & FIELD', 74)
    text(286, 'R E S E A R C H   M A T E R I A L', 30)
    d.line((430, 420, 1970, 420), fill='#d4dbd6', width=3)
    text(525, name, 190)
    text(820, sku, 48, '#566169')
    d.rectangle((1060, 950, 1340, 968), fill=accent)
    text(1080, 'FOR RESEARCH USE ONLY', 40)
    text(1190, 'NOT FOR HUMAN OR VETERINARY USE', 28, '#566169')
    text(1420, 'CONCEPT PACKAGING  /  PREVIEW', 28, '#78817f')
    im.save(OUT / f'{slug}.png')
    print(OUT / f'{slug}.png')
