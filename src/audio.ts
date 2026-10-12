import Groq from 'groq-sdk';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { execFile } from 'child_process';
import { getSetting } from './db';

// Locate ffmpeg binary (bundled in tools/ or system PATH)
function getFfmpegPath(): string {
  const bundled = path.join(__dirname, '..', 'tools', 'ffmpeg-9.0.2-essentials_build', 'bin', 'ffmpeg.exe');
  if (fs.existsSync(bundled)) return bundled;
  return 'ffmpeg'; // fall back to system PATH
}

/**
 * Convert an MP3 file to OGG/Opus (WhatsApp-compatible PTT format) using ffmpeg.
 * Returns the path to the generated .ogg file.
 */
export async function convertMp3ToOgg(mp3Path: string): Promise<string> {
  const oggPath = mp3Path.replace(/\.mp3$/i, '.ogg');
  const ffmpeg = getFfmpegPath();
  return new Promise<string>((resolve, reject) => {
    execFile(ffmpeg, [
      '-y', '-i', mp3Path,
      '-c:a', 'libopus', '-b:a', '64k', '-vbr', 'on',
      '-application', 'voip', '-ac', '1', '-ar', '48000',
      oggPath,
    ], { windowsHide: true, timeout: 30000 }, (err) => {
      if (err) {
        reject(new Error('ffmpeg conversion failed: ' + err.message));
        return;
      }
      if (!fs.existsSync(oggPath)) {
        reject(new Error('ffmpeg produced no output file'));
        return;
      }
      resolve(oggPath);
    });
  });
}

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
 * Download a URL to a local file using Node's built-in https/http modules.
 * Follows up to 5 redirects. Returns the final file path.
 */
function downloadToFile(url: string, destPath: string, redirectsLeft: number = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    if (redirectsLeft <= 0) {
      reject(new Error('Too many redirects'));
      return;
    }
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
      // Handle redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadToFile(res.headers.location, destPath, redirectsLeft - 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} from TTS endpoint`));
        return;
      }
      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close(() => resolve(destPath));
      });
      fileStream.on('error', (err) => {
        try { fs.unlinkSync(destPath); } catch {}
        reject(err);
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('TTS request timeout'));
    });
  });
}

/**
 * Split text into chunks of maxLen characters, breaking at sentence boundaries when possible.
 */
function splitTextIntoChunks(text: string, maxLen: number = 180): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to break at a sentence boundary within maxLen
    let breakIdx = remaining.lastIndexOf('. ', maxLen);
    if (breakIdx < maxLen / 2) breakIdx = remaining.lastIndexOf('! ', maxLen);
    if (breakIdx < maxLen / 2) breakIdx = remaining.lastIndexOf('? ', maxLen);
    if (breakIdx < maxLen / 2) breakIdx = remaining.lastIndexOf(', ', maxLen);
    if (breakIdx < maxLen / 2) breakIdx = remaining.lastIndexOf(' ', maxLen);
    if (breakIdx <= 0) breakIdx = maxLen;
    chunks.push(remaining.substring(0, breakIdx + 1).trim());
    remaining = remaining.substring(breakIdx + 1).trim();
  }
  return chunks.filter(c => c.length > 0);
}

/**
 * Generate speech from text using Google Translate TTS (free, no API key, pt-BR voice).
 * For long texts, splits into chunks and concatenates the MP3 frames.
 * Note: MP3 concatenation works because each chunk is a standalone MP3 stream;
 * most players (including WhatsApp) handle concatenated MP3 frames fine.
 */
export async function textToSpeech(text: string, messageId: string): Promise<string> {
  const outputPath = path.join(TEMP_DIR, `tts_${messageId}_${Date.now()}.mp3`);

  // Sanitize and truncate
  const safeText = text.replace(/\s+/g, ' ').trim();
  if (!safeText) throw new Error('Empty text for TTS');

  const chunks = splitTextIntoChunks(safeText, 180);
  const buffers: Buffer[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const encoded = encodeURIComponent(chunk);
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=pt-BR&client=tw-ob`;
    const tmpFile = path.join(TEMP_DIR, `tts_chunk_${messageId}_${Date.now()}_${i}.mp3`);
    try {
      await downloadToFile(url, tmpFile);
      const buf = fs.readFileSync(tmpFile);
      if (buf.length > 0) buffers.push(buf);
      try { fs.unlinkSync(tmpFile); } catch {}
      // Small delay between requests to avoid rate limiting
      if (i < chunks.length - 1) {
        await new Promise(r => setTimeout(r, 300));
      }
    } catch (err: any) {
      try { fs.unlinkSync(tmpFile); } catch {}
      console.error(`⚠️ TTS chunk ${i} failed: ${err.message}`);
      // Continue with other chunks rather than failing entirely
    }
  }

  if (buffers.length === 0) {
    throw new Error('All TTS chunks failed');
  }

  fs.writeFileSync(outputPath, Buffer.concat(buffers));
  // Convert MP3 to OGG/Opus for WhatsApp mobile compatibility (PTT format)
  try {
    const oggPath = await convertMp3ToOgg(outputPath);
    try { fs.unlinkSync(outputPath); } catch {}
    return oggPath;
  } catch (err: any) {
    console.error(`⚠️ OGG conversion failed, using MP3 fallback: ${err.message}`);
    return outputPath;
  }
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
  // Google Translate TTS only has one pt-BR voice; we keep the list for UI compatibility
  // but they all map to the same Google voice.
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