# RenMenu Control Room · Jarvis operativo

**Stato (1 ottobre 2026): staging privato distribuito su Pages, PR #3 aperta e non unita.** La vecchia app Jarvis su Manus è distinta ed è già online. La Control Room è il cockpit privato del Team RenMenu, non un portale clienti. Il sito commerciale `renmenu.pages.dev`, i menù e i QR esistenti rimangono invariati. Lo staging contiene pratiche **fittizie** di collaudo, non materiali di clienti reali.

## Ambienti e accesso

| Ambiente | Origine | Dati e azioni | Stato |
| --- | --- | --- | --- |
| Demo locale | `http://127.0.0.1:8765/control-room/site/?demo=1` | Dati sintetici nel solo localStorage; upload di nuovi file solo metadati; PR/pubblicazione simulate | Funzionante |
| Staging privato | `https://renmenu-jarvis-stage.pages.dev/control-room/` | D1/R2 dedicati, JWT Cloudflare Access di `renmenu1569@gmail.com`; email owner-only collaudata, AI limitata a una fixture fittizia | **Distribuito e verificato; non è produzione RenMenu** |
| RenMenu pubblico | `https://renmenu.pages.dev/` | Sito statico commerciale e menù esistenti | Invariato |

Lo staging è stato distribuito **separatamente** tramite Dashboard Direct Upload di un archivio con frontend e Worker compilato. Due app Access autorizzano esclusivamente `renmenu1569@gmail.com` per l'host stabile e per i deployment wildcard; il middleware e la route API verificano a loro volta firma RS256/JWKS, issuer, audience, scadenza, tipo di token ed email owner. Le scritture richiedono Origine same-origin. Mancanza di firma/configurazione = rifiuto. È stato verificato il login owner e il redirect al login da sessione non autenticata sui due host; prima di usare dati veri, completare anche una verifica da un'identità non autorizzata di HTML, JS, CSS, API e allegati. Non esporre al pubblico file R2 o codice contenente segreti.

## Avvio locale e prove

```sh
python3 -m http.server 8765 --bind 127.0.0.1  # eseguire dalla root del repository
# Aprire http://127.0.0.1:8765/control-room/site/?demo=1
npm test --prefix control-room
npm run check --prefix control-room
python3 scripts/validate-menus.py
sh scripts/build-cloudflare.sh
# Deve rimanere assente dist/control-room.
```

Per i collaudi browser opzionali installare Playwright Chromium e avviare il server HTTP localhost, poi eseguire `python3 control-room/tests/browser_smoke.py` (375, 390, 430, 768, 1280 px), `demo_flow.py` e `preview_flow.py` nella stessa cartella. `CONTROL_ROOM_SCREENSHOT_DIR` imposta una destinazione separata per gli screenshot. Il PDF fittizio a due pagine è rigenerabile con `python3 control-room/tests/make_demo_pdf.py` e non contiene dati cliente. Un vero PDF privato è renderizzato localmente da PDF.js; testo incorporato estraibile può essere proposto come fonte, mentre OCR per scansioni/immagini **non è ancora attivo**.

Flusso demo: **Clienti → Richieste → Materiali → Builder → Revisione → Anteprima → Approvazioni → PR mock → pubblicazione simulata**. La checklist richiede evidenza scritta per prezzi, allergeni, lingua e approvazione del locale; omissioni allergeni richiedono un consenso distinto e non equivalgono a dichiararne l'assenza. Fonte o JSON modificati azzerano la checklist. Il QR provvisorio punta solo alla preview privata, mai al link del menu pubblico. La voce browser è opzionale, richiede consenso, produce testo correggibile e non approva né pubblica. Il mock non invia email, WhatsApp, chiamate, pagamenti o modifiche GitHub. I file binari caricati durante la demo locale non sono conservati, salvo il PDF statico fittizio.

## Architettura

