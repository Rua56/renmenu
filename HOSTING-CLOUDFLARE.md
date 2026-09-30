# RenMenu su Cloudflare Pages

**Origine ufficiale del sito RenMenu:** https://renmenu.pages.dev/. Il codice resta nel repository `Rua56/renmenu`, branch `main`; il progetto Cloudflare Pages `renmenu` lo distribuisce automaticamente. GitHub Pages resta online per i QR e i messaggi già distribuiti, ma i canonical delle pagine puntano alla nuova origine.

## Build e pagine

- Build command: `sh scripts/build-cloudflare.sh`; output directory: `dist`; root: radice del repository.
- Il build copia solo i file pubblici: home, anteprima, caso studio Blanch, demo, menù, pagamento, asset, dati JSON pubblicati e menù Blanch. Non invia `.git`, documenti commerciali, foto grezze, `blanch/data/food.json`, `blanch/data/wines.tsv` o script di manutenzione.
- `crea/` è già una pagina pubblica, non un pannello riservato: ora propone `https://renmenu.pages.dev/` per i nuovi QR, ma il campo URL può essere cambiato per un menù legacy.
- L'output Pages contiene `robots.txt` e `sitemap.xml` con **home, anteprima e il caso studio `/casi-studio/trattoria-blanch/`**. Demo incorporata, pagamenti, generatore interno e menù cliente restano `noindex` e fuori sitemap. L'elenco va aggiornato quando si creano pagine di marketing con contenuti autonomi.
- Il menù Blanch non viene reindirizzato né spostato: il QR già stampato punta a `https://rua56.github.io/renmenu/blanch/`, che deve rimanere raggiungibile. Il menù esiste anche su Pages.
- In Cloudflare esiste separatamente un Worker chiamato `renmenu`: non è il progetto Pages e non serve al sito qui documentato.

## Search Console

Usare una proprietà **Prefisso URL** con `https://renmenu.pages.dev/` (lo slash finale incluso). Verificare la proprietà con il metodo Google disponibile al proprietario, poi inviare `https://renmenu.pages.dev/sitemap.xml` nella sezione Sitemap. Un sitemap pubblicato non equivale alla sua registrazione in Search Console e non garantisce l'indicizzazione.

## Aggiornamenti e controllo

Per un aggiornamento del menù Blanch modificare `blanch/data/food.json` o `blanch/data/wines.tsv`, eseguire `python3 blanch/tools/build_menu.py`, revisionare `blanch/data/menu.json`, poi commit e push. Dopo il deployment verificare home, anteprima, caso studio, `blanch/data/menu.json`, sitemap e gli URL GitHub Pages dei QR prima di confermare al cliente. JSON e HTML mantengono cache breve per riflettere correzioni senza ristampare il QR.
