import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';

const TEMP_DIR = path.join(__dirname, '..', 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Download a URL to a local file, following up to 5 redirects.
 */
function downloadToFile(url: string, destPath: string, redirectsLeft: number = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    if (redirectsLeft <= 0) {
      reject(new Error('Too many redirects'));
      return;
    }
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadToFile(res.headers.location, destPath, redirectsLeft - 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} from image endpoint`));
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
    req.setTimeout(60000, () => {
      req.destroy(new Error('Image generation request timeout (60s)'));
    });
  });
}

/**
 * Generate an image from a text prompt using Pollinations.ai (free, no API key).
 * Returns the path to the generated JPEG file.
 */
export async function generateImage(prompt: string, messageId: string): Promise<string> {
  const outputPath = path.join(TEMP_DIR, `img_${messageId}_${Date.now()}.jpg`);
  // Encode the prompt for URL
  const encodedPrompt = encodeURIComponent(prompt);
  // Use Pollinations.ai — free, no key, returns JPEG directly
  // Parameters: width, height, nologo (remove watermark), seed (random for variety)
  const seed = Math.floor(Math.random() * 1000000);
  const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=768&height=768&nologo=true&seed=${seed}`;

  await downloadToFile(url, outputPath);

  // Verify the file was created and has content
  if (!fs.existsSync(outputPath)) {
    throw new Error('Image file was not created');
  }
  const stat = fs.statSync(outputPath);
  if (stat.size < 1000) {
    try { fs.unlinkSync(outputPath); } catch {}
    throw new Error('Generated image is too small (likely an error response)');
  }

  return outputPath;
}

/**
 * Detect if a message is requesting image generation.
 * Returns the extracted prompt or null if not an image request.
 */
export function detectImageRequest(text: string): string | null {
  const lowerText = text.toLowerCase();

  // Patterns that indicate an image generation request
  const imagePatterns = [
    /cria?\s+(uma\s+)?imagem?\s+(de\s+|com\s+|do\s+|da\s+)(.+)/i,
    /gere?\s+(uma\s+)?imagem?\s+(de\s+|com\s+|do\s+|da\s+)(.+)/i,
    /desenha?\s+(.+?)(?:\s+por\s+favor|\s*$)/i,
    /faz\s+(uma\s+)?foto\s+(de\s+|com\s+|do\s+|da\s+)(.+)/i,
    /gera?\s+(uma\s+)?foto\s+(de\s+|com\s+|do\s+|da\s+)(.+)/i,
    /cria?\s+(uma\s+)?foto\s+(de\s+|com\s+|do\s+|da\s+)(.+)/i,
    /me\s+(mostra|manda|envia)\s+(uma\s+)?(imagem|foto|picture)\s+(de\s+|com\s+|do\s+|da\s+)(.+)/i,
    /generate\s+(an?\s+)?image\s+(of\s+|with\s+)(.+)/i,
    /draw\s+(.+?)(?:\s+please|\s*$)/i,
    /create\s+(an?\s+)?(image|picture|photo)\s+(of\s+|with\s+)(.+)/i,
    /make\s+(an?\s+)?(image|picture|photo)\s+(of\s+|with\s+)(.+)/i,
  ];

  for (const pattern of imagePatterns) {
    const match = text.match(pattern);
    if (match) {
      // Extract the descriptive part (usually the last capture group)
      const prompt = match[match.length - 1]?.trim();
      if (prompt && prompt.length > 2) {
        return prompt;
      }
    }
  }

  // Also check for simple keyword triggers
  if (lowerText.includes('criar imagem') || lowerText.includes('gerar imagem') ||
      lowerText.includes('cria imagem') || lowerText.includes('gera imagem') ||
      lowerText.includes('criar foto') || lowerText.includes('gerar foto')) {
    // Try to extract everything after the trigger phrase
    const afterTrigger = text.replace(/.*?(criar?|gerar?|desenhar?|faz(er)?\s+uma)\s+(imagem?|foto)\s+(de\s+|com\s+|do\s+|da\s+)?/i, '').trim();
    if (afterTrigger.length > 2) {
      return afterTrigger;
    }
  }

  return null;
}

/**
 * Enhance a prompt for better image generation results.
 * Adds quality modifiers and style hints.
 */
export function enhancePrompt(prompt: string): string {
  // Don't enhance if the prompt already has quality modifiers
  if (prompt.toLowerCase().includes('high quality') || prompt.toLowerCase().includes('alta qualidade')) {
    return prompt;
  }
  return `${prompt}, high quality, detailed, professional photography`;
}