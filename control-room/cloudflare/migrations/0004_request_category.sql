-- Apply ONLY to the dedicated private staging D1 database, never to public RenMenu.
-- Additive and non-destructive: adds the approved RenMenu request category.
-- Existing rows keep category NULL ("da classificare") and their current kind/plan.
-- Apply this migration BEFORE deploying the code that reads requests.category;
-- the API also tolerates its absence (fallback query) to avoid a broken dashboard.
ALTER TABLE requests ADD COLUMN category TEXT CHECK (category IS NULL OR category IN (
  'nuovo_standard', 'nuovo_annuale', 'nuovo_premium', 'prezzo', 'piatto', 'disponibilita',
  'vini_cocktail', 'lingua', 'qr_cartello', 'commerciale', 'da_verificare'
));
