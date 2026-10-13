import initSqlJs, { Database } from 'sql.js';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.join(__dirname, '..', 'data', 'bot.db');
const dataDir = path.dirname(DB_PATH);

let db: Database | null = null;

function saveDb() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  }
}

export async function initDb(): Promise<void> {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS allowed_users (
      phone TEXT PRIMARY KEY,
      name TEXT,
      added_at TEXT DEFAULT (datetime('now')),
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS blocked_users (
      phone TEXT PRIMARY KEY,
      name TEXT,
      added_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS message_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      sender_name TEXT,
      message TEXT,
      response TEXT,
      model_used TEXT,
      timestamp TEXT DEFAULT (datetime('now')),
      is_group INTEGER DEFAULT 0,
      group_id TEXT
    );
    CREATE TABLE IF NOT EXISTS groups (
      group_id TEXT PRIMARY KEY,
      group_name TEXT,
      require_mention INTEGER DEFAULT 1,
      enabled INTEGER DEFAULT 1,
      added_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const defaultSettings: Record<string, string> = {
    api_key: '',
    api_base_url: 'https://ghostcli.cloud/v1',
    default_model: 'claude-fable-5.1',
    system_prompt: 'Você é um assistente útil e direto. Responda em português brasileiro.',
    panel_password: 'admin123',
    respond_to_all_private: 'true',
    max_tokens: '4096',
    groq_api_key: '',
    tts_voice: 'pt-BR-AntonioNeural',
    auto_reply_audio: 'false',
    company_name: 'Manutenção Sul',
    company_phone: '',
    company_address: '',
  };

  for (const [key, value] of Object.entries(defaultSettings)) {
    const existing = db.exec(`SELECT value FROM settings WHERE key = '${key}'`);
    if (existing.length === 0 || existing[0].values.length === 0) {
      db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, value]);
    }
  }

  saveDb();
}

function getDb(): Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function getSetting(key: string): string {
  const result = getDb().exec(`SELECT value FROM settings WHERE key = ?`, [key]);
  if (result.length > 0 && result[0].values.length > 0) {
    return result[0].values[0][0] as string;
  }
  return '';
}

export function setSetting(key: string, value: string): void {
  getDb().run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
  saveDb();
}

export function getAllSettings(): Record<string, string> {
  const result = getDb().exec('SELECT key, value FROM settings');
  const settings: Record<string, string> = {};
  if (result.length > 0) {
    for (const row of result[0].values) {
      settings[row[0] as string] = row[1] as string;
    }
  }
  return settings;
}

export function isUserAllowed(phone: string): boolean {
  // Check blocked first — supports exact match and partial match for @lid vs @s.whatsapp.net
  const blocked = getDb().exec(
    'SELECT phone FROM blocked_users WHERE phone = ? OR phone LIKE ? OR ? LIKE phone',
    [phone, `%${phone}%`, `%${phone}%`]
  );
  if (blocked.length > 0 && blocked[0].values.length > 0) return false;
  // Check allowed — same flexible matching
  const allowed = getDb().exec(
    'SELECT phone FROM allowed_users WHERE phone = ? OR phone LIKE ? OR ? LIKE phone',
    [phone, `%${phone}%`, `%${phone}%`]
  );
  return allowed.length > 0 && allowed[0].values.length > 0;
}

export function isUserBlocked(phone: string): boolean {
  const result = getDb().exec(
    'SELECT phone FROM blocked_users WHERE phone = ? OR phone LIKE ? OR ? LIKE phone',
    [phone, `%${phone}%`, `%${phone}%`]
  );
  return result.length > 0 && result[0].values.length > 0;
}

export function addAllowedUser(phone: string, name?: string, isGroup: boolean = false): void {
  getDb().run('INSERT OR REPLACE INTO allowed_users (phone, name, is_group) VALUES (?, ?, ?)', [phone, name || phone, isGroup ? 1 : 0]);
  saveDb();
}

export function removeAllowedUser(phone: string): void {
  getDb().run('DELETE FROM allowed_users WHERE phone = ?', [phone]);
  saveDb();
}

export function addBlockedUser(phone: string, name?: string): void {
  getDb().run('INSERT OR REPLACE INTO blocked_users (phone, name) VALUES (?, ?)', [phone, name || phone]);
  saveDb();
}

export function removeBlockedUser(phone: string): void {
  getDb().run('DELETE FROM blocked_users WHERE phone = ?', [phone]);
  saveDb();
}

