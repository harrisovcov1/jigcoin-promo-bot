import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { createClient } from '@supabase/supabase-js';

/**
 * JIGCOIN Promo Bot (safe autoposter)
 * - Registers "safe zones" (channels/groups) where the bot is granted post permission
 * - Autoposts on a schedule with strict cooldown + daily caps
 * - Logs every attempt to Supabase
 *
 * IMPORTANT: Permission-based promotion only (no discovery, no DMs).
 */

const PROMO_BOT_TOKEN = process.env.PROMO_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAIN_BOT_USERNAME = (process.env.MAIN_BOT_USERNAME || process.env.MAIN_BOT || 'jigcoinbot')
  .replace('@', '')
  .trim();

// Supports either:
// - PROMO_INTERVAL_MINUTES=15 (fixed)
// OR
// - PROMO_INTERVAL_MIN_MINUTES=10 and PROMO_INTERVAL_MAX_MINUTES=20 (randomized each cycle)
const PROMO_INTERVAL_MINUTES = Math.max(1, Number(process.env.PROMO_INTERVAL_MINUTES || 15));
const PROMO_INTERVAL_MIN_MINUTES = Math.max(1, Number(process.env.PROMO_INTERVAL_MIN_MINUTES || 0)) || null;
const PROMO_INTERVAL_MAX_MINUTES = Math.max(1, Number(process.env.PROMO_INTERVAL_MAX_MINUTES || 0)) || null;

const GLOBAL_MIN_GAP_SECONDS = Math.max(10, Number(process.env.GLOBAL_MIN_GAP_SECONDS || 60));
const DEFAULT_MIN_GAP_MINUTES = Math.max(1, Number(process.env.DEFAULT_MIN_GAP_MINUTES || 360));
const DEFAULT_DAILY_CAP = Math.max(1, Number(process.env.DEFAULT_DAILY_CAP || 3));

const QUIET_HOURS = String(process.env.QUIET_HOURS || '').trim(); // e.g. "23-07" (UTC)
const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => Number(s))
  .filter(n => Number.isFinite(n));

const PROMO_LINK_BASE = String(process.env.PROMO_LINK_BASE || '').trim(); // optional override
const PROMO_MESSAGE_TEMPLATES = String(process.env.PROMO_MESSAGE_TEMPLATES || '').trim(); // "a|||b|||c"
const PROMO_MESSAGE_TEMPLATES_JSON = String(process.env.PROMO_MESSAGE_TEMPLATES_JSON || '').trim(); // JSON list

if (!PROMO_BOT_TOKEN) throw new Error('Missing PROMO_BOT_TOKEN');
if (!SUPABASE_URL) throw new Error('Missing SUPABASE_URL');
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');

const bot = new Telegraf(PROMO_BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

let lastGlobalPostAt = 0;

// --- scheduler state ---
let cycleTimer = null;
let shuttingDown = false;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function isoNow() {
  return new Date().toISOString();
}

function inQuietHours() {
  if (!QUIET_HOURS) return false;
  const m = QUIET_HOURS.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m) return false;
  const start = Number(m[1]);
  const end = Number(m[2]);
  const h = new Date().getUTCHours();
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  // Example: 23-07 wraps midnight
  if (start <= end) return h >= start && h < end;
  return h >= start || h < end;
}

function computeNextIntervalMs() {
  if (
    PROMO_INTERVAL_MIN_MINUTES &&
    PROMO_INTERVAL_MAX_MINUTES &&
    PROMO_INTERVAL_MAX_MINUTES >= PROMO_INTERVAL_MIN_MINUTES
  ) {
    const min = PROMO_INTERVAL_MIN_MINUTES;
    const max = PROMO_INTERVAL_MAX_MINUTES;
    const n = Math.floor(min + Math.random() * (max - min + 1));
    return n * 60 * 1000;
  }
  return PROMO_INTERVAL_MINUTES * 60 * 1000;
}

