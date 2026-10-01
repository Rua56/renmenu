-- Apply ONLY to a new, dedicated Control Room D1 database after explicit approval.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  contact_name TEXT,
  contact_role TEXT,
  plan TEXT NOT NULL DEFAULT 'da_definire',
  payment_status TEXT,
  menu_id TEXT,
  menu_url TEXT,
  internal_notes TEXT NOT NULL DEFAULT '',
  trial_ends_at TEXT,
  renewal_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  subject TEXT NOT NULL,
  source_channel TEXT NOT NULL,
  source_text TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('nuovo', 'aggiornamento', 'prezzo', 'traduzione', 'qr', 'commerciale', 'altro')),
  status TEXT NOT NULL DEFAULT 'nuova' CHECK (status IN ('nuova', 'materiale_ricevuto', 'in_analisi', 'dati_da_confermare', 'bozza_pronta', 'in_revisione', 'in_attesa', 'approvata', 'pronta_pubblicazione', 'completata', 'archiviata', 'chiusa')),
  plan TEXT NOT NULL DEFAULT 'da_definire',
  contact_name TEXT,
  contact_role TEXT,
  contact_info TEXT,
  internal_notes TEXT NOT NULL DEFAULT '',
  menu_id TEXT,
  public_url TEXT,
  next_step TEXT,
  follow_up_at TEXT,
  last_action_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_client ON requests(client_id);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);

CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'caricamento_manuale',
  processing_status TEXT NOT NULL DEFAULT 'ricevuto',
  text_preview TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_materials_request ON materials(request_id);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES requests(id),
  slug TEXT NOT NULL,
  menu_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'bozza' CHECK (status IN ('bozza','revisione','pronta_pr','pr_simulata','pubblicazione_simulata')),
  checks_json TEXT NOT NULL DEFAULT '{"prices":false,"allergens":false,"languages":false,"clientApproval":false}',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS draft_versions (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  revision INTEGER NOT NULL,
  menu_json TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(draft_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_draft_versions ON draft_versions(draft_id, revision DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  request_id TEXT REFERENCES requests(id),
  channel TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normale' CHECK (priority IN ('normale','importante','urgente')),
  due_at TEXT,
  read_at TEXT,
  status TEXT NOT NULL DEFAULT 'mock' CHECK (status = 'mock'),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  channel TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'bozza_mock' CHECK (status = 'bozza_mock'),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  request_id TEXT REFERENCES requests(id),
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_request ON audit_events(request_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pr_proposals (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  revision INTEGER NOT NULL,
  snapshot_sha TEXT NOT NULL,
  diff_json TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  commit_message TEXT NOT NULL,
  pr_body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'mock' CHECK (status = 'mock'),
  created_at TEXT NOT NULL,
  UNIQUE(draft_id, revision)
);