export function getAllowedUsers(): { phone: string; name: string; added_at: string; is_group: number }[] {
  const result = getDb().exec('SELECT phone, name, added_at, is_group FROM allowed_users ORDER BY added_at DESC');
  if (result.length === 0) return [];
  return result[0].values.map((row: any[]) => ({
    phone: row[0] as string,
    name: row[1] as string,
    added_at: row[2] as string,
    is_group: row[3] as number,
  }));
}

export function getBlockedUsers(): { phone: string; name: string; added_at: string }[] {
  const result = getDb().exec('SELECT phone, name, added_at FROM blocked_users ORDER BY added_at DESC');
  if (result.length === 0) return [];
  return result[0].values.map((row: any[]) => ({
    phone: row[0] as string,
    name: row[1] as string,
    added_at: row[2] as string,
  }));
}

export function logMessage(sender: string, senderName: string, message: string, response: string, modelUsed: string, isGroup: boolean = false, groupId?: string): void {
  getDb().run(
    'INSERT INTO message_log (sender, sender_name, message, response, model_used, is_group, group_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [sender, senderName, message, response, modelUsed, isGroup ? 1 : 0, groupId || null]
  );
  saveDb();
}

export function getMessageLog(limit: number = 50): any[] {
  const result = getDb().exec('SELECT id, sender, sender_name, message, response, model_used, timestamp, is_group, group_id FROM message_log ORDER BY timestamp DESC LIMIT ?', [limit]);
  if (result.length === 0) return [];
  return result[0].values.map((row: any[]) => ({
    id: row[0],
    sender: row[1],
    sender_name: row[2],
    message: row[3],
    response: row[4],
    model_used: row[5],
    timestamp: row[6],
    is_group: row[7],
    group_id: row[8],
  }));
}

export function getGroupSettings(groupId: string): { group_id: string; group_name: string; require_mention: number; enabled: number } | undefined {
  const result = getDb().exec('SELECT group_id, group_name, require_mention, enabled FROM groups WHERE group_id = ?', [groupId]);
  if (result.length === 0 || result[0].values.length === 0) return undefined;
  const row = result[0].values[0];
  return {
    group_id: row[0] as string,
    group_name: row[1] as string,
    require_mention: row[2] as number,
    enabled: row[3] as number,
  };
}

export function setGroupSettings(groupId: string, groupName: string, requireMention: boolean, enabled: boolean): void {
  getDb().run('INSERT OR REPLACE INTO groups (group_id, group_name, require_mention, enabled) VALUES (?, ?, ?, ?)', [groupId, groupName, requireMention ? 1 : 0, enabled ? 1 : 0]);
  saveDb();
}

export function getAllGroups(): any[] {
  const result = getDb().exec('SELECT group_id, group_name, require_mention, enabled, added_at FROM groups ORDER BY added_at DESC');
  if (result.length === 0) return [];
  return result[0].values.map((row: any[]) => ({
    group_id: row[0],
    group_name: row[1],
    require_mention: row[2],
    enabled: row[3],
    added_at: row[4],
  }));
}

// ─── Admin users (pipeline command access control) ────────────────────────
// Only JIDs in this table may run /backlog, /risco, /preventivas, etc.
// The admin_users table is created lazily on first check so existing DBs work.
function ensureAdminTable(): void {
  getDb().run('CREATE TABLE IF NOT EXISTS admin_users (jid TEXT PRIMARY KEY, name TEXT, added_at TEXT)');
}

export function isAdmin(jid: string): boolean {
  if (!jid) return false;
  ensureAdminTable();
  // Flexible match: exact JID, or partial (handles @lid vs @s.whatsapp.net and bare numbers)
  const result = getDb().exec(
    'SELECT jid FROM admin_users WHERE jid = ? OR jid LIKE ? OR ? LIKE jid',
    [jid, `%${jid}%`, `%${jid}%`]
  );
  return result.length > 0 && result[0].values.length > 0;
}

export function addAdmin(jid: string, name?: string): void {
  ensureAdminTable();
  getDb().run('INSERT OR REPLACE INTO admin_users (jid, name, added_at) VALUES (?, ?, ?)', [jid, name || jid, new Date().toISOString()]);
  saveDb();
}

export function removeAdmin(jid: string): void {
  ensureAdminTable();
  getDb().run('DELETE FROM admin_users WHERE jid = ?', [jid]);
  saveDb();
}