function buildDeepLink({ zoneId, templateId }) {
  const base = PROMO_LINK_BASE || `https://t.me/${MAIN_BOT_USERNAME}?start=`;
  const payload = `pz_${String(zoneId).slice(0, 8)}_t_${String(templateId).slice(0, 8)}`;
  return `${base}${encodeURIComponent(payload)}`;
}

function renderTemplate(body, link) {
  const safe = String(body || '').trim();
  return safe.replace(/\{LINK\}|\{link\}/g, link);
}

function pickWeighted(items, weightKey = 'weight') {
  const list = (items || []).filter(Boolean);
  if (!list.length) return null;
  const weights = list.map(it => Math.max(0, Number(it[weightKey] ?? 1) || 0));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return list[Math.floor(Math.random() * list.length)];
  let r = Math.random() * total;
  for (let i = 0; i < list.length; i++) {
    r -= weights[i];
    if (r <= 0) return list[i];
  }
  return list[list.length - 1];
}

async function fetchEnabledTemplates() {
  // Preferred: promo_messages (legacy/prod schema)
  {
    const { data, error } = await supabase
      .from('promo_messages')
      .select('id, content, weight, is_active')
      .eq('is_active', true);

    if (!error && data && data.length) {
      return data
        .filter(r => r && r.content)
        .map(r => ({
          id: String(r.id),
          weight: Number(r.weight || 1),
          body: String(r.content),
          is_enabled: true,
          _message_id: r.id,
        }));
    }
  }

  // Fallback: promo_templates (newer schema)
  {
    const { data, error } = await supabase.from('promo_templates').select('*');
    if (!error && data && data.length) {
      return data
        .filter(r => (r.is_enabled === undefined ? true : !!r.is_enabled))
        .map(r => {
          const body = r.body ?? r.content ?? r.text ?? r.message ?? null;
          return body
            ? {
                id: String(r.id ?? r.name ?? 'tpl'),
                weight: Number(r.weight || 1),
                body: String(body),
                is_enabled: true,
                _template_row_id: r.id ?? null,
              }
            : null;
        })
        .filter(Boolean);
    }
  }

  // Env-provided templates
  try {
    if (PROMO_MESSAGE_TEMPLATES_JSON) {
      const parsed = JSON.parse(PROMO_MESSAGE_TEMPLATES_JSON);
      if (Array.isArray(parsed) && parsed.length) {
        return parsed
          .map((t, i) => ({
            id: String(t.id || `env_json_${i + 1}`),
            weight: Number(t.weight || 1),
            body: String(t.body || t.content || ''),
            is_enabled: true,
          }))
          .filter(t => t.body);
      }
    }
  } catch {}

  try {
    const chunks = PROMO_MESSAGE_TEMPLATES
      .split('|||')
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 20);
    if (chunks.length) {
      return chunks.map((body, i) => ({ id: `env_${i + 1}`, weight: 1, body, is_enabled: true }));
    }
  } catch {}

  // Hard fallback templates
  return [
    { id: 'soft_1', weight: 3, body: `🚀 New Telegram tap empire just dropped.\nStart early — farm rewards daily.\n👇 Tap to join\n{LINK}` },
    { id: 'soft_2', weight: 2, body: `People are grinding this right now.\nStill early access.\n👇\n{LINK}` },
    { id: 'soft_3', weight: 1, body: `If you like airdrops + tap-to-earn…\nThis one is worth a look.\n{LINK}` },
  ];
}

async function fetchZones() {
  const { data, error } = await supabase
    .from('promo_zones')
    .select('*')
    .eq('is_enabled', true);

  if (error) throw error;
  return data || [];
}

async function countTodaySuccessPosts(chatId) {
  const startUtc = new Date();
  startUtc.setUTCHours(0, 0, 0, 0);
  const { count, error } = await supabase
    .from('promo_posts')
    .select('id', { count: 'exact', head: true })
    .eq('telegram_chat_id', chatId)
    .eq('status', 'success')
    .gte('created_at', startUtc.toISOString());

  if (error) throw error;
  return Number(count || 0);
}

async function updateZonePosted(zoneId) {
  await supabase.from('promo_zones').update({ last_posted_at: isoNow(), last_error: null }).eq('id', zoneId);
}

