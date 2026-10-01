/* Dati fittizi: nessun cliente, contatto, immagine o credenziale reale. */

export const DEMO_IDS = {
  clientAurora: '2f5f3b66-7a50-4bd2-8b8a-000000000101',
  clientGinestra: '2f5f3b66-7a50-4bd2-8b8a-000000000102',
  requestAurora: '3c8cb099-7a50-4bd2-8b8a-000000000201',
  requestGinestra: '3c8cb099-7a50-4bd2-8b8a-000000000202',
  requestTerra: '3c8cb099-7a50-4bd2-8b8a-000000000203',
  draftAurora: '4d9df1aa-7a50-4bd2-8b8a-000000000301',
  draftGinestra: '4d9df1aa-7a50-4bd2-8b8a-000000000302'
};

const auroraMenu = {
  id: 'bottega-aurora-demo',
  nome: { it: 'Bottega Aurora — demo' },
  lingue: ['it'],
  sezioni: [
    { nome: { it: 'Piccoli piatti' }, voci: [
      { nome: { it: 'Crostino alle erbe' }, prezzo: '4,50' },
      { nome: { it: 'Verdure arrosto' }, prezzo: '6,00' }
    ] },
    { nome: { it: 'Bevande' }, voci: [
      { nome: { it: 'Acqua naturale 0,75 l' }, prezzo: '2,50' },
      { nome: { it: 'Tisana della casa' }, prezzo: '3,00' }
    ] }
  ]
};

const ginestraMenu = {
  id: 'cucina-ginestra-demo',
  nome: { it: 'Cucina Ginestra — demo' },
  lingue: ['it'],
  sezioni: [
    { nome: { it: 'Pranzo' }, voci: [
      { nome: { it: 'Zuppa di stagione' }, prezzo: '8,00' },
      { nome: { it: 'Riso alle verdure' }, prezzo: '' }
    ] }
  ]
};

