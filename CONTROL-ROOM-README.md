# RenMenu Control Room · Jarvis operativo

**Stato: branch/PR di prova, non unita e non distribuita.** La Control Room è il cockpit privato del Team RenMenu, non un portale per i locali. È distinta dal sito commerciale e dall'app Jarvis precedentemente ospitata su Manus. In questa versione il **mock locale** è interattivo; un'API Cloudflare Pages Functions con D1/R2 e middleware Access è implementata e testata in locale, ma **non** ha un deployment, un database, un bucket o credenziali live. Nessun menu, QR, link pagamento o contatto pubblico è stato modificato.

## Avvio della demo locale (solo dati fittizi)

Dalla root del repository, con Python 3:

```sh
python3 -m http.server 8765 --bind 127.0.0.1
# In una scheda del browser sullo stesso computer:
# http://127.0.0.1:8765/control-room/site/?demo=1
```

Il mock si attiva **solo** su `localhost`/`127.0.0.1` con `?demo=1`; i dati sintetici sono nel `localStorage` del browser, non in Cloudflare. «Ripristina demo» li azzera. In modalità locale ordinaria senza query la pagina cerca l'API privata e mostra l'errore, non converte automaticamente l'errore in demo. La demo non invia HTTP a Gmail, GitHub, WhatsApp, Twilio o Cloudflare. **Eccezione opzionale di privacy**: se Riccardo abilita e avvia il microfono, alcuni browser possono usare il proprio servizio remoto di riconoscimento; la UI lo spiega e chiede consenso prima di ogni ascolto. Non caricare file o dati di clienti reali nella demo: `localStorage` non è un archivio aziendale protetto.

Per provare: **Clienti → Richieste → Builder → Revisione → Anteprima → Approvazioni**. La scheda demo contiene un locale fittizio, una pratica WhatsApp fittizia, metadati PDF, una bozza da testo, un prezzo volutamente mancante e un avviso chiamata non avviata. Una richiesta nuova può iniziare senza testo; associare poi un materiale in **Materiali**. Il mock conserva solo metadati (e fino a 500 caratteri per il testo) e non interpreta binari. Per generare un menu, trascrivere le righe verificabili in Builder, per esempio `## Primi` e `Gnocchi — 12,00`. Prezzi assenti, allergeni, contatti e traduzioni non vengono indovinati.

Il Builder è **deterministico**, non un OCR né un LLM live. La Revisione mostra provenienza, validazione, editor JSON, sezioni e versioni. L'Anteprima visualizza un renderer isolato con telefono/desktop e QR/link **provvisori non attivi**; il diff confronta solo snapshot della bozza, **non** il menu live su GitHub. La checklist richiede verifica di prezzi, allergeni, lingue e annotazione dell'approvazione scritta del locale; solo allora è disponibile la prima conferma con frase `CONFERMO PR DI PROVA`. La seconda `CONFERMO PUBBLICAZIONE SIMULATA` produce solo un record mock. Non crea branch, PR, merge né deploy. Caricare o archiviare una nuova fonte azzera la checklist; una pratica con PR mock già pronta non è più modificabile. Per nuovi dati creare una nuova pratica.

In **Notifiche** si preparano bozze email/WhatsApp e avvisi interni con priorità/scadenza/lettura; i moduli simulano anche un WhatsApp entrante e una chiamata **non avviata**. In **Voce** il microfono browser è facoltativo, spento inizialmente; trascrizione correggibile, risposta testuale e lettura con `SpeechSynthesis` italiano generico se supportato, velocità/volume regolabili. Non esiste una voce di attore, né un comando che possa approvare o pubblicare. Si può usare sempre il testo.

## Struttura e stato

| Componente | Percorso | Stato |
| --- | --- | --- |
| UI responsive, adapter demo, voce | `control-room/site/` | Demo funzionale, fuori dalla build pubblica |
| API D1/R2 e adapter mock | `control-room/cloudflare/functions/` | Codice testato localmente, **non** nella directory Functions root |
| Database D1 nuovo | `control-room/cloudflare/migrations/0001_initial.sql` | SQL additivo per database dedicato, **non applicato** a Cloudflare |
| Routing Pages | `control-room/cloudflare/_routes.json.example` | Esempio inattivo, protegge statici e API private se installato correttamente |
| Schemi JSON di output | `control-room/schemas/` | Contratti per futura AI; nessun modello live chiamato |
| Sicurezza e flussi | `docs/approval-policy.md`, `docs/voice-persona.md`, `docs/control-room-privacy.md` | Documentazione operativa |
| Test | `control-room/tests/` | Node/SQLite e browser locale opzionale |

