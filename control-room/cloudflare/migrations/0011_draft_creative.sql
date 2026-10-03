-- Apply ONLY to the dedicated private staging D1 database, never to public RenMenu.
-- Additive: Premium «su misura» — scheda creativa dal testo del cliente e 3 direzioni grafiche
-- (blocchi «premium» pubblicabili). NULL per le bozze Standard e Annuale.
ALTER TABLE drafts ADD COLUMN creative_json TEXT;
