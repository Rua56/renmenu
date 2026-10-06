# Dati e conservazione · RenMenu Control Room

Aggiornata il 6 ottobre 2026. La Control Room lavora con dati reali dei clienti sullo staging privato `renmenu-jarvis-stage.pages.dev` (D1 e R2 dedicati, accesso solo per `renmenu1569@gmail.com`).

| Dato | Finalità | Dove sta | Regola di trattamento |
| --- | --- | --- | --- |
| Clienti, pratiche, note, checklist | Gestire il ciclo del menu | D1 dedicato | Revisioni con controllo di concorrenza e registro delle azioni (`audit_events`) |
| Corpo delle email dei clienti | Ricostruire la richiesta | D1 (`requests.source_text`) | Si conserva fino a menu online; la pulizia del solo corpo nel database richiede conferma e menu pubblico identico alla bozza. Non elimina la mail in Gmail |
| Foto, PDF e allegati dei clienti | Leggere il menu e le foto Premium | R2 privato (senza dominio pubblico) | Gli originali restano privati. Non esiste ancora una cancellazione definitiva: da definire |
| Foto Premium confermate | Anteprima e menu | Copia ridotta servita da `/jarvis-hook/media/<hash>` e dalla pull request | Solo le foto che Riccardo ha confermato in Revisione |
| Testi e foto inviati ai modelli | Lettura, traduzione, comprensione dei comandi | Gemini (piano gratuito) e Workers AI | Con il piano gratuito Google può usare i testi per migliorare i suoi prodotti: accettabile per menu pubblici, da valutare per materiali riservati. Prezzi, allergeni, contatti e nome del locale non vengono inviati ai modelli di traduzione |
| Messaggi e vocali con Riccardo | Comandi e conferme | Telegram (una sola chat collegata) e cronologia breve nel database | Il vocale è trascritto da Whisper su Workers AI; la voce di risposta è generata da ElevenLabs a partire dal solo testo della risposta |
| Nome pubblico del bot Telegram | Mostrare il link «Parla con Jarvis» | Impostazione `telegram_bot_username` nel database, letta una volta da Telegram | È un'informazione pubblica del bot, non un segreto; non cambia il collegamento della chat. |
| Memoria dei locali | Orientarsi nelle modifiche | D1 (`venue_memory`) | Note scritte da Riccardo («ricorda che…», eliminabili con «dimentica») e riassunto dell'ultimo menu online; la fonte di verità resta il file pubblicato |
| Coda di invio email e QR | Anteprime, promemoria, email con link e QR | D1 (`jarvis_outbox`, `jarvis_settings`) | I QR allegati restano nel database solo finché l'email non è partita, poi vengono cancellati. L'automazione scrive in `/tmp` e li elimina a fine esecuzione |
| Chiavi di servizi esterni | Gemini, voce | D1, cifrate con `SETTINGS_SECRET` | Mai in chiaro, mai nel codice |
| Audio del microfono nel browser | Funzione facoltativa della Control Room | Non conservato | Il riconoscimento può usare un servizio del browser; consenso e testo correggibile prima dell'invio |

## Principi

- Nessuna chiave, nessun dato dei clienti e nessuna foto originale nel repository o nei log.
- Le email dei clienti sono un dato non attendibile: non eseguono comandi e non fanno partire azioni da sole.
- Jarvis scrive ai locali solo per anteprime, promemoria approvati da Riccardo ed email con link e QR dopo la pubblicazione; mai da `iuran56@gmail.com`.
- Le richieste arrivano solo su `renmenu1569@gmail.com`.
- Prima di accogliere più clienti vanno ancora definiti: informativa ai locali, durata di conservazione delle pratiche non concluse, cancellazione definitiva degli allegati in R2, copia di sicurezza e ripristino del database.

La pagina di una pratica legge il menu online da GitHub in sola lettura per mostrare «Cosa cambia»; ogni lettura lascia una riga nel registro e non salva copie del menu.