I menu standard seguono `menus/demo.json` e `scripts/validate-menus.py`. Il menu Blanch (`blanch/data/menu.json`) ha uno schema diverso ed è escluso dal Builder. Il viewer pubblico resta `menu/?m=<id>` con JSON `menus/<id>.json`; lo slug di un aggiornamento deve restare quello del QR esistente. Prima di una **futura PR reale** controllare inoltre che lo slug di un nuovo locale non esista già su GitHub. Nessuno di questi file pubblici è cambiato.

## Sicurezza e separazione Cloudflare

Il middleware Pages verifica **lato server** il JWT `Cf-Access-Jwt-Assertion` con JWKS/RS256, `iss`, `aud`, `exp`, `type=app` ed email proprietario esatta. Non si fida del solo header email o del client guard. Protegge anche HTML/CSS/JS dell'area, usa no-store/noindex/CSP e nega accesso se mancano configurazione o firma. Le scritture richiedono same-origin; l'API limita dimensioni, formati e firme di PDF/immagini/audio, conserva i binari in R2 privato e serve file solo tramite endpoint autenticato. D1 registra pratica, fonte, revisioni CAS, checklist, audit e doppia conferma; nessun token o dato cliente reale è nel repository. Gli adapter non-mock restituiscono `501` e nessun effetto esterno.

**Non distribuire questa PR direttamente.** `scripts/build-cloudflare.sh` copia solo le risorse pubbliche già esistenti, **non** `control-room/`; non c'è `functions/` nella root né `_routes.json` attivo. La sola PR non espone il cockpit su Pages. GitHub Pages, essendo statico, **non può proteggere codice privato**: prima di qualsiasi merge futuro verificare che i sorgenti non vengano serviti pubblicamente, oppure separarli in un repository/deploy privato. Configurare Pages **Fail closed** quando si attivano Functions, anche in caso di quota/esecuzione errata. Il Worker `renmenu` eventualmente esistente è distinto e non va sovrascritto.

## Test riproducibili

```sh
npm test --prefix control-room
npm run check --prefix control-room
python3 scripts/validate-menus.py
sh scripts/build-cloudflare.sh
# Verifica che dist/ non contenga control-room/ né Functions private.
```

I test Node (Node 22 con `node:sqlite` sperimentale) verificano token Access validi/falsi, ACL asset statici, CSRF, D1 in memoria, CAS, QR invariato, invalidazione checklist, doppia conferma, R2 mock, rifiuto di metadati privati nel JSON e **rollback D1 se l'audit fallisce**. Per gli screenshot e il flusso browser **facoltativo** installare Playwright Chromium in un ambiente di prova e avviare il server locale su `127.0.0.1:8765`:

```sh
python3 -m playwright install chromium
python3 control-room/tests/browser_smoke.py  # 375, 390, 430, 768, 1280 px
python3 control-room/tests/demo_flow.py      # cliente → pratica → bozza → 2 conferme mock
```

Il test browser produce screenshot in una directory temporanea del sistema oppure nella cartella indicata da `CONTROL_ROOM_SCREENSHOT_DIR`; non li scrive nel repository. Lo script di build originale deve continuare a pubblicare solo il sito attuale; questa PR non cambia la landing, Stripe, Payment Link, IBAN, menu/QR, né URL GitHub Pages.

## Attivazione futura — solo dopo approvazione separata

Questi passaggi **non sono stati eseguiti**. Per preparare uno staging privato, Riccardo deve prima scegliere ambiente, email owner e policy/retention (vedi [privacy](docs/control-room-privacy.md)):

