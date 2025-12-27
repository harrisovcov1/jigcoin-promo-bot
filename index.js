import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { createClient } from '@supabase/supabase-js';

const bot = new Telegraf(process.env.PROMO_BOT_TOKEN);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Detect when bot is added or its permissions change
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
        zone_type: 'owned_channel',
        auto_allowed: true,
        last_posted_at: null
      }, { onConflict: 'telegram_chat_id' });

    console.log(`Safe zone registered: ${chat.title}`);

  } catch (err) {
    console.error('Error registering zone:', err);
  }
});

bot.launch();
console.log('JIGCOIN Promo Bot started');
