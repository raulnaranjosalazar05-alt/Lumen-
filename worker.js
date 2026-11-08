import { createWalletClient, http, parseUnits, createPublicClient } from 'viem';
import { bsc } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const ADMIN_ID = 6985217869;
const USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955";
const MASTER_WALLET = "0x55F366C92f3fbE564eB9262150EF6eedbD18FEd3";
const RPC_URL = "https://bsc-dataseed.bnbchain.org";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") return json({ status: "ok" });

    if (path === "/webhook" && request.method === "POST") {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (env.WEBHOOK_SECRET && secret !== env.WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });
      let update;
      try { update = await request.json(); } catch { return new Response("Bad JSON", { status: 400 }); }
      ctx.waitUntil(handleUpdate(update, env));
      return new Response("ok");
    }
    return new Response("Lumen OK", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkPayments(env));
    ctx.waitUntil(checkExpirations(env));
    ctx.waitUntil(checkMonthlyPayouts(env));
  }
};

// === PAGOS DE FANS (Con RPC) ===
async function checkPayments(env) {
  const pending = await env.DB.prepare("SELECT * FROM subscriptions WHERE status = 'pending'").all();
  if (!pending.results || pending.results.length === 0) return;

  const data = "0x70a08231" + MASTER_WALLET.slice(2).padStart(64, '0'); 
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDT_CONTRACT, data: data }, "latest"] })
  }).then(r => r.json());

  if (!res.result) return;
  const balance = parseInt(res.result, 16) / 1e18;
  
  if (balance >= pending.results.length * 1.0) {
    for (const sub of pending.results) {
      const now = new Date();
      const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await env.DB.prepare("UPDATE subscriptions SET status = 'active', started_at = ?, expires_at = ? WHERE id = ?").bind(now.toISOString(), expires, sub.id).run();

      const channelId = await env.KV.get("config:channel_id");
      const link = await createInviteLink(env, channelId, `fan_${sub.subscriber_id}_${Date.now()}`);
      const fan = await env.DB.prepare("SELECT telegram_id FROM subscribers WHERE id = ?").bind(sub.subscriber_id).first();
      if (fan && link) await sendMessage(env, fan.telegram_id, `✅ ¡Pago recibido! Aquí tienes tu enlace:\n\n${link}`);
    }
  }
}

// === EXPULSIONES ===
async function checkExpirations(env) {
  const channelId = await env.KV.get("config:channel_id");
  if (!channelId) return;
  const expired = await env.DB.prepare("SELECT s.*, u.telegram_id FROM subscriptions s JOIN subscribers u ON u.id = s.subscriber_id WHERE s.status = 'active' AND s.expires_at < datetime('now')").all();
  for (const sub of expired.results) {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/banChatMember`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: channelId, user_id: sub.telegram_id }) });
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/unbanChatMember`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: channelId, user_id: sub.telegram_id, only_if_banned: true }) });
    await env.DB.prepare("UPDATE subscriptions SET status = 'expired' WHERE id = ?").bind(sub.id).run();
    await sendMessage(env, sub.telegram_id, "⚠️ Tu suscripción ha vencido. Pulsa /start para renovar.");
  }
}

// === PAGOS AUTOMÁTICOS A CREADORAS (CON VIEM) ===
async function checkMonthlyPayouts(env) {
  const now = new Date();
  if (now.getUTCDate() !== 1 || now.getUTCHours() !== 12) return;
  const prevMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  const period = `${prevMonth.getUTCFullYear()}-${String(prevMonth.getUTCMonth() + 1).padStart(2, '0')}`;

  const earnings = await env.DB.prepare("SELECT creator_id, COUNT(*) as total_subs FROM payments WHERE period = ? GROUP BY creator_id").bind(period).all();
  if (!earnings.results || earnings.results.length === 0) return;

  const account = privateKeyToAccount(env.PRIVATE_KEY);
  const client = createWalletClient({ account, chain: bsc, transport: http(RPC_URL) });
  const publicClient = createPublicClient({ chain: bsc, transport: http(RPC_URL) });

  for (const row of earnings.results) {
    const creator = await env.DB.prepare("SELECT * FROM creators WHERE id = ?").bind(row.creator_id).first();
    if (!creator || !creator.wallet_address) continue;

    const commission = (row.total_subs * 1.0) * 0.50; // 50%
    const amountInWei = parseUnits(commission.toFixed(2), 18);

    try {
      const { request } = await publicClient.simulateContract({
        address: USDT_CONTRACT,
        abi: [{ name: 'transfer', type: 'function', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }] }],
        functionName: 'transfer',
        args: [creator.wallet_address, amountInWei],
        account,
      });
      const hash = await client.writeContract(request);
      await sendMessage(env, creator.telegram_id, `💰 ¡Pago recibido! Se han enviado **${commission.toFixed(2)} USDT** a tu wallet.\nHash: \`${hash}\``);
    } catch (e) {
      await sendMessage(env, ADMIN_ID, `❌ Error pagando a ${creator.display_name}: ${e.message}`);
    }
  }
}