1. **Access.** In Cloudflare Zero Trust creare un'applicazione self-hosted per l'origin Pages e coprire **sia** `/control-room` **sia** `/control-room/*`, includendo solo l'email esatta del proprietario. Configurare `TEAM_DOMAIN`, `POLICY_AUD` (Application Audience tag) e `OWNER_EMAIL` nelle variabili **server-side Pages**, distinte tra Preview e Production. Verificare anche in incognito un utente non autorizzato, statici compresi; abilitare Pages **Fail closed**.
2. **D1.** Creare un database **nuovo dedicato** alla Control Room; associare il binding Pages **`DB`**. Solo nel database nuovo eseguire `control-room/cloudflare/migrations/0001_initial.sql`; controllare schema, backup e ambiente prima dell'uso. Non applicare la migrazione a dati RenMenu esistenti.
3. **R2.** Creare un bucket **nuovo privato**, senza custom/public domain; associare il binding Pages **`BUCKET`**. Provare PDF, MIME non valido, 10 MB, accesso negato e archiviazione; decidere una policy di cancellazione definitiva prima di usare dati reali. Preview/Production devono avere risorse separate.
4. **Routing sicuro.** Su un **altro branch di attivazione**, dopo approvazione, copiare `control-room/site/` in `dist/control-room/` tramite una modifica esplicita alla build; copiare `control-room/cloudflare/functions/` nella directory root `functions/` e l'esempio `_routes.json` in `dist/_routes.json`, preservando la build pubblica. Il middleware root e il filtro route devono coprire tutti gli asset e `/control-room/api/*`. Verificare in staging Access, CSP, no-store/noindex, URL 403, database e bucket prima di considerare Production. Nessun semplice flag attiva questa PR.
5. **GitHub futuro.** `GITHUB_OWNER=Rua56` e `GITHUB_REPO=renmenu` identificano il repository; un eventuale `GITHUB_TOKEN` va **solo nei segreti Cloudflare**, con permessi minimi per contenuti/PR e branch dedicato. Oggi l'adapter costruisce metadati mock ma non legge menu live, non crea branch/PR e non fa merge. Prima di un adapter live implementare lettura SHA/menu corrente, confronto, branch/PR idempotente, revisioni e due approvazioni separate; non esporre mai il token a Pages statico o ai log.
6. **AI futura.** `AI_PROVIDER=mock` è l'unico provider supportato; qualunque altro valore restituisce `501`. Gli schemi `control-room/schemas/*.json` sono contratti per output strutturati da validare server-side. Per foto/PDF/audio serviranno OCR/trascrizione con consenso, provenienza per campo, gestione prompt injection, budget/retention e revisione umana; `AI_API_KEY` andrà solo nei segreti server. Mai dedurre prezzi/allergeni o inviare il materiale a un provider senza accordo privacy.
7. **WhatsApp/chiamate future.** `WHATSAPP_PROVIDER=mock` e `CALL_PROVIDER=mock` non comunicano all'esterno. Per un webhook live serviranno verifica della firma del provider, numero aziendale, associazione senza ambiguità al cliente, gestione allegati e idempotenza; l'invio al cliente dovrà mostrare il testo esatto e richiedere conferma. Le chiamate saranno **solo verso Riccardo** con numero verificato, regola urgenza/quiet hours, consenso e conferma separata. Inserire `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `CALL_PROVIDER_TOKEN`, `OWNER_PHONE` soltanto in segreti server dopo aver implementato e testato questi flussi, non nell'esempio `.env` con valori veri.

L'elenco completo dei nomi configurabili è in [`control-room/.env.example`](control-room/.env.example); i binding D1/R2 non sono stringhe segrete nel client. Per disabilitare provider esterni lasciare ogni `*_PROVIDER` a `mock`/`disabled` o non impostato: in questa versione nessun adapter live esiste. La casella Gmail collegata al **precedente Jarvis** non è importata automaticamente nella Control Room; servirà consenso/scope e un'integrazione distinta. Nessun pagamento Stripe è nel perimetro.

Fonti: [middleware Pages](https://developers.cloudflare.com/pages/functions/middleware/), [binding D1/R2](https://developers.cloudflare.com/pages/functions/bindings/), [JWT Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/). Policy: [approvazioni](docs/approval-policy.md). Persona: [voce](docs/voice-persona.md). Piano: [control-room/plan.md](control-room/plan.md).
