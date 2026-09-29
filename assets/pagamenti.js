/* ============================================================
   RenMenu — CONFIGURAZIONE PAGAMENTI
   Questo è l'unico file da modificare quando apri la partita IVA.
   Compila i campi tra apici ' ' e salva: la pagina paga/ si aggiorna da sola.
   Regole: non togliere le virgole a fine riga, non togliere gli apici.
   ============================================================ */
window.RENMENU.pagamenti = {

  /* --- 1. BONIFICO --------------------------------------------
     Intestatario e IBAN del conto su cui vuoi ricevere i pagamenti.
     Lascia iban: '' finché non vuoi mostrare il bonifico.
     Esempio: intestatario: 'Riccardo Iuran', iban: 'IT60X0542811101000000123456' */
  intestatario: '',
  iban: '',
  banca: '',              /* facoltativo, es. 'Intesa Sanpaolo' */

  /* --- 2. STRIPE (carta) --------------------------------------
     Su dashboard.stripe.com → Payment Links → "+ Nuovo" crea tre link e incolla qui gli indirizzi
     (iniziano con https://buy.stripe.com/...).
       mensile  = prodotto ricorrente 25 €/mese, periodo di prova 30 giorni, "Consenti ai clienti di annullare"
       annuale  = pagamento singolo 249 €
       sumisura = pagamento singolo 490 € (acconto)
     Lascia '' per nascondere il bottone carta di quel piano. */
  stripe: {
    mensile:  '',
    annuale:  '',
    sumisura: ''
  },

  /* --- 3. FACOLTATIVI -----------------------------------------
     paypal:   es. 'https://paypal.me/tuonome'  (il prezzo viene aggiunto da solo)
     satispay: link del tuo negozio Satispay Business, se ne hai uno */
  paypal: '',
  satispay: '',

  /* --- 4. PIANI E PREZZI --------------------------------------
     Se cambi un prezzo qui, ricordati di cambiarlo anche nel listino di index.html. */
  piani: {
    mensile:  { nome: 'Mensile',   prezzo: 25,  unita: '/ mese', prova: true,
                descr: 'Menù online in 24 ore, QR, IT + EN, aggiornamenti illimitati. Primo mese gratis, disdici quando vuoi.' },
    annuale:  { nome: 'Annuale',   prezzo: 249, unita: '/ anno',
                descr: 'Tutto il mensile, una lingua extra, QR con il tuo logo, fattura unica. Due mesi gratis rispetto al mensile.' },
    sumisura: { nome: 'Su misura', prezzo: 490, unita: 'acconto', mensile: 39,
                descr: 'Grafica disegnata sul tuo locale, fino a 4 lingue, tema giorno/notte. Il preventivo definitivo lo concordiamo su WhatsApp; qui versi l\'acconto per partire.' }
  }
};
