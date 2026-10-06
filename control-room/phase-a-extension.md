# Estensione verificata — Control Room, perimetro A

Il 1 ottobre 2026 Riccardo ha scelto **A: completare rigorosamente il prompt**, quindi demo/mock avanzata, PR non unita, **nessun deploy**, nessun invio, chiamata, pagamento o modifica a menu reali. La PR #3 rimane il veicolo di revisione del codice. Non sono necessarie chiavi o credenziali per questa fase; Gmail/Resend/Twilio della precedente app Jarvis restano fuori dalla nuova Control Room.

## Completamenti entro il perimetro

- **Fonti visualizzabili senza fuga di dati:** foto e PDF della futura API R2 privata si visualizzano solo dopo fetch same-origin autenticato; PDF.js locale rende i PDF da byte Blob nel browser con pagine e zoom, senza URL permanenti R2. Nel mock gli upload conservano solo metadati, con una sola eccezione: un PDF statico inventato e incluso nel codice, per provare il viewer a due colonne. La preview resta spenta su file archiviati.
- **QR realmente codificato, ma mai pubblicato:** un encoder self-hosted crea un codice scansionabile per un percorso preview deliberatamente non attivo, distinto dal QR commerciale già distribuito. Il testo e la UI lo segnalano con chiarezza, e nessuna richiesta remota è necessaria per disegnarlo.
- **Conversazione contestuale demo:** la voce e il testo interrogano il medesimo stato di pratiche, materiali e checklist. La risposta mantiene cronologia leggibile nella sessione mock; se il contesto manca, ammette il limite e propone l'azione successiva. I comandi non approvano né inviano e non simulano un LLM o traduzioni certificate.
- **Bozza chiarimenti:** da dati mancanti e materiali non letti si prepara una bozza per il cliente senza inviarla; i prezzi e gli allergeni restano da verificare.
- **Diff e revisione:** confronto fra snapshot bozze o snapshot pubblicato **fittizio** di Ginestra, riferimenti alla fonte, PDF fittizio e azioni contestuali restano disponibili su telefono e desktop; un confronto con il menu realmente online non viene dichiarato né simulato come già eseguito. Prezzi, lingue e allergeni non documentati impediscono la PR mock: ogni conferma richiede evidenza scritta, con omissione allergeni separata.

## Struttura aggiuntiva

`site/vendor/` conserva encoder QR MIT e PDF.js Apache 2.0 con licenze; `site/demo-assets/` contiene l'unico PDF sintetico. `site/app.js`, `site/api.js`, `site/pdf-preview.js`, `site/voice.js` e CSS espongono anteprima materiale, QR e dialogo contestuale. `tests/` aggiunge regressioni QR/voce/privacy e browser smoke/viewer. Nessuna modifica a `menu/`, `menus/`, `crea/`, pagamenti, build Cloudflare o servizi live.

Il checkpoint di verifica rimane `npm test --prefix control-room`, `npm run check --prefix control-room`, `python3 scripts/validate-menus.py`, `sh scripts/build-cloudflare.sh` con `dist/control-room` assente, e browser demo su 375/390/430/768/1280 px. Documentazione e PR saranno aggiornate con il comportamento reale e i limiti.
