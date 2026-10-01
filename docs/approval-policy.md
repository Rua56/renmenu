# Policy di approvazione — RenMenu Control Room

Jarvis è il copilota del **Team RenMenu**; Riccardo mantiene il controllo. La demo locale usa soltanto dati fittizi. Lo staging Pages separato è **distribuito e protetto da Access**, con D1/R2 dedicati e pratiche sintetiche; il solo canale email **verso il proprietario** è stato collaudato. L'AI OpenAI è configurata esclusivamente per un ID di pratica fittizia, con chiave di progetto limitata a Chat Completions; il test ora riceve HTTP 429 e la dashboard mostra saldo API zero. L'analisi non è ancora operativa e nessun acquisto viene effettuato da Jarvis. GitHub, Gmail relay, WhatsApp e chiamate live restano disattivati.

| Operazione | Automazione possibile | Condizione/effetto |
| --- | --- | --- |
| Registrare pratica, allegati e cronologia | Sì, in area privata dopo Access | D1/R2 privati; audit, CAS e limiti MIME/dimensione |
| Classificare/estrarre testo e menù | Proposta AI, se provider abilitato | Mai inventare prezzi, ingredienti, allergeni o attribuire traduzioni come confermate; bozza salvata solo dopo revisione umana |
| Revisionare JSON e fonti | Sì, con operatore | Prezzi/allergeni/lingue devono avere prove scritte; modifiche invalidano la checklist |
| Preparare PR mock | Dopo approvazione editoriale | Soltanto simulazione, frase `CONFERMO PR DI PROVA` |
| Aprire **draft PR GitHub live** | Solo dopo Access, token ristretto, controllo SHA/versione/checklist, diff e conferma owner `CONFERMO APERTURA PR LIVE` | Branch e PR idempotenti; **nessun merge, pubblicazione o cambio a main** |
| Verificare un menù realmente online | Letture GitHub/public allowlist, conferma `CONFERMO VERIFICA PUBBLICAZIONE` | Segna la pratica completata **solo se** PR merged, hash/branch/versione coerenti e menù pubblico identico alla bozza; non esegue merge/deploy |
| Pulire il corpo di email importate in D1 | Conferma distinta `CONFERMO ELIMINAZIONE EMAIL PUBBLICATA` | Solo dopo PR merged e menù raggiungibile/identico; non elimina la mail originale in Gmail né allegati R2 |
| Avviso email al proprietario | Solo previa visione di destinatario/oggetto/testo e conferma sullo schermo `CONFERMO EMAIL AL PROPRIETARIO` | Destinatario fisso `renmenu1569@gmail.com`, Resend dell'account business, quiet hours e idempotenza. Una email **TEST INTERNO** è risultata Delivered nel registro Resend; questo non dimostra la lettura del destinatario. Nessuna email ai clienti. |
| Messaggi ai clienti, WhatsApp, SMS o telefonate | Nessun invio automatico | WhatsApp/chiamate mock o stub fail-closed; nessuna chiamata/risposta cliente reale oggi |
| Merge, deploy produzione, modifica QR/menù live | Nessuna API autonoma | Richiedono revisione e azione esplicita separata, non una frase vocale |
| Stripe, IBAN, link pagamento, acquisti | Fuori ambito | Nessuna modifica o esecuzione |

La validazione JSON **non certifica la veridicità** di prezzo, allergene, ingrediente, orario, disponibilità, contatto o traduzione. Il validatore pubblico è `scripts/validate-menus.py`. Le voci dello standard pubblico sono allowlistate lato server; note interne, chiavi R2, nomi file cliente e segreti non entrano nei JSON o nel testo PR. Per aggiornamenti preservare lo slug dei QR e leggere il SHA GitHub corrente; per nuovi locali verificare assenza dello slug prima di aprire la PR. Il menu Blanch ha formato distinto ed è escluso dal Builder standard.

**Evidenza editoriale:** non bastano quattro spunte; i controlli di prezzi, allergeni e lingua richiedono fonti scritte, e l'approvazione del locale deve essere documentata. Se i numeri allergeni sono omessi serve una conferma distinta di omissione autorizzata dal locale. Un array vuoto non dimostra assenza di allergeni. Prezzi mancanti, lingue dichiarate senza testo e fonti non verificabili bloccano la PR. L'AI non può approvare da sola.

**Transazioni:** upload/archiviazione materiali, salvataggi D1, versioni e audit usano CAS e batch. Una fonte modificata azzera la checklist; errori di audit annullano la scrittura di business. Una perdita della risposta GitHub non provoca retry di scrittura rischiosa: richiede riconciliazione leggendo la PR esistente. Le due conferme del mock (`CONFERMO PR DI PROVA`, `CONFERMO PUBBLICAZIONE SIMULATA`) **non** sono il consenso per una PR/pubblicazione live.

La voce è una comodità di navigazione e proposta: **non vale mai come consenso** per PR, invio, cancellazione, pubblicazione o pagamento. L'azione sullo schermo deve mostrare prima cliente, menù, file/URL/diff e messaggio esatto quando pertinenti. In caso di dubbio: **non inferire; chiedere al locale e a Riccardo**.
