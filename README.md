# RenMenu — menù digitali QR per bar e ristoranti

Sito statico, zero backend, ospitabile gratis su GitHub Pages.

```
index.html          landing page del servizio (per i ristoratori)
menu/index.html     visualizzatore del menù: menu/?m=<id> legge menus/<id>.json
crea/index.html     generatore: compila il menù, scarica il .json, genera QR e cartello A5
menus/*.json        un file per locale (demo.json è l'esempio)
assets/             stile, logo, helper comuni (nome brand e contatti in common.js)
vendita/            kit di vendita: listino, script, obiezioni, zone di Padova
```

## Pubblicare su GitHub Pages (una volta sola)

1. Crea un repository pubblico `renmenu` e carica tutti i file di questa cartella.
2. Settings → Pages → Source: "Deploy from a branch", branch `main`, cartella `/ (root)`.
3. Dopo un minuto il sito è su `https://<tuo-utente>.github.io/renmenu/`.
4. In `assets/common.js` compila `contattoWhatsApp` (es. `393401234567`) e `contattoEmail`.

## Aggiungere un locale (10 minuti)

1. Apri `crea/` sul sito pubblicato, compila il menù (o incolla un JSON preparato).
2. Scarica `<id>.json` e caricalo nella cartella `menus/` del repository (Add file → Upload files, dall'app GitHub va bene).
3. Il menù è online su `menu/?m=<id>`. Scarica il QR PNG e il cartello A5 dal generatore e mandali al locale.
4. Per aggiornare: modifica e ricarica lo stesso file. Il QR non cambia mai.

## Formato del menù

Vedi `menus/demo.json`. Testi in più lingue come oggetti `{ "it": "...", "en": "..." }`.
Allergeni con i numeri 1–14 (Reg. UE 1169/2011). Etichette: `veg`, `vegan`, `spicy`, `gf`, `new`, `top`, `frozen`.
