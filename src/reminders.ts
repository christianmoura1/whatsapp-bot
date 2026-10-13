import cron, { ScheduledTask } from 'node-cron';
import { chatCompletion } from './ai';
import {
  addReminderRow,
  removeReminderRow,
  listRemindersForUser,
  listAllReminders,
  updateReminderNextRun,
  ReminderRow,
} from './db';

/**
 * Callback registered by index.ts so this module can ask the bot to deliver
 * a reminder message over WhatsApp without holding a reference to the socket.
 */
let deliverFn: ((userJid: string, text: string) => Promise<void>) | null = null;

export function registerReminderDeliverer(
  fn: (userJid: string, text: string) => Promise<void>
): void {
  deliverFn = fn;
}

/** In-memory map of active cron jobs: reminderId -> ScheduledTask */
const activeJobs: Map<number, ScheduledTask> = new Map();

/**
 * Ask the LLM to turn a natural-language request like
 *   "me lembra amanhã às 14h de ligar pro cliente"
 *   "toda sexta às 17h enviar relatório"
 * into a structured { cron, message, isRecurring, nextRunISO }.
 *
 * The cron uses America/Sao_Paulo timezone (set in scheduleReminder below),
 * so the LLM should emit local-time fields.
 */
export async function parseReminderRequest(
  userText: string
): Promise<{ cron: string; message: string; isRecurring: boolean; nextRunISO: string } | null> {
  const now = new Date();
  const nowISO = now.toISOString();
  const prompt = `Você é um parser de lembretes. Converta o pedido do usuário em JSON.

Data/hora atual (UTC): ${nowISO}
Fuso do usuário: America/Sao_Paulo (UTC-3).

Regras:
1. "message": o texto curto do lembrete (o que o usuário quer ser lembrado), sem a parte de tempo.
2. "cron": expressão CRON de 5 campos (minuto hora dia mês dia_semana) em horário LOCAL (São Paulo).
   - Pontual único (ex.: "amanhã às 10", "dia 20/10 às 09h"): preencha dia e mês específicos. O sistema cancela após a primeira execução.
   - "todo dia às 07h" -> "0 7 * * *"
   - "toda segunda às 08h" -> "0 8 * * 1"  (0=domingo, 1=segunda, ..., 6=sábado)
   - "toda sexta às 17h" -> "0 17 * * 5"
   - "dia 5 de todo mês às 09h" -> "0 9 5 * *"
3. "is_recurring": true se for repetitivo (todo dia / toda semana / todo mês), false se for único.
4. "next_run": próxima data/hora de disparo em ISO 8601 UTC. Calcule com cuidado usando o fuso -03:00.

Responda APENAS com o JSON válido, sem markdown, sem comentário.

Pedido do usuário: "${userText.replace(/"/g, '\\"')}"`;

  try {
    const response = await chatCompletion(prompt, []);
    const jsonMatch = response.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.cron || !parsed.message) return null;
    if (typeof parsed.cron !== 'string' || !cron.validate(parsed.cron)) return null;

    let nextRunISO: string;
    try {
      nextRunISO = typeof parsed.next_run === 'string' ? parsed.next_run : new Date().toISOString();
      // sanity check
      const d = new Date(nextRunISO);
      if (isNaN(d.getTime())) nextRunISO = new Date(Date.now() + 60_000).toISOString();
    } catch {
      nextRunISO = new Date(Date.now() + 60_000).toISOString();
    }

    return {
      cron: parsed.cron,
      message: String(parsed.message).slice(0, 500),
      isRecurring: !!parsed.is_recurring,
      nextRunISO,
    };
  } catch (e: any) {
    console.error('❌ Erro ao parsear lembrete:', e?.message || e);
    return null;
  }
}

/**
 * Schedule a single reminder row with node-cron. When it fires:
 *  - deliver the message via the registered deliverer (WhatsApp)
 *  - if not recurring, remove from DB and stop the job
 *  - if recurring, update next_run in DB
 */
