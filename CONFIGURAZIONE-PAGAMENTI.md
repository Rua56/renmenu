# RenMenu — Configurazione pagamenti

Da fare una volta sola, appena hai la partita IVA. Tutto si fa dall'iPhone.
L'unico file da toccare è **`assets/pagamenti.js`**. Pagina di controllo: https://rua56.github.io/renmenu/paga/index.html?check=1

---

## Checklist

- [ ] Partita IVA aperta (regime forfettario)
- [ ] IBAN del conto su cui ricevere i pagamenti
- [ ] Account Stripe verificato
- [ ] 3 Payment Link Stripe creati (mensile, annuale, su misura)
- [ ] `assets/pagamenti.js` compilato e salvato
- [ ] Controllo su `paga/index.html?check=1`: tutte le righe con ✓
- [ ] Pagamento di prova da 1 € fatto e rimborsato

---

## 1. Bonifico (5 minuti)

Puoi farlo anche subito, prima della partita IVA: serve solo un conto a tuo nome.

Nel file `assets/pagamenti.js` compila:

```js
intestatario: 'Riccardo Iuran',
iban: 'IT60X0542811101000000123456',   // il tuo, senza spazi
banca: 'Nome banca',                   // facoltativo
```

La pagina controlla l'IBAN con l'algoritmo ufficiale: se c'è un errore di battitura il blocco bonifico resta nascosto e la pagina di controllo te lo segnala.

## 2. Stripe (20 minuti)

1. Vai su [stripe.com](https://stripe.com/it) → **Inizia ora**. Ti chiede partita IVA, indirizzo, IBAN per gli accrediti e un documento. Nessun canone: paghi 1,5% + 0,25 € solo sulle transazioni riuscite.
2. Dalla Dashboard: **Catalogo prodotti → + Aggiungi prodotto**. Crea tre prodotti:

| Prodotto | Prezzo | Tipo |
|---|---|---|
| RenMenu Mensile | 25,00 € | Ricorrente, ogni mese |
| RenMenu Annuale | 249,00 € | Una tantum |
| RenMenu Su misura (acconto) | 490,00 € | Una tantum |

3. **Payment Links → + Nuovo**, uno per prodotto. Per il **Mensile** attiva:
   - *Periodo di prova gratuito*: 30 giorni (così il "primo mese gratis" è automatico e la carta viene addebitata solo dal secondo mese)
   - *Consenti ai clienti di annullare l'abbonamento* (portale clienti)
   - *Raccogli indirizzo di fatturazione* e *Raccogli partita IVA* (ti servono per la fattura)
   Per tutti e tre: *Pagina di conferma* → "Non mostrare la pagina di conferma, reindirizza a" → `https://rua56.github.io/renmenu/index.html#grazie` (facoltativo).
4. Copia i tre link (`https://buy.stripe.com/...`) e incollali nel file:

```js
stripe: {
  mensile:  'https://buy.stripe.com/xxxxx',
  annuale:  'https://buy.stripe.com/yyyyy',
  sumisura: 'https://buy.stripe.com/zzzzz'
},
```

La pagina aggiunge da sola `?client_reference_id=Nome del locale` al link: nella Dashboard Stripe vedrai quale locale ha pagato.

5. Nella Dashboard attiva le notifiche email per "pagamento riuscito" e "pagamento fallito": così sai quando pubblicare o quando sollecitare.

## 3. Facoltativi

```js
paypal:   'https://paypal.me/tuonome',      // il prezzo viene aggiunto da solo al link
satispay: 'https://...',                    // link negozio Satispay Business
```

Consiglio: PayPal costa 3,4% + 0,35 €, più del doppio di Stripe. Attivalo solo se un cliente lo chiede.

## 4. Come modificare il file dall'iPhone

**Opzione A — sito GitHub (Safari):**
1. Apri https://github.com/Rua56/renmenu/blob/main/assets/pagamenti.js
2. Tocca l'icona della **matita** (in alto a destra; se non la vedi, tocca i tre puntini → *Edit in place*).
3. Compila i campi tra apici `' '`. Non cancellare virgole e apici.
4. Tocca **Commit changes…** → **Commit changes**. Dopo circa un minuto il sito è aggiornato.

**Opzione B — chiedi a me:** mandami IBAN, intestatario e i tre link Stripe in chat e faccio io la modifica e il controllo.

## 5. Verifica finale

1. Apri https://rua56.github.io/renmenu/paga/index.html?check=1 → tutte le righe devono avere ✓ (PayPal e Satispay possono restare ✗ se non li usi).
2. Apri la pagina normale https://rua56.github.io/renmenu/paga/index.html, scegli *Annuale*, tocca *Paga con carta*: deve aprirsi la pagina Stripe con "RenMenu Annuale 249,00 €".
3. Fai un pagamento di prova con la tua carta sul link *Su misura* cambiando temporaneamente il prezzo a 1 € in Stripe, poi rimborsalo dalla Dashboard e rimetti 490 €. Oppure usa la **modalità test** di Stripe con la carta `4242 4242 4242 4242`.

## 6. Fattura

In forfettario la fattura elettronica è obbligatoria per ogni incasso. Si emette gratis dal portale *Fatture e Corrispettivi* dell'Agenzia delle Entrate o dall'app del commercialista. Dicitura:

> Servizio RenMenu, piano Mensile, menù digitale QR per [nome locale], periodo [mese/anno].
> Operazione senza applicazione dell'IVA ai sensi dell'art. 1, commi 54-89, L. 190/2014. Imposta di bollo da 2 € assolta virtualmente per importi superiori a 77,47 €.

Stripe può inviare anche una ricevuta automatica al cliente, ma non sostituisce la fattura.

---

Se qualcosa non torna, apri la pagina di controllo e mandami uno screenshot.
