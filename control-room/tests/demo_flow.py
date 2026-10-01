"""Manual/CI local-only E2E for the synthetic demo; requires Playwright Chromium.
Start repo root on localhost:8765 and run `python3 control-room/tests/demo_flow.py`.
"""
from pathlib import Path
import os
import tempfile
from playwright.sync_api import sync_playwright

URL = 'http://127.0.0.1:8765/control-room/site/?demo=1'
OUT = Path(os.environ.get('CONTROL_ROOM_SCREENSHOT_DIR', Path(tempfile.gettempdir()) / 'renmenu-control-room-shots'))
OUT.mkdir(parents=True, exist_ok=True)
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1280, 'height': 820}, locale='it-IT')
    page = context.new_page()
    errors, external = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: external.append(request.url) if not request.url.startswith('http://127.0.0.1:8765/') else None)
    page.goto(URL)
    page.get_by_role('heading', name='Command Center').wait_for()
    page.locator('#primary-nav [href="#clienti"]').click()
    form = page.locator('form[data-form="create-client"]')
    form.locator('[name="name"]').fill('Trattoria Sestante — test fittizio')
    form.locator('[name="plan"]').select_option('standard')
    form.locator('button[type="submit"]').click()
    page.get_by_text('Cliente demo creato.').wait_for()
    page.locator('#primary-nav [href="#richieste"]').click()
    form = page.locator('form[data-form="create-request"]')
    form.locator('[name="clientId"]').select_option(label='Trattoria Sestante — test fittizio')
    form.locator('[name="subject"]').fill('Menu serale nuovo — fittizio')
    form.locator('[name="sourceText"]').fill('Locale: Trattoria Sestante — test fittizio\n# Piatti\nVerdure al forno — 6,50\nZuppa del giorno — 8,00')
    form.locator('button[type="submit"]').click()
    page.get_by_text('Nuova pratica creata.').wait_for()
    page.locator('#primary-nav [href="#builder"]').click()
    page.locator('[data-action="generate-draft"]').click()
    page.get_by_text('Bozza estratta senza dati inferiti.').wait_for()
    page.locator('#primary-nav [href="#approvazioni"]').click()
    assert page.locator('[data-confirm-kind="pr"]').is_disabled(), 'PR bypass before review'
    page.locator('#primary-nav [href="#revisione"]').click()
    review = page.locator('form[data-form="review-draft"]')
    for field in ('prices', 'allergens', 'languages', 'clientApproval'):
        review.locator(f'[name="{field}"]').check()
    review.locator('[name="approvalEvidence"]').fill('Consenso scritto fittizio: documento demo rev. 1')
    review.locator('button[type="submit"]').click()
    page.get_by_text('Checklist registrata.').wait_for()
    page.locator('#primary-nav [href="#approvazioni"]').click()
    assert page.locator('[data-confirm-kind="pr"]').is_enabled()
    page.locator('[data-confirm-kind="pr"]').click()
    page.locator('#confirm-copy').get_by_text('Trattoria Sestante', exact=False).wait_for()
    page.locator('#confirm-input').fill('CONFERMO PR DI PROVA')
    page.locator('#confirm-submit').click()
    page.get_by_text('PR di prova registrata: nessun repository modificato.').wait_for()
    assert page.locator('[data-confirm-kind="publish"]').is_enabled()
    page.locator('[data-confirm-kind="publish"]').click()
    page.locator('#confirm-input').fill('CONFERMO PUBBLICAZIONE SIMULATA')
    page.locator('#confirm-submit').click()
    page.get_by_text('Pubblicazione simulata registrata; nessuna pubblicazione reale.').wait_for()
    assert page.get_by_text('Pubblicazione simulata', exact=True).count() > 0
    assert not errors, errors
    assert not external, f'Unexpected external traffic: {external}'
    print('PASS: cliente → pratica → bozza → revisione → PR simulata → pubblicazione simulata; zero richieste esterne')
    page.wait_for_timeout(4600)  # Let transient success toasts disappear from the proof image.
    page.evaluate('document.activeElement.blur(); window.scrollTo(0, 0)')
    page.wait_for_timeout(150)
    page.screenshot(path=str(OUT / 'approvazioni-demo.png'), full_page=True)
    context.close()
    browser.close()
