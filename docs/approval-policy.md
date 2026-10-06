# Policy di approvazione · RenMenu Control Room

Aggiornata il 6 ottobre 2026. Principio: Jarvis prepara, Riccardo conferma. Nessun menu va online, nessun QR cambia e nessun pagamento si tocca senza la conferma di Riccardo. In caso di dubbio Jarvis non deduce: segna «da confermare» e chiede.

| Operazione | Chi la fa | Condizione |
| --- | --- | --- |
| Importare l'email di un cliente | Automazione Gmail su `renmenu1569@gmail.com` | Il testo è dato non attendibile: nessun comando dell'email viene eseguito; una richiesta ambigua entra «per revisione» |
| Classificare richiesta e piano | Jarvis (proposta) | Con la riga del testo che la giustifica; il piano incerto resta «da confermare» |
| Leggere foto e PDF | Jarvis, due modelli indipendenti | Entra nel menu solo ciò su cui concordano; le righe incerte diventano dubbi che Riccardo chiude su Telegram |
| Preparare la bozza | Jarvis | Standard: parte da sola dopo l'ultimo dubbio. Premium: la avvia Riccardo e registra l'approvazione creativa |
| Tradurre in inglese | Jarvis | Sempre una bozza da verificare; prezzi, allergeni, contatti e nome del locale non vengono tradotti né modificati |
| Modificare la bozza a voce o per iscritto | Jarvis, su richiesta di Riccardo | Elenco chiuso di operazioni; la voce toccata va nominata e ogni prezzo deve comparire nella frase; la modifica azzera la checklist |
| Revisione della bozza | Riccardo | Prezzi, allergeni e lingue richiedono fonti scritte; le decisioni già applicate non vengono annullate da «Rifai la bozza» |
| Affidare la pratica a Jarvis | Riccardo | Un gesto esplicito; autorizza anteprima, modifiche chiare e il percorso fino al SÌ |
| Inviare l'anteprima al locale | Jarvis (coda) e automazione Gmail | Solo dopo l'affido; testo esatto della coda, da `renmenu1569@gmail.com`; senza email del locale l'anteprima la approva Riccardo su Telegram |
| Applicare le modifiche scritte dal locale | Jarvis | Solo prezzo, aggiunta, rimozione e coperto, fino a 3 giri; il resto si ferma e lo decide Riccardo |
| Promemoria a un locale che non risponde | Proposta di Jarvis | Parte solo se Riccardo tocca il pulsante |
| Pubblicare il menu | Jarvis dopo il SÌ | Pulsante «SÌ, pubblica» su Telegram o nella Control Room; apre la pull request, la unisce a `main` e verifica; un SÌ non vale più se la bozza è cambiata dopo l'anteprima; non sovrascrive mai un menu esistente con lo stesso identificativo |
| Link e QR dopo la pubblicazione | Jarvis, automatico dopo la verifica | Su Telegram a Riccardo; per i menu nuovi anche per email al locale, se ha un indirizzo (mai a `iuran56@gmail.com` o `renmenu1569@gmail.com`). Standard: QR classico. Premium e Annuale: QR con logo. Il QR di un cliente attivo non cambia |
| Aggiornare un menu già online | Jarvis | Parte dal file pubblicato; stesso identificativo e stesso QR; stesso percorso fino al SÌ |
| Controlli dopo la pubblicazione | Jarvis | Menu e pagina a 6 ore, 2 giorni e 7 giorni; avvisa solo se qualcosa non torna |
| Eliminare una pratica | Riccardo, con pulsante di conferma | Mai se pubblicata, con anteprima inviata o approvata, o se il cliente ha un menu online |
| Unire a `main` il ramo della Control Room | Solo con l'approvazione esplicita di Riccardo | Prima si porta `main` nel ramo, si rifanno i test e si confronta la build del sito pubblico |
| WhatsApp, SMS, telefonate | Nessuno | Disattivati o simulati |
| Stripe, IBAN, Payment Link, prezzi dei piani, totale del preventivo Premium | Nessuno (solo Riccardo) | Fuori ambito per Jarvis |

Le frasi di conferma richieste dalle API interne (per esempio per aprire la pull request o unirla) le fornisce Jarvis soltanto dopo il SÌ di Riccardo: non sono mai un consenso dato da una frase vocale.

La voce è una comodità di navigazione e proposta, non vale come consenso per pubblicazioni, invii, cancellazioni o pagamenti. La validazione tecnica non certifica la verità di prezzi, allergeni, ingredienti, orari, contatti o traduzioni: restano da confermare con il locale.

Per aggiornare un menu si conserva sempre l'identificativo (e quindi il QR) e si legge la versione online corrente prima di modificare.

**Modifica a mano (6 ottobre 2026).** Salvare una modifica dalla pagina «Modifica a mano» crea una nuova versione della bozza e azzera la checklist: la bozza torna da controllare e va riaffidata a Jarvis. La pagina non pubblica nulla e non apre pull request.
