#!/usr/bin/env python3
"""Prova di comprensione di Jarvis: manda le frasi di frasi.json all'endpoint di sola diagnostica
(/jarvis-hook/probe-intent, nessuna azione eseguita) e confronta l'intenzione capita con quella attesa.
Uso:  JARVIS_PROBE_SECRET=<segreto del bot> python3 run.py [gemini|cloudflare|auto] [quante] [frasi per chiamata]
Una chiamata alla volta: il piano gratuito di Gemini rifiuta (429) se le richieste arrivano troppo fitte.
Aggiungi le tue frasi in frasi.json come coppie [frase, intenzione attesa]; 'risposta' accetta anche 'non_chiaro'
(in quel caso Jarvis passa alla conversazione libera)."""
import json, os, subprocess, sys
engine = sys.argv[1] if len(sys.argv) > 1 else 'gemini'
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 999
size = int(sys.argv[3]) if len(sys.argv) > 3 else 3
base = os.environ.get('JARVIS_BASE', 'https://renmenu-jarvis-stage.pages.dev')
secret = os.environ['JARVIS_PROBE_SECRET']
cases = json.load(open(os.path.join(os.path.dirname(__file__), 'frasi.json')))[:limit]
ok = 0
for i in range(0, len(cases), size):
    batch = cases[i:i + size]
    out = subprocess.run(['curl', '-s', '-m', '170', '-X', 'POST', '-H', 'Content-Type: application/json', '-H', f'X-Telegram-Bot-Api-Secret-Token: {secret}',
                          '-d', json.dumps({'phrases': [p for p, _ in batch], 'engine': engine}), f'{base}/jarvis-hook/probe-intent'], capture_output=True, text=True)
    try: results = json.loads(out.stdout)['results']
    except Exception: results = [{'final': 'ERRORE', 'intent': 'ERRORE'}] * len(batch)
    for (phrase, expected), r in zip(batch, results):
        got = r.get('final')
        good = got == expected or (expected == 'risposta' and got == 'non_chiaro')
        ok += good
        print('OK ' if good else 'NO ', phrase[:50].ljust(50), expected.ljust(13), str(r.get('intent')).ljust(13), r.get('dettaglio', ''), r.get('engine', ''), r.get('ms', ''), r.get('why', ''))
print(f'{engine}: {ok}/{len(cases)}')
