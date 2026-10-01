# Dati e conservazione — RenMenu Control Room

**Stato: codice di prova non distribuito.** Questa pagina descrive i dati che la Control Room gestirebbe, non dichiara un trattamento produttivo già attivo. In questa PR non è stato creato alcun database D1 né bucket R2 e non sono stati importati messaggi Gmail o dati clienti reali.

| Dato | Finalità | Dove si trova ora | Futuro previsto |
| --- | --- | --- | --- |
| Clienti, pratiche, note, messaggi, checklist | Gestire richieste e revisioni editoriali | Solo dati sintetici in `localStorage` di localhost | D1 dedicato, Access owner-only |
| PDF/foto/audio caricati | Allegare materiali e preservare la fonte | Nel mock soltanto metadati e un estratto di file di testo; **non** binari | R2 privato con chiavi UUID e download autenticato |
| Menù JSON e versioni | Preparare una bozza verificabile | Mock locale; nessun menù pubblico toccato | D1 privato; solo dopo altra approvazione una PR GitHub |
| Audit | Ricostruire decisioni e modifiche | Stato demo locale o D1 dedicato se attivato | D1 senza logging di token/segreti |
| Audio del microfono | Dettare un comando facoltativo | Non conservato da RenMenu; elaborazione browser potenzialmente remota | Da valutare con informativa e consenso specifici |

## Principi pratici

- **Non usare materiali reali nella demo**: `localStorage` non equivale a un archivio aziendale protetto. Il pulsante «Ripristina demo» elimina le modifiche fittizie del mock. Chiudere il browser non le elimina automaticamente.
- Se D1/R2 saranno attivati, nessun file avrà URL pubblico. Ogni download passa dal middleware Access e usa `Cache-Control: no-store`; nessuna credenziale è inviata al frontend. L'archiviazione attuale è **logica**: nasconde il materiale dalla lavorazione, ma non cancella il binario R2. La cancellazione definitiva con politica di retention/backups è una scelta futura non implementata.
- Lo stato pagamento in scheda è una **nota dichiarata e non verificata**; l'app non legge né modifica Stripe. QR/link visualizzati nella demo sono proposte non attive.
- Gli adapter WhatsApp, chiamate, GitHub e AI funzionano **solo in mock**. L'account Gmail collegato alla precedente app Jarvis non viene consultato da questa Control Room. Ogni futura integrazione richiede riesame di destinatari, minimizzazione, scopi e tempi di conservazione.
- La firma Cloudflare Access non sostituisce la corretta gestione organizzativa: limitare l'accesso all'email esatta del proprietario, mantenere segreti/binding solo in Cloudflare e configurare fail-closed anche in caso di errore/quota.

Prima di caricare dati autentici decidere con il titolare: titolarità e base giuridica, consenso/comunicazione ai locali, accessi team, retention e cancellazione definitiva, backup/ripristino, registro provider e trattamento di audio/AI. **Nessuno di questi passaggi è già approvato da questa PR.**