async function incrementFailCount(zoneId) {
  const { data, error } = await supabase.from('promo_zones').select('fail_count').eq('id', zoneId).single();
  if (error) return;
  const next = Number(data?.fail_count || 0) + 1;
  await supabase.from('promo_zones').update({ fail_count: next }).eq('id', zoneId);
}

async function logPostAttempt({ zoneId, chatId, templateId, messageId, deepLink, telegramMessageId, status, error }) {
  const now = isoNow();
  const payload = {
    zone_id: zoneId,
    promo_zone_id: zoneId,
    telegram_chat_id: chatId,
    zone_chat_id: chatId,
    template_id: templateId,
    message_id: messageId ?? null,
    deep_link: deepLink ?? null,
    telegram_message_id: telegramMessageId ?? null,
    status: status || 'unknown',
    error: error ? String(error).slice(0, 800) : null,
    created_at: now,
    posted_at: now,
    sent_at: now,
  };

  const { error: insErr } = await supabase.from('promo_posts').insert(payload);
  if (insErr) {
    console.error('[LOG INSERT ERROR]', insErr);
    const { error: insErr2 } = await supabase.from('promo_posts').insert({
      promo_zone_id: zoneId,
      template_id: templateId,
      status: status || 'unknown',
      error: error ? String(error).slice(0, 800) : null,
      created_at: now,
    });
    if (insErr2) console.error('[LOG INSERT ERROR 2]', insErr2);
  }
}

async function postToZone(zone) {
  if (!zone) return;

  const chatId = zone.telegram_chat_id;

  // global throttle
  const now = Date.now();
  if (now - lastGlobalPostAt < GLOBAL_MIN_GAP_SECONDS * 1000) return;

  // per-zone cooldown
  const minGap = Math.max(1, Number(zone.min_gap_minutes || DEFAULT_MIN_GAP_MINUTES));
  if (zone.last_posted_at) {
    const last = new Date(zone.last_posted_at).getTime();
    if (now - last < minGap * 60 * 1000) return;
  }

  // daily cap
  const dailyCap = Math.max(1, Number(zone.daily_cap || DEFAULT_DAILY_CAP));
  const todayCount = await countTodaySuccessPosts(chatId);
  if (todayCount >= dailyCap) return;

  const templates = await fetchEnabledTemplates();
  const tpl = pickWeighted(templates, 'weight');
  if (!tpl) return;

  const deepLink = buildDeepLink({ zoneId: zone.id, templateId: tpl.id });
  const text = renderTemplate(tpl.body, deepLink);

  try {
    const sent = await bot.telegram.sendMessage(chatId, text, {
      disable_web_page_preview: false,
      reply_markup: { inline_keyboard: [[{ text: '▶️ Play JIGCOIN', url: deepLink }]] }
    });

    await logPostAttempt({
      zoneId: zone.id,
      chatId,
      templateId: tpl.id,
      messageId: tpl._message_id ?? null,
      deepLink,
      telegramMessageId: sent?.message_id ?? null,
      status: 'success',
      error: null
    });

    await updateZonePosted(zone.id);
    lastGlobalPostAt = now;
    console.log(`[POSTED] zone=${zone.id} chat=${chatId} template=${tpl.id}`);
  } catch (err) {
    const msg = err?.response?.description || err?.message || String(err);
    console.error(`[FAILED] zone=${zone.id} chat=${chatId} :: ${msg}`);

    await logPostAttempt({
      zoneId: zone.id,
      chatId,
      templateId: tpl.id,
      messageId: tpl._message_id ?? null,
      deepLink,
      telegramMessageId: null,
      status: 'failed',
      error: msg
    });

    await supabase.from('promo_zones').update({ last_error: String(msg).slice(0, 500) }).eq('id', zone.id);
    await incrementFailCount(zone.id);

    const fail = Number(zone.fail_count || 0) + 1;
    const autoDisableAfter = Math.max(0, Number(process.env.AUTO_DISABLE_AFTER || 0));
    if (autoDisableAfter > 0 && fail >= autoDisableAfter) {
      await supabase.from('promo_zones').update({ is_enabled: false }).eq('id', zone.id);
      console.error(`[AUTO-DISABLED] zone=${zone.id} after ${fail} fails`);
    }
  }
}

