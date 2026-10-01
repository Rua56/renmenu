"""Optional local demo smoke test: python3 -m playwright install chromium first.
Run while `python3 -m http.server 8765 --bind 127.0.0.1` serves the repository root.
No provider requests or production URLs are used.
"""
from pathlib import Path
import os
import tempfile
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8765/control-room/site/?demo=1'
OUT = Path(os.environ.get('CONTROL_ROOM_SCREENSHOT_DIR', Path(tempfile.gettempdir()) / 'renmenu-control-room-shots'))
OUT.mkdir(exist_ok=True)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    for width, height in [(375, 812), (390, 844), (430, 932), (768, 1024), (1280, 800)]:
        context = browser.new_context(viewport={'width': width, 'height': height}, reduced_motion='reduce', locale='it-IT')
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(BASE, wait_until='networkidle')
        page.get_by_role('heading', name='Command Center').wait_for()
        dimensions = page.evaluate('({inner: window.innerWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth})')
        assert dimensions['scroll'] <= width and dimensions['body'] <= width, f'overflow {width}: {dimensions}'
        assert not errors, f'JS error {width}: {errors}'
        if width <= 768:
            targets = page.locator('#bottom-nav > .nav-link').evaluate_all('(links) => links.map((item) => ({width: item.getBoundingClientRect().width, height: item.getBoundingClientRect().height}))')
            assert all(target['width'] >= 44 and target['height'] >= 44 for target in targets), f'touch target mobile {width}: {targets}'
        if width in (390, 1280):
            page.screenshot(path=str(OUT / ('mobile-390.png' if width == 390 else 'desktop-1280.png')), full_page=True)
        nav = '#bottom-nav' if width <= 768 else '#primary-nav'
        page.locator(f'{nav} [href="#richieste"]').click()
        page.get_by_role('heading', name='Richieste', exact=True).wait_for()
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), f'overflow Richieste {width}'
        page.locator('#theme-toggle').click()
        assert page.locator('html').get_attribute('data-theme') == 'light'
        page.locator('#theme-toggle').click()
        assert page.locator('html').get_attribute('data-theme') == 'dark'
        page.evaluate('document.activeElement.blur()')
        page.keyboard.press('Tab')
        focus = page.evaluate('({tag: document.activeElement.tagName, visible: document.activeElement.matches(":focus-visible"), outline: getComputedStyle(document.activeElement).outlineStyle, shadow: getComputedStyle(document.activeElement).boxShadow})')
        assert focus['visible'] and (focus['outline'] not in ('none', '') or focus['shadow'] != 'none'), f'focus non visibile {width}: {focus}'
        if width == 390:
            context.set_offline(True)
            page.locator('#bottom-nav [href="#clienti"]').click()
            form = page.locator('form[data-form="create-client"]')
            form.locator('[name="name"]').fill('Locale offline sintetico')
            form.locator('button[type="submit"]').click()
            page.get_by_text('Cliente demo creato.').wait_for()
            context.set_offline(False)
        assert not errors, f'JS error after interactions {width}: {errors}'
        print(f'PASS {width}x{height}: viewport, navigazione, temi, focus, zero errori JS')
        context.close()
    context = browser.new_context(viewport={'width': 390, 'height': 844})
    page = context.new_page()
    page.goto(BASE.replace('?demo=1', ''), wait_until='networkidle')
    page.get_by_role('heading', name='Accesso da verificare').wait_for()
    assert page.get_by_text('Bottega Aurora — demo').count() == 0, 'Demo leaked without local opt-in'
    context.close()
    print('PASS: senza ?demo=1 nessun dato mock; API privata non configurata è un errore visibile')
    browser.close()
print('Screenshot:', OUT)