function scheduleReminder(row: ReminderRow): void {
  // Stop any existing job for this id (defensive)
  const existing = activeJobs.get(row.id);
  if (existing) {
    try { existing.stop(); } catch {}
    activeJobs.delete(row.id);
  }

  // Skip past one-shot reminders
  if (!row.is_recurring) {
    const next = new Date(row.next_run);
    if (!isNaN(next.getTime()) && next.getTime() < Date.now() - 60_000) {
      // more than 1 minute in the past — drop it
      removeReminderRow(row.id);
      return;
    }
  }

  const task = cron.schedule(
    row.cron_expression,
    async () => {
      console.log(`⏰ Lembrete #${row.id} disparado para ${row.user_jid}: ${row.message}`);
      const text = `⏰ *Lembrete:* ${row.message}`;
      try {
        if (deliverFn) {
          await deliverFn(row.user_jid, text);
        } else {
          console.warn(`⚠️ Lembrete #${row.id} disparado mas nenhum deliverer registrado.`);
        }
      } catch (err: any) {
        console.error(`❌ Falha ao entregar lembrete #${row.id}:`, err?.message || err);
      }

      if (!row.is_recurring) {
        try {
          const t = activeJobs.get(row.id);
          if (t) { t.stop(); activeJobs.delete(row.id); }
          removeReminderRow(row.id);
        } catch (e: any) {
          console.error('Erro ao remover lembrete pontual:', e?.message);
        }
      } else {
        // Advance next_run by re-parsing — approximate: now + 1 day for daily,
        // but better to just leave next_run as informational. We'll set it to
        // now + 24h as a rough display value; the cron itself drives firing.
        try {
          const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
          updateReminderNextRun(row.id, future);
        } catch {}
      }
    },
    { timezone: 'America/Sao_Paulo' }
  );

  activeJobs.set(row.id, task);
}

/**
 * Create a new reminder from natural language. Returns the saved row or null
 * if parsing failed.
 */
export async function createReminder(
  userJid: string,
  userText: string
): Promise<ReminderRow | null> {
  const parsed = await parseReminderRequest(userText);
  if (!parsed) return null;
  const row = addReminderRow(
    userJid,
    parsed.message,
    parsed.cron,
    parsed.nextRunISO,
    parsed.isRecurring
  );
  scheduleReminder(row);
  return row;
}

/** Cancel a reminder owned by the given user. Returns true if removed. */
export function cancelReminder(id: number, userJid: string): boolean {
  const all = listRemindersForUser(userJid);
  const owns = all.some(r => r.id === id);
  if (!owns) return false;
  const t = activeJobs.get(id);
  if (t) { try { t.stop(); } catch {} activeJobs.delete(id); }
  removeReminderRow(id);
  return true;
}

/** Format a friendly confirmation after creating a reminder. */
export function formatCreatedReply(row: ReminderRow): string {
  const when = new Date(row.next_run);
  const whenStr = isNaN(when.getTime())
    ? 'em breve'
    : when.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const recur = row.is_recurring ? ' Recorrente' : '📌 Único';
  return (
    `✅ Lembrete criado!
` +
    `📝 "${row.message}"
` +
    `⏰ Próximo disparo: ${whenStr}
` +
    `${recur}
` +
    `ID: *#${row.id}* — use */cancelar ${row.id}* para remover.`
  );
}

/** Format the list of reminders for a user. */
export function formatListReply(rows: ReminderRow[]): string {
  if (rows.length === 0) return '📭 Você não tem lembretes ativos.';
  const lines = ['📋 *Seus lembretes:*', ''];
  for (const r of rows) {
    const when = new Date(r.next_run);
    const whenStr = isNaN(when.getTime()) ? '?' : when.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const tag = r.is_recurring ? '🔁' : '📌';
    lines.push(`${tag} *#${r.id}* — ${r.message}`);
    lines.push(`   ⏰ ${whenStr}`);
  }
  lines.push('');
  lines.push('Use */cancelar <id>* para remover um.');
  return lines.join('\n');
}

/**
 * Load every reminder from the DB and schedule it. Call once at bot startup,
 * AFTER initDb() has run and AFTER registerReminderDeliverer() has been called.
 */
export function initScheduler(): void {
  const rows = listAllReminders();
  for (const r of rows) {
    scheduleReminder(r);
  }
  console.log(`⏰ Scheduler de lembretes inicializado com ${rows.length} item(ns).`);
}

/** Stop all scheduled jobs (used on shutdown / restart). */
export function stopScheduler(): void {
  for (const [id, t] of activeJobs) {
    try { t.stop(); } catch {}
    activeJobs.delete(id);
  }
}