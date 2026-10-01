# Policy di approvazione — RenMenu Control Room

La Control Room è uno strumento del **Team RenMenu**, non un pannello per i ristoratori. L'automazione può leggere fonti autorizzate, organizzare pratiche, preparare bozze e proporre cambiamenti. Il proprietario Riccardo resta responsabile delle decisioni. Tutti i dati di prova nella fase A sono fittizi.

## Scala di autonomia

| Operazione | Automazione ammessa | Uscita effettiva in fase A |
| --- | --- | --- |
| Registrare pratica, collegare cliente e materiale | Sì, in area privata | Persistenza mock locale o D1 isolato dopo setup, con audit |
| Estrarre piatti e prezzi dal testo | Sì, **solo da righe leggibili** | Bozza; righe incerte segnalate, non completate a fantasia |
| Proporre traduzioni | Solo come suggerimenti da confermare | Non approvate automaticamente |
| Salvare versioni/editare il JSON | Sì, dopo validazione | Versioni con revisione concorrente e audit |
| Confermare prezzi, allergeni e lingue | Solo Riccardo con fonti del locale | Checklist manuale, nessuna deduzione dall'AI |
| Registrare approvazione cliente | Solo dopo consenso scritto reale, annotando riferimento | Check esplicito e nota; demo non invia l'anteprima |
| Preparare PR di menù cliente | Solo dopo revisione, conferma esplicita e diff | **Proposta mock**: nessuna PR reale e nessun push a `menus/` |
| Pubblicare, unire branch, aggiornare QR | Mai automaticamente | **Simulazione distinta** con seconda conferma; nessun merge/deploy |
| Messaggio email/WhatsApp/chiamata a cliente | Solo bozza approvata in futura fase autorizzata | Nessun invio: `mock` o `bozza_mock` nel registro |
| Operazioni Stripe, fatture, acquisti | Fuori ambito | Nessun accesso né modifica |

La validazione tecnica del JSON non attesta la verità di prezzo, allergene, ingrediente, disponibilità, coperto, contatto o lingua. Il validatore ufficiale è `scripts/validate-menus.py`; i warning richiedono lettura umana. Per aggiornamenti conservare lo stesso slug e lo stesso `menu/?m=<id>` per non invalidare QR; per nuovi locali lo slug va controllato contro quelli già pubblicati **prima** di qualunque futura PR reale. Il menù Blanch ha un formato distinto e non passa per questo builder standard.

## Transizioni e blocchi

Una richiesta può creare una bozza, ma modificare la fonte, caricare un altro allegato o archiviare un materiale azzera le conferme. Ogni salvataggio richiede la revisione corrente (CAS), conserva una versione, annulla riferimenti di estrazione obsoleti e azzera la checklist. I campi potenzialmente pubblici sono ammessi da una **allow-list server-side** ricavata dallo schema reale `menus/`; riferimenti a R2, note editoriali e chiavi sconosciute sono vietati nel JSON della PR. Le mutazioni D1 e l'audit vengono eseguiti nella **stessa transazione**: un errore dell'audit annulla la scrittura di business. Per marcare il lavoro `pronta_pr` non bastano quattro spunte: servono riferimenti scritti alle fonti di prezzi, allergeni e lingue, più l'approvazione scritta del locale. Prezzi mancanti e lingue dichiarate ma non tradotte bloccano la PR mock. Se mancano numeri allergeni, una conferma **separata** della loro omissione da parte del locale è obbligatoria nel mock: non significa che il piatto sia privo di allergeni e va rivalutata legalmente prima di qualunque distribuzione reale. Il comando `preparePr` rivalida tutto, richiede frase `CONFERMO PR DI PROVA` e produce soltanto un record mock. `simulatePublish` richiede una proposta precedente e una **seconda** frase `CONFERMO PUBBLICAZIONE SIMULATA`. Nessun endpoint `merge`, `publish` reale, `send` o `pay` esiste. Riprocessamenti e conflitti devono essere mostrati invece di sovrascrivere in silenzio.

I comandi vocali possono proporre una modifica o aprire una vista; **non valgono mai come consenso** per approvazione, PR, pubblicazione o invio. In futuro, abilitare provider solo con scope minimo, credenziali nel secret store, limiti di spesa/invio, consenso e test in ambiente di prova. In caso di dubbio prevale `non inferire / chiedere al locale`.
