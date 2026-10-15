# Funzionamento di Jarvis e della Control Room

Documento vivo: si aggiorna insieme al codice, a ogni modifica di comportamento (vedi la regola in [`CONTROL-ROOM-README.md`](../../CONTROL-ROOM-README.md) e il registro in [`CHANGELOG.md`](CHANGELOG.md)). Ultimo aggiornamento: 13 ottobre 2026.

## 1. In sintesi

RenMenu vende menu digitali con QR ai locali. Il progetto ha tre parti distinte:

| Parte | Cos'è | Dove vive | Chi la usa |
|---|---|---|---|
| Sito pubblico | Vetrina, pagamenti e visualizzatore dei menu (`menu/?m=<id>`) | `renmenu.com` (anche `renmenu.pages.dev`), ramo `main` | Clienti e clienti dei locali |
| Control Room | Cruscotto privato: clienti, richieste, materiali, bozze, approvazioni, registro | `renmenu-jarvis-stage.pages.dev/control-room`, dietro Cloudflare Access | Solo Riccardo |
| Jarvis | L'assistente che lavora dentro la Control Room e su Telegram: legge, prepara, chiede, pubblica dopo il SÌ | Stesso staging, con orologio e Telegram | Riccardo (unico interlocutore) |

La regola che regge tutto: Jarvis prepara, Riccardo conferma. Nessun menu va online, nessun QR cambia e nessun pagamento si tocca senza la conferma di Riccardo.

Dimensioni al 6 ottobre 2026: circa 11.250 righe di backend (45 moduli di logica), 4.100 righe di interfaccia, 12 migrazioni del database, 41 file di test con 305 test.

## 2. Mappa del sistema

```
  Locale (email, foto, PDF)                    Riccardo (iPhone)
        |                                        |        |
        v                                        v        v
  renmenu1569@gmail.com  --Apps Script-->   Telegram   Control Room (web)
        |   (testo)        (allegati)           |        |
        v                      v                v        v
  Automazione Gmail     /jarvis-hook/mail-files /jarvis-hook/telegram   /control-room/api
        |                      |                \        |        /
        +----------------------+-----------------+-------+-------+
                                         |
                      Cloudflare Pages Functions (Jarvis)
                      D1 (dati)  R2 (file privati)  Workers AI
                                         |
              Gemini (gratuito: foto, traduzioni, intenzioni, riflessione) · Claude solo con /claude sì  |  ElevenLabs (voce)
                                         |
                    GitHub: branch + PR + merge su main  -->  Cloudflare Pages (sito)
                                         |
                              menu online + QR  <-- orologio ogni minuto (Worker cron)
```

Ingressi e uscite:

