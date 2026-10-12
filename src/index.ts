import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import path from 'path';
import fs from 'fs';
import { chatCompletion } from './ai';
import {
  initDb,
  isUserAllowed,
  isUserBlocked,
  logMessage,
  getSetting,
  getGroupSettings,
  setGroupSettings,
  addAllowedUser,
} from './db';
import { startPanel, setQrCode, setConnectionStatus } from './panel';

const AUTH_DIR = path.join(__dirname, '..', 'auth');

// Conversation history per user (in-memory, last 10 messages)
const conversations: Map<string, { role: string; content: string }[]> = new Map();
const MAX_HISTORY = 10;

function getConversation(sender: string): { role: string; content: string }[] {
  if (!conversations.has(sender)) {
    conversations.set(sender, []);
  }
  return conversations.get(sender)!;
}

function addToConversation(sender: string, role: string, content: string) {
  const conv = getConversation(sender);
  conv.push({ role, content });
  if (conv.length > MAX_HISTORY * 2) {
    conv.splice(0, conv.length - MAX_HISTORY * 2);
  }
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock: WASocket = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, undefined as any),
    },
    getMessage: async () => undefined,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 Escaneie o QR Code abaixo com seu WhatsApp:\n');
      qrcode.generate(qr, { small: true });
      setQrCode(qr);
      setConnectionStatus('qr_pending');
    }

    if (connection === 'close') {
      const shouldReconnect =
        (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('❌ Conexão fechada:', lastDisconnect?.error);
      setConnectionStatus('disconnected');
      setQrCode(null);

      if (shouldReconnect) {
        console.log('🔄 Reconectando em 5 segundos...');
        setTimeout(connectToWhatsApp, 5000);
      } else {
        console.log('🚫 Logged out. Delete a pasta auth/ para reconectar.');
      }
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp conectado com sucesso!');
      setConnectionStatus('connected');
      setQrCode(null);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const sender = msg.key.remoteJid || '';
      const senderName = msg.pushName || sender;
      const isGroup = sender.endsWith('@g.us');
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '';

      if (!text.trim()) continue;

      console.log(
        `📨 [${isGroup ? 'Grupo' : 'Privado'}] ${senderName} (${sender}): ${text.substring(0, 80)}...`
      );

      // Check if bot should respond
      let shouldRespond = false;
      let messageToProcess = text;

      if (isGroup) {
        // Group logic
        const groupId = sender;
        const groupSettings = getGroupSettings(groupId);

        // Auto-register group on first message
        if (!groupSettings) {
          setGroupSettings(groupId, 'Grupo', true, true);
        }

        const settings = getGroupSettings(groupId) || { require_mention: 1, enabled: 1 };
        if (!settings.enabled) continue;

        // Check if mentioned or starts with command
        const isMentioned =
          msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.includes(
            sock.user?.id || ''
          ) || false;
        const isCommand =
          text.startsWith('/ia ') ||
          text.startsWith('/IA ') ||
          text === '/ia' ||
          text === '/IA';

        if (settings.require_mention && !isMentioned && !isCommand) continue;

        // Check if sender is blocked — pass full JID for flexible matching (@lid vs @s.whatsapp.net)
        const senderJid = msg.key.participant || '';
        if (isUserBlocked(senderJid)) continue;

        shouldRespond = true;

        // Strip command prefix from message
        if (isCommand) {
          messageToProcess = text.replace(/^\/[iI][aA]\s*/, '');
        }
      } else {
        // Private message logic
        // Pass full JID for flexible matching (@lid vs @s.whatsapp.net)
        const senderJid = sender;

        if (isUserBlocked(senderJid)) {
          console.log(`🚫 Usuário bloqueado: ${senderJid}`);
          continue;
        }

        const respondToAll = getSetting('respond_to_all_private') === 'true';

        if (respondToAll) {
          shouldRespond = true;
        } else {
          // Only respond to allowed users — silently ignore everyone else
          if (isUserAllowed(senderJid)) {
            shouldRespond = true;
          } else {
            console.log(`🚫 Usuário não permitido: ${senderJid} (${senderName})`);
            continue;
          }
        }

        // Handle commands
        if (text.startsWith('/ia ') || text.startsWith('/IA ')) {
          messageToProcess = text.replace(/^\/[iI][aA]\s*/, '');
        } else if (text === '/modelos' || text === '/MODELOS') {
          const models = [
            'claude-fable-5.1',
            'claude-opus-5-5',
            'claude-sonnet-5',
            'z-ai/glm-5.3',
            'gpt-6-astra',
          ];
          await sock.sendMessage(sender, {
            text: `📋 Modelos disponíveis:\n${models.map((m, i) => `${i + 1}. ${m}`).join('\n')}\n\nModelo atual: ${getSetting('default_model')}`,
          });
          continue;
        } else if (text === '/ajuda' || text === '/AJUDA' || text === '/help') {
          await sock.sendMessage(sender, {
            text:
              `🤖 *Comandos do Bot*\n\n` +
              `/ia <pergunta> — Perguntar algo à IA\n` +
              `/modelos — Listar modelos disponíveis\n` +
              `/ajuda — Esta mensagem\n\n` +
              `Modelo atual: *${getSetting('default_model')}*`,
          });
          continue;
        }
      }

      if (!shouldRespond) continue;

      // Get AI response
      try {
        const conversationKey = isGroup ? `${sender}_${msg.key.participant}` : sender;
        const history = getConversation(conversationKey);

        addToConversation(conversationKey, 'user', messageToProcess);

        const response = await chatCompletion(messageToProcess, history);

        addToConversation(conversationKey, 'assistant', response);

        await sock.sendMessage(sender, { text: response }, {
          quoted: isGroup ? msg : undefined,
        });

        const senderPhone = (msg.key.participant || sender).replace('@s.whatsapp.net', '');
        logMessage(
          senderPhone,
          senderName,
          messageToProcess,
          response,
          getSetting('default_model'),
          isGroup,
          isGroup ? sender : undefined
        );

        console.log(`✅ Resposta enviada para ${senderName}`);
      } catch (error: any) {
        console.error('❌ Erro ao gerar resposta:', error.message);
        await sock.sendMessage(sender, {
          text: `⚠️ Erro: ${error.message || 'Não foi possível gerar resposta. Verifique a configuração da API no painel.'}`,
        });
      }
    }
  });

  return sock;
}

// Start everything
async function main() {
  console.log('🤖 WhatsApp Bot com IA — Iniciando...\n');

  // Initialize database first (sql.js is async)
  await initDb();
  console.log('✅ Banco de dados inicializado.');

  // Ensure auth directory exists
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  // Start admin panel
  startPanel();

  // Connect to WhatsApp
  await connectToWhatsApp();
}

main().catch(console.error);