// === LÓGICA DEL BOT ===
async function handleUpdate(update, env) {
  if (update.callback_query) return await handleCallback(update.callback_query, env);
  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id, telegramId = msg.from.id;

  const uploadState = await env.KV.get(`upload_state:${telegramId}`);
  if (uploadState === "waiting") {
    if (msg.text === "/cancelar") { await env.KV.delete(`upload_state:${telegramId}`); return await sendMessage(env, chatId, "❌ Cancelado."); }
    if (msg.photo || msg.video) { await env.KV.delete(`upload_state:${telegramId}`); return await handleCreatorUpload(env, chatId, telegramId, msg); }
    return await sendMessage(env, chatId, "⚠️ Envía foto/video o /cancelar.");
  }

  if (!msg.text) return;
  const text = msg.text.trim();
  const startMatch = text.match(/^\/start(?:\s+(.+))?$/);
  if (startMatch) return await handleStart(env, chatId, telegramId, msg.from.username || null, startMatch[1]?.trim());
  await sendMessage(env, chatId, "Escribe /start para empezar.");
}

async function handleStart(env, chatId, telegramId, username, startCode) {
  const existing = await env.DB.prepare("SELECT * FROM subscribers WHERE telegram_id = ?").bind(telegramId).first();
  let referredBy = existing ? existing.referred_by : null;
  if (startCode) {
    const creator = await env.DB.prepare("SELECT * FROM creators WHERE start_code = ? AND active = 1 AND verified = 1").bind(startCode).first();
    if (creator) referredBy = startCode;
  }
  if (existing) await env.DB.prepare("UPDATE subscribers SET username = ?, referred_by = ? WHERE telegram_id = ?").bind(username, referredBy, telegramId).run();
  else await env.DB.prepare("INSERT INTO subscribers (telegram_id, username, referred_by) VALUES (?, ?, ?)").bind(telegramId, username, referredBy).run();

  const role = await getRole(env, telegramId);
  if (role === "admin") return await sendMenuAdmin(env, chatId);
  if (role === "creator") return await sendMenuCreator(env, chatId);
  await sendMenuFan(env, chatId);
}

async function handleCallback(cb, env) {
  const chatId = cb.message.chat.id, telegramId = cb.from.id, data = cb.data;
  await answerCallback(env, cb.id);
  try { await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/deleteMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, message_id: cb.message.message_id }) }); } catch (e) {}

  if (data === "subscribe") {
    const sub = await env.DB.prepare("SELECT * FROM subscribers WHERE telegram_id = ?").bind(telegramId).first();
    if (!sub) return;
    await env.DB.prepare("INSERT INTO subscriptions (subscriber_id, creator_id, started_at, expires_at, status) VALUES (?, (SELECT id FROM creators WHERE start_code = ?), datetime('now'), datetime('now'), 'pending')").bind(sub.id, sub.referred_by || 'owner').run();
    return await sendMessage(env, chatId, `💎 *Suscripción VIP*\n\nEnvía exactamente **1 USDT** (BEP20) a:\n\n\`${MASTER_WALLET}\`\n\nEl acceso es automático al detectar el pago.`);
  }
  
  if (data === "status") {
    const sub = await env.DB.prepare("SELECT s.* FROM subscriptions s JOIN subscribers u ON u.id = s.subscriber_id WHERE u.telegram_id = ? AND s.status = 'active'").bind(telegramId).first();
    return await sendMessage(env, chatId, sub ? `✅ Activa hasta: *${sub.expires_at}*` : "📭 No tienes suscripción activa.");
  }
  if (data === "become_creator") return await sendMessage(env, chatId, "🎬 Verificación próximamente.");
  if (data === "creator_upload") { await env.KV.put(`upload_state:${telegramId}`, "waiting", { expirationTtl: 3600 }); return await sendMessage(env, chatId, "📤 Envíame la foto o video."); }
  if (data === "creator_panel") {
    const c = await env.DB.prepare("SELECT * FROM creators WHERE telegram_id = ?").bind(telegramId).first();
    const f = await env.DB.prepare("SELECT COUNT(*) as t FROM subscribers WHERE referred_by = ?").bind(c.start_code).first();
    return await sendMessage(env, chatId, `📊 *Panel*\nNombre: ${c.display_name}\nFans: ${f.t}\nEstado: ${c.verified ? "✅" : "⏳"}`);
  }
  if (data === "creator_channel_link") {
    const channelId = await env.KV.get("config:channel_id");
    const link = await createInviteLink(env, channelId, `c_${telegramId}_${Date.now()}`);
    return await sendMessage(env, chatId, `🔗 Tu enlace:\n${link}`);
  }
  if (data === "creator_ref_link") {
    const c = await env.DB.prepare("SELECT start_code FROM creators WHERE telegram_id = ?").bind(telegramId).first();
    const me = await getMe(env);
    return await sendMessage(env, chatId, `🎯 Tu enlace para fans:\nhttps://t.me/${me.username}?start=${c.start_code}`);
  }
  if (data === "creator_earnings") return await sendMessage(env, chatId, "💰 Próximamente.");
  
  if (data === "admin_creators") {
    const c = await env.DB.prepare("SELECT * FROM creators WHERE id > 1 AND active = 1").all();
    let t = `👥 Creadoras: ${c.results.length}\n\n`;
    for (const x of c.results) t += `• ${x.display_name}\n`;
    return await sendMessage(env, chatId, t || "Ninguna.");
  }
  if (data === "admin_stats") {
    const s = await env.DB.prepare("SELECT COUNT(*) as n FROM subscribers").first();
    const c = await env.DB.prepare("SELECT COUNT(*) as n FROM creators WHERE id > 1").first();
    return await sendMessage(env, chatId, `📈 Fans: ${s.n}\nCreadoras: ${c.n}`);
  }
  if (data === "admin_payments") return await sendMessage(env, chatId, "💵 Próximamente.");
}

