#!/usr/bin/env node
// Ripristino della copia di sicurezza di Jarvis (vedi cloudflare/functions/_lib/backup.js).
// Converte un file `backups/d1/AAAA-MM-GG.json.gz` scaricato da R2 in un file SQL da eseguire su
// un database D1 NUOVO e vuoto. Non si collega a nulla e non esegue nulla da solo.
//
// Uso:
//   wrangler r2 object get <bucket>/backups/d1/2026-10-13.json.gz --file copia.json.gz --remote
//   node control-room/staging/d1-restore.mjs copia.json.gz > ripristino.sql
//   wrangler d1 create renmenu_jarvis_ripristino
//   wrangler d1 execute renmenu_jarvis_ripristino --remote --file ripristino.sql
// Poi si collega il nuovo database allo staging (binding DB) solo dopo averlo controllato.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;
function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function readBackup(bytes) {
  const text = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes).toString('utf8') : Buffer.from(bytes).toString('utf8');
  const copy = JSON.parse(text);
  if (copy?.format !== 'renmenu-d1-backup' || copy.version !== 1) throw new Error('Non è una copia di sicurezza di Jarvis (formato sconosciuto).');
  return copy;
}

// Ordine: tabelle, righe, poi indici e trigger. I vincoli tra tabelle si controllano alla fine.
export function restoreSql(copy) {
  const out = ['PRAGMA defer_foreign_keys = true;'];
  for (const entry of copy.schema.filter((s) => s.type === 'table')) out.push(`${entry.sql};`);
  for (const [table, rows] of Object.entries(copy.tables)) {
    for (const row of rows) {
      const columns = Object.keys(row);
      out.push(`INSERT INTO ${quote(table)} (${columns.map(quote).join(',')}) VALUES (${columns.map((c) => literal(row[c])).join(',')});`);
    }
  }
  for (const entry of copy.schema.filter((s) => s.type !== 'table')) out.push(`${entry.sql};`);
  return `${out.join('\n')}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const file = process.argv[2];
  if (!file) { console.error('Uso: node d1-restore.mjs <copia.json.gz> > ripristino.sql'); process.exit(2); }
  const copy = readBackup(readFileSync(file));
  process.stdout.write(restoreSql(copy));
  console.error(`Copia del ${copy.createdAt}: ${Object.keys(copy.tables).length} tabelle, ${copy.rows} righe.`);
}
