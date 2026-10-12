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