import express from 'express';
import cors from 'cors';
import path from 'path';
import QRCode from 'qrcode';
import {
  getAllSettings,
  setSetting,
  getSetting,
  getAllowedUsers,
  getBlockedUsers,
  addAllowedUser,
  removeAllowedUser,
  addBlockedUser,
  removeBlockedUser,
  getMessageLog,
  getStats,
  getAllGroups,
  setGroupSettings,
} from './db';
import { testConnection, getAvailableModels } from './ai';

const app = express();

// CORS: allow Vercel panel + localhost
const ALLOWED_ORIGINS = [
  'https://whatsapp-bot-seven-tau.vercel.app',
  'https://whatsapp-h4nlpwlem-christianmoura2014-7257s-projects.vercel.app',
  'http://localhost:3456',
  'http://127.0.0.1:3456',
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, mobile apps, same-origin)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
      return callback(null, true);
    }
    // Also allow any vercel.app subdomain for this project
    if (origin.endsWith('.vercel.app')) {
      return callback(null, true);
    }
    callback(null, true); // permissive for now; tighten later if needed
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Token'],
}));

app.use(express.json());

// Serve static files (local panel)
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── Remote API Token ───────────────────────────────────────────────
// A secret token that the Vercel-hosted panel must send to access the VPS API.
// Stored in settings as 'remote_api_token'. Default generated on first run.
function getRemoteToken(): string {
  let token = getSetting('remote_api_token');
  if (!token) {
    // Generate a random token on first use
    token = 'wabot_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
    setSetting('remote_api_token', token);
  }
  return token;
}

// ─── Auth middleware ────────────────────────────────────────────────
function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const password = getSetting('panel_password') || 'admin123';
  const remoteToken = getRemoteToken();
  const authHeader = req.headers.authorization;
  const apiTokenHeader = req.headers['x-api-token'] as string | undefined;

  // Allow login endpoint without auth
  if (req.path === '/login' || req.path === '/qr-image') {
    return next();
  }

  // Check remote API token (for Vercel panel → VPS communication)
  if (apiTokenHeader && apiTokenHeader === remoteToken) {
    return next();
  }

  // Check local panel password (Bearer token)
  if (authHeader && authHeader === `Bearer ${password}`) {
    return next();
  }

  return res.status(401).json({ error: 'Não autorizado' });
}

app.use('/api', authMiddleware);

// ─── Login ──────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  const storedPassword = getSetting('panel_password') || 'admin123';
  if (password === storedPassword) {
    res.json({ success: true, token: storedPassword });
  } else {
    res.status(401).json({ error: 'Senha incorreta' });
  }
});

// ─── Remote API info (for Vercel panel to discover the token) ──────
app.get('/api/remote-info', (req, res) => {
  const remoteToken = getRemoteToken();
  res.json({
    remote_api_token: remoteToken,
    vps_url: `http://${req.hostname}:3456`,
    message: 'Use este token no campo "API Token" do painel remoto (Vercel)',
  });
});

// ─── Settings ──────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  const settings = getAllSettings();
  if (settings.api_key && settings.api_key.length > 8) {
    settings.api_key_masked = settings.api_key.substring(0, 4) + '****' + settings.api_key.substring(settings.api_key.length - 4);
  }
  // Don't expose remote_api_token in plain settings response
  delete (settings as any).remote_api_token;
  res.json(settings);
});

app.put('/api/settings', (req, res) => {
  const updates = req.body;
  for (const [key, value] of Object.entries(updates)) {
    if (typeof value === 'string') {
      setSetting(key, value);
    }
  }
  res.json({ success: true });
});

// ─── Test API connection ────────────────────────────────────────────
app.post('/api/test-connection', async (req, res) => {
  const result = await testConnection();
  res.json(result);
});

// ─── Available models ───────────────────────────────────────────────
app.get('/api/models', (req, res) => {
  res.json(getAvailableModels());
});

// ─── Allowed users ──────────────────────────────────────────────────
app.get('/api/allowed-users', (req, res) => {
  res.json(getAllowedUsers());
});

app.post('/api/allowed-users', (req, res) => {
  const { phone, name } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone é obrigatório' });
  addAllowedUser(phone, name);
  res.json({ success: true });
});

app.delete('/api/allowed-users/:phone', (req, res) => {
  removeAllowedUser(req.params.phone);
  res.json({ success: true });
});

// ─── Blocked users ──────────────────────────────────────────────────
app.get('/api/blocked-users', (req, res) => {
  res.json(getBlockedUsers());
});

app.post('/api/blocked-users', (req, res) => {
  const { phone, name } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone é obrigatório' });
  addBlockedUser(phone, name);
  res.json({ success: true });
});

app.delete('/api/blocked-users/:phone', (req, res) => {
  removeBlockedUser(req.params.phone);
  res.json({ success: true });
});

// ─── Message log ────────────────────────────────────────────────────
app.get('/api/messages', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  res.json(getMessageLog(limit));
});

// ─── Stats ──────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  res.json(getStats());
});

// ─── Groups ─────────────────────────────────────────────────────────
app.get('/api/groups', (req, res) => {
  res.json(getAllGroups());
});

app.put('/api/groups/:groupId', (req, res) => {
  const { groupName, requireMention, enabled } = req.body;
  setGroupSettings(req.params.groupId, groupName || req.params.groupId, requireMention ?? true, enabled ?? true);
  res.json({ success: true });
});

// ─── QR Code status ─────────────────────────────────────────────────
let qrCodeData: string | null = null;
let connectionStatus: string = 'disconnected';

export function setQrCode(qr: string | null) {
  qrCodeData = qr;
}

export function setConnectionStatus(status: string) {
  connectionStatus = status;
}

app.get('/api/status', (req, res) => {
  res.json({
    connected: connectionStatus === 'connected',
    status: connectionStatus,
    qrCode: qrCodeData,
  });
});

// QR Code as PNG image (generated locally, no external service)
app.get('/api/qr-image', async (req, res) => {
  if (!qrCodeData) {
    res.status(404).json({ error: 'No QR code available' });
    return;
  }
  try {
    const buffer = await QRCode.toBuffer(qrCodeData, {
      type: 'png',
      width: 300,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-cache');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR image' });
  }
});

// ─── Test audio (TTS) ──────────────────────────────────────────────
app.get('/api/test-audio', async (req, res) => {
  try {
    const { textToSpeech } = await import('./audio');
    const testText = 'Olá! Este é um teste de áudio do WhatsApp Bot. Se você está ouvindo esta mensagem, a síntese de voz está funcionando corretamente.';
    const audioPath = await textToSpeech(testText, 'test_' + Date.now());
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.resolve(audioPath));
  } catch (err: any) {
    res.status(500).json({ error: `Erro ao gerar áudio de teste: ${err.message}` });
  }
});

// ─── Health check ───────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: connectionStatus, timestamp: new Date().toISOString() });
});

const PORT = parseInt(process.env.PANEL_PORT || '3456', 10);

export function startPanel() {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Painel de administração rodando em http://localhost:${PORT}`);
    console.log(`🔑 Token da API remota: ${getRemoteToken()}`);
    console.log(`   Use este token no painel da Vercel para controlar o bot remotamente.`);
  });
}

export default app;