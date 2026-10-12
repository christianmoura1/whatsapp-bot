// Vercel Serverless Function - Proxy para a API da VPS
// Resolve o problema de Mixed Content (HTTPS -> HTTP)
export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Token');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Support both POST body and GET query params
  const vpsUrl = req.body?.vpsUrl || req.query.vpsUrl;
  const apiToken = req.body?.apiToken || req.query.apiToken;
  const path = req.body?.path || req.query.path;
  const method = req.body?.method || req.query.method || req.method || 'GET';
  const body = req.body?.body || null;

  if (!vpsUrl || !path) {
    return res.status(400).json({ error: 'Missing vpsUrl or path' });
  }

  const targetUrl = `${vpsUrl.replace(/\/$/, '')}${path}`;
  const headers = {};
  if (apiToken) headers['X-API-Token'] = apiToken;
  if (req.headers.authorization) headers['Authorization'] = req.headers.authorization;

  try {
    const fetchOpts = { method, headers };
    if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
      fetchOpts.headers['Content-Type'] = 'application/json';
      fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const response = await fetch(targetUrl, fetchOpts);
    const contentType = response.headers.get('content-type') || '';

    // For binary content (images like QR code PNG), pipe the buffer directly
    if (contentType.includes('image/') || contentType.includes('octet-stream')) {
      const buffer = Buffer.from(await response.arrayBuffer());
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-cache');
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
    return res.status(502).json({ error: `Proxy error: ${err.message}` });
  }
}