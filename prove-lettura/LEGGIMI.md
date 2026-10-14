# Prova di lettura dei menu

Ramo di servizio, mai unito a `main`. `casi.json` elenca i menu di prova che Jarvis rilegge con «/prova lettura» su Telegram.

- `foto`: `{"r2": "<chiave>"}` (foto già nel bucket privato dello staging) oppure `{"file": "<cartella>/<nome>.jpg"}` (foto in questo ramo).
- `riferimento`: il menu giusto per il confronto, nel formato RenMenu: `{"pubblicato": "<slug>"}` (renmenu.com/menus/<slug>.json), `{"file": "<cartella>/riferimento.json"}` (trascritto a mano dalla foto) oppure `{"bozza": "<id pratica>"}` (bozza in Revisione: riferimento provvisorio).

Le foto prese dal web sono menu pubblicati dai locali sui loro siti; `scaricare.txt` («cartella url» per riga) le fa scaricare dall'azione `scarica-foto`.
