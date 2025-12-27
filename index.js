import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { createClient } from '@supabase/supabase-js';

/**
 * JIGCOIN Promo Bot (safe autoposter)
 * - Registers "safe zones" (channels/groups) where the bot is granted post permission
 * - Autoposts on a schedule with strict cooldown + daily caps
 * - Logs every attempt to Supabase
 *
 * IMPORTANT: This is permission-based promotion only (no discovery, no DMs).
 */

const PROMO_BOT_TOKEN = process.env.PROMO_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAIN_BOT_USERNAME = (process.env.MAIN_BOT_USERNAME || 'jigcoinbot').replace('@', '');
const PUBLIC_PROMO_HANDLE = (process.env.PROMO_BOT_USERNAME || 'jigcoinpromobot').replace('@', '');

// Scheduler interval. You can set either:
// - PROMO_INTERVAL_MINUTES=15 (fixed)
// OR
// - PROMO_INTERVAL_MIN_MINUTES=10 and PROMO_INTERVAL_MAX_MINUTES=20 (randomized each cycle)
const PROMO_INTERVAL_MINUTES = Math.max(1, Number(process.env.PROMO_INTERVAL_MINUTES || 15));
const PROMO_INTERVAL_MIN_MINUTES = Math.max(1, Number(process.env.PROMO_INTERVAL_MIN_MINUTES || 0)) || null;
const PROMO_INTERVAL_MAX_MINUTES = Math.max(1, Number(process.env.PROMO_INTERVAL_MAX_MINUTES || 0)) || null;
const GLOBAL_MIN_GAP_SECONDS = Math.max(10, Number(process.env.GLOBAL_MIN_GAP_SECONDS || 60)); // global throttle
const DEFAULT_MIN_GAP_MINUTES = Math.max(1, Number(process.env.DEFAULT_MIN_GAP_MINUTES || 360));
const DEFAULT_DAILY_CAP = Math.max(1, Number(process.env.DEFAULT_DAILY_CAP || 3));

// Optional overrides
// PROMO_LINK_BASE can override the deep link base (defaults to https://t.me/<MAIN_BOT_USERNAME>?start=)
// Examples:
//   PROMO_LINK_BASE=https://t.me/jigcoinbot?start=
//   PROMO_LINK_BASE=tg://resolve?domain=jigcoinbot&start=
const PROMO_LINK_BASE = String(process.env.PROMO_LINK_BASE || '').trim();

// Optional: provide templates via env (used if promo_templates table is empty)
// PROMO_MESSAGE_TEMPLATES_JSON='[{"id":"t1","weight":3,"body":"... {LINK}"}, ...]'
// OR PROMO_MESSAGE_TEMPLATES='Template A ||| Template B ||| Template C'
const PROMO_MESSAGE_TEMPLATES_JSON = String(process.env.PROMO_MESSAGE_TEMPLATES_JSON || '').trim();
const PROMO_MESSAGE_TEMPLATES = String(process.env.PROMO_MESSAGE_TEMPLATES || '').trim();

const QUIET_HOURS = String(process.env.QUIET_HOURS || '').trim(); // e.g. "23-07" (UTC)
const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => Number(s))
  .filter(n => Number.isFinite(n));

if (!PROMO_BOT_TOKEN) throw new Error('Missing PROMO_BOT_TOKEN');
if (!SUPABASE_URL) throw new Error('Missing SUPABASE_URL');
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');

const bot = new Telegraf(PROMO_BOT_TOKEN);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let lastGlobalPostAt = 0;
let cycleInFlight = false;

function nowMs() { return Date.now(); }
function isoNow() { return new Date().toISOString(); }

function parseQuietHours(spec) {
  // "23-07" => start=23 end=7 (UTC)
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(spec);
  if (!m) return null;
  const start = Math.min(23, Math.max(0, Number(m[1])));
  const end = Math.min(23, Math.max(0, Number(m[2])));
  return { start, end };
}

function isQuietNowUtc() {
  const q = parseQuietHours(QUIET_HOURS);
  if (!q) return false;
  const h = new Date().getUTCHours();
  // quiet wraps midnight if start > end
  if (q.start === q.end) return false;
  if (q.start < q.end) return h >= q.start && h < q.end;
  return h >= q.start || h < q.end;
}

function pickWeighted(items, weightKey = 'weight') {
  const arr = items.map(it => ({ it, w: Math.max(1, Number(it[weightKey] ?? 1)) }));
  const total = arr.reduce((s, a) => s + a.w, 0);
  let r = Math.random() * total;
  for (const a of arr) {
    r -= a.w;
    if (r <= 0) return a.it;
  }
  return arr.length ? arr[arr.length - 1].it : null;
}

