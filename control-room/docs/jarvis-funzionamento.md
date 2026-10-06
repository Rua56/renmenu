# Funzionamento di Jarvis e della Control Room

Documento vivo: si aggiorna insieme al codice, a ogni modifica di comportamento (vedi la regola in [`CONTROL-ROOM-README.md`](../../CONTROL-ROOM-README.md) e il registro in [`CHANGELOG.md`](CHANGELOG.md)). Ultimo aggiornamento: 6 ottobre 2026.

## 1. In sintesi

RenMenu vende menu digitali con QR ai locali. Il progetto ha tre parti distinte:

| Parte | Cos'è | Dove vive | Chi la usa |
|---|---|---|---|
| Sito pubblico | Vetrina, pagamenti e visualizzatore dei menu (`menu/?m=<id>`) | `renmenu.pages.dev`, ramo `main` | Clienti e clienti dei locali |
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
              Gemini (lettura foto, traduzioni, intenzioni)  |  ElevenLabs (voce)
                                         |
                    GitHub: branch + PR + merge su main  -->  Cloudflare Pages (sito)
                                         |
                              menu online + QR  <-- orologio ogni minuto (Worker cron)
```

Ingressi e uscite:

- **Email in ingresso.** Un'automazione scatta a ogni nuova email su `renmenu1569@gmail.com`, la legge come dato non attendibile e la registra come pratica nel database di Jarvis. Un Apps Script dello stesso account manda a parte foto e PDF allegati, con un segreto.
- **Telegram.** Una sola chat autorizzata (Riccardo), collegata con un codice monouso. Testo, vocali e foto.
- **Email in uscita.** Jarvis non spedisce direttamente: mette il messaggio in una coda e fa partire un comando interno; l'automazione Gmail lo spedisce da renmenu1569 (anteprime, promemoria, email con link e QR).
- **Orologio.** Un Worker con cron chiama ogni minuto `/jarvis-hook/tick`: legge le foto in coda, genera bozze, fa avanzare le missioni, controlla i menu pubblicati, manda il briefing.

## 3. Il sito pubblico

- **Visualizzatore** `menu/index.html`: legge `menus/<id>.json`, supporta temi Standard (sei palette), lingue, allergeni UE 1-14, prezzi doppi calice/bottiglia e percorsi degustazione.
- **Premium** `menu/premium.js` e `premium.css`: stesso JSON, ma il blocco `premium` decide l'aspetto (direzioni grafiche, logo in apertura, storia, galleria, firma, schede apribili di piatti e vini).
- **Menu online:** `bakaro`, `buffet-alla-valletta`, `caffe-bon-bon`, `pub-underground`, `demo`, `demo-premium`.
- **Vendita e pagamenti:** `crea/`, `paga/`, link Stripe e bonifico. Jarvis non li tocca mai.
- **Controllo:** `scripts/validate-menus.py` è l'autorità di pubblicazione; Jarvis ne applica le stesse regole in `_lib/menu.js`.
- **Indirizzo stabile:** il QR di un locale punta sempre a `https://renmenu.pages.dev/menu/?m=<id>`. Si aggiornano i dati, il QR non cambia.

## 4. La Control Room

Interfaccia mobile-first in HTML e JavaScript senza framework. Protetta da Cloudflare Access (solo `renmenu1569@gmail.com`) e, in più, da una verifica della firma del token lato server su ogni pagina e ogni API. Le scritture accettano solo richieste dello stesso sito.

### Orari di apertura

Gli orari, detti a Telegram o scritti in un'email, vengono letti per giorni e fasce e riscritti in una riga ordinata, uguale in italiano e in inglese, senza traduzione automatica. Esempio: «mercoledì chiuso, da giovedì a martedì dalle 12 alle 15 e dalle 19 alle 22» diventa «12:00–15:00 e 19:00–22:00 · Chiuso il mercoledì». Se dici solo le fasce («12-15 e 19-22») restano i giorni già scritti; se dici un solo giorno cambia solo quello. Ogni orario deve essere stato detto davvero: se la frase è ambigua (giorni senza orario, cifre che non sono orari) Jarvis non scrive nulla e chiede. Il codice è in `_lib/hours.js`. Anche i titoli di sezione scritti tutti in minuscolo («antipasti») prendono l'iniziale maiuscola.

