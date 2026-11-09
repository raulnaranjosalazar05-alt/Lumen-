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
    ctx.waitUntil(checkWeeklyActivity(env));
    ctx.waitUntil(checkMonthlyPayouts(env));
  }
};

async function cleanChat(env, chatId, messageId) {
  try { await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/deleteMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, message_id: messageId }) }); } catch (e) {}
  }
async function checkPayments(env) {
  const pending = await env.DB.prepare("SELECT * FROM subscriptions WHERE status = 'pending'").all();
  if (!pending.results || pending.results.length === 0) return;
  const data = "0x70a08231" + MASTER_WALLET.slice(2).padStart(64, '0'); 
  const res = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDT_CONTRACT, data: data }, "latest"] }) }).then(r => r.json());
  if (!res.result) return;
  const balance = parseInt(res.result, 16) / 1e18;
  
  if (balance >= pending.results.length * 1.0) {
    for (const sub of pending.results) {
      const now = new Date();
      const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await env.DB.prepare("UPDATE subscriptions SET status = 'active', started_at = ?, expires_at = ? WHERE id = ?").bind(now.toISOString(), expires, sub.id).run();
      const link = await createInviteLink(env, await env.KV.get("config:channel_id"), `fan_${sub.subscriber_id}_${Date.now()}`);
      const fan = await env.DB.prepare("SELECT telegram_id FROM subscribers WHERE id = ?").bind(sub.subscriber_id).first();
      if (fan && link) await sendMessageWithButtons(env, fan.telegram_id, `✅ *¡Pago recibido!*\n\nAquí tienes tu acceso:`, [[{ text: "🚪 Entrar al Canal VIP", url: link }]]);
    }
  }
}

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

