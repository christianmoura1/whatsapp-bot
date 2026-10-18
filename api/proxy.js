// Vercel Serverless Function - Proxy para a API da VPS
// Resolve o problema de Mixed Content (HTTPS -> HTTP).
//
// A URL da VPS e o token NAO vem mais do navegador: ficam nas variaveis de
// ambiente da Vercel (VPS_URL e VPS_API_TOKEN, server-side). O navegador manda
// so' o caminho e a senha do painel (Authorization: Bearer). Antes o proxy
// aceitava qualquer vpsUrl e servia de relay aberto para qualquer endereco.
const METODOS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

export default async function handler(req, res) {
  // So' o proprio painel (mesma origem) usa o proxy: sem CORS aberto.
  if (req.method === 'OPTIONS') return res.status(204).end();
  res.setHeader('Cache-Control', 'no-store');

  const vpsUrl = process.env.VPS_URL;
  const apiToken = process.env.VPS_API_TOKEN;
  if (!vpsUrl || !apiToken) {
    return res.status(503).json({ error: 'Proxy sem VPS_URL/VPS_API_TOKEN configurados na Vercel' });
  }

  // Support both POST body and GET query params
  const path = String(req.body?.path || req.query.path || '');
  const method = String(req.body?.method || req.query.method || req.method || 'GET').toUpperCase();
  const body = req.body?.body || null;

  // So' a API do painel, sem truques de caminho.
  if (!/^\/api\/[A-Za-z0-9\-_/%.?=&]*$/.test(path) || path.includes('..') || path.includes('//')) {
    return res.status(400).json({ error: 'Caminho invalido' });
  }
  if (!METODOS.has(method)) return res.status(400).json({ error: 'Metodo invalido' });

  const targetUrl = `${vpsUrl.replace(/\/$/, '')}${path}`;
  const headers = { 'X-API-Token': apiToken };
  if (req.headers.authorization) headers['Authorization'] = req.headers.authorization;

  try {
    const fetchOpts = { method, headers, signal: AbortSignal.timeout(25000) };
    if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
      fetchOpts.headers['Content-Type'] = 'application/json';
      fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const response = await fetch(targetUrl, fetchOpts);
    const contentType = response.headers.get('content-type') || '';

    // For binary content (images, audio, octet-stream), pipe the buffer directly
    if (contentType.includes('image/') || contentType.includes('audio/') || contentType.includes('octet-stream') || contentType.includes('application/pdf')) {
      const buffer = Buffer.from(await response.arrayBuffer());
      res.setHeader('Content-Type', contentType);
      return res.status(response.status).send(buffer);
    }

    if (contentType.includes('application/json')) {
      const data = await response.json();
      return res.status(response.status).json(data);
    } else {
      const text = await response.text();
      res.setHeader('Content-Type', contentType || 'text/plain');
      return res.status(response.status).send(text);
    }
  } catch (err) {
    // Sem detalhe do erro: ele poderia carregar o endereco da VPS.
    return res.status(502).json({ error: 'VPS inacessivel' });
  }
}