export function getAllAdmins(): { jid: string; name: string; added_at: string }[] {
  ensureAdminTable();
  const result = getDb().exec('SELECT jid, name, added_at FROM admin_users ORDER BY added_at DESC');
  if (result.length === 0) return [];
  return result[0].values.map((row: any[]) => ({
    jid: row[0],
    name: row[1],
    added_at: row[2],
  }));
}

// ─── Reminders ────────────────────────────────────────────────────────────
// Table created lazily on first access so existing DBs work without migration.
export interface ReminderRow {
  id: number;
  user_jid: string;
  message: string;
  cron_expression: string;
  next_run: string;
  created_at: string;
  is_recurring: boolean;
}

function ensureRemindersTable(): void {
  getDb().run(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_jid TEXT NOT NULL,
      message TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      next_run TEXT NOT NULL,
      created_at TEXT NOT NULL,
      is_recurring INTEGER NOT NULL DEFAULT 0
    )
  `);
}

export function addReminderRow(
  userJid: string,
  message: string,
  cronExpression: string,
  nextRunISO: string,
  isRecurring: boolean
): ReminderRow {
  ensureRemindersTable();
  const createdAt = new Date().toISOString();
  getDb().run(
    'INSERT INTO reminders (user_jid, message, cron_expression, next_run, created_at, is_recurring) VALUES (?, ?, ?, ?, ?, ?)',
    [userJid, message, cronExpression, nextRunISO, createdAt, isRecurring ? 1 : 0]
  );
  saveDb();
  const lastIdResult = getDb().exec('SELECT last_insert_rowid()');
  const id = (lastIdResult[0]?.values[0]?.[0] ?? 0) as number;
  return {
    id,
    user_jid: userJid,
    message,
    cron_expression: cronExpression,
    next_run: nextRunISO,
    created_at: createdAt,
    is_recurring: isRecurring,
  };
}

export function removeReminderRow(id: number): void {
  ensureRemindersTable();
  getDb().run('DELETE FROM reminders WHERE id = ?', [id]);
  saveDb();
}

export function updateReminderNextRun(id: number, nextRunISO: string): void {
  ensureRemindersTable();
  getDb().run('UPDATE reminders SET next_run = ? WHERE id = ?', [nextRunISO, id]);
  saveDb();
}

export function listRemindersForUser(userJid: string): ReminderRow[] {
  ensureRemindersTable();
  const result = getDb().exec(
    'SELECT id, user_jid, message, cron_expression, next_run, created_at, is_recurring FROM reminders WHERE user_jid = ? ORDER BY next_run ASC',
    [userJid]
  );
  if (result.length === 0) return [];
  return result[0].values.map((row: any[]) => ({
    id: row[0],
    user_jid: row[1],
    message: row[2],
    cron_expression: row[3],
    next_run: row[4],
    created_at: row[5],
    is_recurring: row[6] === 1,
  }));
}

export function listAllReminders(): ReminderRow[] {
  ensureRemindersTable();
  const result = getDb().exec(
    'SELECT id, user_jid, message, cron_expression, next_run, created_at, is_recurring FROM reminders ORDER BY next_run ASC'
  );
  if (result.length === 0) return [];
  return result[0].values.map((row: any[]) => ({
    id: row[0],
    user_jid: row[1],
    message: row[2],
    cron_expression: row[3],
    next_run: row[4],
    created_at: row[5],
    is_recurring: row[6] === 1,
  }));
}

export function getStats(): { total_messages: number; today_messages: number; allowed_users: number; blocked_users: number } {
  const totalResult = getDb().exec('SELECT COUNT(*) FROM message_log');
  const todayResult = getDb().exec("SELECT COUNT(*) FROM message_log WHERE date(timestamp) = date('now')");
  const allowedResult = getDb().exec('SELECT COUNT(*) FROM allowed_users');
  const blockedResult = getDb().exec('SELECT COUNT(*) FROM blocked_users');

  return {
    total_messages: (totalResult.length > 0 ? totalResult[0].values[0][0] : 0) as number,
    today_messages: (todayResult.length > 0 ? todayResult[0].values[0][0] : 0) as number,
    allowed_users: (allowedResult.length > 0 ? allowedResult[0].values[0][0] : 0) as number,
    blocked_users: (blockedResult.length > 0 ? blockedResult[0].values[0][0] : 0) as number,
  };
}