-- Percorso di approvazione prima della pubblicazione reale (2026-10-02).
-- Una riga per bozza; vale solo per il contenuto con lo SHA indicato.
CREATE TABLE IF NOT EXISTS publication_approvals (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL UNIQUE REFERENCES drafts(id),
  request_id TEXT NOT NULL REFERENCES requests(id),
  reference_code TEXT NOT NULL UNIQUE,
  snapshot_sha TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('anteprima_pronta','anteprima_inviata','risposta_ricevuta','approvata_cliente','modifiche_richieste')),
  recipient TEXT,
  preview_url TEXT NOT NULL,
  email_subject TEXT NOT NULL,
  email_body TEXT NOT NULL,
  prepared_at TEXT NOT NULL,
  sent_at TEXT,
  reply_message_id TEXT,
  reply_from TEXT,
  reply_text TEXT,
  reply_received_at TEXT,
  approved_at TEXT,
  approval_evidence TEXT,
  activation TEXT CHECK (activation IS NULL OR activation IN ('prova_30_giorni','annuale_pagato','premium_acconto')),
  activation_date TEXT,
  activation_note TEXT,
  activation_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_publication_approvals_request ON publication_approvals(request_id);
