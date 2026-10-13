import OpenAI from 'openai';
import { getSetting } from './db';

let client: OpenAI | null = null;
let lastApiKey: string = '';
let lastBaseUrl: string = '';

function getClient(): OpenAI {
  const apiKey = getSetting('api_key');
  const baseURL = getSetting('api_base_url') || 'https://ghostcli.cloud/v1';

  if (!apiKey) {
    throw new Error('API Key não configurada. Acesse o painel de administração para configurar.');
  }

  // Recreate client if settings changed
  if (!client || lastApiKey !== apiKey || lastBaseUrl !== baseURL) {
    client = new OpenAI({
      apiKey,
      baseURL,
    });
    lastApiKey = apiKey;
    lastBaseUrl = baseURL;
  }

  return client;
}

export async function chatCompletion(userMessage: string, conversationHistory: { role: string; content: string }[] = []): Promise<string> {
  const model = getSetting('default_model') || 'claude-fable-5.1';
  const systemPrompt = getSetting('system_prompt') || 'Você é um assistente útil e direto. Responda em português brasileiro.';
  const maxTokens = parseInt(getSetting('max_tokens') || '4096', 10);

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user', content: userMessage },
  ];

  const response = await getClient().chat.completions.create({
    model,
    messages,
    max_tokens: maxTokens,
  });

  return response.choices[0]?.message?.content || 'Desculpe, não consegui gerar uma resposta.';
}

export async function testConnection(): Promise<{ success: boolean; message: string; models?: string[] }> {
  try {
    const apiKey = getSetting('api_key');
    const baseURL = getSetting('api_base_url') || 'https://ghostcli.cloud/v1';

    if (!apiKey) {
      return { success: false, message: 'API Key não configurada.' };
    }

    const testClient = new OpenAI({ apiKey, baseURL });
    const models = await testClient.models.list();
    const modelIds = models.data.map(m => m.id);

    return {
      success: true,
      message: `Conexão bem-sucedida! ${modelIds.length} modelos disponíveis.`,
      models: modelIds,
    };
  } catch (error: any) {
    return {
      success: false,
      message: `Erro na conexão: ${error.message || 'Erro desconhecido'}`,
    };
  }
}

export function getAvailableModels(): string[] {
  return [
    'claude-fable-5.1',
    'claude-opus-5-5',
    'claude-sonnet-5',
    'z-ai/glm-5.3',
    'gpt-6-astra',
  ];
}

/**
 * Analyze an image using a vision-capable model (Claude Sonnet 5 via ghostcli).
 * The imageBuffer is the raw bytes of the image (JPEG/PNG) downloaded from WhatsApp.
 * Returns a text description of what's in the image (text OCR + visual description).
 */
export async function analyzeImage(imageBuffer: Buffer, mimeType: string, userQuestion?: string): Promise<string> {
  const apiKey = getSetting('api_key');
  const baseURL = getSetting('api_base_url') || 'https://ghostcli.cloud/v1';
  if (!apiKey) {
    throw new Error('API Key não configurada.');
  }

  // Convert image to base64 data URL
  const base64Image = imageBuffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64Image}`;

  const defaultPrompt = 'Analise esta imagem em detalhe. Se houver texto escrito, transcreva tudo exatamente como aparece. Descreva também o que está sendo exibido visualmente (objetos, pessoas, cenário, cores, etc.). Responda em português brasileiro.';
  const prompt = userQuestion || defaultPrompt;

  const client = new OpenAI({ apiKey, baseURL });

  const response = await client.chat.completions.create({
    model: 'claude-sonnet-5',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: { url: dataUrl },
          },
        ],
      },
    ],
    max_tokens: 2048,
  });

  return response.choices[0]?.message?.content || 'Não consegui analisar a imagem.';
}