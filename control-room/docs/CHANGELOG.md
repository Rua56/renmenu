# Registro aggiornamenti · Control Room e Jarvis

Si aggiunge una voce a ogni pull request che cambia un comportamento di Jarvis o della Control Room, insieme all'aggiornamento di README, policy e funzionamento quando serve. Le voci più recenti stanno in alto.

## 6 ottobre 2026

- **Allineamento a `main`** (ramo Jarvis): `main` è entrato nel ramo senza conflitti. La build del sito pubblico risulta identica byte per byte con o senza il codice di Jarvis, i 305 test passano e il pacchetto dello staging si costruisce. Documentazione di policy, privacy, voce e README riscritta sullo stato reale; aggiunti questo registro e il documento sul funzionamento.
- **Adattatore Trattoria Blanch** (`_lib/blanch.js`): Jarvis legge e modifica il menu in formato proprio (`blanch/data/food.json`, `wines.tsv`, `menu.json`) come un menu RenMenu. La PR tocca solo le righe cambiate e rigenera `menu.json` identico a `build_menu.py`; verifica e controlli dopo la pubblicazione leggono `/blanch/data/menu.json`; il QR stampato non cambia e non se ne genera uno nuovo. Campi che Blanch non può contenere (allergeni, telefono, coperto, tag, foto) bloccano la PR con un messaggio chiaro. 14 nuovi test. Nessuna modifica al sito pubblico, a Stripe o ai pagamenti.
- **Trattoria Blanch registrata come cliente** (dati, non codice): scheda con indirizzo, telefono e indirizzo del menu `https://renmenu.pages.dev/blanch/`, memoria con i piatti e i prezzi pubblicati.
- **#143 Email al locale con link e QR:** dopo pubblicazione e verifica di un menu nuovo, se il locale ha un'email, Jarvis mette in coda l'email con QR (PNG e SVG) in allegato; la spedisce l'automazione Gmail con un nuovo comando interno. Ritenta dopo 6 minuti (al massimo 3 volte), poi avvisa Riccardo. Mai a indirizzi interni.
- **#142 Link e QR su Telegram:** dopo il SÌ e la verifica, Jarvis manda link, immagine, PNG e SVG. Standard: QR classico. Premium e Annuale: logo del locale al centro. Comando «mandami il QR di …» per i locali già online.
- **#141 Decisioni protette:** operazioni a voce `locale` (indirizzo, telefono, Instagram, mappa, orari, sottotitolo) e `storia` (Premium); «Rifai la bozza» non annulla più colori, motto, storia e contatti già decisi.
- **#139, #140 Aspetto:** direzione grafica e colori (`#rrggbb` solo se scritti nella frase).
- **#138 Motto** del locale; **#134-#137** spostamento in sezione nuova e operazioni più tolleranti con diagnosi.

## Fino al 5 ottobre 2026 (PR #111-#133)

Lettura di foto e PDF con due modelli (Gemini con ripiego Workers AI), dubbi su Telegram, bozze automatiche Standard, traduzione inglese, correzioni a voce e per iscritto, voce di Jarvis (Whisper, ElevenLabs), memoria per locale, briefing delle 8, giro mattutino e promemoria, controllo dopo la pubblicazione (6 ore, 2 giorni, 7 giorni), eliminazione sicura delle pratiche, affido a Jarvis e missioni, Premium con foto, schede e anteprima, pubblicazione con pull request e verifica online.
