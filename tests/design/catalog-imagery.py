"""Run with a Python environment containing playwright and pillow."""
import json
import os
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

OUTPUT = Path(os.environ.get('QA_OUTPUT', str(Path.home() / '.hermes/cache/scratch/catalog-imagery-qa')))
OUTPUT.mkdir(parents=True, exist_ok=True)
BASE = os.environ.get('QA_BASE_URL', 'http://localhost:3000')
SLUGS = ['ghk-cu', 'bpc-157', 'tb-500', 'reta', 'tirz', 'semax', 'selank', 'klow', 'ipamorelin', 'tesamorelin', 'mots-c', 'nad-plus', 'kpv', 'epithalon', 'thymosin-alpha-1', 'cjc-1295-ipamorelin', 'bac-water']
results = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    for width in [1440, 768, 390]:
        page = browser.new_page(viewport={'width': width, 'height': 1100})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        response = page.goto(BASE + '/catalog', wait_until='networkidle')
        assert response.status == 200
        images = page.locator('main article img')
        assert images.count() == len(SLUGS), f'Expected {len(SLUGS)} real catalog images, got {images.count()}'
        for image in images.all():
            image.scroll_into_view_if_needed()
            image.evaluate('(i) => i.decode()')
            assert image.evaluate('(i) => i.complete && i.naturalWidth > 0'), 'Image failed to load'
            assert 'concept render' in image.get_attribute('alt').lower()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Catalog overflows'
        page.screenshot(path=str(OUTPUT / f'catalog-{width}.png'), full_page=True)
        for slug in SLUGS:
            page.goto(BASE + '/catalog/' + slug, wait_until='networkidle')
            image = page.locator('main button[aria-label^="Enlarge"] img')
            assert image.count() == 1
            first = image.get_attribute('src')
            page.get_by_role('button', name=f'Show label detail for ', exact=False).click()
            expect(image).to_have_attribute('src', re.compile(re.escape(f'{slug}-detail.webp')))
            image.evaluate('(i) => i.decode()')
            assert image.get_attribute('src') != first, 'Detail view must use a distinct image'
            detail = image.get_attribute('src')
            page.get_by_role('button', name='Show alternate angle for ', exact=False).click()
            expect(image).to_have_attribute('src', re.compile(re.escape(f'{slug}-angle.webp')))
            image.evaluate('(i) => i.decode()')
            assert image.get_attribute('src') not in [first, detail], 'Alternate view must use a distinct image'
            page.get_by_role('button', name='Enlarge ', exact=False).click()
            dialog = page.get_by_role('dialog')
            assert dialog.is_visible()
            dialog.locator('img').evaluate('(i) => i.decode()')
            assert dialog.locator('img').evaluate('(i) => i.complete && i.naturalWidth > 0')
            page.keyboard.press('Escape')
            assert not dialog.is_visible()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Detail overflows'
        page.screenshot(path=str(OUTPUT / f'product-{width}.png'), full_page=True)
        assert not errors, errors
        results.append({'width': width, 'catalogImages': len(SLUGS), 'productGalleries': len(SLUGS), 'status': 'pass'})
        page.close()
    browser.close()
(OUTPUT / 'results.json').write_text(json.dumps(results, indent=2))
print(json.dumps({'output': str(OUTPUT), 'results': results}, indent=2))
