import { execFile } from 'child_process';

/**
 * Pipeline command definitions.
 * Each entry maps a short trigger (used after /) to the Windows Scheduled Task name
 * that powers the corresponding painel on https://sul-blush.vercel.app.
 *
 * Source of truth: C:\Users\xdatacenter\.claude\CLAUDE.md "Pipelines (tarefas agendadas)"
 * and the live Get-ScheduledTask listing on CSMOURA1-VOUCHE.
 */
export interface PipelineCommand {
  trigger: string;          // what the user types after /
  aliases: string[];        // alternative triggers
  taskName: string;         // exact Windows Scheduled Task name
  label: string;            // human-friendly description shown in replies
  painel?: string;          // which painel this feeds (for the reply message)
}

export const PIPELINE_COMMANDS: PipelineCommand[] = [
  {
    trigger: 'risco',
    aliases: ['gestaorisco', 'gestao-risco', 'painelrisco'],
    taskName: 'Risco - Painel Diario 0600',
    label: 'Painel diário de Gestão de Risco',
    painel: 'risco.html',
  },
  {
    trigger: 'backlog',
    aliases: ['chamados', 'chamado'],
    taskName: 'Chamados - Diario 0715',
    label: 'Backlog diário de chamados',
    painel: 'index.html',
  },
  {
    trigger: 'perda',
    aliases: ['perdareceita', 'perda-receita', 'receita'],
    taskName: 'PerdaReceita - Diario 0730',
    label: 'Painel diário de Perda de Receita',
  },
  {
    trigger: 'preventivas',
    aliases: ['preventiva', 'prev'],
    taskName: 'Preventivas - Diario 0745',
    label: 'Painel diário de Preventivas',
    painel: 'preventivas.html',
  },
  {
    trigger: 'campo',
    aliases: ['campocritico', 'criticos', 'chamadoscriticos'],
    taskName: 'Campo - Chamados Criticos 20min',
    label: 'Chamados críticos de Campo (WhatsApp)',
  },
  {
    trigger: 'analista',
    aliases: ['analistaseguranca', 'seguranca', 'relatoriorisco'],
    taskName: 'Analista Seguranca - Risco 0750',
    label: 'Relatório de Risco no WhatsApp',
  },
  {
    trigger: 'pecas',
    aliases: ['peca'],
    taskName: 'Pecas - Diario 0100',
    label: 'Painel diário de Peças',
  },
  {
    trigger: 'sorvete',
    aliases: ['fotosorvete'],
    taskName: 'Sorvete - Foto Diaria 2359',
    label: 'Foto diária da Máquina de Sorvete',
  },
  {
    trigger: 'vigia',
    aliases: ['pedidos', 'vigiapedidos'],
    taskName: 'Claude - Vigia de Pedidos',
    label: 'Vigia de pedidos (nuvem ↔ VPS)',
  },
];

/**
 * Resolve a user-typed trigger (without the leading /) to a pipeline command.
 * Case-insensitive, ignores accents/dashes/spaces for fuzzy matching.
 */
export function resolveCommand(raw: string): PipelineCommand | null {
  const norm = (s: string) =>
    s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s\-_]/g, '');
  const needle = norm(raw);
  if (!needle) return null;
  for (const cmd of PIPELINE_COMMANDS) {
    if (norm(cmd.trigger) === needle) return cmd;
    if (cmd.aliases.some(a => norm(a) === needle)) return cmd;
  }
  return null;
}

/**
 * Trigger a Windows Scheduled Task by exact name using PowerShell's Start-ScheduledTask.
 * Returns a promise that resolves with { ok, stdout, stderr, code }.
 *
 * IMPORTANT per CLAUDE.md: tasks are launched via Start-ScheduledTask and verified
 * afterwards in a separate read — never assume success from the launch call alone.
 * LastTaskResult == 0 means success; anything else needs a log lookup.
 */
export function startScheduledTask(taskName: string): Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}> {
  return new Promise((resolve) => {
    // Escape single quotes in the task name for PowerShell safety
    const safeName = taskName.replace(/'/g, "''");
    const psScript = `Start-ScheduledTask -TaskName '${safeName}'`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { windowsHide: true, timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as any).code === 'ETIMEDOUT' ? -1 : ((err as any).status ?? 1);
          resolve({ ok: false, stdout: stdout || '', stderr: stderr || err.message, code });
          return;
        }
        resolve({ ok: true, stdout: stdout || '', stderr: stderr || '', code: 0 });
      }
    );
  });
}

/**
 * Read the LastTaskResult of a scheduled task to verify whether the last run succeeded.
 * Per CLAUDE.md: 0 = success, anything else = look at logs in C:\projetos\chamados\logs\.
 *
 * NOTE: for server-type tasks (e.g. "Risco Atribuicoes - Servidor") the result is
 * 0x800710E0 (2147946720) which means "operation in progress" — that is NORMAL for a
 * persistent server, not a failure. We surface it as a warning, not an error.
 */
