# RenMenu su Cloudflare Pages

Questo hosting statico è indipendente da GitHub Pages: GitHub resta il repository del codice e può alimentare la build Cloudflare. Il vecchio sito GitHub Pages deve restare attivo finché esistono QR e messaggi che puntano ai suoi URL.

## Configurazione consigliata

- Provider: Cloudflare Pages, progetto `renmenu`, produzione dal branch `main` del repository `Rua56/renmenu`.
- Build command: `sh scripts/build-cloudflare.sh`.
- Build output directory: `dist`.
- Root directory: root del repository.
- Il comando compila solo i file pubblici; non invia `.git`, documenti commerciali, foto grezze, `blanch/data/food.json`, `blanch/data/wines.tsv` o script di manutenzione. La pagina `crea/` è già pubblica su GitHub Pages ed è inclusa per parità funzionale, benché non sia una console privata.
- Per verificare in locale: `sh scripts/build-cloudflare.sh`; poi servire `dist` con un server statico e controllare `/`, `/anteprima/`, `/menu/?m=bakaro`, `/demo/`, `/paga/` e `/blanch/`.

## Transizione degli indirizzi

Il primo deploy crea un URL `*.pages.dev`; non presumere che sia `renmenu.pages.dev` fino alla risposta effettiva di Cloudflare. In questa fase il sito Cloudflare è un **mirror funzionante**, non ancora la destinazione ufficiale: i canonical e gli OG URL esistenti puntano ancora a GitHub Pages. Non sostituire i link stampati, i canonical o l'eventuale URL di ritorno Stripe finché il nuovo dominio pubblico non è stato scelto e verificato.

Per rendere Pages la sede ufficiale dopo la scelta definitiva del dominio: collegare il dominio, controllare HTTPS e tutte le pagine, aggiornare metadati/canonical/OG, verificare gli URL di ritorno Stripe e solo allora diffondere i nuovi link. Lasciare online gli indirizzi precedenti o predisporre redirect equivalenti prima di spegnerli: **il QR della Trattoria Blanch punta a `https://rua56.github.io/renmenu/blanch/`**.

## Aggiornare il menù Blanch

Modificare `blanch/data/food.json` oppure `blanch/data/wines.tsv`, ricompilare `python3 blanch/tools/build_menu.py`, revisionare `blanch/data/menu.json`, poi fare commit e push. Cloudflare Pages ricostruisce il sito se l'integrazione GitHub è attiva. Controllare il contenuto online prima di confermare l'aggiornamento al ristorante.
