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
      if (fan && link) {
  const paymentMsgId = await env.KV.get(`payment_msg:${fan.telegram_id}`);
  if (paymentMsgId) {
    await cleanChat(env, fan.telegram_id, paymentMsgId);
    await env.KV.delete(`payment_msg:${fan.telegram_id}`);
  }
  await sendMessageWithButtons(env, fan.telegram_id, `✅ *¡Pago recibido!*\n\nAquí tienes tu acceso:`, [[{ text: "🚪 Entrar al Canal VIP", url: link }]]);
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
    let bonusPct = qualityIndex >= 5 ? 0.40 : qualityIndex >= 4 ? 0.30 : qualityIndex >= 3 ? 0.20 : qualityIndex >= 2 ? 0.10 : qualityIndex >= 1 ? 0.05 : 0;
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
        const newStars = reaction.new_reaction.length;
        const oldStars = reaction.old_reaction.length;
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
      await sendMessage(env, chatId, "✅ Wallet guardada correctamente.");
      return await sendMenuCreator(env, chatId);
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
  // Borramos el mensaje de las reglas (y cualquier otro que haya mandado)
  await cleanChat(env, chatId, msg.message_id - 1); 
  await cleanChat(env, chatId, msg.message_id);
  
  const creator = await env.DB.prepare("SELECT * FROM creators WHERE telegram_id = ? AND verified = 1").bind(telegramId).first();
  if (!creator) return await sendMessage(env, chatId, "❌ No estás verificada como creadora.");
  
    const channelId = await env.KV.get("config:channel_id");
    const groupId = await env.KV.get("config:control_group_id");
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/copyMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: channelId, from_chat_id: chatId, message_id: msg.message_id, reply_markup: { inline_keyboard: [[{ text: "🚨 Denunciar", callback_data: "report_post" }]] } }) });
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/copyMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: groupId, from_chat_id: chatId, message_id: msg.message_id }) }).then(x => x.json());
    await env.DB.prepare("INSERT INTO posts (creator_id, message_id) VALUES (?, ?)").bind(creator.id, r.result.message_id).run();
    await cleanChat(env, chatId, msg.message_id);
    await sendMenuCreator(env, chatId);
    return;
  }
  if (msg.video_note) {
    const pending = await env.KV.get(`verify_state:${telegramId}`);
  if (pending === "waiting_video") {
   await env.KV.delete(`verify_state:${telegramId}`);
   const savedCode = await env.KV.get(`verify_code:${telegramId}`);
   await env.KV.delete(`verify_code:${telegramId}`);
   await sendMessage(env, chatId, "⏳ Verificando tu video...");
   try {
// Verificamos el peso del video antes de descargarlo (25 MB máximo)
if (msg.video_note.file_size > 25 * 1024 * 1024) {
  return await sendMessage(env, chatId, "❌ El video es muy pesado (más de 25 MB). Por favor, grábame una nota de video más corta (de 10 a 15 segundos) para poder verificarte.");
}

const file = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${msg.video_note.file_id}`).then(r => r.json());
   const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.result.file_path}`;
   const audioBlob = await fetch(fileUrl).then(r => r.blob());
    
    const formData = new FormData();
    formData.append("file", audioBlob, "video.mp4");
    formData.append("model", "whisper-large-v3");
    
    const groqRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", { method: "POST", headers: { "Authorization": `Bearer ${env.GROQ_API_KEY}` }, body: formData }).then(r => r.json());
    
    const transcription = (groqRes.text || "").toLowerCase();
    const hasAge = transcription.includes("18") || transcription.includes("dieciocho") || transcription.includes("mayor");
    const hasCode = savedCode && (transcription.includes(savedCode) || transcription.includes(savedCode.split('').join(' ')));
    
    if (hasAge && hasCode) {
      const code = Math.random().toString(36).substring(2, 6);
      await env.DB.prepare("INSERT INTO creators (telegram_id, username, display_name, start_code, verified, active) VALUES (?, ?, ?, ?, 1, 1)").bind(telegramId, msg.from.username || "sin_user", msg.from.first_name || "Creadora", code).run();
      
      await sendMessageWithButtons(env, chatId, `✅ *¡Verificación exitosa!*\n\nYa eres creadora oficial.`, [[{ text: "🎨 Ir a mi menú", callback_data: "creator_menu" }]]);
      
      await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/copyMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: ADMIN_ID, from_chat_id: chatId, message_id: msg.message_id }) });
      await sendMessage(env, ADMIN_ID, `🚨 Nueva creadora verificada: ${msg.from.first_name} (@${msg.from.username})`);
      return;
    } else {
      await sendMessage(env, chatId, "❌ No pudimos verificar tu video. Asegúrate de decir el código que te dimos y que eres mayor de 18.");
      return;
    }
  } catch (e) { 
    await sendMessage(env, chatId, "⚠️ Error técnico verificando tu video. Inténtalo de nuevo en 5 minutos."); 
  }
    }
  }
}