- **Email in ingresso.** L'indirizzo dei locali è `menu@renmenu.com`: Email Routing di Cloudflare consegna ogni email al Worker `renmenu-jarvis-mail`, che la passa a `/jarvis-hook/mail-in`. Jarvis legge testo e allegati in un colpo solo, crea la pratica (o collega la risposta a un'anteprima), mette da parte foto e PDF per l'orologio e avvisa su Telegram. Newsletter e risposte automatiche restano fuori. Ponte storico, attivo finché non si spegne: un'automazione scatta a ogni nuova email su `renmenu1569@gmail.com`, la legge come dato non attendibile e la registra come pratica nel database di Jarvis. Un Apps Script dello stesso account manda a parte foto e PDF allegati, con un segreto.
- **Telegram.** Una sola chat autorizzata (Riccardo), collegata con un codice monouso. Testo, vocali e foto.
- **WhatsApp in entrata.** Meta chiama `/hooks/whatsapp` (firma verificata con `WHATSAPP_APP_SECRET`). I messaggi dello stesso numero entro 12 ore finiscono nella stessa pratica; foto e PDF vengono scaricati da Meta con `WHATSAPP_TOKEN` e letti da Jarvis come quelli di Telegram. Ogni messaggio nuovo arriva come avviso su Telegram. Se il numero è quello personale di Riccardo (coesistenza con l'app WhatsApp Business, `WHATSAPP_PRIVATE_FILTER=true`), i messaggi di numeri sconosciuti restano in attesa e Jarvis chiede su Telegram «è un locale?»: «Sì» apre la pratica, «No, è privato» ignora quel numero per sempre e cancella i messaggi in attesa (dopo 7 giorni senza risposta spariscono comunque). I clienti già registrati passano subito; le risposte di Riccardo dall'app e lo storico delle chat non arrivano a Jarvis. Con un fornitore come Dualhook (`WHATSAPP_INBOUND_VIA=dualhook`) Meta firma con una chiave che non abbiamo: l'indirizzo del webhook porta un parametro segreto `?k=WHATSAPP_HOOK_KEY`, si accettano solo messaggi del nostro conto `WHATSAPP_WABA_ID` e i file si scaricano da `api.dualhook.com` con la chiave Dualhook in `WHATSAPP_TOKEN`.
- **Email in uscita.** Anteprime, promemoria ed email con link e QR passano dalla coda `jarvis_outbox`. Con `CLIENT_MAIL_FROM` impostato (es. «RenMenu <menu@renmenu.com>») Jarvis le spedisce da solo via Resend, con copia nascosta a `CLIENT_MAIL_BCC`; le risposte dei locali tornano a menu@renmenu.com, cioè a Jarvis. Un errore temporaneo si riprova con la stessa chiave (niente doppioni), dopo 5 tentativi la missione si ferma. Senza `CLIENT_MAIL_FROM` resta il vecchio ponte: comando interno e invio dall'automazione Gmail di renmenu1569.
- **Orologio.** Un Worker con cron chiama ogni minuto `/jarvis-hook/tick`: legge le foto in coda, genera bozze, fa avanzare le missioni, controlla i menu pubblicati, manda il briefing e, alle 3 di notte, salva la copia di sicurezza del database nel bucket R2 (30 giorni di storico; dopo tre tentativi falliti avvisa su Telegram).

## 3. Il sito pubblico

- **Visualizzatore** `menu/index.html`: legge `menus/<id>.json`, supporta temi Standard (sei palette), lingue, allergeni UE 1-14, prezzi doppi calice/bottiglia e percorsi degustazione.
- **Premium** `menu/premium.js` e `premium.css`: stesso JSON, ma il blocco `premium` decide l'aspetto (direzioni grafiche, logo in apertura, storia, galleria, firma, schede apribili di piatti e vini, bottiglie scontornate, abbinamenti vino-piatto ricavati dalle schede, «La tua selezione» del cliente, animazioni che rispettano «riduci movimento»).
- **Menu online:** `bakaro` (in `menus/`) e Trattoria Blanch (`blanch/`). I menu di prova (Al Chiostro, Buffet alla Valletta, Caffè Bon Bon, La Chincaglieria, Pub Underground, Al Tralcio, Calice Storto, `demo`, `demo-premium`) sono stati tolti il 15 ottobre 2026 con le loro foto; se Jarvis aveva ancora un controllo dopo la pubblicazione su uno di questi, lo chiude in silenzio.
- **Vendita e pagamenti:** `crea/`, `paga/`, link Stripe e bonifico. Jarvis non li tocca mai.
- **Controllo:** `scripts/validate-menus.py` è l'autorità di pubblicazione; Jarvis ne applica le stesse regole in `_lib/menu.js`.
- **Indirizzo stabile:** dal 13 ottobre 2026 i link e i QR che Jarvis manda puntano a `https://renmenu.com/menu/?m=<id>`. I QR già stampati con `renmenu.pages.dev` o `rua56.github.io` continuano a funzionare: stesso sito, stesso file. Si aggiornano i dati, il QR non cambia.

## 4. La Control Room

Interfaccia mobile-first in HTML e JavaScript senza framework. Protetta da Cloudflare Access (solo `renmenu1569@gmail.com`) e, in più, da una verifica della firma del token lato server su ogni pagina e ogni API. Le scritture accettano solo richieste dello stesso sito.

### Orari di apertura

Gli orari, detti a Telegram o scritti in un'email, vengono letti per giorni e fasce e riscritti in una riga ordinata, uguale in italiano e in inglese, senza traduzione automatica. Esempio: «mercoledì chiuso, da giovedì a martedì dalle 12 alle 15 e dalle 19 alle 22» diventa «12:00–15:00 e 19:00–22:00 · Chiuso il mercoledì». Se dici solo le fasce («12-15 e 19-22») restano i giorni già scritti; se dici un solo giorno cambia solo quello. Ogni orario deve essere stato detto davvero: se la frase è ambigua (giorni senza orario, cifre che non sono orari) Jarvis non scrive nulla e chiede. Il codice è in `_lib/hours.js`. Anche i titoli di sezione scritti tutti in minuscolo («antipasti») prendono l'iniziale maiuscola.

### Foto con formati diversi tra le due letture

Prima del confronto le due letture sono riportate allo stesso formato. Un piatto scritto come titolo con prezzo («# NOME — 10»), o con il nome come titolo e la descrizione sulla riga col prezzo, diventa «Nome — prezzo» con la descrizione sotto. Restano titoli i percorsi degustazione, il coperto e le sezioni con più piatti. Entra in bozza solo ciò che le due letture confermano; il resto resta «da verificare».

Se sul materiale i piatti sono un elenco unico, senza titoli di sezione, Jarvis li mette in una sola sezione «Piatti» e tiene solo i titoli scritti davvero, come «Dolci». Le foto si uniscono nell'ordine in cui sono state mandate e un file che comincia con piatti senza titolo apre la sezione «Piatti», senza finire nell'ultima sezione del file precedente. «Prepara la bozza» a Telegram vale per la pratica in primo piano o nominata, anche a metà nome.

Controllo dopo la pubblicazione: dopo 6 ore, 2 e 7 giorni Jarvis rilegge il menu online e lo confronta con l'ultimo contenuto da lui pubblicato; una nuova pubblicazione dello stesso menu sostituisce la sorveglianza precedente. Avvisa solo se il contenuto cambia senza una pubblicazione sua.

Allergeni scritti dal locale: Jarvis non li deduce mai dal nome del piatto. Riconosce i numeri UE 1–14 scritti tra parentesi o come «Allergeni: 1, 4, 7» (con o senza simboli * @) e li propone nella Revisione, non preselezionati; solo dopo il tuo tocco diventano icone allergeni e i numeri escono dal testo. Una riga letta una sola volta o tagliata resta da verificare.

### Modifiche a un menu già online senza prezzi né piatti

Se la frase non contiene prezzi o piatti da cambiare (per esempio titoli delle sezioni, unione di sezioni, descrizioni), Jarvis crea comunque la pratica di aggiornamento con una bozza identica al menu online (stesso Menu ID, stesso QR) e vi applica la correzione come per ogni bozza. La pratica diventa quella in primo piano per 60 minuti. Pubblicazione e SÌ restano invariati.

### Cliente senza nome (arrivato via email)

Se il cliente si chiama «Nuovo contatto email», Jarvis a voce usa il nome del locale scritto nella bozza (per esempio «Osteria Ponte Vecchio»). Mostrare la bozza su Telegram o provare ad affidarla la mette in primo piano per un'ora: le frasi senza nome del locale («cappesante 18,50») valgono per quella pratica. La scheda cliente non viene rinominata da Jarvis.

### Quando Jarvis non capisce

Ogni frase che Jarvis non riesce ad applicare alla bozza (modifica non valida, nessuna modifica precisa, errore) viene registrata con il motivo nel registro delle attività (azione «jarvis.not_understood»): contiene solo il testo del comando e la ragione, e serve a migliorare Jarvis. Le frasi vere che hanno causato errori diventano test fissi in `tests/jarvis-corpus.test.mjs`. I modelli Gemini che falliscono vengono saltati per 10 minuti.

### Il coperto

Il coperto non è mai una sezione né una voce: si scrive nel campo coperto del menu e compare in fondo, sopra le informazioni del locale. Jarvis lo inserisce solo con un importo che hai detto davvero; se esiste già una sezione «Coperto» fatta solo da quella voce, la toglie e usa il campo. Frasi come «niente coperto» o con più importi restano un dubbio e Jarvis chiede. Le frasi sui dati del locale con un valore («il coperto è 3 euro», «gli orari sono…», «il telefono è…») sono capite come correzione della bozza in primo piano.

### Sezioni e pratica in primo piano

Da Telegram Jarvis sa anche unire sezioni («unifica le tre sezioni bevande»: le voci finiscono in una sola, i doppioni con stesso nome e stesso prezzo vengono tolti) e togliere una sezione intera («togli la sezione bevande»), purché tu la nomini. Più voci aggiunte nella stessa sezione nuova finiscono in una sola sezione, con l'iniziale maiuscola. Se togli tutte le voci di una sezione, la sezione sparisce da sola. Una frase senza il nome del locale riguarda sempre la pratica su cui stai lavorando (si rinnova a ogni correzione e dura 60 minuti): non viene più dedotta dai nomi dei piatti, che in locali diversi si somigliano («caffè», «bibite»). Un nome di locale che compare solo nell'interpretazione del modello e non nella tua frase viene ignorato. Per un menu già online dì il nome del locale.

### Email lunghe e poco chiare

Le email arrivano con le righe spezzate ogni 75 caratteri circa dal programma di posta. Prima di leggerle Jarvis riunisce le righe spezzate (solo se il testo è davvero «a colonna»: un elenco scritto a mano, una voce per riga, non viene toccato) e conserva il numero di righe, così «riga N» nelle note è sempre la riga dell'email originale, che resta intatta nella pratica.

Cosa legge, senza inventare nulla:

- **Prezzi scritti in modo libero**: «10,-», «€6», «14 € (surgelato in inverno)», «18 € / con rucola». La nota dopo il prezzo diventa la descrizione, con le parole del cliente. Numeri che non sono importi («5 tempi», «6 anni», «2 persone», «4 calici») non sono mai prezzi.
- **Prezzo da chiedere a Riccardo**: se il locale è indeciso, il piatto resta senza prezzo e Jarvis te lo chiede per nome (bozza su Telegram e blocco di «Affida a Jarvis»): rispondi con una frase come «cappesante 18,50». Un prezzo «al mercato, cambia ogni giorno» invece non si chiede: resta senza importo, con le parole del locale in descrizione.
- **Prezzo da decidere o variabile**: «prezzo da decidere, circa 18-19» non diventa un prezzo (nessun numero dell'intervallo): il piatto entra senza prezzo e una nota chiede a Riccardo di sceglierlo. «Prezzo al mercato, cambia ogni giorno» o «chiedere al cameriere» entrano come descrizione, senza prezzo.
- **Disponibilità e commenti nel nome**: «(solo in primavera)» passa nella descrizione; «(nome inventato)» e simili vengono tolti dal nome, con una nota.
- **Percorso degustazione**: il titolo resta intero («Collio in 5 tempi»), ogni formula («5 portate: 65 € a persona (85 € con abbinamento di 4 calici)») è una voce con i suoi prezzi come scritti dal cliente, le regole (prenotazione, minimo persone, giorni non disponibili) vanno nella descrizione del percorso. Il percorso si chiude alla carta dei vini o alla categoria successiva: non assorbe più il resto dell'email. Se il cliente non elenca le portate, una nota lo dice. Gli importi di ogni formula sono scritti anche nella descrizione, perché il visualizzatore Premium non mostra i prezzi in variante (se cambi un prezzo, cambia anche la riga). Le formule con i loro importi contano come prezzi attestati nel controllo prima di «Affida a Jarvis»; le portate senza importo richiedono il prezzo del percorso.
- **Carta dei vini**: «Carta dei vini (…)» è un titolo di pagina; Bollicine, Bianchi, Rossi, Vini dolci sono sezioni; «6 € / 26 €» è calice e bottiglia (una nota per sezione, da confermare); «solo bottiglia, 32 €» e «solo calice, 12 €» hanno un solo prezzo con la sua etichetta.
- **Coperto, servizio, ferie, contatti**: l'importo del coperto viene letto anche con altri numeri nella frase («bambini sotto i 6 anni»); la precisazione del cliente e «servizio compreso» finiscono in una nota da confermare. «Il coperto non lo facciamo» non inserisce nulla. «Ad agosto chiudiamo due settimane, date da decidere» è una nota di conferma, non entra negli orari. L'indirizzo email del locale non ha un campo nel menu pubblico: resta nella pratica.
- **Allergeni**: se l'email ha una legenda numerata e i numeri accanto ai piatti, Jarvis verifica che la legenda sia quella UE 1-14 e propone gli allergeni piatto per piatto (mai preselezionati: li confermi tu). Se la legenda è diversa, o i numeri mancano per alcuni piatti, resta una proposta manuale «da chiedere in cucina». Mai dedotti dagli ingredienti.
- **Frasi e domande del cliente**: ogni frase di un paragrafo lungo ha la sua nota (storia del locale, galleria, schede dei vini, dicitura richiesta, domanda su prezzi e tempi, acconto). Jarvis non risponde alle domande su prezzi e tempi, non scrive la storia, non inserisce diciture che il cliente stesso mette in dubbio («piatti tutti fatti in casa», dubbio sul pane) e non sceglie foto.
- **Schede Premium** (`_lib/premium-schede.js`): su richiesta di Riccardo in Revisione, Jarvis propone con Gemini gratuito le schede sommelier dei vini e le descrizioni dei piatti mancanti; restano in `creative_json.schede` finché Riccardo non le approva una per una o tutte insieme. Solo fatti generali e sicuri, mai sui campi del cliente; le voci incerte restano al cliente.
- **Bottiglie dalle cantine** (`_lib/bottle-search.js`, azione `findBottlePhotos`): per i vini senza foto Jarvis cerca la pagina del vino con Gemini + ricerca Google, scarica le immagini candidate e tiene solo la bottiglia la cui etichetta corrisponde al vino (stesso controllo delle foto del cliente). Salvata come materiale `sito_cantina` con la fonte, diventa una foto proposta da confermare in Revisione.
- **Premium**: la scheda creativa registra il riferimento («come Al Bakaro, più sobrio»), i colori del logo, le lingue chieste (oltre all'inglese, tedesco e sloveno restano da preparare: Jarvis traduce in automatico solo l'inglese), la galleria (numero di foto e come arrivano), le schede dei vini (servono i dati dal cliente) e l'acconto (acconto 490 € + 39 €/mese, totale deciso da Riccardo).

Le righe che Jarvis non capisce non spariscono: restano nell'elenco «Da sistemare o confermare» con il numero di riga.

### Le schermate

Dal 6 ottobre 2026 la Control Room ha tre voci sempre visibili (telefono e computer): **Oggi**, **Locali**, **Sistema**, in una barra in basso con sopra «Scrivi o parla a Jarvis…». L'aspetto segue il modello approvato (colonna stretta, sfera di Jarvis che diventa ambra quando aspetta il tuo SÌ, schede piatte, tema scuro). Gli strumenti di prima restano tutti, dentro Sistema, con i nuovi colori. La barra «Scrivi o parla a Jarvis…» apre un foglio con il link a Telegram e le frasi utili da copiare: la conversazione vera resta su Telegram.

| Voce | Schermata | A cosa serve |
|---|---|---|
| Oggi | Oggi | Saluto di Jarvis, «Da decidere» (cosa aspetta un tuo gesto, in ordine di urgenza), «In corso» (cosa segue Jarvis) e il conteggio di tutte le pratiche. Messaggi e Telegram di Jarvis sotto. |
| Oggi | Pratica | Una pratica sola (se è un nuovo menu con piano da definire, in cima c'è «Scegli il piano»: tre pulsanti Standard, Annuale, Premium; finché non scegli non compare «Prepara la bozza»): avanzamento (Richiesta, Bozza, Controllo, Il tuo SÌ, Online), «Cosa cambia» rispetto al menu online (lettura in sola lettura da GitHub, registrata nel registro), «Modifica a mano», anteprima e il passo successivo reale (affido a Jarvis o SÌ). Sotto «Dettagli e strumenti»: regole del piano, Revisione, Approvazioni, Materiali, richiesta originale, Registro. |
| Oggi | Tutte le pratiche | Elenco unico con tre filtri: Da decidere, In corso, Chiuse (le archiviate restano in Sistema, Richieste). |
| Oggi | Modifica a mano | Sezioni e voci della bozza leggibili: tocco su una voce per cambiare nome o prezzo, «Togli dal menu», «Aggiungi una voce», «Togli la sezione» in fondo a ogni sezione (con «Rimetti» finché non salvi), ricerca. Il salvataggio usa lo stesso comando della Revisione (blocco sulla revisione, validazione, nuova versione): la checklist si azzera e la bozza torna da controllare. Non pubblica nulla. |
| Locali | Elenco e Locale | Elenco dei locali con ricerca; la pagina di un locale mostra piano, menu, prova, email, le sue pratiche e «Apri il menu» (link pubblico, in sola lettura) |
| Sistema | Schede cliente complete | Le schede dei locali con piano, email, link del menu, prova e rinnovo |
| Sistema | Elenco strumenti | Revisione (controllo completo e modifica avanzata JSON, «Rifai la bozza»), Richieste, Approvazioni (PR, pubblicazione, verifica), Builder avanzato, Materiali, Anteprima, Notifiche, Registro, Voce del browser, più «Tutti i numeri e i dettagli» (numeri, coda, email al proprietario, casella Gmail) |

Aprendo uno strumento da una pratica compare «Torna alla pratica». Nessuna azione è cambiata: «Approva e affida a Jarvis» e il SÌ usano gli stessi comandi di prima.

### I dati (database D1, 12 migrazioni)

Tabelle principali: clienti, richieste, materiali e analisi delle letture, bozze e versioni, approvazioni di pubblicazione (legate alla versione della bozza), missioni di Jarvis, coda di invio email, memoria dei locali, foto Premium, notifiche, eventi esterni e un registro (`audit_events`) con ogni azione importante. I file originali stanno in un bucket privato R2 senza dominio pubblico.

Protezioni nel codice: ogni modifica controlla la revisione (due sessioni non si sovrascrivono), ogni scrittura importante lascia una riga nel registro, una fonte modificata azzera la checklist, e l'approvazione vale solo per la versione approvata.

## 5. Jarvis: come funziona

### 5.1 Ciclo di vita di una pratica

1. **Arriva la richiesta** (email, WhatsApp, Telegram o creata da Riccardo). Jarvis classifica la categoria e il piano come proposta, con la riga del testo che la giustifica. Prima prova le parole chiave; se non bastano (richiesta scritta in modo libero, o menu nuovo senza piano) legge la richiesta con un modello gratuito (Gemini, poi Workers AI) e manda a Riccardo «Ho capito: …» con l'elenco delle modifiche chieste. Del modello restano solo i dati scritti dal cliente: il piano se lo nomina, il locale se il nome compare nel testo, le modifiche se nomi e prezzi vengono dal testo. Per WhatsApp aspetta 3 minuti senza messaggi nuovi, così legge la richiesta intera.
   - **Modifica a un menu online scritta a parole** («da domani lo spritz lo facciamo a 5 e la gubana non la facciamo più»): se le regole fisse non trovano la modifica, la bozza parte dal menu online e il modello gratuito la traduce nelle stesse operazioni delle correzioni di Riccardo, con gli stessi controlli (ogni prezzo deve comparire nel testo, ogni voce toccata deve essere nominata). Su Telegram arriva la bozza pronta con Annulla, Mostrami la bozza e Affida a Jarvis. Se il modello non applica nulla, la bozza non resta: decide Riccardo.
2. **Lettura dei materiali.** Le foto sono lette da due modelli Gemini indipendenti: un piatto entra nel menu solo se le due letture concordano su nome e prezzo; altrimenti diventa un dubbio. I PDF si leggono come testo. Se Gemini non risponde, Jarvis ritenta dopo 2, 5 e 10 minuti prima di passare ai modelli Cloudflare. La qualità della lettura si misura con «/prova lettura» su Telegram: Jarvis rilegge con la stessa catena le foto elencate in `prove-lettura/casi.json` (ramo `prove-lettura` del repository: foto in R2 dalle pratiche o nel ramo stesso, con il menu giusto pubblicato, trascritto a mano o la bozza della pratica), una foto per giro dell'orologio quando non ci sono materiali veri da leggere, e confronta la bozza che ne uscirebbe piatto per piatto: giusti, segnalati da controllare, persi, voci in più e soprattutto prezzi sbagliati entrati senza avviso. «/prova lettura esito» mostra l'ultimo risultato (salvato in `jarvis_settings.reading_test_last`).
3. **Dubbi su Telegram.** Ogni riga incerta arriva con i prezzi letti come pulsanti; Riccardo tocca quello giusto, scrive un prezzo o salta.
4. **Bozza.** Standard: la bozza parte da sola dopo l'ultimo dubbio. Premium: la avvia Riccardo, sceglie la direzione grafica e registra l'approvazione creativa. La bozza contiene sezioni, voci, prezzi, descrizioni, coperto, orari, contatti e, per ogni dato, la fonte. L'inglese è tradotto da Jarvis come bozza da verificare.
5. **Revisione di Riccardo.** Controlla e può dettare modifiche a Jarvis («nella bozza di Codelli 23 metti il gin tonic a 7 e 10»).
6. **Affido.** Riccardo affida la pratica a Jarvis con un gesto. Nasce una missione.
7. **Anteprima.** Se il locale ha un'email, Jarvis la mette in coda: arriva al locale da renmenu1569. Senza email, l'anteprima la approva Riccardo su Telegram.
8. **Risposta del locale.** Jarvis la legge: se è un'approvazione chiara propone il SÌ a Riccardo; se sono modifiche chiare (prezzo, aggiunta, rimozione, coperto) le applica e rimanda l'anteprima (massimo 3 giri); se c'è qualcosa che non sa applicare, si ferma e lo dice.
9. **Il SÌ di Riccardo.** Pulsante su Telegram: «SÌ, pubblica» oppure «Non ancora».
10. **Pubblicazione.** Jarvis apre una pull request sul sito con menu e foto, la unisce a `main` e attende la verifica. Si ferma se esiste già un menu con lo stesso identificativo.
11. **Verifica online.** Dopo circa 75 secondi controlla che il menu pubblico sia identico alla bozza approvata.
12. **Dopo la pubblicazione.** Allinea la scheda cliente (link, piano, prova o rinnovo), salva in memoria com'è fatto il menu, manda su Telegram link e QR (immagine, PNG, SVG) e, se il locale ha un'email, mette in coda l'email con link e QR allegati.
13. **Sorveglianza.** Controlla il menu online dopo 6 ore, 2 giorni e 7 giorni: se il file cambia o la pagina non risponde, avvisa Riccardo.

Stati della missione: affidata, attesa invio, attesa cliente, attesa SÌ, pubblicazione, verifica, completata, ferma, annullata.

### 5.2 Come Riccardo parla con Jarvis

- **Telegram:** testo, vocali (trascritti con Whisper su Workers AI, risposte anche a voce con ElevenLabs), foto e documenti.
- **Control Room («Scrivi o parla a Jarvis»):** la stessa conversazione di Telegram dentro la Control Room, scritta o a voce. La frase passa dallo stesso cervello (`missions.telegramUpdate`); le risposte, i pulsanti, il QR e i file tornano nella pagina e non partono su Telegram (`_lib/cr-chat.js`, `POST /control-room/api/jarvis/ask`). Valgono solo i pulsanti che Jarvis ha offerto nella Control Room, una volta ciascuno. Il microfono usa il riconoscimento vocale del browser, solo quando lo si tocca; «Mani libere» riascolta dopo ogni risposta finché non si dice «basta». Le risposte si sentono con la voce del telefono (gratis) oppure, se acceso nel foglio, con la voce di Jarvis su ElevenLabs (`POST /control-room/api/jarvis/voice`, consuma crediti).
- **«Mostrami …» nella Control Room:** «mostrami le pratiche aperte/chiuse/da decidere/in corso», «quali locali sono registrati», «i menu online», «le modifiche», «cosa è successo» (anche «del Bakaro», «oggi», «ieri», «questa settimana», «questo mese») aprono un elenco sulla home senza chiamare Jarvis (`site/jarvis-show.js`, dati già caricati nella pagina). Gli stessi elenchi si aprono toccando i quattro indicatori della home.
- **Dialogo dal vivo nella Control Room:** il pulsante «Dialogo dal vivo» nella conversazione apre un dialogo continuo con l'agente vocale ElevenLabs «Jarvis · Control Room» (creato da solo la prima volta, id nel setting `cr_live_agent_id`, accesso solo con indirizzo firmato chiesto dal server con la rotta `jarvis/live`). Si parla senza toccare nulla e si può interrompere Jarvis. L'agente ha tre strumenti eseguiti dalla pagina: `chiedi_a_jarvis` (passa la richiesta al Jarvis vero, stesse risposte e pulsanti di Telegram; pubblicare resta un tocco), `mostra` (apre l'elenco sulla home) e `chiudi`. Consuma minuti ElevenLabs: parte solo dal tocco, dura al massimo 10 minuti, si chiude dopo 60 secondi di silenzio, se si lascia la pagina o con «Chiudi» (`site/jarvis-live.js`).
- **Jarvis propositivo:** Jarvis cerca da solo nel database ciò che è fermo o in scadenza (`_lib/initiative.js`, senza modelli e senza costi): SÌ di pubblicazione atteso da più di un giorno, pratiche ferme, bozze in revisione da 2 giorni o più, richieste senza bozza da 2 giorni, promemoria segnati nella pratica («follow_up_at»), prove che finiscono entro 5 giorni, rinnovi entro 14 giorni o scaduti da meno di 30, locali registrati da una settimana senza menu online né pratiche. Tra le 11 e le 19 ne propone una su Telegram (al massimo una all'ora, due al giorno, mai mentre ne aspetta una a cui non hai risposto), con l'azione pronta più «Più tardi» (domani) e «Lascia stare» (due settimane, pulsanti `ini:`). Il giro delle 8 ne aggiunge fino a due che non copre già. «/idee» o «cosa mi proponi?» le elenca tutte; «/idee no|sì» spegne o riaccende quelle del giorno. La home della Control Room le mostra in «Jarvis propone», e la situazione detta al telefono e nel dialogo dal vivo le include. Jarvis propone soltanto: pubblicare, scrivere ai locali e i pagamenti restano tuoi.
- **Risposte pronte ai clienti:** quando un locale scrive su WhatsApp o per email, due minuti dopo l'ultimo messaggio (così una raffica di foto e testo fa una sola risposta) Jarvis prepara la risposta dai fatti veri della pratica (`_lib/client-reply.js`): menu online con il link, anteprima in attesa di «Approvo», menu quasi pronto, bozza in preparazione, materiale ricevuto, oppure servono foto o PDF. La scrive un modello gratuito (Gemini, poi Workers AI); una risposta con numeri, date o link che non stanno nei fatti, nel messaggio del cliente o nelle parole di Riccardo viene scartata e resta la frase a modello fisso. Su Telegram arriva con «Manda», «Cambia» e «Non rispondere» (pulsanti `rep:`): niente parte senza il tocco. Dopo «Cambia» il messaggio successivo (scritto o vocale, entro 15 minuti) dice come riscriverla («più breve», «digli che passo venerdì»), oppure è il testo intero tra virgolette, usato così com'è; «manda» la spedisce. Le email partono da menu@renmenu.com con «Re: oggetto» (copia nascosta a renmenu1569); WhatsApp parte dal numero di Riccardo tramite Dualhook solo entro 24 ore dall'ultimo messaggio del cliente (regola di WhatsApp) e serve l'identificativo del numero, che Jarvis impara dal primo messaggio ricevuto (`wa_phone_number_id`). Se l'invio non riesce Jarvis dà il testo da copiare. Tace quando la pratica aspetta «Approvo» (risponde già il giro delle approvazioni). «/risposte no|sì» le spegne o riaccende.
- **Menu dei comandi su Telegram:** «/menu» (o «comandi») manda un messaggio con un pulsante per ogni comando, due per riga (pulsanti `cmd:`); toccarne uno è come scrivere il comando. Anche un comando sconosciuto o «/aiuto» mostrano i pulsanti. Jarvis imposta da solo il menu «/» accanto al campo di scrittura (setMyCommands, una volta per versione dell'elenco `COMMANDS` in `_lib/telegram.js`). «Chiamami» telefona davvero (costa minuti). Sotto il campo di scrittura c'è anche il pulsante fisso «☰ Menu» (tastiera persistente, messa una volta con un breve messaggio, `KEYBOARD_VERSION`) che apre gli stessi pulsanti. Dalla Control Room (risposte catturate) il menu «/» e il pulsante non si impostano.
- **Intenzioni capite:** stato, anteprima, crea pratica, affida pratica, aggiorna menu, pubblica, cancella pratica, ricorda una nota, chiacchiera. Un modello sceglie una sola intenzione tra poche consentite; i valori (prezzi, piatti) restano quelli detti da Riccardo e sono verificati dal codice.
- **Modifiche alla bozza:** elenco chiuso di operazioni (prezzo, varianti, aggiungi, rimuovi, rinomina, descrizione, sposta, motto, aspetto, campi del locale, storia). Ogni operazione deve nominare la voce toccata e ogni prezzo deve comparire nella frase. Le decisioni già applicate (colori, motto, storia, contatti) sopravvivono a «Rifai la bozza».
- **Risposte brevi:** a ogni messaggio con pulsanti si può rispondere anche a parole («sì», «no», «non ora», «la seconda», «entrambe»): vale come il tocco. Pubblicare resta un tocco; cancellare a parole chiede sempre conferma.
- **Modelli:** di base Jarvis usa solo modelli gratuiti (Gemini e Workers AI). `/claude sì` accende Claude (a pagamento, chiave `ANTHROPIC_API_KEY`) per capire, rispondere e preparare le proposte; `/claude no` lo spegne.
- **Telefonata:** `/chiamami` (o «chiamami») fa telefonare Jarvis a Riccardo con la sua voce, via ElevenLabs e il numero Twilio importato lì. La prima volta si scrive il cellulare («/chiamami +39 …»). Al telefono Jarvis racconta la situazione; le azioni restano su Telegram. A pagamento, solo su richiesta. La chiamata automatica per gli avvisi importanti è accesa di base (richiesta di Riccardo, 14 ottobre): ogni nuovo messaggio di un cliente (WhatsApp, email, anche da un numero WhatsApp sconosciuto), bozza pronta, SÌ da dare, guasto o problema dopo la pubblicazione arriva su Telegram e con una telefonata, senza limite di chiamate, dalle 8 alle 22. Due sole regole: più messaggi della stessa pratica entro 10 minuti fanno una chiamata sola, e gli avvisi che arrivano entro 3 minuti da una chiamata aspettano e partono tutti insieme nella chiamata successiva (`phone_pending`, `phoneTick` dall'orologio). «/chiamami avvisi no» la spegne, «sì» la riaccende.
- **Avvisi:** ogni avviso va nella Control Room e su Telegram. Dalle 22 alle 7 quelli normali arrivano senza suono; quelli importanti suonano sempre e Jarvis li dice anche a voce. `/voce` sceglie: solo importanti (predefinito), tutti (di giorno) o nessuno. Messaggi WhatsApp e Gmail dai webhook, email non registrate, orologio inceppato e copia di sicurezza fallita hanno un avviso proprio.
- **Comandi utili:** `/stato`, `/briefing`, `/settimana` (diario degli ultimi 7 giorni: richieste, correzioni, dubbi, pubblicazioni, errori e locali silenziosi), `/proposte` e `/rifletti` (proposte di miglioramento: il lunedì alle 8:15 Jarvis rilegge il diario con Claude e ne manda al massimo 3 con Fallo, Non ora e Mai; «Fallo» su una miglioria al codice apre una issue su GitHub), «mandami il QR di …», «mostrami l'anteprima» (link privato valido 24 ore), «ricorda che …», «dimentica …».
- **Modalità visita** (`_lib/visit.js`): nel locale Riccardo scrive (o dice) «visita Bar Centrale», oppure manda la foto con quella didascalia, o tocca «🚶 Visita a un locale» nel menu dei comandi. Jarvis crea il cliente «prospect» e la pratica «Visita · Bar Centrale» (Standard), le foto che arrivano dopo si collegano lì. Bastano 15 secondi di calma invece di 40, nessuna domanda sui prezzi in dubbio (quelle voci restano fuori dall'anteprima e nelle note di Revisione), nessuna preparazione automatica né «la mando al locale?»: torna solo il link di sola visione (24 ore) da mostrare al titolare. Un locale con menu già online non si «visita». Niente viene inviato al locale né pubblicato; se il titolare accetta, la bozza resta in Revisione come una pratica normale.
- **Agenda delle visite** (`_lib/agenda.js`, impostazione `agenda`): «questa settimana devo visitare 8 locali: A, B, C…» (scritto o a voce; senza nomi Jarvis li chiede e prende come elenco il messaggio successivo, entro mezz'ora). «ho visitato A» o «sono stato da A» la segna, e dopo i due punti si può aggiungere una nota («ho visitato A: vuole il Premium»). Anche «visita A» la segna da sola. Poi ci sono «aggiungi all'agenda …», «agenda» o «chi mi manca?», e «cancella l'agenda». Una nuova agenda sostituisce la precedente, e Jarvis dice quali locali restavano. Se per 24 ore Riccardo non dice niente sulle visite, Jarvis gli ricorda quelli mancanti su Telegram, dalle 9 alle 20 e al massimo una volta al giorno (`agendaTick`). Non scrive mai ai locali. Nella Control Room c'è la scheda «Agenda visite» (Strumenti), che mostra la stessa agenda e manda a Jarvis le stesse frasi.
- **Sorveglianza dei menu online** (`_lib/guard.js`, impostazioni `guard_menus` e `guard_state`): ogni 15 minuti Jarvis apre il file e la pagina del QR dei menu sorvegliati, al massimo due per giro (`guardTick`). Se un menu non si apre per due controlli di fila (a 3 minuti l'uno dall'altro), manda un avviso importante: su Telegram e, di giorno, con la chiamata se è accesa. Poi lo ricorda ogni 6 ore finché il menu non torna a posto, e quando torna lo dice. L'elenco parte da Al Bakaro e Trattoria Blanch. Ogni menu che Jarvis pubblica si aggiunge da solo. Comandi: «sorveglianza» (elenco e ultimo controllo), «sorveglia …», «non sorvegliare …». Jarvis non tocca mai niente.
- **Locali di prova** (`RETIRED_MENUS` in `_lib/delete-request.js`): «togli i locali di prova» elenca i clienti con un menu di prova già tolto dal sito; il pulsante «SÌ, cancella» li elimina con tutte le pratiche (anche chiuse), bozze e file. Controlla prima che il menu non sia davvero più online. Mai sui clienti veri.
- **Menu da stampare** (`menu/stampa.html`, `printTurn` in missions): «menu da stampare di …» risponde con il link alla versione A4 del menu (lingua, colonne e descrizioni si scelgono sulla pagina, QR al menu online in fondo). Solo lettura: non pubblica e non manda niente.
- **Pulsanti Premium «Prenota su WhatsApp» e «Lascia una recensione»**: campi `premium.whatsapp` (numero con prefisso) e `premium.recensioni` (link https), impostabili a parole come i dati del locale (operazione `locale`, campi `whatsapp` e `recensioni`, solo menu Premium). Finiscono nella bozza come ogni modifica: online solo con la pubblicazione.
- **Briefing:** ogni mattina dal lunedì al sabato alle 8 e un giro di proposte con pulsanti (promemoria ai locali che non rispondono, bozze ferme, SÌ in attesa).

### 5.3 La memoria

- Note per locale («ricorda che…»), eliminabili.
- Copia del menu appena pubblicato, per orientarsi nelle modifiche future. La fonte di verità resta il file online.
- Cronologia breve della conversazione con regola esplicita: i dati reali di adesso valgono più della chat.

### 5.4 Cosa Jarvis non fa mai

- Non inventa prezzi, ingredienti, allergeni, orari o piatti. Un dato dubbio resta «da confermare».
- Non scrive il totale di un preventivo Premium e non tocca Stripe, IBAN o Payment Link.
- Non pubblica, non sovrascrive un menu esistente e non cambia il QR di un cliente attivo senza il tuo SÌ.
- Non agisce da `iuran56@gmail.com`: le richieste arrivano solo su `renmenu1569@gmail.com`.
- Non elimina pratiche pubblicate, con anteprima inviata o approvata, o di clienti con menu online.
- Non usa le foto del locale senza la conferma di Riccardo; le schede sommelier restano proposte da approvare.

## Menu in formato proprio (Trattoria Blanch)

Trattoria Blanch ha un formato proprio: il suo menu si compila da `blanch/data/food.json` e `blanch/data/wines.tsv` in `blanch/data/menu.json` (stesso risultato, byte per byte, di `blanch/tools/build_menu.py`). Jarvis lo legge e lo modifica con un adattatore (`_lib/blanch.js`), con identificativo `trattoria-blanch`.

- **Lettura:** Jarvis legge i tre file da GitHub, controlla che `menu.json` coincida con la compilazione di cibo e vini e li presenta nella forma RenMenu (sezioni e voci). I due importi senza spiegazione («€ 10,00 / 13,00») restano due importi: «Primo prezzo» e «Secondo prezzo». Le varianti calice, quarto, mezzo litro e litro restano tali.
- **Bozza e anteprima:** come per ogni locale. L'anteprima usa la grafica standard di RenMenu, non la pagina di Blanch.
- **Pubblicazione (solo dopo il tuo SÌ):** una PR modifica soltanto le righe cambiate di `food.json` e `wines.tsv` e rigenera `menu.json`, mai altro. Un piatto o un vino nuovo ha l'inglese e il tedesco scritti da Jarvis oppure, se mancano, il testo italiano da rivedere. Le righe non toccate restano identiche, con le loro note interne e l'ordine originale.
- **Cosa non può contenere:** allergeni per piatto, telefono, coperto, tag, foto, schede, tema. Se la bozza li contiene Jarvis si ferma prima di aprire la PR e lo dice. Gli avvisi su coperto e allergie non si cambiano da qui.
- **Verifica dopo la pubblicazione:** Jarvis rilegge `https://renmenu.pages.dev/blanch/data/menu.json` e la pagina `/blanch/`, e confronta con il menu approvato; il controllo a 6 ore, 2 e 7 giorni e il briefing usano gli stessi indirizzi.
- **QR:** non cambia mai. Quello stampato resta valido: su richiesta Jarvis manda il link e i file esistenti (`blanch/qr/`), senza generarne uno nuovo.
- **Se qualcosa non torna** (menu compilato diverso dai sorgenti, formato inatteso): errore chiaro, nessuna scrittura.

## 6. Piani e regole di servizio

| Piano | Condizioni | QR | Cosa prepara Jarvis |
|---|---|---|---|
| Standard | 25 €/mese, 30 giorni gratis | Classico | Grafica RenMenu, italiano e inglese, aggiornamenti |
| Annuale | 249 €/anno | Con logo | Come lo Standard, una lingua in più, priorità |
| Premium su misura | Preventivo, acconto 490 € e 39 €/mese | Con logo | Identità del locale, schede interattive, foto, storia, vini, approvazione creativa |

Le regole complete sono in `control-room/docs/renmenu-service-rules.md` e nel modulo `service-rules.js`. Il QR usa la correzione d'errore più alta e il logo copre meno del 10% dell'area, quindi resta leggibile (verificato con un lettore QR).

## 7. Infrastruttura, segreti e costi

- **Hosting:** Cloudflare Pages (sito pubblico e staging separato), D1, R2, Workers AI, Worker cron.
- **Segreti:** chiavi in Cloudflare Pages (`TELEGRAM_BOT_TOKEN`, `GITHUB_TOKEN`, `RESEND_API_KEY`, `JARVIS_CLOCK_SECRET`, `SETTINGS_SECRET`, `AI_API_KEY`). Le chiavi Gemini e voce stanno nel database, cifrate. Nessun segreto nel codice.
- **Ingressi pubblici protetti da segreto:** Telegram, orologio, allegati email. Le foto Premium confermate sono servite pubblicamente perché l'anteprima deve caricarle.
- **Costi:** Gemini in piano gratuito, Workers AI gratuito (10.000 Neurons al giorno). Le email in uscita e l'import consumano esecuzioni dell'automazione.
- **Distribuzione dello staging:** pacchetto compilato e caricato con un solo comando; il sito pubblico non viene toccato.
