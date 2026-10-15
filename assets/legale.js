/* RenMenu — riempie i dati del titolare e i contatti nelle pagine legali */
document.addEventListener('DOMContentLoaded', () => {
  const R = window.RENMENU, t = R.titolare || {};
  const righe = [
    t.nome && `<b>${t.nome}</b>`,
    t.indirizzo,
    t.piva && `Partita IVA ${t.piva}`,
    t.codiceFiscale && `Codice fiscale ${t.codiceFiscale}`,
    t.pec && `PEC: <a href="mailto:${t.pec}">${t.pec}</a>`,
    `Email: <a href="mailto:${R.contattoEmail}">${R.contattoEmail}</a>`
  ].filter(Boolean);
  document.querySelectorAll('[data-titolare]').forEach(el => { el.innerHTML = righe.join('<br>'); });
  document.querySelectorAll('[data-titolare-nome]').forEach(el => { if (t.nome) el.textContent = t.nome; });
  document.querySelectorAll('[data-mail]').forEach(a => { a.href = 'mailto:' + R.contattoEmail; a.textContent = R.contattoEmail; });
});