async function handleCallback(cb, env) {
  const chatId = cb.message.chat.id, telegramId = cb.from.id, data = cb.data;
  await answerCallback(env, cb.id);
  await cleanChat(env, chatId, cb.message.message_id);

  // === FAN ===
  if (data === "subscribe") {
  const sub = await env.DB.prepare("SELECT * FROM subscribers WHERE telegram_id = ?").bind(telegramId).first();
  if (!sub) return;
  
  let creatorId = 1; 
  if (sub.referred_by) {
    const creator = await env.DB.prepare("SELECT id FROM creators WHERE start_code = ?").bind(sub.referred_by).first();
    if (creator) creatorId = creator.id;
  }
  
  await env.DB.prepare("INSERT INTO subscriptions (subscriber_id, creator_id, started_at, expires_at, status) VALUES (?, ?, datetime('now'), datetime('now'), 'pending')").bind(sub.id, creatorId).run();
  
  const msg = `💎 *Suscripción VIP*\n\nEnvía exactamente **1 USDT** (red BEP20) a esta dirección:`;
  const sent = await sendMessageWithButtonsAndCopy(env, chatId, msg, MASTER_WALLET, [[{ text: "🔙 Volver al menú", callback_data: "fan_menu" }]]);
  
  // Guardamos el ID del mensaje de pago en KV para borrarlo luego
  await env.KV.put(`payment_msg:${telegramId}`, sent.result.message_id);
  return;
}
  if (data === "status") {
    const sub = await env.DB.prepare("SELECT s.* FROM subscriptions s JOIN subscribers u ON u.id = s.subscriber_id WHERE u.telegram_id = ? AND s.status = 'active'").bind(telegramId).first();
    if (!sub) return await sendMessageWithButtons(env, chatId, "📭 No tienes suscripción activa.", [[{ text: "🔙 Volver al menú", callback_data: "fan_menu" }]]);
    const link = await createInviteLink(env, await env.KV.get("config:channel_id"), `fan_${telegramId}_${Date.now()}`);
    return await sendMessageWithButtons(env, chatId, `✅ Activa hasta: *${sub.expires_at}*`, [[{ text: "🚪 Entrar al Canal VIP", url: link }], [{ text: "🔙 Volver al menú", callback_data: "fan_menu" }]]);
  }
  if (data === "how_it_works") return await sendMessageWithButtons(env, chatId, "📚 *¿Cómo funciona?*\n\nPagas 1 USDT al mes y entras al canal VIP. Verás a TODAS las creadoras.", [[{ text: "🔙 Volver al menú", callback_data: "fan_menu" }]]);
  if (data === "support_fan") return await sendMessageWithButtons(env, chatId, "🆘 *Centro de Ayuda*", [[{ text: "⏳ No me llega el enlace", callback_data: "faq_wait" }],[{ text: "💰 He pagado pero no tengo acceso", callback_data: "faq_pay" }],[{ text: "📅 ¿Cómo renuevo?", callback_data: "faq_renew" }],[{ text: "🌐 ¿En qué red envío?", callback_data: "faq_net" }],[{ text: "👤 Hablar con administrador", callback_data: "faq_human" }],[{ text: "🔙 Volver al menú", callback_data: "fan_menu" }]]);
  if (data === "faq_wait") return await sendMessageWithButtons(env, chatId, "El sistema revisa pagos cada minuto. Espera 2 minutos y revisa 'Mi Estado'.", [[{ text: "🔙 Volver", callback_data: "support_fan" }]]);
  if (data === "faq_pay") return await sendMessageWithButtons(env, chatId, "Asegúrate de enviar 1 USDT o más a la wallet mostrada.", [[{ text: "🔙 Volver", callback_data: "support_fan" }]]);
  if (data === "faq_renew") return await sendMessageWithButtons(env, chatId, "Tu suscripción dura 30 días. Toca 'Suscribirme' de nuevo y envía 1 USDT.", [[{ text: "🔙 Volver", callback_data: "support_fan" }]]);
  if (data === "faq_net") return await sendMessageWithButtons(env, chatId, "Debes enviar USDT por la red *BNB Smart Chain (BEP20)*.", [[{ text: "🔙 Volver", callback_data: "support_fan" }]]);
  if (data === "faq_human") return await sendMessageWithButtons(env, chatId, "Escribe tu problema y un administrador te responderá.", [[{ text: "🔙 Volver", callback_data: "support_fan" }]]);
  if (data === "fan_menu") {
  await env.KV.delete(`state:${telegramId}`);
  return await sendMenuFan(env, chatId);
}
  if (data === "report_post") {
  const post = await env.DB.prepare("SELECT creator_id, message_id FROM posts WHERE message_id = ?").bind(cb.message.message_id).first();
  if (!post) return await sendMessage(env, chatId, "❌ Error: Post no encontrado.");

  await env.DB.prepare("INSERT INTO reports (message_id, reporter_id) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(post.message_id, cb.from.id).run();
  const count = await env.DB.prepare("SELECT COUNT(*) as n FROM reports WHERE message_id = ?").bind(post.message_id).first();

  if (count.n >= 3) {
    const creator = await env.DB.prepare("SELECT display_name, telegram_id FROM creators WHERE id = ?").bind(post.creator_id).first();
    await sendMessageWithButtons(env, ADMIN_ID, `🚨 *POST REPORTADO 3 VECES*\n\nCreadora: ${creator.display_name}\nID: \`${creator.telegram_id}\``, [
      [{ text: "🚫 Banear Creadora", callback_data: `admin_ban_${creator.telegram_id}` }],
      [{ text: "✅ Ignorar", callback_data: `admin_ignore_${post.message_id}` }]
    ]);
    const channelId = await env.KV.get("config:channel_id");
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/copyMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: ADMIN_ID, from_chat_id: channelId, message_id: post.message_id }) });
  }

  return await sendMessage(env, chatId, "✅ Denuncia enviada. Gracias por ayudar.");
}

  // === CREADORA ===
  if (data === "become_creator") {
  const state = await env.KV.get("config:creator_registration") || "open";
  if (state === "paused") return await sendMessage(env, chatId, "⏳ El registro está cerrado temporalmente.");
  
  const randomCode = Math.floor(1000 + Math.random() * 9000).toString();
  await env.KV.put(`verify_code:${telegramId}`, randomCode, { expirationTtl: 3600 });
  await env.KV.put(`verify_state:${telegramId}`, "waiting_video", { expirationTtl: 3600 });
  
  return await sendMessageWithButtons(env, chatId, `🎬 *Verificación*\n\nEnvía una Nota de Video diciendo: *"Soy [tu nombre], mi código es ${randomCode}, tengo más de 18 años"* y pásate los dedos por la cara.`, [[{ text: "🔙 Cancelar", callback_data: "creator_menu" }]]);
}
  if (data === "creator_upload") { 
  await env.KV.put(`upload_state:${telegramId}`, "waiting", { expirationTtl: 3600 }); 
  return await sendMessageWithButtons(env, chatId, `📤 *Subir Contenido*\n\nEnvía tu foto, video o nota de video. Se publicará al instante en el canal VIP.\n\n✅ *Qué puedes incluir:*\n• *Enlaces a tus redes:* Instagram, TikTok, OnlyFans, etc.\n• *Hashtags (#):* Para que los fans encuentren tu contenido.\n• *Apoyo con Estrellas (⭐):* Puedes pedir a tus fans que te envíen Estrellas como muestra de apoyo. Estas se acumulan a tu favor para el bono de calidad.\n\n❌ *Prohibido (Expulsión y pérdida de monetización):*\n• *CSAM:* Cualquier contenido de abuso o explotación infantil.\n• *Bestialidad:* Contenido sexual con animales.\n• *No consensuado:* Contenido sexual de personas sin su permiso.`, [[{ text: "🔙 Volver al menú", callback_data: "creator_menu" }]]); 
}
  if (data === "creator_panel") {
    const c = await env.DB.prepare("SELECT * FROM creators WHERE telegram_id = ?").bind(telegramId).first();
    const f = await env.DB.prepare("SELECT COUNT(*) as t FROM subscribers WHERE referred_by = ?").bind(c.start_code).first();
    return await sendMessageWithButtons(env, chatId, `📊 *Mi Panel*\n\nFans: ${f.t}\nEstado: ${c.verified ? "✅ Verificada" : "⏳ Pendiente"}`, [[{ text: "🔙 Volver al menú", callback_data: "creator_menu" }]]);
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
    let bonusPct = qualityIndex >= 5 ? 0.40 : qualityIndex >= 4 ? 0.30 : qualityIndex >= 3 ? 0.20 : qualityIndex >= 2 ? 0.10 : qualityIndex >= 1 ? 0.05 : 0;
    const bonus = ownerMargin * bonusPct;
    return await sendMessageWithButtons(env, chatId, `💰 *Mis Ganancias*\n\nFans: ${fans}\nComisión: ${(pct*100)}%\nCalidad: ${qualityIndex.toFixed(2)} ⭐\n\nDesglose:\n• Comisión: ${commission.toFixed(2)} USDT\n• Bono: ${bonus.toFixed(2)} USDT\n\n*Total estimado:* ${(commission+bonus).toFixed(2)} USDT`, [[{ text: "🔙 Volver al menú", callback_data: "creator_menu" }]]);
  }
  if (data === "creator_wallet") { 
    const c = await env.DB.prepare("SELECT wallet_address FROM creators WHERE telegram_id = ?").bind(telegramId).first();
    const hasWallet = c && c.wallet_address;
    const txt = hasWallet ? `🏦 *Mi Wallet*\n\nTu dirección actual es:\n\`${c.wallet_address}\`\n\nSi quieres cambiarla, envíame la nueva dirección por este chat.` : `🏦 *Configura tu Wallet para cobrar*\n\nPara recibir tus pagos, necesitas una wallet.\n1. Descarga una app de abajo.\n2. Busca USDT en red BEP20.\n3. Copia tu dirección (0x...).\n4. Envíamela por este chat.`;
    await env.KV.put(`state:${telegramId}`, "awaiting_wallet", { expirationTtl: 3600 }); 
    return await sendMessageWithButtons(env, chatId, txt, [[{ text: "📲 SafePal", url: "https://www.safepal.com/download" }, { text: "📲 Trust", url: "https://trustwallet.com/download" }],[{ text: "▶️ Tutorial YouTube", url: "https://www.youtube.com/results?search_query=como+crear+wallet+usdt+bep20" }],[{ text: "🔙 Volver al menú", callback_data: "creator_menu" }]]); 
  }
  if (data === "creator_channel_link") { 
    const link = await createInviteLink(env, await env.KV.get("config:channel_id"), `c_${telegramId}_${Date.now()}`); 
    return await sendMessageWithButtons(env, chatId, "🔗 *Acceso al Canal*", [[{ text: "🚪 Entrar al Canal", url: link }], [{ text: "🔙 Volver al menú", callback_data: "creator_menu" }]]); 
  }
  if (data === "creator_ref_link") { 
  try {
    let c = await env.DB.prepare("SELECT start_code FROM creators WHERE telegram_id = ?").bind(telegramId).first(); 
    
    // AUTO-REPARACIÓN: Si no tiene start_code, se lo generamos y guardamos
    if (!c || !c.start_code) {
      const newCode = "ref" + Math.random().toString(36).substring(2, 6);
      await env.DB.prepare("UPDATE creators SET start_code = ? WHERE telegram_id = ?").bind(newCode, telegramId).run();
      c = { start_code: newCode };
    }

    const me = await getMe(env); 
    const botUsername = me && me.username ? me.username : "LumenVipBot"; // Fallback por si getMe falla
    const link = `https://t.me/${botUsername}?start=${c.start_code}`;
    
    const msg = `🎯 *Enlace para fans*\n\nToca el botón de abajo para copiar tu enlace:`;
    
    return await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, { 
      method: "POST", 
      headers: { "content-type": "application/json" }, 
      body: JSON.stringify({ 
        chat_id: chatId, 
        text: msg, 
        parse_mode: "Markdown", 
        reply_markup: { 
          inline_keyboard: [
            [{ text: "📋 Copiar mi enlace", copy_text: { text: link } }],
            [{ text: "🔙 Volver al menú", callback_data: "creator_menu" }]
          ]
        } 
      }) 
    }).then(r => r.json());
    
  } catch (e) {
    // Si aún así falla, te avisa a ti pero NO a la creadora con tecnicismos
    await sendMessage(env, ADMIN_ID, `🚨 Error en enlace de fans (ID ${telegramId}): ${e.message}`);
    return await sendMessageWithButtons(env, chatId, "⏳ Estamos teniendo un problema técnico. Inténtalo más tarde.", [[{ text: "🔙 Volver al menú", callback_data: "creator_menu" }]]);
  }
}
  if (data === "creator_norms") {
  const txt = `📜 *Normas y Privacidad*\n\n✅ *Permitido:*\nTodo el contenido legal para adultos (fotos, videos, desnudos, explícito).\nEnlaces a redes sociales (Instagram, TikTok, OnlyFans, etc.).\nHashtags y peticiones de apoyo con Estrellas (⭐).\n\n❌ *Prohibido (Expulsión y pérdida de monetización):*\n• *CSAM:* Cualquier contenido de abuso o explotación infantil.\n• *Bestialidad:* Contenido sexual con animales.\n• *No consensuado:* Contenido sexual de personas sin su permiso.\n• Enlaces a otros canales o bots de Telegram.\n\n🔒 *Privacidad:*\nTus datos (ID de Telegram y wallet) solo se usan para gestionar tus pagos. No se comparten con terceros.`;
  return await sendMessageWithButtons(env, chatId, txt, [[{ text: "✅ Acepto", callback_data: "creator_menu" }]]);
}
  if (data === "creator_calc") {
  const txt = `🧮 *Transparencia de Ganancias*\n\n*1. Comisión por Fans:*\nCobras un porcentaje de cada suscripción de 1 USDT que traigas. El porcentaje sube según cuántos fans activos tengas:\n• 1 a 99 fans: *50%* (0.50 USDT por fan)\n• 100 a 499 fans: *60%* (0.60 USDT por fan)\n• 500 a 999 fans: *70%* (0.70 USDT por fan)\n• 1,000 a 4,999 fans: *80%* (0.80 USDT por fan)\n• Más de 5,000 fans: *90%* (0.90 USDT por fan)\n\n*2. Bono por Calidad (Estrellas):*\nEl Índice de Calidad se calcula dividiendo *todas las Estrellas (⭐) que recibas en el mes (de cualquier fan, sin importar quién te trajo)* entre tus fans activos. Este bono sale del margen del dueño, no te quita tu comisión:\n• Índice 0 a 0.99: *Sin bono*\n• Índice 1.0 a 1.99: *🥉 Bronce (5%)*\n• Índice 2.0 a 2.99: *🥈 Plata (10%)*\n• Índice 3.0 a 3.99: *🥇 Oro (20%)*\n• Índice 4.0 a 4.99: *💎 Diamante (30%)*\n• Índice 5.0 o más: *👑 Leyenda (40%)*\n\n*3. Pago:*\nEl día 1 de cada mes se te envía automáticamente a tu wallet de USDT (BEP20).`;
  return await sendMessageWithButtons(env, chatId, txt, [[{ text: "🔙 Volver al menú", callback_data: "creator_menu" }]]);
}
  if (data === "creator_tutorial") {
  const txt = `📚 *Guía Rápida para Creadoras*\n\n*1. Configura tu Wallet:* Ve a "🏦 Mi Wallet" y envía tu dirección USDT (BEP20) para recibir tus pagos.\n\n*2. Sube tu contenido:* Toca "📤 Subir Contenido". Envía fotos o videos. El bot los publicará en el canal VIP.\n\n*3. Consigue Fans:* Usa "🎯 Enlace Fans" para copiar tu enlace único. Compártelo en tus redes (Instagram, TikTok, etc.). Cada fan que entre por ahí contará para tus ganancias.\n\n*4. Mira tus Ganancias:* En "💰 Mis Ganancias" verás cuánto llevas acumulado. Recuerda que el día 1 de cada mes recibes tu pago automático.\n\n*5. Calidad:* En "🧮 Cómo se calcula" tienes todas las reglas de comisiones y el bono por Estrellas.`;
  return await sendMessageWithButtons(env, chatId, txt, [[{ text: "🔙 Volver al menú", callback_data: "creator_menu" }]]);
}
  if (data === "creator_support") {
  try {
    const groupLinkRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/createChatInviteLink`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: env.CREATORS_GROUP_ID, name: `creator_${telegramId}` }) }).then(x => x.json());
    const groupLink = groupLinkRes.ok ? groupLinkRes.result.invite_link : null;
    if (!groupLink) throw new Error("No se pudo crear el enlace");
    
    const txt = `🆘 *Soporte para Creadoras*\n\nEste es tu espacio de ayuda. Entra al grupo para:\n• Resolver dudas técnicas (subir contenido, enlaces, wallet).\n• Ver los avisos de pago con su hash de transacción.\n• Hablar con el administrador y con otras creadoras.`;
    
    return await sendMessageWithButtons(env, chatId, txt, [[{ text: "🚪 Entrar al Grupo de Creadoras", url: groupLink }], [{ text: "🔙 Volver al menú", callback_data: "creator_menu" }]]);
  } catch (e) {
    return await sendMessageWithButtons(env, chatId, "⏳ El grupo de soporte no está disponible en este momento. Inténtalo más tarde.", [[{ text: "🔙 Volver al menú", callback_data: "creator_menu" }]]);
  }
}
  if (data === "creator_menu") {
  await env.KV.delete(`state:${telegramId}`);
  await env.KV.delete(`upload_state:${telegramId}`);
  await env.KV.delete(`verify_state:${telegramId}`);
  await env.KV.delete(`verify_code:${telegramId}`);
  return await sendMenuCreator(env, chatId);
}

  // === ADMIN ===
  if (data === "admin_menu") return await sendMenuAdmin(env, chatId);
  if (data.startsWith("admin_ignore_")) {
  const msgId = data.split("_")[2];
  await env.DB.prepare("DELETE FROM reports WHERE message_id = ?").bind(msgId).run();
  return await sendMessage(env, ADMIN_ID, "✅ Denuncia ignorada. Los reportes han sido borrados.");
}
  if (data === "admin_stats") { 
  const s = await env.DB.prepare("SELECT COUNT(*) as n FROM subscribers").first(); 
  const c = await env.DB.prepare("SELECT COUNT(*) as n FROM creators WHERE id > 1").first(); 
  const act = await env.DB.prepare("SELECT COUNT(*) as n FROM subscriptions WHERE status = 'active'").first(); 
  
  // Calculamos los ingresos del mes actual
  const now = new Date();
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const income = await env.DB.prepare("SELECT COUNT(*) as n FROM payments WHERE period = ?").bind(period).first();
  
  return await sendMessageWithButtons(env, chatId, `📈 *Estadísticas Generales*\n\nFans Totales: ${s.n}\nCreadoras Activas: ${c.n}\nSuscripciones Activas: ${act.n}\nIngresos del Mes: ${income.n.toFixed(2)} USDT`, [[{ text: "🔙 Volver al menú", callback_data: "admin_menu" }]]); 
}
  
  // Paginación Creadoras
  if (data.startsWith("admin_creators_page_")) {
  const page = parseInt(data.split("_")[3]) || 0;
  const limit = 5;
  const offset = page * limit;
  const total = await env.DB.prepare("SELECT COUNT(*) as n FROM creators WHERE id > 1 AND active = 1").first();
  const c = await env.DB.prepare("SELECT * FROM creators WHERE id > 1 AND active = 1 LIMIT ? OFFSET ?").bind(limit, offset).all();
  
  const now = new Date(); 
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  
  let t = `👥 *Creadoras (Pág ${page + 1})*\n\n`; 
  for (const x of c.results) {
    // Calculamos fans y estrellas de cada una
    const f = await env.DB.prepare("SELECT COUNT(*) as t FROM subscribers WHERE referred_by = ?").bind(x.start_code).first();
    const stars = await env.DB.prepare("SELECT total_stars FROM stars_monthly WHERE creator_id = ? AND period = ?").bind(x.id, period).first();
    const totalStars = stars ? stars.total_stars : 0;
    const qualityIndex = f.t > 0 ? (totalStars / f.t) : 0;
    
    t += `• *${x.display_name}*\n  Fans: ${f.t} | ⭐ Calidad: ${qualityIndex.toFixed(2)}\n`; 
  }
  
  const buttons = [];
  if (page > 0) buttons.push([{ text: "⬅️ Anterior", callback_data: `admin_creators_page_${page - 1}` }]);
  if ((page + 1) * limit < total.n) buttons.push([{ text: "Siguiente ➡️", callback_data: `admin_creators_page_${page + 1}` }]);
  buttons.push([{ text: "🔙 Volver al menú", callback_data: "admin_menu" }]);
  return await sendMessageWithButtons(env, chatId, t, buttons);
}
  if (data === "admin_creators") return await handleCallback({ ...cb, data: "admin_creators_page_0" }, env); // Ir a la página 1
  
  // Paginación Pagos
  if (data.startsWith("admin_payments_page_")) {
    const page = parseInt(data.split("_")[3]) || 0;
    const limit = 5;
    const offset = page * limit;
    const total = await env.DB.prepare("SELECT COUNT(*) as n FROM payments WHERE subscriber_id = creator_id").first(); // Pagos reales a creadoras
    const p = await env.DB.prepare("SELECT c.display_name, p.amount_usdt, p.tx_hash FROM payments p JOIN creators c ON c.id = p.creator_id WHERE p.subscriber_id = p.creator_id LIMIT ? OFFSET ?").bind(limit, offset).all();
    
    let t = `💵 *Pagos a Creadoras (Pág ${page + 1})*\n\n`; 
    for (const x of p.results) t += `• ${x.display_name}: ${x.amount_usdt.toFixed(2)} USDT\n  [Ver en BscScan](https://bscscan.com/tx/${x.tx_hash})\n`; 
    if (p.results.length === 0) t += "No hay pagos registrados.";
    
    const buttons = [];
    if (page > 0) buttons.push([{ text: "⬅️ Anterior", callback_data: `admin_payments_page_${page - 1}` }]);
    if ((page + 1) * limit < total.n) buttons.push([{ text: "Siguiente ➡️", callback_data: `admin_payments_page_${page + 1}` }]);
    buttons.push([{ text: "🔙 Volver al menú", callback_data: "admin_menu" }]);
    return await sendMessageWithButtons(env, chatId, t, buttons);
  }
  if (data === "admin_payments") return await handleCallback({ ...cb, data: "admin_payments_page_0" }, env); // Ir a la página 1
  if (data.startsWith("admin_ban_")) {
  const creatorId = data.split("_")[2];
  const creator = await env.DB.prepare("SELECT * FROM creators WHERE telegram_id = ?").bind(creatorId).first();
  
  if (creator) {
    // 1. Expulsar del canal
    const channelId = await env.KV.get("config:channel_id");
    if (channelId) {
      await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/banChatMember`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: channelId, user_id: creatorId }) });
    }
    
    // 2. Expulsar del grupo de creadoras
    if (env.CREATORS_GROUP_ID) {
      await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/banChatMember`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: env.CREATORS_GROUP_ID, user_id: creatorId }) });
    }
    
    // 3. Desactivar en la base de datos (no le pagará este mes)
    await env.DB.prepare("UPDATE creators SET active = 0 WHERE telegram_id = ?").bind(creatorId).run();
    
    // 4. Avisarte a ti y avisarle a ella
    await sendMessage(env, ADMIN_ID, `✅ Creadora ${creator.display_name} baneada y desactivada.`);
    await sendMessage(env, creatorId, "🚫 Has sido expulsada de Lumen VIP por incumplimiento de las normas. Se ha cancelado tu monetización de este mes.");
  } else {
    await sendMessage(env, ADMIN_ID, "⚠️ No se encontró a la creadora en la base de datos.");
  }
  return;
}
  if (data === "admin_pause") { 
    const st = await env.KV.get("config:creator_registration") || "open"; 
    if (st === "open") { 
      await env.KV.put("config:creator_registration", "paused"); 
      return await sendMessageWithButtons(env, chatId, "⏸️ *Registro Pausado*", [[{ text: "🔙 Volver al menú", callback_data: "admin_menu" }]]); 
    } else { 
      await env.KV.put("config:creator_registration", "open"); 
      return await sendMessageWithButtons(env, chatId, "▶️ *Registro Activado*", [[{ text: "🔙 Volver al menú", callback_data: "admin_menu" }]]); 
    } 
  }
}