| Percorso | Responsabilità |
| --- | --- |
| `control-room/site/` | UI mobile-first, mock locale, voce browser, QR self-hosted e renderer PDF.js/preview |
| `control-room/cloudflare/functions/` | API privata Access, middleware asset statici, adapter AI/GitHub, webhook firmati, notifiche e retention |
| `control-room/cloudflare/migrations/` | Schema D1 dedicato: pratiche, revisioni, audit, eventi esterni, operazioni PR e consegne |
| `control-room/staging/build.sh` | Assembla `.staging/dist/` e `.staging/functions/` senza distribuire né toccare la build pubblica |
| `control-room/staging/package-dashboard.sh` | Compila Functions in `_worker.js` e prepara uno ZIP per Direct Upload nel solo progetto Pages staging; non distribuisce |
| `control-room/tests/` | Prove offline SQLite, JWT, adapter finti, idempotenza, Browser/QR/PDF |
| `control-room/schemas/` | Contratti JSON per classificazione, estrazione, bozza e risposta |
| `docs/approval-policy.md`, `docs/voice-persona.md`, `docs/control-room-privacy.md` | Regole approvazione, voce originale, dati/retention |

Il database D1 **dedicato** ha già ricevuto `0001_initial.sql`, `0002_integrations.sql` e `0003_ai_free_scope.sql`; contiene pratiche di test esplicitamente fittizie, **non** dati cliente reali. Una sola pratica è marcata fixture AI e i payload di testo approvati sono sigillati con SHA-256. Nel bucket R2 WEUR `renmenu-jarvis-stage-private` è stato caricato il PDF sintetico `menu-fittizio-demo.pdf` per collaudare upload D1/R2 e viewer privato a due pagine. Il PDF è un dato inventato, non un menù reale; una trascrizione non ne certifica l'approvazione. D1 e R2 sono associati al solo progetto Pages separato `renmenu-jarvis-stage` nelle configurazioni Preview e Production; il sito Pages RenMenu esistente non ha questi binding. Lo script pubblico `scripts/build-cloudflare.sh` copia soltanto pagine commerciali e menù; mai l'intera cartella Control Room. Per ricostruire un archivio staging:

```sh
sh control-room/staging/build.sh
cd control-room/.staging
wrangler pages functions build --outdir .wrangler/functions-check --compatibility-date 2026-10-01
# Non scrivere l'output di verifica dentro dist/: il Worker bundle non è un asset statico.
cd ../..
sh control-room/staging/package-dashboard.sh /tmp/renmenu-jarvis-stage-upload.zip
# Poi caricare ZIP via Dashboard del SOLO progetto renmenu-jarvis-stage; la build non fa deploy.
```

**Il deployment staging è riuscito**, non quello pubblico. Prima di ogni aggiornamento verificare `_routes.json`, la presenza di `_worker.js` nell'archivio, Access e i binding; la giurisdizione API del bucket R2 WEUR è `default`, non `eu`. I webhook `/hooks/gmail` e `/hooks/whatsapp` richiedono HMAC provider/relay e rimangono spenti e dietro Access finché non esiste una policy/service token strettamente limitata a tali route. Non aprire bypass generici. Direct Upload non crea PR né modifica `renmenu.pages.dev`. Il branch di lavoro e la PR #3 non vanno uniti a `main` senza revisione separata: il repository è servito anche da GitHub Pages.

## Integrazioni e limiti reali

