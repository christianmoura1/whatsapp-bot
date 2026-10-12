import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { getSetting } from './db';

const TEMP_DIR = path.join(__dirname, '..', 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

export interface QuoteItem {
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface QuoteData {
  clientName: string;
  clientAddress?: string;
  clientPhone?: string;
  clientEmail?: string;
  items: QuoteItem[];
  observations?: string;
  validityDays?: number;
  paymentTerms?: string;
}

/**
 * Generate a professional PDF quote and return the file path
 */
export async function generateQuotePdf(data: QuoteData, messageId: string): Promise<string> {
  const outputPath = path.join(TEMP_DIR, `orcamento_${messageId}_${Date.now()}.pdf`);
  const companyName = getSetting('company_name') || 'Manutenção Sul';
  const companyPhone = getSetting('company_phone') || '';
  const companyAddress = getSetting('company_address') || '';

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 50, bottom: 50, left: 50, right: 50 },
    info: {
      Title: `Orçamento - ${data.clientName}`,
      Author: companyName,
      Subject: 'Orçamento de Serviços',
    },
  });

  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  // Header
  doc.fontSize(24).fillColor('#1a5276').text(companyName, { align: 'center' });
  doc.fontSize(10).fillColor('#666666').text(companyPhone ? `Tel: ${companyPhone}` : '', { align: 'center' });
  doc.text(companyAddress, { align: 'center' });
  doc.moveDown(0.5);

  // Divider
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#1a5276').lineWidth(2).stroke();
  doc.moveDown(1);

  // Title
  doc.fontSize(20).fillColor('#1a5276').text('ORÇAMENTO', { align: 'center' });
  doc.moveDown(0.5);

  // Date and quote number
  const now = new Date();
  const dateStr = now.toLocaleDateString('pt-BR');
  const quoteNumber = `ORC-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(Math.floor(Math.random() * 9000) + 1000)}`;

  doc.fontSize(10).fillColor('#333333');
  doc.text(`Número: ${quoteNumber}`, 50, doc.y);
  doc.text(`Data: ${dateStr}`, 350, doc.y - 12);
  doc.moveDown(1);

  // Client info (extracted from the conversation with the requester)
  doc.fontSize(12).fillColor('#1a5276').text('Cliente');
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#cccccc').lineWidth(1).stroke();
  doc.moveDown(0.3);
  doc.fontSize(11).fillColor('#333333').text(data.clientName);
  if (data.clientAddress) {
    doc.fontSize(10).fillColor('#555555').text(data.clientAddress);
  }
  if (data.clientPhone) {
    doc.fontSize(10).fillColor('#555555').text(`Tel: ${data.clientPhone}`);
  }
  if (data.clientEmail) {
    doc.fontSize(10).fillColor('#555555').text(`E-mail: ${data.clientEmail}`);
  }
  doc.moveDown(1);

  // Items table header
  const tableTop = doc.y;
  doc.rect(50, tableTop, 495, 25).fill('#1a5276');
  doc.fontSize(9).fillColor('#ffffff');
  doc.text('Descrição', 60, tableTop + 7);
  doc.text('Qtd', 350, tableTop + 7);
  doc.text('Valor Unit.', 400, tableTop + 7);
  doc.text('Total', 480, tableTop + 7);

  // Items
  let currentY = tableTop + 25;
  let subtotal = 0;

  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i];
    const lineTotal = item.quantity * item.unitPrice;
    subtotal += lineTotal;

    // Alternate row color
    if (i % 2 === 0) {
      doc.rect(50, currentY, 495, 25).fill('#f5f5f5');
    }

    doc.fontSize(9).fillColor('#333333');
    // Truncate description if too long
    const desc = item.description.length > 45 ? item.description.substring(0, 42) + '...' : item.description;
    doc.text(desc, 60, currentY + 7);
    doc.text(String(item.quantity), 355, currentY + 7);
    doc.text(`R$ ${item.unitPrice.toFixed(2).replace('.', ',')}`, 400, currentY + 7);
    doc.text(`R$ ${lineTotal.toFixed(2).replace('.', ',')}`, 480, currentY + 7);

    currentY += 25;
  }

  // Totals
  doc.moveDown(0.5);
  doc.moveTo(350, doc.y).lineTo(545, doc.y).strokeColor('#1a5276').lineWidth(1).stroke();
  doc.moveDown(0.3);

  doc.fontSize(11).fillColor('#333333');
  doc.text('Subtotal:', 350, doc.y);
  doc.text(`R$ ${subtotal.toFixed(2).replace('.', ',')}`, 480, doc.y - 12);
  doc.moveDown(0.5);

  doc.fontSize(14).fillColor('#1a5276').font('Helvetica-Bold');
  doc.text('TOTAL:', 350, doc.y);
  doc.text(`R$ ${subtotal.toFixed(2).replace('.', ',')}`, 480, doc.y - 16);
  doc.font('Helvetica');
  doc.moveDown(1.5);

  // Payment terms
  if (data.paymentTerms) {
    doc.fontSize(10).fillColor('#1a5276').text('Condições de Pagamento');
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#cccccc').lineWidth(1).stroke();
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor('#333333').text(data.paymentTerms);
    doc.moveDown(0.8);
  }

  // Validity
  const validityDays = data.validityDays || 15;
  doc.fontSize(10).fillColor('#1a5276').text('Validade');
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#cccccc').lineWidth(1).stroke();
  doc.moveDown(0.3);
  doc.fontSize(9).fillColor('#333333').text(`Este orçamento é válido por ${validityDays} dias a partir da data de emissão.`);
  doc.moveDown(0.8);

  // Observations
  if (data.observations) {
    doc.fontSize(10).fillColor('#1a5276').text('Observações');
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#cccccc').lineWidth(1).stroke();
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor('#333333').text(data.observations);
    doc.moveDown(0.8);
  }

  // Footer
  doc.moveTo(50, 750).lineTo(545, 750).strokeColor('#1a5276').lineWidth(2).stroke();
  doc.fontSize(8).fillColor('#999999').text(
    `${companyName} — Orçamento gerado automaticamente — ${dateStr}`,
    50, 755, { align: 'center' }
  );

  doc.end();

  // Wait for file to be written
  await new Promise<void>((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return outputPath;
}

/**
 * Parse a natural language quote request into structured QuoteData
 * Uses simple pattern matching — the AI will structure the data
 */
export function parseQuoteFromAI(aiResponse: string, clientName: string): QuoteData | null {
  try {
    // Try to extract JSON from the AI response
    const jsonMatch = aiResponse.match(/```json\s*([\s\S]*?)\s*```/) || aiResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const jsonStr = jsonMatch[1] || jsonMatch[0];
    const parsed = JSON.parse(jsonStr);

    if (!parsed.items || !Array.isArray(parsed.items) || parsed.items.length === 0) {
      return null;
    }

    return {
      clientName: parsed.clientName || clientName,
      clientAddress: parsed.clientAddress || parsed.address || undefined,
      clientPhone: parsed.clientPhone || parsed.phone || undefined,
      clientEmail: parsed.clientEmail || parsed.email || undefined,
      items: parsed.items.map((item: any) => ({
        description: item.description || item.desc || 'Item',
        quantity: Number(item.quantity || item.qty || 1),
        unitPrice: Number(item.unitPrice || item.price || item.valor || 0),
      })),
      observations: parsed.observations || parsed.obs || undefined,
      validityDays: Number(parsed.validityDays || 15),
      paymentTerms: parsed.paymentTerms || parsed.payment || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Build the system prompt addition for quote generation
 */
export function getQuotePromptAddition(): string {
  return `
Quando o usuário pedir um orçamento, EXTRAIA os dados do cliente da própria conversa (nome, endereço, telefone, e-mail — o que ele informar) e crie um orçamento profissional. Responda com um JSON estruturado dentro de um bloco \`\`\`json ... \`\`\`. O JSON deve ter este formato exato:
{
  "clientName": "Nome do Cliente (extraído da conversa)",
  "clientAddress": "Endereço do cliente (se informado, senão omitir)",
  "clientPhone": "Telefone do cliente (se informado, senão omitir)",
  "clientEmail": "E-mail do cliente (se informado, senão omitir)",
  "items": [
    {"description": "Descrição do serviço/produto", "quantity": 1, "unitPrice": 150.00}
  ],
  "observations": "Observações adicionais (opcional)",
  "validityDays": 15,
  "paymentTerms": "Condições de pagamento (opcional)"
}
IMPORTANTE: Os dados do cliente (nome, endereço, telefone) devem vir do que a pessoa escreveu na conversa. Se ela não informou algo, omita o campo — não invente dados.
Depois do JSON, adicione uma mensagem amigável confirmando que o orçamento foi gerado.
Sempre inclua pelo menos um item. Use preços realistas em Reais (BRL).`;
}