async function checkWeeklyActivity(env) {
  const creators = await env.DB.prepare("SELECT * FROM creators WHERE active = 1 AND id > 1").all();
  const now = new Date();
  for (const c of creators.results) {
    const diffDays = Math.floor((now - new Date(c.created_at)) / (1000 * 60 * 60 * 24));
    if (diffDays > 0 && diffDays % 7 === 0 && now.getUTCHours() === 12) {
      const posts = await env.DB.prepare("SELECT COUNT(*) as n FROM posts WHERE creator_id = ? AND created_at >= datetime('now', '-7 days')").bind(c.id).first();
      if (posts.n < 3) await sendMessage(env, c.telegram_id, `⚠️ Solo has subido ${posts.n} publicaciones esta semana. Necesitas mínimo 3 para mantener tu monetización.`);
    }
  }
}

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
    if (!creator || !creator.wallet_address) { await sendMessage(env, ADMIN_ID, `⚠️ Creadora ${creator.display_name} no tiene wallet.`); continue; }
    const fans = row.total_subs;
    let pct = fans >= 5000 ? 0.90 : fans >= 1000 ? 0.80 : fans >= 500 ? 0.70 : fans >= 100 ? 0.60 : 0.50;
    const commission = fans * 1.0 * pct;
    const stars = await env.DB.prepare("SELECT total_stars FROM stars_monthly WHERE creator_id = ? AND period = ?").bind(creator.id, period).first();
    const totalStars = stars ? stars.total_stars : 0;
    const qualityIndex = fans > 0 ? (totalStars / fans) : 0;
    let bonusPct = qualityIndex >= 5 ? 0.40 : qualityIndex >= 3 ? 0.20 : qualityIndex >= 1.5 ? 0.10 : qualityIndex > 0 ? 0.05 : 0;
    const ownerMargin = fans * 1.0 * (1 - pct);
    const totalToPay = commission + (ownerMargin * bonusPct);
    if (totalToPay < 0.10) continue;
    try {
      const { request } = await publicClient.simulateContract({ address: USDT_CONTRACT, abi: [{ name: 'transfer', type: 'function', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }] }], functionName: 'transfer', args: [creator.wallet_address, parseUnits(totalToPay.toFixed(2), 18)], account });
      const hash = await client.writeContract(request);
      await env.DB.prepare("INSERT INTO payments (subscriber_id, creator_id, amount_usdt, period, tx_hash) VALUES (?, ?, ?, ?, ?)").bind(creator.id, creator.id, totalToPay, period, hash).run();
      const msg = `💰 *Pago Realizado - ${period}*\n\n*Creadora:* ${creator.display_name}\n*Monto:* ${totalToPay.toFixed(2)} USDT\n*Hash:* \`${hash}\``;
      await sendMessage(env, creator.telegram_id, msg);
      if (env.CREATORS_GROUP_ID) { const sent = await sendMessage(env, env.CREATORS_GROUP_ID, msg); try { await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/pinChatMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: env.CREATORS_GROUP_ID, message_id: sent.result.message_id }) }); } catch(e){} }
    } catch (e) { await sendMessage(env, ADMIN_ID, `❌ Error pagando a ${creator.display_name}: ${e.message}`); }
  }                                                                                                   
}
async function handleUpdate(update, env) {
  if (update.message_reaction) {
    const reaction = update.message_reaction;
    const channelId = await env.KV.get("config:channel_id");
    if (reaction.chat.id.toString() === channelId) {
      const post = await env.DB.prepare("SELECT creator_id FROM posts WHERE message_id = ?").bind(reaction.message_id).first();
      if (post) {
        const newStars = reaction.new_reaction.filter(r => r.type === 'paid').length;
        const oldStars = reaction.old_reaction.filter(r => r.type === 'paid').length;
        const diff = newStars - oldStars;
        if (diff !== 0) {
          const now = new Date();
          const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
          await env.DB.prepare("INSERT INTO stars_monthly (creator_id, period, total_stars) VALUES (?, ?, ?) ON CONFLICT(creator_id, period) DO UPDATE SET total_stars = total_stars + ?").bind(post.creator_id, period, diff, diff).run();
        }
      }
    }
    return;
  }

  if (update.callback_query) return await handleCallback(update.callback_query, env);
  const msg = update.message;
  if (!msg) return;
  if (msg.video_note || msg.photo || msg.video) return await handleMedia(env, msg);
  if (!msg.text) return;
  const chatId = msg.chat.id, telegramId = msg.from.id, text = msg.text.trim();
  const state = await env.KV.get(`state:${telegramId}`);
  if (state === "awaiting_wallet") {
    await cleanChat(env, chatId, msg.message_id);
    if (text.startsWith("0x") && text.length === 42) {
      await env.DB.prepare("UPDATE creators SET wallet_address = ? WHERE telegram_id = ?").bind(text, telegramId).run();
      await env.KV.delete(`state:${telegramId}`);
      return await sendMessage(env, chatId, "✅ Wallet guardada correctamente.");
    }
    return await sendMessage(env, chatId, "❌ Dirección inválida. Debe empezar por 0x y tener 42 caracteres.");
  }
  const startMatch = text.match(/^\/start(?:\s+(.+))?$/);
  if (startMatch) { await cleanChat(env, chatId, msg.message_id); return await handleStart(env, chatId, telegramId, msg.from.username || null, startMatch[1]?.trim()); }
  await cleanChat(env, chatId, msg.message_id);
  await sendMessage(env, ADMIN_ID, `🆘 *SOPORTE:* @${msg.from.username || "sin_user"} (ID: ${telegramId}) dice:\n\n"${text}"`);
}

async function handleStart(env, chatId, telegramId, username, startCode) {
  const existing = await env.DB.prepare("SELECT * FROM subscribers WHERE telegram_id = ?").bind(telegramId).first();
  let referredBy = existing ? existing.referred_by : null;
  if (startCode) { const creator = await env.DB.prepare("SELECT * FROM creators WHERE start_code = ? AND active = 1 AND verified = 1").bind(startCode).first(); if (creator) referredBy = startCode; }
  if (existing) await env.DB.prepare("UPDATE subscribers SET username = ?, referred_by = ? WHERE telegram_id = ?").bind(username, referredBy, telegramId).run();
  else await env.DB.prepare("INSERT INTO subscribers (telegram_id, username, referred_by) VALUES (?, ?, ?)").bind(telegramId, username, referredBy).run();
  const role = await getRole(env, telegramId);
  if (role === "admin") return await sendMenuAdmin(env, chatId);
  if (role === "creator") return await sendMenuCreator(env, chatId);
  await sendMenuFan(env, chatId);
}

