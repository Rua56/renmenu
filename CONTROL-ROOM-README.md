# RenMenu Control Room · Jarvis

**Stato (6 ottobre 2026):** la Control Room con Jarvis lavora sullo staging privato `renmenu-jarvis-stage.pages.dev`, separato dal sito pubblico `renmenu.pages.dev`. Jarvis legge richieste e materiali, prepara bozze, chiede conferme a Riccardo su Telegram e, solo dopo il suo SÌ, pubblica il menu sul sito tramite pull request. La Control Room non è un portale per i clienti: è il cruscotto privato del Team RenMenu.

> **Regola di manutenzione.** Ogni modifica a Jarvis o alla Control Room aggiorna, nella stessa pull request, questo README, le policy in `docs/` quando cambia un comportamento e il registro in [`control-room/docs/CHANGELOG.md`](control-room/docs/CHANGELOG.md). Il funzionamento passo per passo è in [`control-room/docs/jarvis-funzionamento.md`](control-room/docs/jarvis-funzionamento.md).

**Coperto (6 ottobre 2026):** detto a Telegram va nel campo coperto, in fondo al menu sopra le informazioni, mai in una sezione propria.

**Sezioni (6 ottobre 2026):** da Telegram si possono unire o togliere sezioni, e dalla Modifica a mano togliere voci e sezioni intere (con «Rimetti» prima di salvare); una frase senza nome del locale riguarda la pratica in primo piano.

**Interfaccia (dal 6 ottobre 2026):** tre voci in una barra in basso (Oggi, Locali, Sistema), con l'aspetto del modello approvato e la barra «Scrivi o parla a Jarvis…» che rimanda a Telegram. Oggi elenca solo ciò che aspetta una decisione; ogni pratica ha la sua pagina (avanzamento, «Cosa cambia», «Modifica a mano», passo successivo). Gli strumenti completi (Revisione, Richieste, Approvazioni, Builder, Materiali, Anteprima, Notifiche, Registro, Voce) sono in Sistema. Dettagli in `control-room/docs/jarvis-funzionamento.md`.

## Ambienti e accesso

| Ambiente | Origine | Dati e azioni |
| --- | --- | --- |
| Demo locale | `http://127.0.0.1:8765/control-room/site/?demo=1` | Dati sintetici nel solo `localStorage`; nessuna chiamata esterna |
| Staging privato (Jarvis) | `https://renmenu-jarvis-stage.pages.dev/control-room/` | D1 e R2 dedicati, Cloudflare Access solo per `renmenu1569@gmail.com`; dati reali dei clienti, Telegram, email, pubblicazione dei menu dopo il SÌ |
| Sito pubblico | `https://renmenu.pages.dev/` (e GitHub Pages per i QR storici) | Sito statico, menu e QR; ramo `main` |

L'accesso alla Control Room è protetto due volte: Cloudflare Access davanti all'host e verifica lato server della firma del token (RS256/JWKS, emittente, audience, scadenza, tipo ed email del proprietario) su ogni pagina e ogni API. Le scritture accettano solo richieste dello stesso sito. Se la configurazione manca, l'accesso è negato.

Gli ingressi pubblici di Jarvis stanno fuori da Access ma sono protetti da segreti: `/jarvis-hook/telegram` (segreto del bot), `/jarvis-hook/tick` (segreto dell'orologio), `/jarvis-hook/mail-files` (segreto dello script Gmail), `/jarvis-hook/media/<hash>` (solo le foto Premium confermate da Riccardo, indispensabili per l'anteprima).

## Cosa fa Jarvis

Il dettaglio è in [`control-room/docs/jarvis-funzionamento.md`](control-room/docs/jarvis-funzionamento.md). In sintesi:

- **Ingressi:** email su `renmenu1569@gmail.com` (testo e allegati) e messaggi Telegram di Riccardo (testo, vocali, foto, documenti).
- **Lettura:** le foto sono lette da due modelli indipendenti; entra nel menu solo ciò su cui concordano, il resto diventa un dubbio che Riccardo chiude con un tocco.
- **Bozza e revisione:** voci, prezzi (anche calice/bottiglia), percorsi degustazione, coperto, contatti, inglese tradotto come bozza; ogni dato porta la sua fonte.
- **Missione:** dopo l'affido, Jarvis manda l'anteprima al locale, applica le modifiche chiare, chiede il SÌ a Riccardo, pubblica, verifica online, manda link e QR a Riccardo e, se il locale ha un'email, anche al locale, poi sorveglia il menu a 6 ore, 2 giorni e 7 giorni.
- **Aggiornamenti:** per un menu già online la bozza parte dal file pubblicato, con lo stesso identificativo e lo stesso QR.
- **Assistente:** briefing alle 8 (lunedì-sabato), stato, memoria per locale, risposte a voce.

## Avvio locale e prove

```sh
python3 -m http.server 8765 --bind 127.0.0.1   # dalla radice del repository
# Aprire http://127.0.0.1:8765/control-room/site/?demo=1
npm test --prefix control-room                  # test offline (SQLite, JWT, provider finti)
npm run check --prefix control-room             # controllo sintassi
python3 scripts/validate-menus.py               # validatore dei menu pubblici
sh scripts/build-cloudflare.sh                  # build del sito pubblico
# Dopo la build deve restare assente dist/control-room.
```

Prove opzionali nel browser: `python3 control-room/tests/browser_smoke.py`, `demo_flow.py`, `preview_flow.py` (richiedono Playwright e il server locale).

## Architettura

