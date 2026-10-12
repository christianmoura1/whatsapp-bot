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
app.use(cors());
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Auth middleware
function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const password = getSetting('panel_password') || 'admin123';
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${password}`) {
    // Allow login and QR image endpoints without auth
    if (req.path === '/login' || req.path === '/qr-image' || req.path === '/api/login' || req.path === '/api/qr-image' || req.originalUrl?.startsWith('/api/qr-image')) {
      return next();
    }
    return res.status(401).json({ error: 'Não autorizado' });
  }
  next();
}

app.use('/api', authMiddleware);

// Login
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  const storedPassword = getSetting('panel_password') || 'admin123';
  if (password === storedPassword) {
    res.json({ success: true, token: storedPassword });
  } else {
    res.status(401).json({ error: 'Senha incorreta' });
  }
});

// Settings
app.get('/api/settings', (req, res) => {
  const settings = getAllSettings();
  // Mask API key for security
  if (settings.api_key && settings.api_key.length > 8) {
    settings.api_key_masked = settings.api_key.substring(0, 4) + '****' + settings.api_key.substring(settings.api_key.length - 4);
  }
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

// Test API connection
app.post('/api/test-connection', async (req, res) => {
  const result = await testConnection();
  res.json(result);
});

// Available models
app.get('/api/models', (req, res) => {
  res.json(getAvailableModels());
});

// Allowed users
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

// Blocked users
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

// Message log
app.get('/api/messages', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  res.json(getMessageLog(limit));
});

// Stats
app.get('/api/stats', (req, res) => {
  res.json(getStats());
});

// Groups
app.get('/api/groups', (req, res) => {
  res.json(getAllGroups());
});

app.put('/api/groups/:groupId', (req, res) => {
  const { groupName, requireMention, enabled } = req.body;
  setGroupSettings(req.params.groupId, groupName || req.params.groupId, requireMention ?? true, enabled ?? true);
  res.json({ success: true });
});

// QR Code status (will be updated by the bot)
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

const PORT = parseInt(process.env.PANEL_PORT || '3456', 10);

export function startPanel() {
  app.listen(PORT, () => {
    console.log(` Painel de administração rodando em http://localhost:${PORT}`);
  });
}

export default app;