function buildDeepLink({ zoneId, templateId }) {
  // Telegram /start payload should be <= 64 chars; keep it short.
  const t = String(templateId || 't').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 10) || 't';
  const ts = nowMs().toString(36).slice(-6);
  const payload = `p${zoneId}t${t}_${ts}`.slice(0, 64);
  const base = PROMO_LINK_BASE || `https://t.me/${MAIN_BOT_USERNAME}?start=`;
  return `${base}${payload}`;
}

function renderTemplate(body, deepLink) {
  // simple placeholder replacement
  return String(body)
    .replaceAll('{LINK}', deepLink)
    .replaceAll('{MAIN_BOT}', `@${MAIN_BOT_USERNAME}`)
    .replaceAll('{PROMO_BOT}', `@${PUBLIC_PROMO_HANDLE}`);
}

async function fetchEnabledTemplates() {
  const { data, error } = await supabase
    .from('promo_templates')
    .select('id, body, weight, is_enabled')
    .eq('is_enabled', true);

  if (error) throw error;

  if (data && data.length) return data;

  // Env-provided templates (used only if table empty)
  try {
    if (PROMO_MESSAGE_TEMPLATES_JSON) {
      const parsed = JSON.parse(PROMO_MESSAGE_TEMPLATES_JSON);
      if (Array.isArray(parsed) && parsed.length) {
        return parsed.map((t, i) => ({
          id: String(t.id || `env_${i + 1}`).slice(0, 40),
          weight: Math.max(1, Number(t.weight || 1)),
          body: String(t.body || '').slice(0, 3500),
          is_enabled: true,
        })).filter(t => t.body);
      }
    }
  } catch (e) {
    console.warn('PROMO_MESSAGE_TEMPLATES_JSON invalid JSON, ignoring.');
  }

  if (PROMO_MESSAGE_TEMPLATES) {
    const chunks = PROMO_MESSAGE_TEMPLATES
      .split('|||')
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 20);
    if (chunks.length) {
      return chunks.map((body, i) => ({ id: `env_${i + 1}`, weight: 1, body, is_enabled: true }));
    }
  }

  // Hard fallback templates (used only if table + env are empty)
  return [
    { id: 'soft_1', weight: 3, body: `🚀 New Telegram tap empire just dropped.\nStart early — farm rewards daily.\n👇 Tap to join\n{LINK}` },
    { id: 'soft_2', weight: 2, body: `People are grinding this right now.\nStill early access.\n👇\n{LINK}` },
    { id: 'soft_3', weight: 1, body: `⚡️ Quick game, real rewards.\nJoin {MAIN_BOT} here:\n{LINK}` },
  ];
}

function computeNextIntervalMs() {
  if (PROMO_INTERVAL_MIN_MINUTES && PROMO_INTERVAL_MAX_MINUTES) {
    const lo = Math.min(PROMO_INTERVAL_MIN_MINUTES, PROMO_INTERVAL_MAX_MINUTES);
    const hi = Math.max(PROMO_INTERVAL_MIN_MINUTES, PROMO_INTERVAL_MAX_MINUTES);
    const mins = lo + Math.random() * (hi - lo);
    return Math.round(mins * 60 * 1000);
  }
  return PROMO_INTERVAL_MINUTES * 60 * 1000;
}