export function getLastTaskResult(taskName: string): Promise<{
  found: boolean;
  lastResult: number | null;
  lastRunTime: string | null;
  state: string | null;
  raw: string;
}> {
  return new Promise((resolve) => {
    const safeName = taskName.replace(/'/g, "''");
    const psScript =
      `$t = Get-ScheduledTask -TaskName '${safeName}' -ErrorAction SilentlyContinue; ` +
      `if ($t) { ` +
      `  $i = $t | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue; ` +
      `  [PSCustomObject]@{ ` +
      `    Found=$true; ` +
      `    LastResult=$i.LastTaskResult; ` +
      `    LastRunTime=if($i.LastRunTime){$i.LastRunTime.ToString('yyyy-MM-dd HH:mm:ss')}else{''}; ` +
      `    State=$t.State ` +
      `  } | ConvertTo-Json -Compress ` +
      `} else { ` +
      `  [PSCustomObject]@{ Found=$false } | ConvertTo-Json -Compress ` +
      `}`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { windowsHide: true, timeout: 15000 },
      (err, stdout, stderr) => {
        const raw = (stdout || '') + (stderr || '');
        if (err || !stdout) {
          resolve({ found: false, lastResult: null, lastRunTime: null, state: null, raw });
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve({
            found: !!parsed.Found,
            lastResult: parsed.LastResult ?? null,
            lastRunTime: parsed.LastRunTime || null,
            state: parsed.State || null,
            raw,
          });
        } catch {
          resolve({ found: false, lastResult: null, lastRunTime: null, state: null, raw });
        }
      }
    );
  });
}

/**
 * Build the help text listing all available pipeline commands.
 */
export function buildHelpText(): string {
  const lines = ['🤖 *Comandos de Painel*', ''];
  for (const cmd of PIPELINE_COMMANDS) {
    lines.push(`• */${cmd.trigger}* — ${cmd.label}`);
  }
  lines.push('');
  lines.push('*/painéis* ou */help-paineis* — esta lista');
  lines.push('*/status <comando>* — ver resultado da última execução');
  lines.push('');
  lines.push('Exemplo: digite */backlog* para atualizar o backlog agora.');
  return lines.join('\n');
}

/**
 * Format a friendly reply after triggering a task.
 */
export function formatTriggerReply(cmd: PipelineCommand, result: { ok: boolean; stderr: string }): string {
  if (!result.ok) {
    const tail = result.stderr.trim().split('\n').slice(-3).join('\n');
    return `⚠️ Não consegui disparar *${cmd.label}*.\n\nDetalhe:\n\`\`\`\n${tail || 'erro desconhecido'}\n\`\`\`\n\nVerifique se a tarefa "${cmd.taskName}" existe na VPS.`;
  }
  const painelLine = cmd.painel ? `\n📊 Painel: https://sul-blush.vercel.app/${cmd.painel}` : '';
  return (
    `✅ *${cmd.label}* disparado!\n\n` +
    `Tarefa: \`${cmd.taskName}\`\n` +
    `A atualização roda em segundo plano na VPS. Em instantes o painel reflete os novos dados.${painelLine}\n\n` +
    `Para conferir se terminou com sucesso, digite */status ${cmd.trigger}*.`
  );
}

/**
 * Format a friendly reply for /status <trigger>.
 */
export function formatStatusReply(
  cmd: PipelineCommand,
  info: { found: boolean; lastResult: number | null; lastRunTime: string | null; state: string | null }
): string {
  if (!info.found) {
    return `⚠️ Tarefa *${cmd.taskName}* não encontrada na VPS.`;
  }
  // 0x800710E0 = 2147946720 → "operation in progress" (normal for server-type tasks)
  const IN_PROGRESS = 2147946720;
  let emoji = '❓';
  let verdict = `código ${info.lastResult}`;
  if (info.lastResult === 0) {
    emoji = '✅';
    verdict = 'sucesso (LastTaskResult = 0)';
  } else if (info.lastResult === IN_PROGRESS) {
    emoji = '🔄';
    verdict = 'em andamento (servidor persistente — normal, não é erro)';
  } else if (info.lastResult !== null && info.lastResult > 0) {
    emoji = '⚠️';
    verdict = `possível falha (LastTaskResult = ${info.lastResult}) — veja logs em C:\\projetos\\chamados\\logs\\`;
  }
  const when = info.lastRunTime ? `\n🕒 Última execução: ${info.lastRunTime}` : '\n🕒 Nunca executou (ou sem registro)';
  const state = info.state ? `\n📌 Estado atual: ${info.state}` : '';
  return `${emoji} *${cmd.label}*\n${verdict}${when}${state}`;
}