- **AI:** il solo progetto Pages staging usa ora `AI_PROVIDER=cloudflare_workers_ai`, binding server-side `AI` e modello fisso `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. L'account Cloudflare è attualmente **Workers Free**: quota 10.000 Neurons/giorno con blocco al superamento; nessun upgrade o acquisto eseguito. L'eventuale passaggio futuro a Paid va rivalutato perché può comportare costi. La vecchia chiave OpenAI resta Secret cifrato ma non viene usata da questa modalità. Il gate lato server ammette solo staging protetto, ID della fixture D1 marcata e hash immutabili di oggetto/canale/nome locale/testo/trascrizione; richiede conferma esatta e riserva in D1 non più di tre tentativi al giorno per azione, senza inferenze parallele. Traduzioni con input arbitrari, audio e OCR restano spenti. Un primo test live sulla sola trascrizione fittizia ha raggiunto il modello ma è stato **respinto dal validatore delle citazioni**; la normalizzazione delle sole citazioni letteralmente presenti nella fonte è stata aggiunta e collaudata offline, ma non ritestata live su richiesta di fermare i test AI. **Non dichiarare ancora riuscita l'analisi automatica.** Il Builder conserva la risposta solo come proposta di sessione, non salva menù, invia messaggi o pubblica. Materiali cliente reali restano esclusi.
- **GitHub:** `GITHUB_PROVIDER=mock` è spento per azioni live. L'adapter live legge SHA/menu, rifiuta slug esistenti per nuove pratiche, prepara branch e **draft PR** idempotenti solo dopo checklist e conferma esatta del proprietario. Nessun merge/deploy automatico. Serve un token limitato a `Rua56/renmenu` con permessi minimi, memorizzato solo come segreto Pages. La verifica del menu pubblicato è distinta dalla creazione PR; il testo Gmail non deve essere eliminato prima della corrispondenza tra PR merged e menu raggiungibile.
- **Gmail:** il Trigger business già attivo manda nuove richieste al precedente Jarvis Manus, **non** a questa Control Room. Il webhook `/hooks/gmail` accetta soltanto eventi di `renmenu1569@gmail.com` con HMAC, scadenza 5 minuti e ID deduplicato; è disattivato. Prima del cutover creare un relay firmato che legge il messaggio completo dal solo account business, non lo snippet e non l'account personale; importare allegati solo se realmente acquisiti; verificare Access, poi disattivare l'uscita precedente per evitare duplicati. Le email restano conservate fino a quando il menu è online e disponibile, come richiesto dal proprietario; l'eliminazione del corpo richiede conferma esatta e verifica reale della versione pubblica.
- **Email in uscita:** il compositore è disponibile direttamente nel **Command Center** e nella scheda Notifiche; invia **solo al proprietario `renmenu1569@gmail.com`**, con testo esatto e conferma on-screen. La chiave Resend dell'account business è un Secret nel solo progetto Pages staging e `onboarding@resend.dev` è limitato all'email di tale account. Un avviso **TEST INTERNO** inviato il 1 ottobre 2026 è risultato **Delivered** nel registro Resend; ciò prova la consegna al provider destinatario, non la lettura dell'email da parte del proprietario. Non esiste invio automatico da richieste Gmail: quel Trigger resta sul vecchio Jarvis. Quiet hours Europa/Roma 21:00–08:00 salvo priorità urgente; l'ora silenziosa blocca, non accoda. Nessuna email ai clienti.
- **WhatsApp:** webhook Meta con firma e deduplica/bozza; provider in uscita disattivato. Per avviare serviranno account Business, numero, token, finestra assistenza 24h, prova firma e conferma esatta del messaggio; nessun invio reale oggi.
- **Telefonate e SMS:** adapter fail-closed, soltanto simulazioni. Nessun numero owner verificato o credenziale, e non si chiama nessuno in questa fase.
- **Pagamenti/produzione:** nessuna integrazione Stripe, modifica ai Payment Link, merge, pubblicazione autonoma o cambi al sito RenMenu. Ogni azione esterna richiede un riepilogo materiale e conferma umana.

## Variabili e binding server-side

I valori reali vanno **solo** nei Secret/Environment Variables Pages, mai nell'HTML, in Git, nei log o nella chat. L'esempio con nomi è in [`control-room/.env.example`](control-room/.env.example). Binding `DB` → D1 dedicato; `BUCKET` → R2 privato; `AI` → Workers AI nel solo staging Production; `TEAM_DOMAIN`, `POLICY_AUD`, `PREVIEW_AUD`, `OWNER_EMAIL` per Access. Per l'AI gratuita: `AI_PROVIDER`, `AI_MODEL`, `AI_TEST_REQUEST_ID` (la chiave/base OpenAI rimane inutilizzata). Per GitHub: `GITHUB_PROVIDER`, `GITHUB_TOKEN`. Per Gmail relay: `GMAIL_RELAY_ENABLED`, `GMAIL_RELAY_SECRET`. Per l'email owner: `ENVIRONMENT`, `STAGING_PROTECTED`, `EMAIL_LIVE_ENABLED`, `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_FROM_VERIFIED`, `RESEND_ONBOARDING_SENDER_AUTHORIZED`. Per WhatsApp: `WHATSAPP_WEBHOOK_ENABLED`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`; i segreti per outbound non sono configurati. Lasciare ogni altra integrazione live spenta finché il relativo collaudo non è riuscito. Nessun materiale cliente reale va importato finché l'uso non è autorizzato e verificato.

Licenze: `qrcode-generator` MIT e `pdfjs-dist` Apache 2.0 con file di licenza nella cartella `site/vendor/`. Il Blanch viewer (`blanch/data/menu.json`) usa uno schema diverso e resta escluso dal Builder; i menù standard sono `menus/<id>.json`, validati con `scripts/validate-menus.py`, e conservano lo slug dei QR esistenti.