### Foto con formati diversi tra le due letture

Prima del confronto le due letture sono riportate allo stesso formato. Un piatto scritto come titolo con prezzo («# NOME — 10»), o con il nome come titolo e la descrizione sulla riga col prezzo, diventa «Nome — prezzo» con la descrizione sotto. Restano titoli i percorsi degustazione, il coperto e le sezioni con più piatti. Entra in bozza solo ciò che le due letture confermano; il resto resta «da verificare».

### Modifiche a un menu già online senza prezzi né piatti

Se la frase non contiene prezzi o piatti da cambiare (per esempio titoli delle sezioni, unione di sezioni, descrizioni), Jarvis crea comunque la pratica di aggiornamento con una bozza identica al menu online (stesso Menu ID, stesso QR) e vi applica la correzione come per ogni bozza. La pratica diventa quella in primo piano per 60 minuti. Pubblicazione e SÌ restano invariati.

### Quando Jarvis non capisce

Ogni frase che Jarvis non riesce ad applicare alla bozza (modifica non valida, nessuna modifica precisa, errore) viene registrata con il motivo nel registro delle attività (azione «jarvis.not_understood»): contiene solo il testo del comando e la ragione, e serve a migliorare Jarvis. Le frasi vere che hanno causato errori diventano test fissi in `tests/jarvis-corpus.test.mjs`. I modelli Gemini che falliscono vengono saltati per 10 minuti.

### Il coperto

Il coperto non è mai una sezione né una voce: si scrive nel campo coperto del menu e compare in fondo, sopra le informazioni del locale. Jarvis lo inserisce solo con un importo che hai detto davvero; se esiste già una sezione «Coperto» fatta solo da quella voce, la toglie e usa il campo. Frasi come «niente coperto» o con più importi restano un dubbio e Jarvis chiede. Le frasi sui dati del locale con un valore («il coperto è 3 euro», «gli orari sono…», «il telefono è…») sono capite come correzione della bozza in primo piano.

### Sezioni e pratica in primo piano

Da Telegram Jarvis sa anche unire sezioni («unifica le tre sezioni bevande»: le voci finiscono in una sola, i doppioni con stesso nome e stesso prezzo vengono tolti) e togliere una sezione intera («togli la sezione bevande»), purché tu la nomini. Più voci aggiunte nella stessa sezione nuova finiscono in una sola sezione, con l'iniziale maiuscola. Se togli tutte le voci di una sezione, la sezione sparisce da sola. Una frase senza il nome del locale riguarda sempre la pratica su cui stai lavorando (si rinnova a ogni correzione e dura 60 minuti): non viene più dedotta dai nomi dei piatti, che in locali diversi si somigliano («caffè», «bibite»). Un nome di locale che compare solo nell'interpretazione del modello e non nella tua frase viene ignorato. Per un menu già online dì il nome del locale.

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

1. **Arriva la richiesta** (email, Telegram o creata da Riccardo). Jarvis classifica la categoria e il piano come proposta, con la riga del testo che la giustifica.
2. **Lettura dei materiali.** Le foto sono lette da due modelli Gemini indipendenti: un piatto entra nel menu solo se le due letture concordano su nome e prezzo; altrimenti diventa un dubbio. I PDF si leggono come testo. Se Gemini non risponde, Jarvis ritenta dopo 2, 5 e 10 minuti prima di passare ai modelli Cloudflare.
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
- **Intenzioni capite:** stato, anteprima, crea pratica, affida pratica, aggiorna menu, pubblica, cancella pratica, ricorda una nota, chiacchiera. Un modello sceglie una sola intenzione tra poche consentite; i valori (prezzi, piatti) restano quelli detti da Riccardo e sono verificati dal codice.
- **Modifiche alla bozza:** elenco chiuso di operazioni (prezzo, varianti, aggiungi, rimuovi, rinomina, descrizione, sposta, motto, aspetto, campi del locale, storia). Ogni operazione deve nominare la voce toccata e ogni prezzo deve comparire nella frase. Le decisioni già applicate (colori, motto, storia, contatti) sopravvivono a «Rifai la bozza».
- **Comandi utili:** `/stato`, `/briefing`, «mandami il QR di …», «mostrami l'anteprima» (link privato valido 24 ore), «ricorda che …», «dimentica …».
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
