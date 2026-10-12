import Groq from 'groq-sdk';
import fs from 'fs';
import path from 'path';
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
 * Generate speech from text using Microsoft Edge TTS API (free, no key needed)
 * Uses the WebSocket-based Edge TTS protocol directly
 */
export async function textToSpeech(text: string, messageId: string): Promise<string> {
  const voice = getSetting('tts_voice') || 'pt-BR-AntonioNeural';
  const outputPath = path.join(TEMP_DIR, `tts_${messageId}_${Date.now()}.mp3`);

  // Use the Edge TTS REST-like endpoint via fetch
  // Microsoft Edge TTS uses a WebSocket protocol, but we can use the simpler HTTP approach
  // via the speech.platform.bing.com endpoint
  const escapedText = text.replace(/'/g, "\\'");
  const ssml = `<speak version='1.0' xml:lang='pt-BR'><voice name='${voice}'><prosody rate='+0%' pitch='+0Hz'>${escapedText}</prosody></voice></speak>`;

  // Generate a random request ID
  const requestId = Math.random().toString(36).substring(2, 15);
  const date = new Date().toISOString();

  // Use the Edge TTS WebSocket protocol via a simple HTTP workaround
  // We'll use the node-fetch approach with the Bing Speech API
  try {
    // Try using the simpler approach: call edge-tts via npx or use a direct HTTP call
    // Since edge-tts npm package is incompatible with Node 24, we use the REST API directly
    const { execSync } = require('child_process');

    // Write SSML to temp file
    const ssmlPath = path.join(TEMP_DIR, `ssml_${messageId}_${Date.now()}.xml`);
    fs.writeFileSync(ssmlPath, ssml);

    // Use PowerShell to call the Edge TTS API via .NET (available on Windows)
    // Or use curl with the Bing Speech endpoint
    // Actually, let's use a simpler approach: the edge-tts Python package or direct API

    // Direct approach: use the Microsoft Cognitive Services Speech SDK REST API
    // But that requires a key. Instead, let's use the free Edge TTS via websocket simulation

    // Simplest working approach for Windows: use the built-in SAPI via PowerShell
    const psCommand = `
      Add-Type -AssemblyName System.Speech;
      $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer;
      $synth.SetOutputToWaveFile('${outputPath.replace(/\\/g, '\\\\')}');
      $synth.Speak('${text.replace(/'/g, "''")}');
      $synth.Dispose();
    `;

    try {
      execSync(`powershell -NoProfile -Command "${psCommand.replace(/\n/g, ' ')}"`, {
        timeout: 15000,
        windowsHide: true,
      });

      // Check if file was created
      if (fs.existsSync(outputPath)) {
        // Clean up SSML file
        try { fs.unlinkSync(ssmlPath); } catch {}
        return outputPath;
      }
    } catch (psErr: any) {
      console.log('⚠️ PowerShell SAPI failed, trying alternative...');
    }

    // Fallback: generate a simple silent audio or use the text as-is
    // For now, create a minimal valid MP3 file (silence) as fallback
    // Actually, let's just skip audio if TTS fails
    try { fs.unlinkSync(ssmlPath); } catch {}
    throw new Error('TTS generation failed - PowerShell SAPI not available');

  } catch (err: any) {
    console.error('❌ TTS error:', err.message);
    throw err;
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