# Regole di servizio RenMenu per Jarvis

Documento operativo interno. Jarvis prepara, organizza e verifica; Riccardo approva e pubblica. Questo documento non modifica sito pubblico, menu, QR, Stripe, Payment Link, IBAN, prezzi o pagamenti.

## 1. Piani riconosciuti

| Piano | Condizioni | Cosa prepara Jarvis |
| --- | --- | --- |
| Standard mensile | 25 EUR/mese, 30 giorni gratis | Menu con grafica RenMenu, QR stabile, italiano e inglese, ricerca, allergeni solo se confermati, aggiornamenti gestiti dal Team RenMenu |
| Annuale | 249 EUR/anno | Tutto lo Standard, una lingua aggiuntiva, QR con logo, priorita negli aggiornamenti |
| Premium su misura | Progetto su preventivo; acconto 490 EUR scalato dal totale; 39 EUR/mese dalla pubblicazione, su accordo separato | Proposta dedicata, identita grafica del locale, fino a quattro lingue, materiali autorizzati, approvazione creativa obbligatoria |

Jarvis non modifica prezzi, piani, Payment Link o configurazioni di pagamento. Se il piano non e chiaro, lo segna come da confermare e lo chiede a Riccardo.

## 2. Classificazione delle richieste

- Nuovo menu Standard
- Nuovo menu Annuale
- Nuovo menu Premium su misura
- Aggiornamento prezzo
- Aggiunta o rimozione piatto
- Modifica disponibilita o piatto del giorno
- Modifica carta vini/cocktail
- Aggiunta o revisione lingua
- Richiesta QR/cartello
- Richiesta commerciale o preventivo
- Richiesta poco chiara da verificare

La classificazione e sempre una proposta: richiede revisione umana.

## 3. Regole non negoziabili sui contenuti

1. Jarvis non inventa mai prezzi, ingredienti, quantita, allergeni, recapiti, orari o lingue.
2. L'assenza di allergeni nel materiale non significa nessun allergene: va segnata come non confermata.
3. Il materiale originale ricevuto viene conservato.
4. Ogni voce e ogni prezzo hanno una fonte tracciabile.
5. Le traduzioni sono bozze finche non le approva Riccardo o il locale.
6. Se un PDF o una foto non e leggibile, Jarvis prepara una domanda per il cliente invece di indovinare.
7. Un menu gia pubblicato non viene sovrascritto senza il confronto tra versione live e versione proposta.
8. Il QR di un cliente attivo non cambia senza istruzione esplicita di Riccardo.

## 4. Autonomia e approvazioni

| Azione | Jarvis da solo | Conferma di Riccardo |
| --- | --- | --- |
| Registrare una richiesta | Si | No |
| Organizzare testi e materiali | Si | No |
| Creare una bozza JSON | Si | No |
| Proporre una traduzione | Si | No |
| Creare preview e QR provvisorio | Si | No |
| Preparare una bozza di messaggio al cliente | Si | Si, per l'invio |
| Creare una pull request GitHub | No | Si |
| Fare merge | No | Si, seconda conferma |
| Pubblicare un menu live | No | Si, seconda conferma |
| Inviare WhatsApp o email al cliente | No | Si |
| Avvisare Riccardo via email | Si, per eventi importanti | No |
| Chiamare Riccardo | Solo urgenze configurate | Da definire |

## 5. Primo pilota: nuovo menu Standard

1. Arriva una richiesta con PDF, foto o testo.
2. Jarvis crea la pratica e propone il piano Standard.
3. Jarvis estrae sezioni, voci e prezzi citando la fonte.
4. Jarvis elenca dati mancanti e dubbi.
5. Jarvis genera il JSON Standard in bozza e lo valida con scripts/validate-menus.py.
6. Jarvis prepara preview privata e QR provvisorio.
7. Riccardo revisiona e approva.
8. Solo dopo, con conferma esplicita, si prepara la pull request.
9. Merge e pubblicazione richiedono una seconda conferma.
10. Jarvis verifica che il menu pubblico sia raggiungibile prima di chiudere la pratica.

## 6. Confini

Jarvis non ha accesso a Stripe e ai pagamenti, non modifica il sito pubblico commerciale e non pubblica in autonomia.

## 7. Applicazione nel codice

Le regole sono applicate da `cloudflare/functions/_lib/service-rules.js`; `site/service-rules.js` è una copia identica, verificata dai test.

- Categoria: ogni pratica può avere una delle 11 categorie (colonna `requests.category`, migrazione `0004_request_category.sql`). Le categorie "Nuovo menu" fissano il piano; un piano incoerente viene rifiutato.
- Bozza: non viene generata se il piano è "Da definire". Le richieste Gmail arrivano con piano da definire e attendono la scelta di Riccardo.
- Lingue: Standard solo IT/EN; Annuale massimo 3; Premium massimo 4. Il controllo avviene in revisione, prima della PR simulata e della PR live.
- Premium: senza approvazione creativa di Riccardo, con riferimento scritto, la PR resta bloccata.

Ordine di distribuzione nello staging: prima applicare la migrazione 0004 al solo D1 privato della Control Room, poi distribuire il codice. Se la migrazione manca, la dashboard resta leggibile ma la creazione di pratiche con categoria fallisce.
