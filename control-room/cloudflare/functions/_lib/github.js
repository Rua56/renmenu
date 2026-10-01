import { menuDiff, validateMenu } from './menu.js';

// Phase A/B only: pure proposal construction. There is deliberately NO fetch(), token or GitHub write here.
export function prepareMockGitHubProposal({ clientName, requestKind, requestId, slug, menu, previousMenu = null, sourceFiles = [] }) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || menu?.id !== slug) throw new Error('Slug non valido.');
  const validation = validateMenu(menu);
  if (validation.errors.length) throw new Error('JSON non valido.');
  const label = String(clientName).replace(/[\r\n<>]/g, ' ').slice(0, 120);
  const update = requestKind !== 'nuovo';
  const branchName = `${update ? 'update' : 'menu'}/${slug}-${new Date().toISOString().slice(0, 10)}`;
  const filePath = `menus/${slug}.json`;
  const commitMessage = update ? `Update ${label}: prices and items` : `Create menu for ${label}`;
  const changes = menuDiff(previousMenu, menu);
  const itemCount = menu.sezioni.reduce((sum, section) => sum + section.voci.length, 0);
  const prBody = [
    `## Proposta simulata — ${label}`,
    `Tipo: ${update ? 'Aggiornamento' : 'Nuovo menù'}`,
    `File proposto: \`${filePath}\` · ${itemCount} voci`,
    `Materiali di origine: ${sourceFiles.length ? `${sourceFiles.length} file privati (nomi consultabili solo nella Control Room)` : 'testo associato alla pratica'}`,
    `Controllo JSON: ${validation.errors.length} errori; ${validation.warnings.length} avvisi.`,
    'Prezzi, allergeni, lingue, cliente e QR devono essere verificati da Riccardo.',
    '**DEMO: nessun branch, commit, PR, merge o deploy è stato eseguito.**'
  ].join('\n\n');
  return { branchName, filePath, commitMessage, prBody, changes, validation, simulated: true };
}