export function createDemoState() {
  return {
    clients: [
      { id: DEMO_IDS.clientAurora, name: 'Bottega Aurora — demo', phone: '+390000000001', plan: 'da_definire', internalNotes: 'Anagrafica interamente sintetica; numero non reale.', revision: 1, createdAt: '2026-09-28T09:10:00.000Z', updatedAt: '2026-09-28T09:10:00.000Z', tags: ['demo'] },
      { id: DEMO_IDS.clientGinestra, name: 'Cucina Ginestra — demo', menuId: 'cucina-ginestra-demo', plan: 'standard', internalNotes: 'Nessun contatto reale associato.', revision: 1, createdAt: '2026-09-29T11:30:00.000Z', updatedAt: '2026-09-29T11:30:00.000Z', tags: ['demo'] }
    ],
    requests: [
      {
        id: DEMO_IDS.requestAurora, clientId: DEMO_IDS.clientAurora, subject: 'Nuovo menu pranzo (demo)', sourceChannel: 'manuale',
        sourceText: 'Locale: Bottega Aurora — demo\n# Piccoli piatti\nCrostino alle erbe — 4,50\nVerdure arrosto — 6,00\n# Bevande\nAcqua naturale 0,75 l — 2,50\nTisana della casa — 3,00',
        kind: 'nuovo', status: 'in_revisione', revision: 3, createdAt: '2026-09-28T09:15:00.000Z', updatedAt: '2026-10-01T08:42:00.000Z', lastActionAt: '2026-10-01T08:42:00.000Z'
        , plan: 'da_definire', internalNotes: 'Contenuti e prezzi fittizi; verifica editoriale in corso.', nextStep: 'Completa i quattro controlli di revisione.', followUpAt: '2026-10-02T09:00:00.000Z'
      },
      {
        id: DEMO_IDS.requestGinestra, clientId: DEMO_IDS.clientGinestra, subject: 'Aggiornamento pranzo: due prezzi da verificare', sourceChannel: 'manuale',
        sourceText: 'Locale: Cucina Ginestra — demo\n# Pranzo\nZuppa di stagione — 8,00\nRiso alle verdure —',
        kind: 'aggiornamento', status: 'in_attesa', revision: 2, createdAt: '2026-09-29T11:35:00.000Z', updatedAt: '2026-10-01T07:10:00.000Z', lastActionAt: '2026-10-01T07:10:00.000Z'
        , plan: 'standard', menuId: 'cucina-ginestra-demo', internalNotes: 'Prezzo del riso mancante: nessun valore dedotto.', nextStep: 'Richiedi al locale la fonte del prezzo.', followUpAt: '2026-10-01T15:00:00.000Z'
      },
      {
        id: DEMO_IDS.requestTerra, clientId: DEMO_IDS.clientAurora, subject: 'WhatsApp demo: aperitivo da impostare', sourceChannel: 'whatsapp',
        sourceText: 'Locale: Bottega Aurora — demo\n# Aperitivo\nAnalcolico agrumato — 5,00\nTagliere della casa —',
        kind: 'nuovo', status: 'nuova', revision: 1, createdAt: '2026-10-01T08:50:00.000Z', updatedAt: '2026-10-01T08:50:00.000Z', lastActionAt: '2026-10-01T08:50:00.000Z'
        , plan: 'da_definire', internalNotes: 'Messaggio WhatsApp simulato: nessun webhook reale.', nextStep: 'Genera la bozza e verifica la voce senza prezzo.', followUpAt: '2026-10-02T10:00:00.000Z'
      }
    ],
    materials: [
      { id: '5eae22bc-7a50-4bd2-8b8a-000000000401', requestId: DEMO_IDS.requestAurora, filename: 'appunti-menu-demo.txt', mime: 'text/plain', size: 182, source: 'manuale', processingStatus: 'metadati', textPreview: 'Piccoli piatti e bevande: testo sintetico per prova.', createdAt: '2026-09-28T09:17:00.000Z' },
      { id: '5eae22bc-7a50-4bd2-8b8a-000000000403', requestId: DEMO_IDS.requestAurora, filename: 'menu-fittizio-demo.pdf', mime: 'application/pdf', size: 12024, source: 'demo_sintetica', processingStatus: 'solo_metadati', textPreview: null, createdAt: '2026-09-28T09:18:00.000Z' },
      { id: '5eae22bc-7a50-4bd2-8b8a-000000000402', requestId: DEMO_IDS.requestGinestra, filename: 'listino-da-verificare.txt', mime: 'text/plain', size: 98, source: 'manuale', processingStatus: 'metadati', textPreview: 'Un prezzo è assente: nessun valore è stato dedotto.', createdAt: '2026-09-29T11:39:00.000Z' }
    ],
    drafts: [
      {
        id: DEMO_IDS.draftAurora, requestId: DEMO_IDS.requestAurora, slug: 'bottega-aurora-demo', menu: auroraMenu, status: 'revisione', revision: 4,
        checks: { prices: false, allergens: false, languages: false, clientApproval: false },
        provenance: [
          { path: 'sezioni.0.voci.0.prezzo', source: 'riga 3', value: '4,50', status: 'confermato' },
          { path: 'sezioni.1.voci.0.prezzo', source: 'riga 6', value: '2,50', status: 'confermato' }
        ],
        versions: [{ revision: 3, at: '2026-09-30T16:00:00.000Z', summary: 'Prima estrazione demo.', menu: auroraMenu }]
      },
      {
        id: DEMO_IDS.draftGinestra, requestId: DEMO_IDS.requestGinestra, slug: 'cucina-ginestra-demo', menu: ginestraMenu, status: 'bozza', revision: 1,
        checks: { prices: false, allergens: false, languages: false, clientApproval: false },
        provenance: [{ path: 'sezioni.0.voci.1.prezzo', source: 'nessuna fonte', value: '—', status: 'da_verificare' }],
        versions: []
      }
    ],
    notifications: [
      { id: '6fae22bc-7a50-4bd2-8b8a-000000000501', requestId: DEMO_IDS.requestGinestra, channel: 'in_app', subject: 'Prezzo da verificare', body: 'Il riso alle verdure non ha un prezzo esplicito.', status: 'mock', priority: 'urgente', dueAt: '2026-10-01T15:00:00.000Z', readAt: null, createdAt: '2026-10-01T07:15:00.000Z' },
      { id: '6fae22bc-7a50-4bd2-8b8a-000000000502', requestId: DEMO_IDS.requestAurora, channel: 'in_app', subject: 'Checklist editoriale', body: 'Completa i quattro controlli visibili prima della PR di prova.', status: 'mock', priority: 'normale', dueAt: null, readAt: '2026-10-01T08:45:00.000Z', createdAt: '2026-10-01T08:43:00.000Z' },
      { id: '6fae22bc-7a50-4bd2-8b8a-000000000503', requestId: DEMO_IDS.requestAurora, channel: 'telefono', subject: 'Chiamata demo non avviata', body: 'Simulazione: verifica bozza pronta; nessun numero chiamato.', status: 'mock', priority: 'importante', dueAt: null, readAt: null, createdAt: '2026-10-01T08:46:00.000Z' }
    ],
    messages: [
      { id: '7aae22bc-7a50-4bd2-8b8a-000000000601', requestId: DEMO_IDS.requestGinestra, channel: 'whatsapp', body: 'Ciao, puoi confermare il prezzo del riso alle verdure?', status: 'bozza_mock', createdAt: '2026-10-01T07:18:00.000Z' },
      { id: '7aae22bc-7a50-4bd2-8b8a-000000000602', requestId: DEMO_IDS.requestTerra, channel: 'whatsapp', body: 'Messaggio in ingresso simulato: nuovo aperitivo.', status: 'bozza_mock', createdAt: '2026-10-01T08:50:00.000Z' }
    ],
    audit: [
      { id: '8bae22bc-7a50-4bd2-8b8a-000000000701', requestId: DEMO_IDS.requestAurora, action: 'generateDraft', summary: 'Bozza demo estratta da testo: nessun dato inferito.', createdAt: '2026-09-30T16:00:00.000Z' },
      { id: '8bae22bc-7a50-4bd2-8b8a-000000000702', requestId: DEMO_IDS.requestGinestra, action: 'addNotification', summary: 'Avviso demo sul prezzo mancante.', createdAt: '2026-10-01T07:15:00.000Z' }
    ],
    proposals: []
  };
}

export const cloneDemo = () => JSON.parse(JSON.stringify(createDemoState()));
