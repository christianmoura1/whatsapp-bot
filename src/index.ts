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
import { chatCompletion, analyzeImage } from './ai';
import {
  initDb,
  isUserAllowed,
  isUserBlocked,
  isAdmin,
  logMessage,
  getSetting,
  getGroupSettings,
  setGroupSettings,
  addAllowedUser,
  listRemindersForUser,
} from './db';
import { startPanel, setQrCode, setConnectionStatus } from './panel';
import { transcribeAudio, textToSpeech, downloadMedia, saveAudioBuffer } from './audio';
import { generateQuotePdf, parseQuoteFromAI, getQuotePromptAddition } from './quote';
import { generateImage, detectImageRequest, enhancePrompt } from './image';
import {
  resolveCommand,
  startScheduledTask,
  getLastTaskResult,
  buildHelpText,
  formatTriggerReply,
  formatStatusReply,
} from './commands';
import {
  createReminder,
  cancelReminder,
  formatCreatedReply,
  formatListReply,
  initScheduler as initReminderScheduler,
  registerReminderDeliverer,
} from './reminders';

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
      // Register the reminder deliverer so the scheduler can send messages via this socket,
      // then load all saved reminders and arm their cron jobs.
      try {
        registerReminderDeliverer(async (userJid, text) => {
          await sock.sendMessage(userJid, { text });
        });
        initReminderScheduler();
      } catch (e: any) {
        console.error('⚠️ Falha ao inicializar scheduler de lembretes:', e?.message || e);
      }
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

      // ─── Group gate: by default the bot stays SILENT in every group.
      // It only responds in a group when that group is explicitly registered
      // in the `groups` table with enabled = 1 (configured via the panel's
      // "👨‍👩‍‍👦 Grupos" tab). Any unregistered group — like "Líderes Man.Reg SUL"
      // before you add it — is ignored entirely (text, audio, and images).
      if (isGroup) {
        const groupCfg = getGroupSettings(sender);
        if (!groupCfg || !groupCfg.enabled) {
          continue;
        }
      }

      // ─── Lista de autorizados (pedido do Christian em 18/10/2026): o bot so'
      // responde a quem esta' em "usuarios permitidos" do painel, ou e' admin.
      // Vale no privado E dentro de grupo autorizado (quem fala e' o participante).
      // Roda ANTES de baixar/transcrever qualquer midia: estranho nao gasta
      // Groq nem recebe nem mensagem de erro. "Responder a todos" foi desligado
      // de proposito e o codigo nao le mais essa opcao.
      {
        const quemFala = isGroup ? (msg.key.participant || '') : sender;
        const autorizado = !!quemFala && !isUserBlocked(quemFala) && (isUserAllowed(quemFala) || isAdmin(quemFala));
        if (!autorizado) {
          console.log(`🚫 Ignorado (fora da lista de autorizados): ${isGroup ? 'grupo ' + sender + ' / ' : ''}${quemFala || '(sem remetente)'}`);
          continue;
        }
      }

      // Detect audio messages (voice notes or audio files)
      const hasAudio = !!(msg.message?.audioMessage);
      // Detect image messages (photos sent by the user)
      const hasImage = !!(msg.message?.imageMessage);
      let messageToProcess = text;
      let isAudioMessage = false;
      let audioResponsePath: string | null = null;

      // ─── Image analysis: if user sent a photo, analyze it with vision model ───
      if (hasImage) {
        const senderJidImg = isGroup ? (msg.key.participant || '') : sender;
        // Permission check: same rules as text messages
        let canProcessImage = false;
        if (isGroup) {
          // Group already passed the gate above, so groupCfg is enabled here.
          const groupSettingsImg = getGroupSettings(sender) || { require_mention: 1, enabled: 1 };
          if (groupSettingsImg.enabled && !isUserBlocked(senderJidImg)) {
            const isMentionedImg = !!(msg.message?.imageMessage?.caption || text.trim().length > 0);
            canProcessImage = !groupSettingsImg.require_mention || isMentionedImg;
          }
        } else {
          // Ja' passou pela lista de autorizados acima.
          canProcessImage = true;
        }
        if (canProcessImage) {
          console.log(`🖼️ [${isGroup ? 'Grupo' : 'Privado'}] ${senderName} (${sender}): [Imagem recebida, analisando...]`);
          try {
            const media = await downloadMedia(msg, sock);
            if (media) {
              const userQuestion = text.trim() || undefined;
              const description = await analyzeImage(media.buffer, media.mimeType, userQuestion);
              await sock.sendMessage(sender, { text: `🖼️ *Análise da imagem:*\n\n${description}` }, {
                quoted: isGroup ? msg : undefined,
              });
              const senderPhoneImg = (msg.key.participant || sender).replace('@s.whatsapp.net', '');
              logMessage(senderPhoneImg, senderName, `[Imagem enviada] ${text || '(sem legenda)'}`, description, 'claude-sonnet-5-vision', isGroup, isGroup ? sender : undefined);
              console.log(`🖼️ Análise enviada para ${senderName}`);
              continue;
            } else {
              console.log('⚠️ Não foi possível baixar a imagem');
            }
          } catch (imgErr: any) {
            console.error('❌ Erro ao analisar imagem:', imgErr.message);
            await sock.sendMessage(sender, { text: `⚠️ Erro ao analisar imagem: ${imgErr.message}` });
            continue;
          }
        }
      }

      if (hasAudio && !text.trim()) {
        // Audio message without caption — transcribe it
        console.log(`🎤 [${isGroup ? 'Grupo' : 'Privado'}] ${senderName} (${sender}): [Áudio recebido, transcrevendo...]`);
        try {
          const media = await downloadMedia(msg, sock);
          if (media) {
            const ext = media.mimeType.includes('ogg') ? 'ogg' : media.mimeType.includes('mp4') ? 'm4a' : 'ogg';
            const audioPath = saveAudioBuffer(media.buffer, msg.key.id || 'unknown', ext);
            const transcribed = await transcribeAudio(audioPath);
            messageToProcess = transcribed;
            isAudioMessage = true;
            console.log(`📝 Transcrição: ${transcribed.substring(0, 100)}...`);
            // Clean up temp audio file
            try { fs.unlinkSync(audioPath); } catch {}
          } else {
            console.log('⚠️ Não foi possível baixar o áudio');
            continue;
          }
        } catch (err: any) {
          console.error('❌ Erro na transcrição:', err.message);
          await sock.sendMessage(sender, { text: `⚠️ Erro ao transcrever áudio: ${err.message}` });
          continue;
        }
      } else if (!text.trim()) {
        continue;
      }

      if (!messageToProcess.trim()) continue;

      console.log(
        `📨 [${isGroup ? 'Grupo' : 'Privado'}] ${senderName} (${sender}): ${messageToProcess.substring(0, 80)}...`
      );

      // Check if bot should respond
      let shouldRespond = false;

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

        // Ja' passou pela lista de autorizados no topo do laco.
        shouldRespond = true;

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

        // ─── Pipeline control commands (admin-only) ────────────────────────
        // /painéis or /help-paineis → list available pipeline triggers (anyone can see the list)
        const lowerText = text.trim().toLowerCase();
        if (lowerText === '/painéis' || lowerText === '/paineis' || lowerText === '/help-paineis') {
          await sock.sendMessage(sender, { text: buildHelpText() });
          continue;
        }

        // /status <trigger> → show last run result for a pipeline (admin-only)
        const statusMatch = text.trim().match(/^\/status\s+(\S+)\s*$/i);
        if (statusMatch) {
          if (!isAdmin(senderJid)) {
            await sock.sendMessage(sender, { text: '🚫 Apenas administradores podem consultar o status dos painéis.' });
            continue;
          }
          const cmd = resolveCommand(statusMatch[1]);
          if (!cmd) {
            await sock.sendMessage(sender, { text: `⚠️ Comando desconhecido: \`${statusMatch[1]}\`. Digite */painéis* para ver a lista.` });
            continue;
          }
          const info = await getLastTaskResult(cmd.taskName);
          await sock.sendMessage(sender, { text: formatStatusReply(cmd, info) });
          continue;
        }

        // /<trigger> → fire the corresponding Scheduled Task (admin-only)
        if (text.trim().startsWith('/')) {
          const triggerRaw = text.trim().substring(1).split(/\s+/)[0];
          const cmd = resolveCommand(triggerRaw);
          if (cmd) {
            if (!isAdmin(senderJid)) {
              await sock.sendMessage(sender, { text: `🚫 Apenas administradores podem disparar atualizações de painel. Comando */${cmd.trigger}* negado.` });
              continue;
            }
            console.log(`⚡ [ADMIN] ${senderName} (${senderJid}) disparou: ${cmd.taskName}`);
            const result = await startScheduledTask(cmd.taskName);
            await sock.sendMessage(sender, { text: formatTriggerReply(cmd, result) });
            continue;
          }
        }

        // ─── Reminder commands (any allowed user) ─────────────────────────
        // /lembrete <texto natural> → create a reminder
        const lembreteMatch = text.trim().match(/^\/lembrete\s+([\s\S]+)$/i);
        if (lembreteMatch) {
          const userText = lembreteMatch[1].trim();
          await sock.sendMessage(sender, { text: '⏳ Interpretando seu lembrete...' });
          const row = await createReminder(senderJid, userText);
          if (row) {
            await sock.sendMessage(sender, { text: formatCreatedReply(row) });
          } else {
            await sock.sendMessage(sender, { text: '⚠️ Não consegui entender o lembrete. Tente algo como: "/lembrete amanhã às 14h ligar pro cliente" ou "/lembrete toda sexta às 17h enviar relatório".' });
          }
          continue;
        }
        // /lembretes → list my reminders
        if (/^\/lembretes?$/i.test(text.trim())) {
          const rows = listRemindersForUser(senderJid);
          await sock.sendMessage(sender, { text: formatListReply(rows) });
          continue;
        }
        // /cancelar <id> → cancel a reminder
        const cancelarMatch = text.trim().match(/^\/cancelar\s+(\d+)\s*$/i);
        if (cancelarMatch) {
          const id = parseInt(cancelarMatch[1], 10);
          const ok = cancelReminder(id, senderJid);
          if (ok) {
            await sock.sendMessage(sender, { text: `✅ Lembrete *#${id}* cancelado.` });
          } else {
            await sock.sendMessage(sender, { text: `⚠️ Lembrete *#${id}* não encontrado ou não pertence a você.` });
          }
          continue;
        }
      }

      if (!shouldRespond) continue;

      // Get AI response
      try {
        const conversationKey = isGroup ? `${sender}_${msg.key.participant}` : sender;
        const history = getConversation(conversationKey);

        // Check if this is an image generation request — handle BEFORE calling the LLM
        const imagePrompt = detectImageRequest(messageToProcess);
        if (imagePrompt) {
          try {
            console.log(`🎨 Gerando imagem para ${senderName}: "${imagePrompt}"...`);
            await sock.sendMessage(sender, { text: `🎨 Gerando imagem: "${imagePrompt}"... Aguarde alguns segundos.` }, {
              quoted: isGroup ? msg : undefined,
            });
            const enhancedImgPrompt = enhancePrompt(imagePrompt);
            const imgPath = await generateImage(enhancedImgPrompt, msg.key.id || 'unknown');
            await sock.sendMessage(sender, {
              image: fs.readFileSync(imgPath),
              caption: `🎨 ${imagePrompt}`,
              mimetype: 'image/jpeg',
            });
            try { fs.unlinkSync(imgPath); } catch {}
            console.log(`🎨 Imagem enviada para ${senderName}`);
            // Log and skip the rest of the AI flow for this message
            const senderPhoneImg = (msg.key.participant || sender).replace('@s.whatsapp.net', '');
            logMessage(senderPhoneImg, senderName, messageToProcess, `[Imagem gerada: ${imagePrompt}]`, 'pollinations', isGroup, isGroup ? sender : undefined);
            continue;
          } catch (imgErr: any) {
            console.error('❌ Erro ao gerar imagem:', imgErr.message);
            await sock.sendMessage(sender, { text: `⚠️ Erro ao gerar imagem: ${imgErr.message}` });
            continue;
          }
        }

        // Check if this is a quote request
        const isQuoteRequest = /orçamento|orcamento|budget|quote|preço|preco|quanto custa|valor de/i.test(messageToProcess);

        // Build system prompt with quote instructions if needed
        let enhancedMessage = messageToProcess;
        if (isQuoteRequest) {
          enhancedMessage = messageToProcess + '\n\n' + getQuotePromptAddition();
        }

        addToConversation(conversationKey, 'user', messageToProcess);

        const response = await chatCompletion(enhancedMessage, history);

        addToConversation(conversationKey, 'assistant', response);

        // Decide reply mode: if the incoming message was audio, reply with audio ONLY (no text).
        // Otherwise send text, and optionally also audio if auto_reply_audio is enabled.
        const autoReplyAudio = getSetting('auto_reply_audio') === 'true';
        const replyWithAudioOnly = isAudioMessage; // audio-in → audio-out only
        const replyWithAudioAlso = !isAudioMessage && autoReplyAudio && response.length < 500;

        // Send text response — SKIP when replying to audio (user wants audio-only reply)
        if (!replyWithAudioOnly) {
          await sock.sendMessage(sender, { text: response }, {
            quoted: isGroup ? msg : undefined,
          });
        }

        // Check for quote PDF generation (still send PDF even on audio replies)
        if (isQuoteRequest) {
          const quoteData = parseQuoteFromAI(response, senderName);
          if (quoteData) {
            try {
              console.log(`📄 Gerando PDF de orçamento para ${senderName}...`);
              const pdfPath = await generateQuotePdf(quoteData, msg.key.id || 'unknown');
              await sock.sendMessage(sender, {
                document: fs.readFileSync(pdfPath),
                fileName: `Orcamento_${quoteData.clientName.replace(/\s+/g, '_')}.pdf`,
                mimetype: 'application/pdf',
                caption: `📋 Orçamento gerado para ${quoteData.clientName}`,
              });
              try { fs.unlinkSync(pdfPath); } catch {}
              console.log(`📄 PDF de orçamento enviado para ${senderName}`);
            } catch (pdfErr: any) {
              console.error('❌ Erro ao gerar PDF:', pdfErr.message);
            }
          }
        }

        // Generate and send audio response (OGG/Opus for WhatsApp mobile PTT compatibility)
        // When input was audio (replyWithAudioOnly), ALWAYS reply with audio regardless of length.
        // For auto_reply_audio on text input, keep the 500-char limit to avoid long TTS generation.
        const shouldGenerateAudio = replyWithAudioOnly || (replyWithAudioAlso && response.length < 500);
        if (shouldGenerateAudio) {
          try {
            console.log(`🔊 Gerando resposta em áudio para ${senderName}...`);
            // Truncate text for TTS if too long (TTS services have limits), but still generate audio
            const textForTTS = response.length > 1000 ? response.substring(0, 997) + '...' : response;
            const ttsPath = await textToSpeech(textForTTS, msg.key.id || 'unknown');
            const isOgg = ttsPath.toLowerCase().endsWith('.ogg');
            await sock.sendMessage(sender, {
              audio: fs.readFileSync(ttsPath),
              mimetype: isOgg ? 'audio/ogg; codecs=opus' : 'audio/mpeg',
              ptt: true,
            });
            try { fs.unlinkSync(ttsPath); } catch {}
            console.log(`🔊 Áudio enviado para ${senderName} (${isOgg ? 'ogg/opus' : 'mp3'})`);
          } catch (ttsErr: any) {
            console.error('❌ Erro ao gerar áudio:', ttsErr.message);
            // Fallback: if we skipped text because it was audio-in, send text now so user isn't left without a reply
            if (replyWithAudioOnly) {
              try {
                await sock.sendMessage(sender, { text: response }, { quoted: isGroup ? msg : undefined });
              } catch {}
            }
          }
        }

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