| Percorso | Responsabilità |
| --- | --- |
| `control-room/site/` | Interfaccia mobile-first (HTML e JavaScript senza framework), demo locale, voce del browser, QR e PDF self-hosted |
| `control-room/cloudflare/functions/control-room/api/` | API privata (Access), azioni su D1/R2 con controllo di revisione e registro |
| `control-room/cloudflare/functions/jarvis-hook/` | Ingressi pubblici protetti da segreto: Telegram, orologio, allegati email, foto Premium |
| `control-room/cloudflare/functions/_lib/` | Logica: `missions.js` (missioni, Telegram, QR, email), `vision.js` (foto), `menu-structure.js`, `draft-edit.js`, `translate.js`, `premium.js`, `media.js`, `qr.js`, `github-live.js`, `voice.js` e altri |
| `control-room/cloudflare/clock/` | Worker con cron: chiama ogni minuto `/jarvis-hook/tick` |
| `control-room/cloudflare/migrations/` | Schema D1 (0001-0012, additive) |
| `control-room/staging/` | Costruzione e pacchetto dello staging, script di import Gmail e coda di invio email |
| `control-room/tests/` | Test automatici (oltre 300) |
| `control-room/docs/` | Funzionamento di Jarvis, regole di servizio, relay Gmail, registro aggiornamenti |
| `docs/` | Policy: approvazioni, dati e privacy, voce e persona |

Il sito pubblico non include mai la Control Room: `scripts/build-cloudflare.sh` copia solo un elenco fisso di cartelle e la build resta identica con o senza il codice di Jarvis nel repository (verificato il 6 ottobre 2026 confrontando le due build).

## Distribuzione dello staging

```sh
sh control-room/staging/package-dashboard.sh /percorso/fuori/dal/repository/renmenu-jarvis-stage-upload.zip
# poi, da control-room/.staging: wrangler pages deploy dist --project-name renmenu-jarvis-stage --branch staging
```

Lo script compila le Functions, controlla che nel pacchetto ci siano `_worker.js`, `_routes.json` e la Control Room, rifiuta file di chiavi e non distribuisce nulla da solo. Dopo ogni distribuzione si verifica Jarvis dal vivo (stato su Telegram) e si cancellano i dati di prova. Il progetto Pages dello staging è distinto da quello del sito pubblico.

## Integrazioni

| Servizio | Uso | Note |
| --- | --- | --- |
| Gmail (`renmenu1569@gmail.com`) | Import delle richieste; invio di anteprime, promemoria ed email con link e QR | L'import e l'invio sono fatti da un'automazione Perplexity; Jarvis mette i messaggi in coda e fa partire un comando interno. Mai da `iuran56@gmail.com` |
| Apps Script Google | Foto e PDF allegati alle email dei clienti | Segreto dedicato; fino a sei allegati per email |
| Telegram | Unico canale con Riccardo (una chat collegata con codice monouso) | Pulsanti per SÌ, dubbi, affido, eliminazioni |
| Gemini (piano gratuito) | Lettura foto, traduzioni, correzioni, intenzioni | Chiave cifrata nel database; ripiego automatico su Workers AI |
| Workers AI (piano gratuito, 10.000 Neurons al giorno) | Ripiego dei modelli, trascrizione vocali (Whisper), conversazione | Se la quota finisce Jarvis lo segnala |
| ElevenLabs | Voce di Jarvis nelle risposte vocali | Chiave cifrata nel database |
| GitHub (`Rua56/renmenu`) | Lettura del menu online, branch e pull request, unione su `main` dopo il SÌ, verifica | Token ristretto; Jarvis non tocca altro |
| Resend | Solo comandi interni verso `renmenu1569@gmail.com` e avvisi al proprietario | Nessun messaggio ai clienti da qui |
| WhatsApp | Webhook con firma, disattivato | Nessun invio |
| Telefonate e SMS | Solo simulazioni | Nessuna chiamata reale |
| Stripe e pagamenti | Fuori ambito | Jarvis non li tocca |

## Variabili e binding

I valori reali stanno solo nei Secret e nelle variabili di Cloudflare Pages, mai nell'HTML, in Git, nei log o in chat. L'elenco dei nomi è in [`control-room/.env.example`](control-room/.env.example). Binding: `DB` (D1), `BUCKET` (R2 privato), `AI` (Workers AI). Secret principali: `TELEGRAM_BOT_TOKEN`, `GITHUB_TOKEN`, `JARVIS_CLOCK_SECRET`, `RESEND_API_KEY`, `SETTINGS_SECRET`, `AI_API_KEY`. Le chiavi Gemini e voce sono nel database, cifrate con `SETTINGS_SECRET`.

## Limiti noti e da fare

- Nessuna copia di sicurezza periodica del database: da predisporre prima di accogliere più clienti.
- La spedizione reale dell'email con QR in allegato non è ancora stata provata su un cliente: la prima prova è la pubblicazione di Osteria Codelli 23.
- Lingue: la traduzione automatica implementata è l'inglese; tedesco e sloveno richiedono preparazione aggiuntiva.
- Trattoria Blanch ha un formato proprio (`blanch/`): Jarvis lo legge e lo modifica con un adattatore dedicato. Non può contenere allergeni per piatto, telefono, coperto, tag o foto; il QR già stampato non cambia mai.
- Con il piano gratuito di Gemini Google può usare i testi inviati per migliorare i suoi prodotti: va bene per menu pubblici, da valutare per materiali riservati.

Licenze di terzi: `qrcode-generator` (MIT, anche in `control-room/cloudflare/functions/_lib/vendor/`) e `pdfjs-dist` (Apache 2.0), con i file di licenza accanto al codice.