// === AUXILIARES Y MENÚS ===
async function getRole(env, telegramId) { if (telegramId === ADMIN_ID) return "admin"; const c = await env.DB.prepare("SELECT id FROM creators WHERE telegram_id = ? AND active = 1").bind(telegramId).first(); return c ? "creator" : "fan"; }
async function createInviteLink(env, chatId, name) { const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/createChatInviteLink`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, member_limit: 1, name: name }) }).then(x => x.json()); return r.ok ? r.result.invite_link : null; }
let meCache = null;
async function getMe(env) { if (meCache) return meCache; const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getMe`).then(x => x.json()); meCache = r.result; return meCache; }
async function cleanChat(env, chatId, messageId) { try { await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/deleteMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, message_id: messageId }) }); } catch (e) {} }
async function sendMessage(env, chatId, text) { return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }) }).then(r => r.json()); }
async function sendMessageWithButtons(env, chatId, text, buttons) { return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } }) }).then(r => r.json()); }
async function sendMessageWithButtonsAndCopy(env, chatId, text, textToCopy, buttons) { return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons, copy_text: { text: textToCopy } } }) }).then(r => r.json()); }
async function answerCallback(env, id) { return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callback_query_id: id }) }).then(r => r.json()); }
function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } }); }

async function sendMenuFan(env, chatId) { 
  await sendMessageWithButtons(env, chatId, "👋 *Bienvenido a Lumen VIP*\n\nPaga **1 USDT al mes** y accede al contenido exclusivo de todas nuestras creadoras.\n\nElige una opción:", [
    [{ text: "💎 Suscribirme — 1 USDT (Mensual)", callback_data: "subscribe" }],
    [{ text: "📊 Mi Estado de Suscripción", callback_data: "status" }, { text: "📚 ¿Cómo funciona Lumen VIP?", callback_data: "how_it_works" }],
    [{ text: "🆘 Soporte y Ayuda", callback_data: "support_fan" }]
  ]); 
}
async function sendMenuCreator(env, chatId) { 
  await sendMessageWithButtons(env, chatId, "👩‍🎨 *Menú de Creadora*\n\nElige una opción:", [
    [{ text: "📤 Subir Contenido al Canal VIP", callback_data: "creator_upload" }],
    [{ text: "📊 Mi Panel de Rendimiento", callback_data: "creator_panel" }, { text: "💰 Mis Ganancias Acumuladas", callback_data: "creator_earnings" }],
    [{ text: "🏦 Mi Wallet de Pagos", callback_data: "creator_wallet" }, { text: "🔗 Enlace de Acceso al Canal", callback_data: "creator_channel_link" }],
    [{ text: "🎯 Enlace de Captación para Fans", callback_data: "creator_ref_link" }, { text: "📜 Normas y Privacidad", callback_data: "creator_norms" }],
    [{ text: "🧮 Cómo se Calculan las Ganancias", callback_data: "creator_calc" }],
    [{ text: "📚 Guía y Tutorial de la Creadora", callback_data: "creator_tutorial" }, { text: "🆘 Soporte Técnico", callback_data: "creator_support" }]
  ]); 
}
async function sendMenuAdmin(env, chatId) { 
  const state = await env.KV.get("config:creator_registration") || "open"; 
  const pauseBtn = state === "open" ? "⏸️ Pausar Nuevas Creadoras" : "▶️ Reanudar Nuevas Creadoras"; 
  await sendMessageWithButtons(env, chatId, "⚙️ *Panel de Administración*\n\nElige una opción:", [
    [{ text: "📈 Estadísticas Generales y Reportes", callback_data: "admin_stats" }],
    [{ text: "👥 Gestionar Creadoras", callback_data: "admin_creators" }, { text: "💵 Ingresos y Pagos", callback_data: "admin_payments" }],
    [{ text: pauseBtn + " del Sistema", callback_data: "admin_pause" }]
  ]); 
}
