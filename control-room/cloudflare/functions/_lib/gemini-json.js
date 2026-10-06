// Chiamata Gemini che restituisce un oggetto JSON, con pensiero minimo e un tempo massimo complessivo.
// I modelli sono provati in ordine (prima quelli che hanno risposto per ultimi); ogni tentativo fallito
// viene annotato in `tries` per la diagnostica. Niente chiave o modelli: restituisce null.
export async function geminiJson(gemini, { system, user, validate = () => true, deadlineMs = 14_000, perModelMs = 8_000, maxOutputTokens = 1200 }, tries = []) {
  if (!gemini?.key || !gemini.models?.length) return null;
  const fetchImpl = gemini.fetchImpl || globalThis.fetch;
  const deadline = Date.now() + deadlineMs;
  const bodyFor = (model, thinking) => ({ system_instruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens, responseMimeType: 'application/json',
      ...(thinking ? { thinkingConfig: /^gemini-2\.5/.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: 'low' } } : {}) } });
  for (const model of gemini.models) {
    const left = deadline - Date.now();
    if (left < 2_500) break;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), Math.min(perModelMs, left));
    try {
      const ask = (thinking) => fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': gemini.key }, body: JSON.stringify(bodyFor(model, thinking)), signal: controller?.signal });
      let response = await ask(true);
      if (response.status === 400) response = await ask(false);
      if (!response.ok) { tries.push({ model, status: response.status }); continue; }
      const data = await response.json();
      const raw = (data?.candidates?.[0]?.content?.parts || []).filter((part) => !part.thought).map((part) => part.text || '').join('');
      const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
      let parsed = null; try { parsed = start >= 0 && end > start ? JSON.parse(raw.slice(start, end + 1)) : null; } catch { parsed = null; }
      if (parsed && validate(parsed)) return { ...parsed, modelName: model };
      tries.push({ model, status: 'risposta non valida' });
    } catch (error) { tries.push({ model, status: String(error?.name === 'AbortError' ? 'tempo scaduto' : error?.message || 'errore').slice(0, 40) }); } finally { clearTimeout(timer); }
  }
  return null;
}
