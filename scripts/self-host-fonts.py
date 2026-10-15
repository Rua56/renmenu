#!/usr/bin/env python3
"""Porta in casa i caratteri di Google Fonts usati dalle pagine pubbliche (privacy: nessun indirizzo IP
dei visitatori a Google). Scarica i soli sottoinsiemi latin e latin-ext (italiano, tedesco, sloveno,
francese, spagnolo) in assets/fonts/ e riscrive i <link> delle pagine. Si rilancia quando una pagina
aggiunge un carattere nuovo. I caratteri sono sotto licenza SIL Open Font License."""
import hashlib, html, pathlib, re, sys, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets' / 'fonts'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
KEEP = {'latin', 'latin-ext'}
PAGES = [p for p in ROOT.rglob('*.html') if 'control-room' not in p.parts and '.git' not in p.parts]
# Insiemi usati da menu/premium.js (CARATTERI): stessi parametri di Google, file con nome fisso.
PREMIUM = {
    'premium-classico': 'family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=DM+Sans:wght@400;500;600',
    'premium-moderno': 'family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=Manrope:wght@400;500;600;700',
    'premium-artigianale': 'family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Karla:wght@400;500;600;700',
}

def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()

def localize(query, name):
    css = get(f'https://fonts.googleapis.com/css2?{query}' + ('' if 'display=' in query else '&display=swap')).decode()
    blocks = re.findall(r'/\* ([a-z-]+) \*/\s*(@font-face \{.*?\})', css, re.S)
    out = []
    for subset, block in blocks:
        if subset not in KEEP:
            continue
        def swap(m):
            src = m.group(1)
            file = OUT / 'files' / (hashlib.sha256(src.encode()).hexdigest()[:16] + '.woff2')
            if not file.exists():
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(get(src))
            return f"url(files/{file.name})"
        out.append(f'/* {subset} */\n' + re.sub(r'url\((https://fonts\.gstatic\.com/[^)]+)\)', swap, block))
    if not out:
        sys.exit(f'nessun font latin per {query}')
    (OUT / f'{name}.css').write_text('/* Copia locale di Google Fonts (licenza SIL OFL), generata da scripts/self-host-fonts.py */\n' + '\n'.join(out) + '\n')
    return f'{name}.css'

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, query in PREMIUM.items():
        localize(query, name)
    link = re.compile(r'<link[^>]*href="https://fonts\.googleapis\.com/css2\?([^"]+)"[^>]*>')
    pre = re.compile(r'[ \t]*<link rel="preconnect" href="https://fonts\.(?:googleapis|gstatic)\.com"[^>]*>\n')
    for page in PAGES:
        text = page.read_text()
        if 'fonts.googleapis.com' not in text:
            continue
        depth = len(page.relative_to(ROOT).parts) - 1
        prefix = '../' * depth
        def repl(m):
            query = html.unescape(m.group(1)).replace('&display=swap', '')
            name = 'g-' + hashlib.sha256(query.encode()).hexdigest()[:10]
            css = localize(query, name)
            return f'<link rel="stylesheet" href="{prefix}assets/fonts/{css}">'
        text = pre.sub('', link.sub(repl, text))
        page.write_text(text)
        print('aggiornata', page.relative_to(ROOT))

if __name__ == '__main__':
    main()