async function handleCreatorUpload(env, chatId, telegramId, message) {
  const creator = await env.DB.prepare("SELECT * FROM creators WHERE telegram_id = ? AND verified = 1").bind(telegramId).first();
  const channelId = await env.KV.get("config:channel_id");
  const groupId = await env.KV.get("config:control_group_id");
  if (!creator || !channelId || !groupId) return await sendMessage(env, chatId, "❌ Error.");

  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/copyMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: channelId, from_chat_id: chatId, message_id: message.message_id }) });
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/copyMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: groupId, from_chat_id: chatId, message_id: message.message_id }) }).then(x => x.json());
  await env.DB.prepare("INSERT INTO posts (creator_id, message_id) VALUES (?, ?)").bind(creator.id, r.result.message_id).run();
  await sendMessage(env, chatId, "✅ Publicado.");
}

async function getRole(env, telegramId) {
  if (telegramId === ADMIN_ID) return "admin";
  const c = await env.DB.prepare("SELECT id FROM creators WHERE telegram_id = ? AND active = 1").bind(telegramId).first();
  return c ? "creator" : "fan";
}

async function createInviteLink(env, chatId, name) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/createChatInviteLink`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, member_limit: 1, name: name }) }).then(x => x.json());
  return r.ok ? r.result.invite_link : null;
}

let meCache = null;
async function getMe(env) {
  if (meCache) return meCache;
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getMe`).then(x => x.json());
  meCache = r.result; return meCache;
}

async function sendMessage(env, chatId, text) {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }) }).then(r => r.json());
}

async function sendMenuFan(env, chatId) {
  await sendMessageWithButtons(env, chatId, "👋 *Bienvenido*", [
    [{ text: "💎 Suscribirme", callback_data: "subscribe" }],
    [{ text: "📊 Mi estado", callback_data: "status" }],
    [{ text: "🎨 Ser creadora", callback_data: "become_creator" }]
  ]);
}

async function sendMenuCreator(env, chatId) {
  await sendMessageWithButtons(env, chatId, "👩‍🎨 *Menú Creadora*", [
    [{ text: "📤 Subir Contenido", callback_data: "creator_upload" }],
    [{ text: "📊 Mi panel", callback_data: "creator_panel" }],
    [{ text: "🔗 Enlace canal", callback_data: "creator_channel_link" }],
    [{ text: "🎯 Enlace fans", callback_data: "creator_ref_link" }],
    [{ text: "💰 Ganancias", callback_data: "creator_earnings" }]
  ]);
}

async function sendMenuAdmin(env, chatId) {
  await sendMessageWithButtons(env, chatId, "⚙️ *Admin*", [
    [{ text: "👥 Creadoras", callback_data: "admin_creators" }],
    [{ text: "💵 Pagos", callback_data: "admin_payments" }],
    [{ text: "📈 Stats", callback_data: "admin_stats" }]
  ]);
}

async function sendMessageWithButtons(env, chatId, text, buttons) {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } }) }).then(r => r.json());
}

async function answerCallback(env, id) {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callback_query_id: id }) }).then(r => r.json());
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
      }