async function handleMedia(env, msg) {
  const chatId = msg.chat.id, telegramId = msg.from.id;
  const uploadState = await env.KV.get(`upload_state:${telegramId}`);
  if (uploadState === "waiting") {
    await env.KV.delete(`upload_state:${telegramId}`);
    const creator = await env.DB.prepare("SELECT * FROM creators WHERE telegram_id = ? AND verified = 1").bind(telegramId).first();
    if (!creator) return await sendMessage(env, chatId, "❌ No estás verificada como creadora.");
    const channelId = await env.KV.get("config:channel_id");
    const groupId = await env.KV.get("config:control_group_id");
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/copyMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: channelId, from_chat_id: chatId, message_id: msg.message_id, reply_markup: { inline_keyboard: [[{ text: "🚨 Denunciar", callback_data: "report_post" }]] } }) });
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/copyMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: groupId, from_chat_id: chatId, message_id: msg.message_id }) }).then(x => x.json());
    await env.DB.prepare("INSERT INTO posts (creator_id, message_id) VALUES (?, ?)").bind(creator.id, r.result.message_id).run();
    return await sendMessage(env, chatId, "✅ ¡Contenido publicado!");
  }
  if (msg.video_note) {
    const pending = await env.KV.get(`verify_state:${telegramId}`);
    if (pending === "waiting_video") {
      await env.KV.delete(`verify_state:${telegramId}`);
      await sendMessage(env, chatId, "⏳ Verificando tu video...");
      try {
        const file = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${msg.video_note.file_id}`).then(r => r.json());
        const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.result.file_path}`;
        const audioBlob = await fetch(fileUrl).then(r => r.blob());
        const formData = new FormData();
        formData.append("file", audioBlob, "video.mp4");
        formData.append("model", "whisper-large-v3");
        const groqRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", { method: "POST", headers: { "Authorization": `Bearer ${env.GROQ_API_KEY}` }, body: formData }).then(r => r.json());
        const transcription = (groqRes.text || "").toLowerCase();
        const hasAge = transcription.includes("18") || transcription.includes("dieciocho") || transcription.includes("mayor");
        const hasCode = transcription.includes("4921") || transcription.includes("cuatro nueve dos uno") || transcription.includes("cuarenta y nueve veintiuno");
        if (hasAge && hasCode) {
          const code = Math.random().toString(36).substring(2, 6);
          await env.DB.prepare("INSERT INTO creators (telegram_id, username, display_name, start_code, verified, active) VALUES (?, ?, ?, ?, 1, 1)").bind(telegramId, msg.from.username || "sin_user", msg.from.first_name || "Creadora", code).run();
          await sendMessageWithButtons(env, chatId, `✅ *¡Verificación exitosa!*\n\nYa eres creadora oficial.`, [[{ text: "🎨 Ir a mi menú", callback_data: "creator_menu" }]]);
          await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/copyMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: ADMIN_ID, from_chat_id: chatId, message_id: msg.message_id }) });
          await sendMessage(env, ADMIN_ID, `🚨 Nueva creadora verificada: ${msg.from.first_name} (@${msg.from.username})`);
          return;
        } else {
          await sendMessage(env, chatId, "❌ No pudimos verificar tu video. Asegúrate de decir el código 4921 y que eres mayor de 18.");
          return;
        }
      } catch (e) { await sendMessage(env, chatId, "⚠️ Error técnico verificando tu video. Inténtalo de nuevo en 5 minutos."); }
    }
  }
}

