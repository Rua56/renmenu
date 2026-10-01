# Dati e conservazione — RenMenu Control Room

**Stato (1 ottobre 2026): staging predisposto, non distribuito.** D1 dedicato e bucket R2 privato WEUR esistono e sono associati al nuovo progetto Pages `renmenu-jarvis-stage`; il progetto **non ha ancora un deploy**, non ha acquisito messaggi Gmail o dati clienti reali. Il vecchio Jarvis su Manus e il suo monitor Gmail rimangono separati. Questa pagina descrive il comportamento del codice quando lo staging privato sarà verificato, non un trattamento già attivo.

| Dato | Finalità | Stato attuale | Regola di trattamento nello staging |
| --- | --- | --- | --- |
| Clienti, pratiche, note, checklist | Gestire il ciclo del menù | Dati sintetici nel localStorage demo; D1 staging vuoto | D1 dedicato, owner-only Access, revisioni CAS e audit redatto |
| PDF, foto, audio ricevuti | Rivedere il materiale originale | Demo conserva solo metadati dei nuovi upload; PDF statico fittizio | Binari in R2 privato, chiavi non indovinabili, download soltanto da API autenticata; nessun dominio pubblico R2 |
| Trascrizione/OCR | Associare testo a una fonte | Disponibile estrazione testo PDF locale; AI off | Provenienza con hash del materiale originale, stato revisione e approvazione umana obbligatoria |
| Menù e versioni | Preparare JSON e confrontare bozze | Solo bozza/PR sintetiche nella demo | D1 privato; nessuna PR/merge/pubblicazione senza conferma specifica |
| Corpo email Gmail | Ricostruire una richiesta cliente | La casella aziendale è monitorata dal *vecchio* Jarvis; Control Room non importa ancora | Conservare fino a quando il menù corrispondente è online e disponibile; pulizia del corpo nel solo D1 dopo PR merged e confronto esatto con il JSON pubblico, con conferma owner. L'email originale nella casella Gmail non è eliminata da questo codice. |
| Audit e ricevute invio | Identificare chi ha fatto cosa | Test sintetici locali | D1 registra identificativi/stati senza token e senza corpo delle email in uscita |
| Audio microfono del proprietario | Dettare un'intenzione facoltativa | Non conservato da RenMenu | Browser SpeechRecognition può usare un servizio remoto del browser; informativa e consenso prima dell'ascolto |

## Principi operativi

- **Non usare materiali reali nella demo locale**: localStorage non è un archivio protetto. «Ripristina demo» elimina soltanto i dati fittizi di quella demo; chiudere il browser non li cancella automaticamente.
- **Prima del primo caricamento reale**, verificare in incognito che un utente diverso da `renmenu1569@gmail.com` non possa ottenere HTML, JS, API né file, sia su host Pages stabile sia sui link di deployment. Cloudflare Access, firma JWT lato server, policy fail-closed e bucket senza dominio pubblico sono controlli complementari. I file non sono inseriti nel menù JSON pubblico.
- Il viewer PDF.js self-hosted disegna i byte ricevuti dall'API in canvas locale; non li invia a un servizio PDF esterno. L'archiviazione materiale è **logica**: nasconde il file dalla lavorazione ma non elimina ancora il binario R2. La cancellazione definitiva di allegati e backup richiede una policy implementata e verificata separatamente.
- L'AI, se abilitata, trasmetterà estratti/testi al provider scelto; verificare accordi e informativa prima di caricare materiale reale. Prezzi, allergeni, ingredienti e traduzioni dubbie non sono accreditati come fatti senza prova del locale e revisione owner.
- Il campo stato pagamento è una nota dichiarata, non una lettura Stripe. Il mock non esegue pagamenti, invii, merge né pubblicazione. Resend, WhatsApp, Gmail relay e GitHub live sono spenti nello staging fino alla configurazione e ai test separati.
- La scelta del proprietario sulla conservazione riguarda **il corpo importato nel database Control Room fino al menù online**. L'azione `purgePublishedEmail` richiede una conferma esplicita, la versione PR merged verificata e una lettura fresca del menù pubblico; non elimina messaggi dalla casella Gmail, allegati R2 né copie nel vecchio Jarvis. Queste ultime richiedono una decisione separata sulla retention.

Prima di caricare dati autentici definire con il titolare base giuridica/informativa ai locali, accessi al team, durata per pratiche non concluse, backup/ripristino, cancellazione definitiva degli allegati e trattamento di contenuti dal provider AI. La policy owner-only e la regola «email sino al menù online» sono state indicate; gli altri punti non sono automaticamente risolti dal codice.
