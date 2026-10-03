// Percorso completo di approvazione del cliente per i test: anteprima → inviata →
// risposta importata (come farebbe gmail-import.mjs) → conferma di Riccardo → attivazione.
export async function approveByClient(action, db, draftId, { reply = 'Approvo, grazie.', recipient = 'locale@example.com', activation = true } = {}) {
  const findDraft = (state) => state.drafts.find((entry) => entry.id === draftId);
  const stateNow = (await action(db, 'preparePreview', { draftId, revision: (await currentDraftRevision(action, db, draftId)), recipient }));
  if (stateNow.status !== 200) throw new Error(`preparePreview ${stateNow.status} ${JSON.stringify(stateNow.body).slice(0, 200)}`);
  let approval = stateNow.body.state.approvals.find((entry) => entry.draftId === draftId);
  const sent = await action(db, 'markPreviewSent', { id: approval.id, revision: approval.revision });
  if (sent.status !== 200) throw new Error(`markPreviewSent ${sent.status}`);
  const stamp = new Date().toISOString();
  db.prepare("UPDATE publication_approvals SET status='risposta_ricevuta',reply_message_id=?,reply_from=?,reply_text=?,reply_received_at=?,revision=revision+1,updated_at=? WHERE id=?")
    .bind(`msg-${approval.id.slice(0, 8)}`, recipient, reply, stamp, stamp, approval.id).run();
  const decided = await action(db, 'decideClientReply', { id: approval.id, revision: approval.revision + 2, decision: 'approva' });
  if (decided.status !== 200) throw new Error(`decideClientReply ${decided.status} ${JSON.stringify(decided.body).slice(0, 200)}`);
  let last = decided;
  approval = decided.body.state.approvals.find((entry) => entry.draftId === draftId);
  const request = decided.body.state.requests.find((entry) => entry.id === approval.requestId);
  if (activation && request.kind === 'nuovo') {
    const value = { standard: 'prova_30_giorni', annuale: 'annuale_pagato', premium: 'premium_acconto' }[request.plan];
    last = await action(db, 'setActivation', { id: approval.id, revision: approval.revision, activation: value, date: '2026-10-02' });
    if (last.status !== 200) throw new Error(`setActivation ${last.status} ${JSON.stringify(last.body).slice(0, 200)}`);
  }
  return { response: last, draft: findDraft(last.body.state), approval: last.body.state.approvals.find((entry) => entry.draftId === draftId), ready: decided.body.result.ready };
}
async function currentDraftRevision(action, db, draftId) {
  const row = db.prepare('SELECT revision FROM drafts WHERE id=?').bind(draftId).first();
  return row.revision;
}