async function handleCallback(cb, env) {
  const chatId = cb.message.chat.id, telegramId = cb.from.id, data = cb.data;
  await answerCallback(env, cb.id);
  await cleanChat(env, chatId, cb.message.message_id);

  if (data === "subscribe") {
    const sub = await env.DB.prepare("SELECT * FROM subscribers WHERE telegram_id = ?").bind(telegramId).first();
    if (!sub) return;
    await env.DB.prepare("INSERT INTO subscriptions (subscriber_id, creator_id, started_at, expires_at, status) VALUES (?, (SELECT id FROM creators WHERE start_code = ?), datetime('now'), datetime('now'), 'pending')").bind(sub.id, sub.referred_by || 'owner').run();
    return await sendMessage(env, chatId, `💎 *Suscripción VIP*\n\nEnvía exactamente **1 USDT** (BEP20) a:\n\n\`${MASTER_WALLET}\`\n\nEl acceso es automático.`);
  }
  if (data === "status") {
    const sub = await env.DB.prepare("SELECT s.* FROM subscriptions s JOIN subscribers u ON u.id = s.subscriber_id WHERE u.telegram_id = ? AND s.status = 'active'").bind(telegramId).first();
    if (!sub) return await sendMessage(env, chatId, "📭 No tienes suscripción activa.");
    const link = await createInviteLink(env, await env.KV.get("config:channel_id"), `fan_${telegramId}_${Date.now()}`);
    return await sendMessageWithButtons(env, chatId, `✅ Activa hasta: *${sub.expires_at}*`, [[{ text: "🚪 Entrar al Canal", url: link }]]);
  }
  if (data === "how_it_works") return await sendMessage(env, chatId, "📚 *¿Cómo funciona?*\n\nPagas 1 USDT al mes y entras al canal VIP. Verás a TODAS las creadoras.");
  if (data === "support_fan") return await sendMessageWithButtons(env, chatId, "🆘 *Centro de Ayuda*", [[{ text: "⏳ No me llega el enlace", callback_data: "faq_wait" }],[{ text: "💰 He pagado pero no tengo acceso", callback_data: "faq_pay" }],[{ text: "📅 ¿Cómo renuevo?", callback_data: "faq_renew" }],[{ text: "🌐 ¿En qué red envío?", callback_data: "faq_net" }],[{ text: "👤 Hablar con administrador", callback_data: "faq_human" }]]);
  if (data === "faq_wait") return await sendMessage(env, chatId, "El sistema revisa pagos cada minuto. Espera 2 minutos y revisa 'Mi Estado'.");
  if (data === "faq_pay") return await sendMessage(env, chatId, "Asegúrate de enviar 1 USDT o más a la wallet mostrada.");
  if (data === "faq_renew") return await sendMessage(env, chatId, "Tu suscripción dura 30 días. Toca 'Suscribirme' de nuevo y envía 1 USDT.");
  if (data === "faq_net") return await sendMessage(env, chatId, "Debes enviar USDT por la red *BNB Smart Chain (BEP20)*.");
  if (data === "faq_human") return await sendMessage(env, chatId, "Escribe tu problema y un administrador te responderá.");
  if (data === "become_creator") {
    const state = await env.KV.get("config:creator_registration") || "open";
    if (state === "paused") return await sendMessage(env, chatId, "⏳ El registro está cerrado temporalmente.");
    await env.KV.put(`verify_state:${telegramId}`, "waiting_video", { expirationTtl: 3600 });
    return await sendMessage(env, chatId, "🎬 *Verificación*\n\nEnvía una Nota de Video (el círculo) diciendo: *\"Soy [tu nombre], mi código es 4921, tengo más de 18 años\"* y pásate los dedos por la cara.");
  }
  if (data === "report_post") return await sendMessage(env, chatId, "✅ Denuncia enviada. Un administrador revisará el contenido.");

  if (data === "creator_upload") { await env.KV.put(`upload_state:${telegramId}`, "waiting", { expirationTtl: 3600 }); return await sendMessage(env, chatId, "📤 Envíame la foto o video."); }
  if (data === "creator_panel") {
    const c = await env.DB.prepare("SELECT * FROM creators WHERE telegram_id = ?").bind(telegramId).first();
    const f = await env.DB.prepare("SELECT COUNT(*) as t FROM subscribers WHERE referred_by = ?").bind(c.start_code).first();
    return await sendMessageWithButtons(env, chatId, `📊 *Mi Panel*\n\nFans: ${f.t}\nEstado: ${c.verified ? "✅ Verificada" : "⏳ Pendiente"}`, [[{ text: "🔙 Volver", callback_data: "creator_menu" }]]);
  }
  if (data === "creator_earnings") {
    const c = await env.DB.prepare("SELECT * FROM creators WHERE telegram_id = ?").bind(telegramId).first();
    const f = await env.DB.prepare("SELECT COUNT(*) as t FROM subscribers WHERE referred_by = ?").bind(c.start_code).first();
    const fans = f.t;
    let pct = fans >= 5000 ? 0.90 : fans >= 1000 ? 0.80 : fans >= 500 ? 0.70 : fans >= 100 ? 0.60 : 0.50;
    const commission = fans * 1.0 * pct;
    const ownerMargin = fans * 1.0 * (1 - pct);
    const now = new Date(); const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const stars = await env.DB.prepare("SELECT total_stars FROM stars_monthly WHERE creator_id = ? AND period = ?").bind(c.id, period).first();
    const totalStars = stars ? stars.total_stars : 0;
    const qualityIndex = fans > 0 ? (totalStars / fans) : 0;
    let bonusPct = qualityIndex >= 5 ? 0.40 : qualityIndex >= 3 ? 0.20 : qualityIndex >= 1.5 ? 0.10 : qualityIndex > 0 ? 0.05 : 0;
    const bonus = ownerMargin * bonusPct;
    return await sendMessageWithButtons(env, chatId, `💰 *Mis Ganancias*\n\nFans: ${fans}\nComisión: ${(pct*100)}%\nCalidad: ${qualityIndex.toFixed(2)} ⭐\n\nDesglose:\n• Comisión: ${commission.toFixed(2)} USDT\n• Bono: ${bonus.toFixed(2)} USDT\n\n*Total estimado:* ${(commission+bonus).toFixed(2)} USDT`, [[{ text: "🔙 Volver", callback_data: "creator_menu" }]]);
  }
  if (data === "creator_wallet") { await env.KV.put(`state:${telegramId}`, "awaiting_wallet", { expirationTtl: 3600 }); return await sendMessageWithButtons(env, chatId, "🏦 *Mi Wallet*\n\nEnvía tu dirección USDT (BEP20) empezando por 0x...", [[{ text: "📲 SafePal", url: "https://www.safepal.com/download" }, { text: "📲 Trust", url: "https://trustwallet.com/download" }],[{ text: "▶️ Tutorial YouTube", url: "https://www.youtube.com/results?search_query=como+crear+wallet+usdt+bep20" }],[{ text: "🔙 Volver", callback_data: "creator_menu" }]]); }
  if (data === "creator_channel_link") { const link = await createInviteLink(env, await env.KV.get("config:channel_id"), `c_${telegramId}_${Date.now()}`); return await sendMessageWithButtons(env, chatId, "🔗 *Acceso al Canal*", [[{ text: "🚪 Entrar al Canal", url: link }]]); }
  if (data === "creator_ref_link") { const c = await env.DB.prepare("SELECT start_code FROM creators WHERE telegram_id = ?").bind(telegramId).first(); const me = await getMe(env); return await sendMessageWithButtons(env, chatId, `🎯 *Enlace para fans*\n\nhttps://t.me/${me.username}?start=${c.start_code}`, [[{ text: "🔙 Volver", callback_data: "creator_menu" }]]); }
  if (data === "creator_norms") return await sendMessageWithButtons(env, chatId, "📜 *Normas*\n\n✅ Permitido: Todo el contenido legal para adultos.\n❌ Prohibido: CSAM, bestialidad, no consensuado.", [[{ text: "✅ Acepto", callback_data: "creator_menu" }]]);
  if (data === "creator_tutorial") return await sendMessageWithButtons(env, chatId, "📚 *Tutorial*\n\n1. Configura wallet.\n2. Sube contenido.\n3. Comparte enlace.\n4. Cobra el día 1.", [[{ text: "🔙 Volver", callback_data: "creator_menu" }]]);
  if (data === "creator_support") return await sendMessageWithButtons(env, chatId, "🆘 *Soporte*", [[{ text: "🚪 Ir al Grupo", url: "https://t.me/+EWpRI3PN7-Y4ZDEx" }]]);
  if (data === "creator_menu") return await sendMenuCreator(env, chatId);

  if (data === "admin_menu") return await sendMenuAdmin(env, chatId);
  if (data === "admin_stats") { const s = await env.DB.prepare("SELECT COUNT(*) as n FROM subscribers").first(); const c = await env.DB.prepare("SELECT COUNT(*) as n FROM creators WHERE id > 1").first(); const act = await env.DB.prepare("SELECT COUNT(*) as n FROM subscriptions WHERE status = 'active'").first(); return await sendMessageWithButtons(env, chatId, `📈 *Estadísticas*\n\nFans: ${s.n}\nCreadoras: ${c.n}\nSuscripciones: ${act.n}`, [[{ text: "🔙 Volver", callback_data: "admin_menu" }]]); }
  if (data === "admin_creators") { const c = await env.DB.prepare("SELECT * FROM creators WHERE id > 1 AND active = 1").all(); let t = `👥 *Creadoras: ${c.results.length}*\n\n`; for (const x of c.results) t += `• ${x.display_name}\n`; return await sendMessageWithButtons(env, chatId, t, [[{ text: "🔙 Volver", callback_data: "admin_menu" }]]); }
  if (data === "admin_payments") { const now = new Date(); const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`; const income = await env.DB.prepare("SELECT COUNT(*) as n FROM payments WHERE period = ?").bind(period).first(); return await sendMessageWithButtons(env, chatId, `💵 *Ingresos (${period})*\n\nTotal: ${income.n.toFixed(2)} USDT`, [[{ text: "🔙 Volver", callback_data: "admin_menu" }]]); }
  if (data === "admin_pause") { const st = await env.KV.get("config:creator_registration") || "open"; if (st === "open") { await env.KV.put("config:creator_registration", "paused"); return await sendMessageWithButtons(env, chatId, "⏸️ *Pausado*", [[{ text: "🔙 Volver", callback_data: "admin_menu" }]]); } else { await env.KV.put("config:creator_registration", "open"); return await sendMessageWithButtons(env, chatId, "▶️ *Activado*", [[{ text: "🔙 Volver", callback_data: "admin_menu" }]]); } }
}

async function getRole(env, telegramId) { if (telegramId === ADMIN_ID) return "admin"; const c = await env.DB.prepare("SELECT id FROM creators WHERE telegram_id = ? AND active = 1").bind(telegramId).first(); return c ? "creator" : "fan"; }
async function createInviteLink(env, chatId, name) { const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/createChatInviteLink`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, member_limit: 1, name: name }) }).then(x => x.json()); return r.ok ? r.result.invite_link : null; }
let meCache = null;
async function getMe(env) { if (meCache) return meCache; const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getMe`).then(x => x.json()); meCache = r.result; return meCache; }
async function sendMessage(env, chatId, text) { return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }) }).then(r => r.json()); }
async function sendMessageWithButtons(env, chatId, text, buttons) { return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } }) }).then(r => r.json()); }
async function answerCallback(env, id) { return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callback_query_id: id }) }).then(r => r.json()); }

async function sendMenuFan(env, chatId) { await sendMessageWithButtons(env, chatId, "👋 *Bienvenido a Lumen VIP*\n\nElige una opción:", [[{ text: "💎 Suscribirme — 1 USDT", callback_data: "subscribe" }],[{ text: "📊 Mi Estado", callback_data: "status" }, { text: "📚 ¿Cómo funciona?", callback_data: "how_it_works" }],[{ text: "🆘 Soporte", callback_data: "support_fan" }]]); }
async function sendMenuCreator(env, chatId) { await sendMessageWithButtons(env, chatId, "👩‍🎨 *Menú de Creadora*\n\nElige una opción:", [[{ text: "📤 Subir Contenido", callback_data: "creator_upload" }],[{ text: "📊 Mi Panel", callback_data: "creator_panel" }, { text: "💰 Mis Ganancias", callback_data: "creator_earnings" }],[{ text: "🏦 Mi Wallet", callback_data: "creator_wallet" }, { text: "🔗 Enlace Canal", callback_data: "creator_channel_link" }],[{ text: "🎯 Enlace Fans", callback_data: "creator_ref_link" }, { text: "📜 Normas", callback_data: "creator_norms" }],[{ text: "📚 Tutorial", callback_data: "creator_tutorial" }, { text: "🆘 Soporte", callback_data: "creator_support" }],[{ text: "🔙 Volver", callback_data: "creator_menu" }]]); }
async function sendMenuAdmin(env, chatId) { const state = await env.KV.get("config:creator_registration") || "open"; const pauseBtn = state === "open" ? "⏸️ Pausar Nuevas Creadoras" : "▶️ Reanudar Nuevas Creadoras"; await sendMessageWithButtons(env, chatId, "⚙️ *Panel de Administración*\n\nElige una opción:", [[{ text: "📈 Estadísticas Generales", callback_data: "admin_stats" }],[{ text: "👥 Gestionar Creadoras", callback_data: "admin_creators" }, { text: "💵 Ingresos y Pagos", callback_data: "admin_payments" }],[{ text: pauseBtn, callback_data: "admin_pause" }],[{ text: "🔙 Volver", callback_data: "admin_menu" }]]); }

function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } }); }
