import Groq from 'groq-sdk';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getSetting } from './db';

const TEMP_DIR = path.join(__dirname, '..', 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

let groqClient: Groq | null = null;
let lastGroqKey = '';

function getGroqClient(): Groq {
  const apiKey = getSetting('groq_api_key');
  if (!apiKey) {
    throw new Error('Groq API Key não configurada. Adicione no painel de administração.');
  }
  if (!groqClient || lastGroqKey !== apiKey) {
    groqClient = new Groq({ apiKey });
    lastGroqKey = apiKey;
  }
  return groqClient;
}

/**
 * Transcribe audio file using Groq Whisper
 */
export async function transcribeAudio(audioFilePath: string): Promise<string> {
  const client = getGroqClient();
  const transcription = await client.audio.transcriptions.create({
    file: fs.createReadStream(audioFilePath),
    model: 'whisper-large-v3',
    language: 'pt',
    response_format: 'text',
  });
  return typeof transcription === 'string' ? transcription : (transcription as any).text || String(transcription);
}

/**
 * Generate speech using Microsoft Edge TTS via WebSocket (free, neural voices, no API key)
 * Implements the Edge TTS protocol directly — no external dependencies needed.
 */
export async function textToSpeech(text: string, messageId: string): Promise<string> {
  const voice = getSetting('tts_voice') || 'pt-BR-AntonioNeural';
  const outputPath = path.join(TEMP_DIR, `tts_${messageId}_${Date.now()}.mp3`);

  // Truncate very long texts to avoid TTS timeouts
  const safeText = text.length > 500 ? text.substring(0, 497) + '...' : text;
  const escapedText = safeText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  const requestId = crypto.randomUUID().replace(/-/g, '');
  const date = new Date().toString();

  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="pt-BR"><voice name="${voice}"><prosody rate="+0%" pitch="+0Hz">${escapedText}</prosody></voice></speak>`;

  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('Edge TTS timeout after 20s'));
    }, 20000);

    let ws: any;
    try {
      // Use the built-in WebSocket available in Node 22+ or fall back to a manual implementation
      const WebSocketImpl = (globalThis as any).WebSocket || require('ws');
      ws = new WebSocketImpl(
        'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=' + requestId,
        { headers: { 'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold' } }
      );
    } catch (err: any) {
      clearTimeout(timeout);
      // Fallback: try dynamic import of 'ws'
      import('ws').then((wsModule) => {
        doTTS(wsModule.default || wsModule.WebSocket, ssml, requestId, date, voice, outputPath, resolve, reject, timeout);
      }).catch(() => {
        reject(new Error('WebSocket not available for Edge TTS'));
      });
      return;
    }

    doTTS(ws.constructor === Function ? ws.constructor : (globalThis as any).WebSocket, ssml, requestId, date, voice, outputPath, resolve, reject, timeout, ws);
  });
}

function doTTS(
  WSClass: any,
  ssml: string,
  requestId: string,
  date: string,
  voice: string,
  outputPath: string,
  resolve: (value: string) => void,
  reject: (reason: any) => void,
  timeout: ReturnType<typeof setTimeout>,
  existingWs?: any
) {
  const audioChunks: Buffer[] = [];
  let ws: any;

  try {
    ws = existingWs || new WSClass(
      'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=' + requestId,
      existingWs ? undefined : { headers: { 'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold' } }
    );
  } catch (err: any) {
    clearTimeout(timeout);
    reject(new Error('Failed to create WebSocket: ' + err.message));
    return;
  }

  ws.onopen = () => {
    // Send config message
    const configMsg = `Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`;
    ws.send(configMsg);

    // Send SSML request
    const ssmlMsg = `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`;
    ws.send(ssmlMsg);
  };

  ws.onmessage = (event: any) => {
    const data = event.data;
    if (data instanceof ArrayBuffer) {
      // Binary audio data — skip the header (first 2 bytes are length of header)
      const buf = Buffer.from(data);
      if (buf.length > 2) {
        const headerLen = buf.readUInt16BE(0);
        if (buf.length > headerLen + 2) {
          audioChunks.push(buf.slice(headerLen + 2));
        }
      }
    } else if (typeof data === 'string') {
      if (data.includes('Path:turn.end')) {
        // TTS complete — write file
        clearTimeout(timeout);
        try { ws.close(); } catch {}
        const audioBuffer = Buffer.concat(audioChunks);
        if (audioBuffer.length > 0) {
          fs.writeFileSync(outputPath, audioBuffer);
          resolve(outputPath);
        } else {
          reject(new Error('Edge TTS returned empty audio'));
        }
      }
    }
  };

  ws.onerror = (err: any) => {
    clearTimeout(timeout);
    try { ws.close(); } catch {}
    reject(new Error('Edge TTS WebSocket error: ' + (err.message || 'unknown')));
  };

  ws.onclose = () => {
    clearTimeout(timeout);
    // If we have audio data, save it even on close
    if (audioChunks.length > 0 && !fs.existsSync(outputPath)) {
      const audioBuffer = Buffer.concat(audioChunks);
      if (audioBuffer.length > 0) {
        fs.writeFileSync(outputPath, audioBuffer);
        resolve(outputPath);
        return;
      }
    }
  };
}

/**
 * Download media from WhatsApp using Baileys socket
 */
export async function downloadMedia(
  msg: any,
  sock: any
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
      logger: undefined as any,
      reuploadRequest: sock.updateMediaMessage,
    });
    const mimeType =
      msg.message?.audioMessage?.mimetype ||
      'audio/ogg';
    return { buffer: Buffer.from(buffer), mimeType };
  } catch (err: any) {
    console.error('❌ Erro ao baixar mídia:', err.message);
    return null;
  }
}

/**
 * Save audio buffer to temp file for transcription
 */
export function saveAudioBuffer(buffer: Buffer, messageId: string, ext: string = 'ogg'): string {
  const filePath = path.join(TEMP_DIR, `audio_${messageId}_${Date.now()}.${ext}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

/**
 * Clean up temp files older than 1 hour
 */
export function cleanupTempFiles(): void {
  try {
    const files = fs.readdirSync(TEMP_DIR);
    const now = Date.now();
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > 3600000) {
        fs.unlinkSync(filePath);
      }
    }
  } catch (err) {
    // Ignore cleanup errors
  }
}

// Cleanup temp files every 10 minutes
setInterval(cleanupTempFiles, 600000);

export function getAvailableVoices(): string[] {
  return [
    'pt-BR-AntonioNeural',
    'pt-BR-FranciscaNeural',
    'pt-BR-BrendaNeural',
    'pt-BR-DonatoNeural',
    'pt-BR-FabioNeural',
    'pt-BR-ManuelaNeural',
    'pt-BR-NicolauNeural',
    'pt-BR-ThalitaNeural',
    'pt-BR-ValerioNeural',
    'pt-BR-YaraNeural',
  ];
}