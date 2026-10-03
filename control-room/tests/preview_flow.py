"""Local-only PDF/QR preview flow. Start repository root at 127.0.0.1:8765 first."""
from pathlib import Path
import os
import tempfile
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8765/control-room/site/?demo=1'
OUT = Path(os.environ.get('CONTROL_ROOM_SCREENSHOT_DIR', Path(tempfile.gettempdir()) / 'renmenu-control-room-shots'))
OUT.mkdir(parents=True, exist_ok=True)
PDF_ID = '5eae22bc-7a50-4bd2-8b8a-000000000403'
GINESTRA_ID = '3c8cb099-7a50-4bd2-8b8a-000000000202'

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    for width, height in ((1280, 800), (390, 844)):
        context = browser.new_context(viewport={'width': width, 'height': height}, locale='it-IT')
        page = context.new_page()
        errors, external = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda request: external.append(request.url) if not request.url.startswith('http://127.0.0.1:8765/') and not request.url.startswith('blob:') else None)
        page.goto(BASE, wait_until='networkidle')
        page.evaluate("window.__revoked = []; const original = URL.revokeObjectURL; URL.revokeObjectURL = function(url) { window.__revoked.push(url); return original.call(URL, url); }")
        page.evaluate("location.hash = '#revisione'")
        page.get_by_role('heading', name='Revisione editoriale').wait_for()
        page.locator(f'[data-action="preview-material"][data-material-id="{PDF_ID}"]').click()
        page.locator('#material-viewer').wait_for(state='visible')
        assert page.locator('#material-viewer-meta').inner_text().find('PDF FINTIZIO') >= 0
        assert page.locator('#material-viewer-comparison').get_by_text('Crostino alle erbe').count() > 0
        page.locator('.pdf-preview-canvas').wait_for(state='visible')
        page.get_by_text('Pagina 1 di 2', exact=False).wait_for()
        pixels = page.locator('.pdf-preview-canvas').evaluate("canvas => { const p = canvas.getContext('2d').getImageData(40, 40, 1, 1).data; return [...p]; }")
        assert len(pixels) == 4
        page.screenshot(path=str(OUT / ('viewer-pdf-mobile.png' if width == 390 else 'viewer-pdf-desktop.png')))
        page.get_by_role('button', name='Pagina successiva').click()
        page.get_by_text('Pagina 2 di 2', exact=False).wait_for()
        page.get_by_role('button', name='Aumenta zoom PDF').click()
        page.get_by_text('125%', exact=False).wait_for()
        page.locator('#material-viewer-close').click()
        assert page.evaluate('window.__revoked.length') >= 1, 'Blob must be revoked after close'
        page.evaluate("location.hash = '#anteprima'")
        page.get_by_role('heading', name='Anteprima').wait_for()
        page.locator('.qr-real svg').wait_for(state='visible')
        assert page.get_by_text('QR DI PROVA — NON ATTIVO').count() > 0
        if width == 1280:
            page.locator('select[data-select-request]').select_option(GINESTRA_ID)
            page.get_by_text('Rispetto allo snapshot pubblicato FINTIZIO').wait_for()
            assert page.locator('.diff-row').count() >= 1
        else:
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        page.evaluate('document.activeElement.blur(); window.scrollTo(0, 0)')
        page.wait_for_timeout(130)
        page.screenshot(path=str(OUT / ('preview-390.png' if width == 390 else 'preview-1280.png')), full_page=True)
        assert not errors, errors
        assert not external, external
        print(f'PASS {width}x{height}: PDF sintetico, confronto, Blob revocato, QR reale, nessuna rete esterna')
        context.close()
    browser.close()
print('Screenshot:', OUT)
