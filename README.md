# RenMenu

**Origine pubblica principale per i nuovi link:** https://renmenu.pages.dev/
**Compatibilità legacy:** GitHub Pages resta attivo per i QR e gli URL già distribuiti, che non devono essere modificati o interrotti.

RenMenu crea e mantiene menù digitali QR per bar, ristoranti e trattorie. Il locale invia foto, PDF o modifiche via WhatsApp/email; il Team RenMenu prepara e pubblica il menù. Non è previsto alcun pannello o account per il ristoratore.

Pagamenti: guida passo passo in [CONFIGURAZIONE-PAGAMENTI.md](CONFIGURAZIONE-PAGAMENTI.md); si compila solo `assets/pagamenti.js`.

## Control Room e Jarvis (area privata)

Il repository contiene anche la Control Room con Jarvis, l'assistente che prepara i menu e chiede conferma a Riccardo prima di pubblicare. Non fa parte del sito pubblico e non viene mai copiata nella build. Guida: [CONTROL-ROOM-README.md](CONTROL-ROOM-README.md); funzionamento: [control-room/docs/jarvis-funzionamento.md](control-room/docs/jarvis-funzionamento.md); registro degli aggiornamenti: [control-room/docs/CHANGELOG.md](control-room/docs/CHANGELOG.md). Ogni modifica a Jarvis aggiorna anche questi documenti. Dal 6 ottobre 2026 la Control Room si usa da tre voci (Oggi, Locali, Sistema), pensate per l'iPhone.

Trattoria Blanch usa un formato proprio (`blanch/`, vedi [blanch/README.md](blanch/README.md)), diverso da `menus/<id>.json`; Jarvis lo gestisce con un adattatore dedicato che lascia invariati sito e QR.

## Struttura

```text
index.html                    landing page del servizio
menu/index.html               visualizzatore: menu/?m=<id> legge menus/<id>.json
crea/index.html               generatore JSON, QR e cartello A5
menus/*.json                  un file per ogni locale
richard/index.html             menu privato interattivo con carrello e ordine WhatsApp
scripts/validate-menus.py     controllo locale dei JSON, senza modifiche automatiche
assets/                       stile, logo e helper comuni
vendita/                      materiali commerciali e checklist operativa
```

Il menu speciale di Richard è disponibile su `https://renmenu.pages.dev/richard/` (e sul corrispondente percorso GitHub Pages). È indipendente dai menu JSON standard: le scelte vengono salvate localmente nel browser e il pulsante finale apre WhatsApp con il messaggio precompilato; l'invio effettivo richiede un'azione dell'utente nella chat. La pagina è esclusa dall'indicizzazione e dalla sitemap.

## Aggiungere o aggiornare un locale

1. Il Team RenMenu riceve e verifica il materiale del locale.
2. Crea o aggiorna lo stesso file `menus/<id>.json`; l’URL `menu/?m=<id>` e il QR restano stabili.
3. Esegue il controllo JSON, la build e le verifiche descritte qui sotto.
4. Invia l’anteprima al titolare e pubblica solo dopo la sua approvazione.

I contenuti su **allergeni, prezzi, disponibilità, coperto e lingue** devono essere confermati dal locale: il controllo tecnico non sostituisce la verifica umana né l’approvazione del cliente.

## Controllo prima della pubblicazione

1. Aggiorna o aggiungi il JSON in `menus/`.
2. Esegui il validatore:

   ```sh
   python3 scripts/validate-menus.py
   ```

3. Correggi gli eventuali errori bloccanti indicati dal report.
4. Esegui la build Cloudflare:

   ```sh
   sh scripts/build-cloudflare.sh
   ```

5. Prova il link del menù e il QR dal telefono.
6. Invia l’anteprima al titolare per approvazione.

Il validatore segnala JSON non valido, struttura incompleta, prezzi incoerenti, allergeni fuori dall’intervallo 1–14, tag non supportati, lingue dichiarate senza contenuti essenziali e contatti/URL probabilmente errati. Gli avvisi sulle traduzioni secondarie non bloccano la pubblicazione, ma vanno valutati prima della consegna. I tag legacy `hot` e `riserva`, già mostrati dal visualizzatore per Al Bakaro, restano utilizzabili solo come avviso di compatibilità: nei nuovi menù usa i tag standard elencati sotto.

## Formato del menù

Vedi `menus/demo.json`. Testi in più lingue sono oggetti come `{ "it": "...", "en": "..." }`. Allergeni: numeri 1–14 (Reg. UE 1169/2011). Tag supportati: `veg`, `vegan`, `spicy`, `gf`, `new`, `top`, `frozen`.

Per la procedura completa di pubblicazione usa [vendita/checklist-pubblicazione-menu.md](vendita/checklist-pubblicazione-menu.md).
