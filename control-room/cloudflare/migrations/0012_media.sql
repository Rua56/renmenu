-- Apply ONLY to the dedicated private staging D1 database, never to public RenMenu.
-- Additive (2026-10-04): foto per il menu Premium. Ogni foto del cliente che non è una pagina di
-- menu (logo, bottiglia, piatto, locale) ha qui il suo riconoscimento e, dopo la conferma di
-- Riccardo, il posto nella bozza e la versione ridotta pubblicabile (public/media/<sha>.<ext>).
CREATE TABLE IF NOT EXISTS media_items (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  material_id TEXT NOT NULL UNIQUE REFERENCES materials(id),
  kind TEXT NOT NULL,
  description TEXT,
  label_json TEXT,
  status TEXT NOT NULL DEFAULT 'proposta',
  target TEXT,
  target_name TEXT,
  with_label INTEGER NOT NULL DEFAULT 0,
  public_key TEXT,
  public_sha TEXT,
  public_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_request ON media_items(request_id);
CREATE INDEX IF NOT EXISTS idx_media_public ON media_items(public_sha);