async function countTodaySuccessPosts(chatId) {
  // Count today's successful posts for this chat (UTC day)
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

async function markZoneError(zoneId, message) {
  await supabase
    .from('promo_zones')
    .update({ last_error: String(message).slice(0, 500), fail_count: supabase.rpc ? undefined : undefined })
    .eq('id', zoneId);

  // Increment fail_count separately (Supabase update doesn't support expressions cleanly without RPC)
  await supabase.rpc('increment_fail_count', { zone_id: zoneId }).catch(() => {});
}

async function ensureFailCountIncrementFunction() {
  // Creates a tiny RPC if it doesn't exist (safe). If you don't want RPCs, we can remove this and just update fail_count from code with a read-modify-write.
  const sql = `
  create or replace function public.increment_fail_count(zone_id bigint)
  returns void
  language plpgsql
  as $$
  begin
    update public.promo_zones set fail_count = coalesce(fail_count,0) + 1 where id = zone_id;
  end;
  $$;`;
  // Use SQL over RPC? Supabase JS cannot run arbitrary SQL with service key; so we skip auto-creating.
  // We'll instead do read-modify-write in code.
}

async function incrementFailCount(zoneId) {
  const { data, error } = await supabase
    .from('promo_zones')
    .select('fail_count')
    .eq('id', zoneId)
    .single();
  if (error) return;
  const next = Number(data?.fail_count || 0) + 1;
  await supabase.from('promo_zones').update({ fail_count: next }).eq('id', zoneId);
}

async function logPostAttempt({ zoneId, chatId, templateId, deepLink, status, error }) {
  await supabase.from('promo_posts').insert({
    promo_zone_id: zoneId,
    telegram_chat_id: chatId,
    template_id: templateId,
    deep_link: deepLink,
    status,
    error: error ? String(error).slice(0, 800) : null,
  });
}

async function updateZonePosted(zoneId) {
  await supabase
    .from('promo_zones')
    .update({ last_posted_at: isoNow(), last_error: null })
    .eq('id', zoneId);
}

async function fetchZonesCandidateBatch(limit = 50) {
  const { data, error } = await supabase
    .from('promo_zones')
    .select('id, telegram_chat_id, name, zone_type, auto_allowed, is_enabled, min_gap_minutes, daily_cap, last_posted_at, fail_count')
    .eq('is_enabled', true)
    .order('last_posted_at', { ascending: true, nullsFirst: true })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

function isEligibleByGap(zone) {
  const minGap = Math.max(1, Number(zone.min_gap_minutes || DEFAULT_MIN_GAP_MINUTES));
  if (!zone.last_posted_at) return true;
  const last = new Date(zone.last_posted_at).getTime();
  const minsSince = (nowMs() - last) / 60000;
  return minsSince >= minGap;
}

async function attemptOnePost() {
  if (isQuietNowUtc()) return;

  // global throttle
  if (nowMs() - lastGlobalPostAt < GLOBAL_MIN_GAP_SECONDS * 1000) return;

  const zones = await fetchZonesCandidateBatch(75);
  if (!zones.length) return;

  // choose earliest eligible zone
  let zone = zones.find(z => isEligibleByGap(z));
  if (!zone) return;

  const chatId = zone.telegram_chat_id;

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
    await bot.telegram.sendMessage(chatId, text, {
      disable_web_page_preview: false,
      reply_markup: {
        inline_keyboard: [[
          { text: '▶️ Play JIGCOIN', url: deepLink }
        ]]
      }
    });

    await logPostAttempt({
      zoneId: zone.id,
      chatId,
      templateId: tpl.id,
      deepLink,
      status: 'success',
      error: null
    });

    await updateZonePosted(zone.id);
    lastGlobalPostAt = nowMs();
    console.log(`[POSTED] zone=${zone.id} chat=${chatId} template=${tpl.id}`);

  } catch (err) {
    const msg = err?.response?.description || err?.message || String(err);
    console.error(`[FAILED] zone=${zone.id} chat=${chatId} :: ${msg}`);

    await logPostAttempt({
      zoneId: zone.id,
      chatId,
      templateId: tpl.id,
      deepLink,
      status: 'failed',
      error: msg
    });

    await supabase.from('promo_zones')
      .update({ last_error: String(msg).slice(0, 500) })
      .eq('id', zone.id);

    await incrementFailCount(zone.id);

    // If repeated failures, auto-disable (safe)
    const failCount = Number(zone.fail_count || 0) + 1;
    const AUTO_DISABLE_AFTER = Math.max(3, Number(process.env.AUTO_DISABLE_AFTER || 5));
    if (failCount >= AUTO_DISABLE_AFTER) {
      await supabase.from('promo_zones').update({ is_enabled: false }).eq('id', zone.id);
      console.log(`[AUTO-DISABLED] zone=${zone.id} after fail_count=${failCount}`);
    }
  }
}

function isAdmin(ctx) {
  const id = ctx.from?.id;
  return id && ADMIN_IDS.includes(Number(id));
}

// Register safe zones when bot gains admin + can post
bot.on('my_chat_member', async (ctx) => {
  const chat = ctx.chat;
  const update = ctx.update.my_chat_member;
  if (!chat || !update) return;

  const newStatus = update.new_chat_member.status;
  if (newStatus !== 'administrator') return;

  try {
    const me = await ctx.telegram.getMe();
    const admins = await ctx.telegram.getChatAdministrators(chat.id);
    const botAdmin = admins.find(a => a.user.id === me.id);

    if (!botAdmin || !botAdmin.can_post_messages) {
      console.log('Bot lacks post permission in', chat.id);
      return;
    }

    await supabase
      .from('promo_zones')
      .upsert({
        telegram_chat_id: chat.id,
        name: chat.title,
        zone_type: chat.type || 'owned_channel',
        auto_allowed: true,
        is_enabled: true,
        min_gap_minutes: DEFAULT_MIN_GAP_MINUTES,
        daily_cap: DEFAULT_DAILY_CAP,
        last_posted_at: null,
        last_error: null,
        fail_count: 0,
      }, { onConflict: 'telegram_chat_id' });

    console.log(`Safe zone registered: ${chat.title} (${chat.id})`);
  } catch (err) {
    console.error('Error registering zone:', err);
  }
});

// Admin commands (optional)
bot.command('status', async (ctx) => {
  const { data, error } = await supabase.from('promo_zones').select('id', { count: 'exact', head: true });
  const zonesCount = error ? 'unknown' : (data ? 'unknown' : 'ok'); // supabase-js quirk; head:true doesn't return data
  const intervalText = (PROMO_INTERVAL_MIN_MINUTES && PROMO_INTERVAL_MAX_MINUTES)
    ? `${Math.min(PROMO_INTERVAL_MIN_MINUTES, PROMO_INTERVAL_MAX_MINUTES)}–${Math.max(PROMO_INTERVAL_MIN_MINUTES, PROMO_INTERVAL_MAX_MINUTES)}m (random)`
    : `${PROMO_INTERVAL_MINUTES}m`;
  await ctx.reply(
    `✅ ${PUBLIC_PROMO_HANDLE} online\nMain bot: @${MAIN_BOT_USERNAME}\nInterval: ${intervalText}\nQuiet hours (UTC): ${QUIET_HOURS || 'off'}\nLink base: ${PROMO_LINK_BASE || '(default)'}\nAdmin IDs set: ${ADMIN_IDS.length ? 'yes' : 'no'}`
  );
});

bot.command('zones', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not allowed.');
  const { data, error } = await supabase
    .from('promo_zones')
    .select('id, telegram_chat_id, name, is_enabled, min_gap_minutes, daily_cap, last_posted_at, fail_count')
    .order('id', { ascending: false })
    .limit(20);
  if (error) return ctx.reply(`Error: ${error.message}`);
  if (!data?.length) return ctx.reply('No zones yet. Add me as admin to a channel with post permission.');
  const lines = data.map(z =>
    `#${z.id} ${z.is_enabled ? '✅' : '⛔'} cap=${z.daily_cap}/day gap=${z.min_gap_minutes}m fails=${z.fail_count}\n${z.name || '(no name)'}\nchat_id=${z.telegram_chat_id}\nlast=${z.last_posted_at || 'never'}`
  );
  await ctx.reply(lines.join('\n\n').slice(0, 3800));
});

