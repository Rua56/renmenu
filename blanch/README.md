# Trattoria Blanch — menù digitale

Il menù pubblico si trova in `blanch/index.html`; l'URL stabile è `https://rua56.github.io/renmenu/blanch/`. Il QR punta a quell'URL, **non al file JSON**. Per aggiornare prezzi o disponibilità si modifica il contenuto e si pubblica il commit: il QR già stampato resta valido.

I QR stampabili si trovano in `qr/trattoria-blanch-qr.png` (1080 × 1080 px) e `qr/trattoria-blanch-qr.svg` (vettoriale). Entrambi codificano lo stesso URL stabile; la versione SVG ha un fondo bianco per conservare il contrasto anche su superfici colorate.

## Fonti e responsabilità

Le voci della cucina, i prezzi, il coperto e l'avviso allergie provengono dalle fotografie del cliente `IMG_9187`–`IMG_9203`. Il biglietto `IMG_9207` conferma nome, indirizzo, telefono e chiusure. Il logo e le fotografie di contesto provengono dal sito ufficiale della trattoria. Le foto originali del menù non sono pubblicate nel repository. Traduzioni EN/DE sono state rese più naturali rispetto alla carta stampata, senza introdurre ingredienti non attestati. La carta vini cartacea non indica annate né volumi delle bottiglie.

Nel restyling editoriale, `assets/blecs.webp` riprende il piatto dalla [galleria ufficiale](https://trattoriablanch.it/galleria/); `assets/insegna.webp` ritrae l'insegna originale fotografata sul sito della trattoria. I file sono copie WebP ottimizzate localmente. Il menù e il QR conservano percorso e dati: il progetto resta una carta consultabile, non una nuova versione della lista prezzi.

## Aggiornare

1. **Piatti e bevande:** modificare `data/food.json` (nome e prezzo; mantenere le chiavi `it`, `en`, `de`). Sono presenti il coperto e l'avviso allergie in `notes`.
2. **Bottiglie:** modificare `data/wines.tsv`, una riga per vino. Prezzi nel formato `25,00`, senza simbolo `€`. La colonna `source` è un riferimento interno e può essere adattata ai nuovi materiali.
3. **Compilazione:** dalla root del repository eseguire `python3 blanch/tools/build_menu.py` e controllare il numero di voci e il diff di `blanch/data/menu.json`. Il compilatore genera i prezzi in euro e non include nel JSON pubblico i commenti editoriali interni del file `food.json`.
4. **Verifica e pubblicazione:** confrontare i prezzi con l'ultima carta del ristorante, poi fare commit/push sul branch servito da GitHub Pages; attendere il completamento della build e aprire l'URL pubblico con `?lang=en` e `?lang=de` e `?view=wine`.

Non aggiungere allergeni per singolo piatto, annate, volumi delle bottiglie o disponibilità stagionali per deduzione. Richiedere una fonte aggiornata se queste informazioni servono. Se una voce presenta due prezzi senza spiegazione, mantenerli entrambi oppure chiarire il criterio con la trattoria prima di specificarlo.