async function promoCycle() {
  try {
    if (inQuietHours()) return;

    const zones = await fetchZones();
    if (!zones.length) return;

    const shuffled = zones.slice().sort(() => Math.random() - 0.5);
    for (const z of shuffled) {
      await postToZone(z);
      break; // one post max per cycle
    }
  } catch (err) {
    console.error('[CYCLE ERROR]', { message: err?.message || String(err) });
  }
}

// --- Randomized scheduler (true random each cycle) ---
function scheduleNextCycle(immediate = false) {
  if (shuttingDown) return;
  if (cycleTimer) clearTimeout(cycleTimer);

  const waitMs = immediate ? 2000 : computeNextIntervalMs();
  cycleTimer = setTimeout(async () => {
    try {
      await promoCycle();
    } finally {
      scheduleNextCycle(false);
    }
  }, waitMs);
}

function isGetUpdatesConflict(err) {
  const msg = String(err?.message || err?.response?.description || err || '');
  return msg.includes('409') && msg.toLowerCase().includes('getupdates');
}

// --- Launch with webhook cleanup + retry on 409 ---
async function launchWithRetry() {
  // Make sure webhook is not set (prevents webhook/polling conflicts)
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  } catch {}

  while (!shuttingDown) {
    try {
      // dropPendingUpdates helps reduce backlog; also reduces weirdness after redeploy
      await bot.launch({ dropPendingUpdates: true });
      return;
    } catch (err) {
      if (isGetUpdatesConflict(err)) {
        console.error('[LAUNCH RETRY] getUpdates conflict (409). Another instance is polling. Retrying in 6s...');
        await sleep(6000);
        continue;
      }
      throw err;
    }
  }
}

// Commands
bot.command('ping', ctx => ctx.reply('pong'));
bot.command('status', async ctx => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  const zones = await fetchZones().catch(() => []);
  ctx.reply(
    `Zones enabled: ${zones.length}\n` +
    `Interval: ${
      PROMO_INTERVAL_MIN_MINUTES && PROMO_INTERVAL_MAX_MINUTES
        ? `random ${PROMO_INTERVAL_MIN_MINUTES}–${PROMO_INTERVAL_MAX_MINUTES}`
        : `${PROMO_INTERVAL_MINUTES}`
    } min\n` +
    `Quiet hours: ${QUIET_HOURS || 'none'}`
  );
});

// Keep process alive + self-heal if Telegram polling throws
process.on('unhandledRejection', async (err) => {
  if (isGetUpdatesConflict(err)) {
    console.error('[POLLING CONFLICT] 409 detected at runtime. Restarting polling in 6s...');
    try { bot.stop('409_CONFLICT'); } catch {}
    await sleep(6000);
    if (!shuttingDown) {
      try { await launchWithRetry(); } catch (e) { console.error('[RELAUNCH FAILED]', e?.message || e); }
    }
    return;
  }
  console.error('[UNHANDLED REJECTION]', err);
});

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});

// Start
(async () => {
  await launchWithRetry();

  console.log(`JIGCOIN Promo Bot started as @${bot.botInfo.username}`);
  console.log(`Main bot: @${MAIN_BOT_USERNAME}`);
  console.log(
    `Promo interval: ${
      PROMO_INTERVAL_MIN_MINUTES && PROMO_INTERVAL_MAX_MINUTES
        ? `random ${PROMO_INTERVAL_MIN_MINUTES}–${PROMO_INTERVAL_MAX_MINUTES} minute(s)`
        : `${PROMO_INTERVAL_MINUTES} minute(s)`
    }`
  );
  console.log(`Quiet hours (UTC): ${QUIET_HOURS || 'none'}`);

  scheduleNextCycle(true);
})();

// Graceful shutdown (reduces overlap during deploys)
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { if (cycleTimer) clearTimeout(cycleTimer); } catch {}
  try { bot.stop(signal); } catch {}
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