bot.command('enable', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not allowed.');
  const parts = ctx.message.text.split(' ').map(s => s.trim()).filter(Boolean);
  const chatId = Number(parts[1]);
  if (!Number.isFinite(chatId)) return ctx.reply('Usage: /enable <telegram_chat_id>');
  const { error } = await supabase.from('promo_zones').update({ is_enabled: true }).eq('telegram_chat_id', chatId);
  if (error) return ctx.reply(`Error: ${error.message}`);
  await ctx.reply('Enabled.');
});

bot.command('disable', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not allowed.');
  const parts = ctx.message.text.split(' ').map(s => s.trim()).filter(Boolean);
  const chatId = Number(parts[1]);
  if (!Number.isFinite(chatId)) return ctx.reply('Usage: /disable <telegram_chat_id>');
  const { error } = await supabase.from('promo_zones').update({ is_enabled: false }).eq('telegram_chat_id', chatId);
  if (error) return ctx.reply(`Error: ${error.message}`);
  await ctx.reply('Disabled.');
});

bot.command('postnow', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not allowed.');
  await ctx.reply('Attempting one safe post cycle…');
  try {
    await attemptOnePost();
    await ctx.reply('Done.');
  } catch (e) {
    await ctx.reply(`Error: ${e.message || e}`);
  }
});

// Scheduler
async function startScheduler() {
  console.log(`JIGCOIN Promo Bot started as @${PUBLIC_PROMO_HANDLE}`);
  console.log(`Main bot: @${MAIN_BOT_USERNAME}`);
  if (PROMO_INTERVAL_MIN_MINUTES && PROMO_INTERVAL_MAX_MINUTES) {
    console.log(`Promo interval: random ${Math.min(PROMO_INTERVAL_MIN_MINUTES, PROMO_INTERVAL_MAX_MINUTES)}–${Math.max(PROMO_INTERVAL_MIN_MINUTES, PROMO_INTERVAL_MAX_MINUTES)} minute(s)`);
  } else {
    console.log(`Promo interval: ${PROMO_INTERVAL_MINUTES} minute(s)`);
  }
  if (QUIET_HOURS) console.log(`Quiet hours (UTC): ${QUIET_HOURS}`);

  const tick = async () => {
    const delay = computeNextIntervalMs();
    setTimeout(tick, delay);

    if (cycleInFlight) return;
    cycleInFlight = true;
    try {
      await attemptOnePost();
    } catch (err) {
      console.error('[CYCLE ERROR]', err?.message || err);
    } finally {
      cycleInFlight = false;
    }
  };

  // Kick off immediately, then self-schedule.
  tick();
}

// Graceful shutdown (Render restarts)
function setupShutdown() {
  const shutdown = async (signal) => {
    console.log(`Received ${signal}. Shutting down...`);
    try { await bot.stop(signal); } catch {}
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

bot.launch();
setupShutdown();
startScheduler();
