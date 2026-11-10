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
    ctx.waitUntil(checkReminders(env));
  }
};

async function checkPayments(env) {
  // Buscamos el último bloque escaneado (o empezamos desde el actual si es la primera vez)
  let lastBlock = await env.KV.get("last_scanned_block");
  const currentBlockRes = await fetch(RPC_URL, { 
    method: "POST", headers: { "content-type": "application/json" }, 
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) 
  }).then(r => r.json());
  
  if (!currentBlockRes.result) return;
  const currentBlock = parseInt(currentBlockRes.result, 16);

  if (!lastBlock) {
    // Si es la primera vez, empezamos desde 5 bloques atrás para no perder nada
    lastBlock = currentBlock - 5;
  } else {
    lastBlock = parseInt(lastBlock);
  }

  if (currentBlock <= lastBlock) return; // No hay bloques nuevos

  // El topic de tu wallet (para filtrar solo las transferencias hacia ti)
  const walletTopic = "0x000000000000000000000000" + MASTER_WALLET.slice(2).toLowerCase();
  
  // Consultamos los logs de la blockchain
  const logsRes = await fetch(RPC_URL, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "eth_getLogs",
      params: [{
        fromBlock: "0x" + lastBlock.toString(16),
        toBlock: "0x" + currentBlock.toString(16),
        address: USDT_CONTRACT,
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", // Topic de Transfer
          null, // Desde cualquier wallet
          walletTopic // Hacia tu wallet
        ]
      }]
    })
  }).then(r => r.json());

  if (logsRes.result && logsRes.result.length > 0) {
    for (const log of logsRes.result) {
      const amount = parseInt(log.data, 16) / 1e18;
      // Si la transferencia es de al menos 1 USDT, guardamos el hash
      if (amount >= 1.0) {
        await env.DB.prepare("INSERT INTO verified_hashes (tx_hash) VALUES (?) ON CONFLICT DO NOTHING").bind(log.transactionHash).run();
      }
    }
  }

  // Guardamos el último bloque escaneado para la próxima vez
  await env.KV.put("last_scanned_block", currentBlock.toString());
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
    
    // Revisamos cada 7 días a las 12:00 UTC
    if (diffDays > 0 && diffDays % 7 === 0 && now.getUTCHours() === 12) {
      const posts = await env.DB.prepare("SELECT COUNT(*) as n FROM posts WHERE creator_id = ? AND created_at >= datetime('now', '-7 days')").bind(c.id).first();
      
      if (posts.n < 3) {
        // No cumplió: le sumamos 1 semana de penalización
        await env.DB.prepare("UPDATE creators SET penalty_weeks = penalty_weeks + 1 WHERE id = ?").bind(c.id).run();
        
        // Le avisamos
        await sendMessage(env, c.telegram_id, `⚠️ *Aviso de Monetización*\n\nSolo has subido ${posts.n} publicaciones esta semana. Necesitas mínimo 3.\n\nHas acumulado una penalización del 10% para este mes.`);
      }
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

// Aplicamos la penalización por semanas inactivas
const penalty = creator.penalty_weeks || 0;
const penaltyAmount = penalty * 0.10; // 10% por cada semana
pct = pct - penaltyAmount;
if (pct < 0) pct = 0; // Evitamos que sea negativo

const commission = fans * 1.0 * pct;

const stars = await env.DB.prepare("SELECT total_stars FROM stars_monthly WHERE creator_id = ? AND period = ?").bind(creator.id, period).first();
const totalStars = stars ? stars.total_stars : 0;
const qualityIndex = fans > 0 ? (totalStars / fans) : 0;

// Si tiene penalización, pierde el bono de calidad
let bonusPct = 0;
if (penalty === 0) {
  bonusPct = qualityIndex >= 5 ? 0.40 : qualityIndex >= 4 ? 0.30 : qualityIndex >= 3 ? 0.20 : qualityIndex >= 2 ? 0.10 : qualityIndex >= 1 ? 0.05 : 0;
}

const ownerMargin = fans * 1.0 * (1 - pct);
const totalToPay = commission + (ownerMargin * bonusPct);
    try {
      const { request } = await publicClient.simulateContract({ address: USDT_CONTRACT, abi: [{ name: 'transfer', type: 'function', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }] }], functionName: 'transfer', args: [creator.wallet_address, parseUnits(totalToPay.toFixed(2), 18)], account });
      const hash = await client.writeContract(request);
      await env.DB.prepare("INSERT INTO payments (subscriber_id, creator_id, amount_usdt, period, tx_hash) VALUES (?, ?, ?, ?, ?)").bind(creator.id, creator.id, totalToPay, period, hash).run();
      // Reseteamos las penalizaciones para el próximo mes
      await env.DB.prepare("UPDATE creators SET penalty_weeks = 0 WHERE id = ?").bind(creator.id).run();
      const msg = `💰 *Pago Realizado - ${period}*\n\n*Creadora:* ${creator.display_name}\n*Monto:* ${totalToPay.toFixed(2)} USDT\n*Hash:* \`${hash}\`\n\n_Enviado automáticamente el día 1 de cada mes (12:00 UTC)._`;
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
  if (state === "awaiting_hash") {
  await cleanChat(env, chatId, msg.message_id);
  
  // Filtro estricto: solo aceptamos texto con formato de hash
  if (!msg.text || !text.startsWith("0x") || text.length !== 66) {
    return await sendMessage(env, chatId, "❌ Formato inválido. Por favor, envíame solo el hash de la transacción (empieza por 0x y tiene 66 caracteres). No acepto fotos, videos ni otro tipo de archivos.");
  }
  
  // Verificamos si el hash está en la base de datos y no ha sido usado
  const validHash = await env.DB.prepare("SELECT * FROM verified_hashes WHERE tx_hash = ? AND status = 'unused'").bind(text).first();
  
  if (!validHash) {
    return await sendMessage(env, chatId, "❌ El hash no es válido o ya ha sido utilizado. Asegúrate de que has enviado 1 USDT a la dirección correcta y de que el hash es el correcto.");
  }
  
  // El hash es válido. Activamos la suscripción.
  const sub = await env.DB.prepare("SELECT * FROM subscriptions WHERE subscriber_id = (SELECT id FROM subscribers WHERE telegram_id = ?) AND status = 'pending'").bind(telegramId).first();
  
  if (sub) {
    const now = new Date();
    const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    
    await env.DB.prepare("UPDATE subscriptions SET status = 'active', started_at = ?, expires_at = ? WHERE id = ?").bind(now.toISOString(), expires, sub.id).run();
    await env.DB.prepare("UPDATE verified_hashes SET status = 'used' WHERE id = ?").bind(validHash.id).run();
    
    const link = await createInviteLink(env, await env.KV.get("config:channel_id"), `fan_${telegramId}_${Date.now()}`);
    await env.KV.delete(`state:${telegramId}`);
    
    return await sendMessageWithButtons(env, chatId, `✅ *¡Pago verificado!*\n\nAquí tienes tu acceso al canal VIP:`, [[{ text: "🚪 Entrar al Canal VIP", url: link }]]);
  }
}
    await cleanChat(env, chatId, msg.message_id);
    if (text.startsWith("0x") && text.length === 42) {
      await env.DB.prepare("UPDATE creators SET wallet_address = ? WHERE telegram_id = ?").bind(text, telegramId).run();
      await env.KV.delete(`state:${telegramId}`);
      await sendMessage(env, chatId, "✅ Wallet guardada correctamente.");
      return await sendMenuCreator(env, chatId);
    }
    return await sendMessage(env, chatId, "❌ Dirección inválida. Debe empezar por 0x y tener 42 caracteres.");
  }
  if (state === "awaiting_ban_id") {
  await cleanChat(env, chatId, msg.message_id);
  
  if (text === "/cancelar") {
    await env.KV.delete(`state:${telegramId}`);
    return await sendMessage(env, chatId, "❌ Baneo cancelado.");
  }
  
  const creator = await env.DB.prepare("SELECT * FROM creators WHERE telegram_id = ?").bind(text).first();
  if (creator) {
    // 1. Banear del canal
    const channelId = await env.KV.get("config:channel_id");
    if (channelId) {
      await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/banChatMember`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: channelId, user_id: text }) });
    }
    
    // 2. Banear del grupo de creadoras
    if (env.CREATORS_GROUP_ID) {
      await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/banChatMember`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: env.CREATORS_GROUP_ID, user_id: text }) });
    }
    
    // 3. Desactivar en la base de datos
    await env.DB.prepare("UPDATE creators SET active = 0 WHERE telegram_id = ?").bind(text).run();
    
    await env.KV.delete(`state:${telegramId}`);
    return await sendMessage(env, chatId, `✅ Creadora ${creator.display_name} baneada y desactivada correctamente.`);
  } else {
    return await sendMessage(env, chatId, "❌ No se encontró ninguna creadora con ese ID. Inténtalo de nuevo o escribe /cancelar.");
  }
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

// Comprobamos si es un fan con suscripción activa
const activeSub = await env.DB.prepare("SELECT * FROM subscriptions s JOIN subscribers u ON u.id = s.subscriber_id WHERE u.telegram_id = ? AND s.status = 'active'").bind(telegramId).first();

if (activeSub) {
  await sendMenuFanActive(env, chatId);
} else {
  await sendMenuFan(env, chatId);
}
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
  
  // Guardamos el estado de que está esperando el hash
  await env.KV.put(`state:${telegramId}`, "awaiting_hash", { expirationTtl: 3600 });
  
  const msg = `💎 *Suscripción VIP*\n\n1. Envía exactamente **1 USDT** (red BEP20) a esta dirección:\n\n\`${MASTER_WALLET}\`\n\n2. Cuando lo hayas enviado, **pégame aquí el hash de la transacción** (empieza por 0x...).\n\n_⏱ El sistema verificará el hash automáticamente._`;
  return await sendMessageWithButtons(env, chatId, msg, [[{ text: "🔙 Volver al menú", callback_data: "fan_menu" }]]);
}
if (data === "renew_sub") {
  // Le mostramos la misma dirección de pago, pero el mensaje es de renovación
  const msg = `💎 *Renovación de Suscripción*\n\nEnvía exactamente **1 USDT** (red BEP20) a esta dirección:\n\n\`${MASTER_WALLET}\`\n\nAl detectar el pago, sumaremos 30 días a tu vencimiento actual.\n\n_⏱ El sistema revisa los pagos cada minuto (horario UTC)._`;
  return await sendMessageWithButtons(env, chatId, msg, [[{ text: "🔙 Volver al menú", callback_data: "fan_menu" }]]);
}
  if (data === "status") {
    const sub = await env.DB.prepare("SELECT s.* FROM subscriptions s JOIN subscribers u ON u.id = s.subscriber_id WHERE u.telegram_id = ? AND s.status = 'active'").bind(telegramId).first();
    if (!sub) return await sendMessageWithButtons(env, chatId, "📭 No tienes suscripción activa.", [[{ text: "🔙 Volver al Menú Principal", callback_data: "fan_menu" }]]);
    const link = await createInviteLink(env, await env.KV.get("config:channel_id"), `fan_${telegramId}_${Date.now()}`);
    return await sendMessageWithButtons(env, chatId, `✅ Activa hasta: *${sub.expires_at}*`, [[{ text: "🚪 Entrar al Canal VIP", url: link }], [{ text: "🔙 Volver al Menú Principal", callback_data: "fan_menu" }]]);
  }
  if (data === "how_it_works") return await sendMessageWithButtons(env, chatId, "📚 *¿Cómo funciona Lumen VIP?*\n\nPagas **1 USDT al mes** y obtienes acceso total e inmediato a nuestro canal VIP.\n\n✅ *¿Qué incluye tu suscripción?*\n• Acceso al contenido exclusivo de **TODAS** las creadoras de la plataforma.\n• No tienes que pagar suscripciones individuales por cada creadora.\n• El acceso es por 30 días. Cuando vence, puedes volver a renovar si quieres seguir disfrutando del contenido.\n• No hay cobros automáticos, tú decides cuándo renovar.\n\n💎 *¿Cómo empiezo?*\nToca el botón de \"Suscribirme\", envía 1 USDT a la dirección que te dará el bot, y en 1 minuto recibirás tu enlace de acceso automático.", [[{ text: "🔙 Volver al Menú Principal", callback_data: "fan_menu" }]]);
  if (data === "support_fan") return await sendMessageWithButtons(env, chatId, "🆘 *Centro de Ayuda*", [[{ text: "⏳ No me llega el enlace de acceso", callback_data: "faq_wait" }],[{ text: "💰 He pagado pero no tengo acceso", callback_data: "faq_pay" }],[{ text: "📅 ¿Cómo renuevo mi suscripción?", callback_data: "faq_renew" }],[{ text: "🌐 ¿En qué red debo enviar el USDT?", callback_data: "faq_net" }],[{ text: "👤 Hablar con un administrador", callback_data: "faq_human" }],[{ text: "🔙 Volver al Menú Principal", callback_data: "fan_menu" }]]);
  if (data === "faq_wait") return await sendMessageWithButtons(env, chatId, "El sistema revisa pagos cada minuto. Espera 2 minutos y revisa 'Mi Estado'.", [[{ text: "🔙 Volver Atrás", callback_data: "support_fan" }]]);
  if (data === "faq_pay") return await sendMessageWithButtons(env, chatId, "Asegúrate de enviar 1 USDT o más a la wallet mostrada.", [[{ text: "🔙 Volver Atrás", callback_data: "support_fan" }]]);
  if (data === "faq_renew") return await sendMessageWithButtons(env, chatId, "Tu suscripción dura 30 días. Toca 'Suscribirme' de nuevo y envía 1 USDT.", [[{ text: "🔙 Volver Atrás", callback_data: "support_fan" }]]);
  if (data === "faq_net") return await sendMessageWithButtons(env, chatId, "Debes enviar USDT por la red *BNB Smart Chain (BEP20)*.", [[{ text: "🔙 Volver Atrás", callback_data: "support_fan" }]]);
  if (data === "faq_human") return await sendMessageWithButtons(env, chatId, "Escribe tu problema y un administrador te responderá.", [[{ text: "🔙 Volver Atrás", callback_data: "support_fan" }]]);
  if (data === "fan_menu") {
  await env.KV.delete(`state:${telegramId}`);
  // Comprobamos si sigue suscrito antes de mostrar el menú
  const activeSub = await env.DB.prepare("SELECT s.* FROM subscriptions s JOIN subscribers u ON u.id = s.subscriber_id WHERE u.telegram_id = ? AND s.status = 'active'").bind(telegramId).first();
  if (activeSub) {
    return await sendMenuFanActive(env, chatId);
  } else {
    return await sendMenuFan(env, chatId);
  }
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
  if (state === "paused") return await sendMessageWithButtons(env, chatId, "⏳ El registro está cerrado temporalmente.", [[{ text: "🔙 Volver al Menú Principal", callback_data: "fan_menu" }]]);
  
  const randomCode = Math.floor(1000 + Math.random() * 9000).toString();
  await env.KV.put(`verify_code:${telegramId}`, randomCode, { expirationTtl: 3600 });
  await env.KV.put(`verify_state:${telegramId}`, "waiting_video", { expirationTtl: 3600 });
  
  return await sendMessageWithButtons(env, chatId, `🎬 *Verificación*\n\nEnvía una Nota de Video...`, [[{ text: "🔙 Cancelar", callback_data: "fan_menu" }]]);
}
  if (data === "creator_upload") { 
  await env.KV.put(`upload_state:${telegramId}`, "waiting", { expirationTtl: 3600 }); 
  return await sendMessageWithButtons(env, chatId, `📤 *Subir Contenido*\n\nEnvía tu foto, video o nota de video. Se publicará al instante en el canal VIP.\n\n✅ *Qué puedes incluir:*\n• *Enlaces a tus redes:* Instagram, TikTok, OnlyFans, etc.\n• *Hashtags (#):* Para que los fans encuentren tu contenido.\n• *Apoyo con Estrellas (⭐):* Puedes pedir a tus fans que te envíen Estrellas como muestra de apoyo. Estas se acumulan a tu favor para el bono de calidad.\n\n❌ *Prohibido (Expulsión y pérdida de monetización):*\n• *CSAM:* Cualquier contenido de abuso o explotación infantil.\n• *Bestialidad:* Contenido sexual con animales.\n• *No consensuado:* Contenido sexual de personas sin su permiso.`, [[{ text: "🔙 Volver al Menú Principal", callback_data: "creator_menu" }]]); 
}
  if (data === "creator_panel") {
  const c = await env.DB.prepare("SELECT * FROM creators WHERE telegram_id = ?").bind(telegramId).first();
  const f = await env.DB.prepare("SELECT COUNT(*) as t FROM subscribers WHERE referred_by = ?").bind(c.start_code).first();
  
  let penaltyText = "";
  if (c.penalty_weeks > 0) {
    penaltyText = `\n⚠️ *Penalización activa:* -${c.penalty_weeks * 10}% de comisión y *pérdida de calidad* este mes.`;
  }
  
  return await sendMessageWithButtons(env, chatId, `📊 *Mi Panel*\n\nFans: ${f.t}\nEstado: ${c.verified ? "✅ Verificada" : "⏳ Pendiente"}${penaltyText}`, [[{ text: "🔙 Volver al Menú Principal", callback_data: "creator_menu" }]]);
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
    return await sendMessageWithButtons(env, chatId, `💰 *Mis Ganancias*\n\nFans: ${fans}\nComisión: ${(pct*100)}%\nCalidad: ${qualityIndex.toFixed(2)} ⭐\n\nDesglose:\n• Comisión: ${commission.toFixed(2)} USDT\n• Bono: ${bonus.toFixed(2)} USDT\n\n*Total estimado:* ${(commission+bonus).toFixed(2)} USDT`, [[{ text: "🔙 Volver al Menú Principal", callback_data: "creator_menu" }]]);
  }
  if (data === "creator_wallet") { 
    const c = await env.DB.prepare("SELECT wallet_address FROM creators WHERE telegram_id = ?").bind(telegramId).first();
    const hasWallet = c && c.wallet_address;
    const txt = hasWallet ? `🏦 *Mi Wallet*\n\nTu dirección actual es:\n\`${c.wallet_address}\`\n\nSi quieres cambiarla, envíame la nueva dirección por este chat.` : `🏦 *Configura tu Wallet para cobrar*\n\nPara recibir tus pagos, necesitas una wallet.\n1. Descarga una app de abajo.\n2. Busca USDT en red BEP20.\n3. Copia tu dirección (0x...).\n4. Envíamela por este chat.`;
    await env.KV.put(`state:${telegramId}`, "awaiting_wallet", { expirationTtl: 3600 }); 
    return await sendMessageWithButtons(env, chatId, txt, [[{ text: "📲 SafePal", url: "https://www.safepal.com/download" }, { text: "📲 Trust", url: "https://trustwallet.com/download" }],[{ text: "▶️ Tutorial YouTube", url: "https://www.youtube.com/results?search_query=como+crear+wallet+usdt+bep20" }],[{ text: "🔙 Volver al Menú Principal", callback_data: "creator_menu" }]]); 
  }
  if (data === "creator_channel_link") { 
    const link = await createInviteLink(env, await env.KV.get("config:channel_id"), `c_${telegramId}_${Date.now()}`); 
    return await sendMessageWithButtons(env, chatId, "🔗 *Acceso al Canal*", [[{ text: "🚪 Entrar al Canal", url: link }], [{ text: "🔙 Volver al Menú Principal", callback_data: "creator_menu" }]]); 
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
            [{ text: "🔙 Volver al Menú Principal", callback_data: "creator_menu" }]
          ]
        } 
      }) 
    }).then(r => r.json());
    
  } catch (e) {
    // Si aún así falla, te avisa a ti pero NO a la creadora con tecnicismos
    await sendMessage(env, ADMIN_ID, `🚨 Error en enlace de fans (ID ${telegramId}): ${e.message}`);
    return await sendMessageWithButtons(env, chatId, "⏳ Estamos teniendo un problema técnico. Inténtalo más tarde.", [[{ text: "🔙 Volver al Menú Principal", callback_data: "creator_menu" }]]);
  }
}
  if (data === "creator_norms") {
  const txt = `📜 *Normas y Privacidad*\n\n✅ *Permitido:*\nTodo el contenido legal para adultos (fotos, videos, desnudos, explícito).\nEnlaces a redes sociales (Instagram, TikTok, OnlyFans, etc.).\nHashtags y peticiones de apoyo con Estrellas (⭐).\n\n❌ *Prohibido (Expulsión y pérdida de monetización):*\n• *CSAM:* Cualquier contenido de abuso o explotación infantil.\n• *Bestialidad:* Contenido sexual con animales.\n• *No consensuado:* Contenido sexual de personas sin su permiso.\n• Enlaces a otros canales o bots de Telegram.\n\n⚠️ *Regla de Monetización:*\nDebes subir un mínimo de *3 publicaciones cada 7 días*. \nSi fallas una semana, perderás un *10% de tu comisión* y el *bono de calidad* de ese mes. Las penalizaciones son acumulativas (si fallas 2 semanas, pierdes el 20%).\n\n🔒 *Privacidad:*\nTus datos (ID de Telegram y wallet) solo se usan para gestionar tus pagos. No se comparten con terceros.`;
  return await sendMessageWithButtons(env, chatId, txt, [[{ text: "🔙 Volver al Menú Principal", callback_data: "creator_menu" }]]);
}
  if (data === "creator_calc") {
  const txt = `🧮 *Transparencia de Ganancias*\n\n*1. Comisión por Fans:*\nCobras un porcentaje de cada suscripción de 1 USDT que traigas. El porcentaje sube según cuántos fans activos tengas:\n• 1 a 99 fans: *50%* (0.50 USDT por fan)\n• 100 a 499 fans: *60%* (0.60 USDT por fan)\n• 500 a 999 fans: *70%* (0.70 USDT por fan)\n• 1,000 a 4,999 fans: *80%* (0.80 USDT por fan)\n• Más de 5,000 fans: *90%* (0.90 USDT por fan)\n\n*2. Bono por Calidad (Estrellas):*\nEl Índice de Calidad se calcula dividiendo *todas las Estrellas (⭐) que recibas en el mes (de cualquier fan, sin importar quién te trajo)* entre tus fans activos. Este bono sale del margen del dueño, no te quita tu comisión:\n• Índice 0 a 0.99: *Sin bono*\n• Índice 1.0 a 1.99: *🥉 Bronce (5%)*\n• Índice 2.0 a 2.99: *🥈 Plata (10%)*\n• Índice 3.0 a 3.99: *🥇 Oro (20%)*\n• Índice 4.0 a 4.99: *💎 Diamante (30%)*\n• Índice 5.0 o más: *👑 Leyenda (40%)*\n\n*3. Pago:*\nEl día 1 de cada mes se te envía automáticamente a tu wallet de USDT (BEP20).`;
  return await sendMessageWithButtons(env, chatId, txt, [[{ text: "🔙 Volver al Menú Principal", callback_data: "creator_menu" }]]);
}
  if (data === "creator_tutorial") {
  const txt = `📚 *Guía Rápida para Creadoras*\n\n*1. Configura tu Wallet:* Ve a "🏦 Mi Wallet" y envía tu dirección USDT (BEP20) para recibir tus pagos.\n\n*2. Sube tu contenido:* Toca "📤 Subir Contenido". Envía fotos o videos. El bot los publicará en el canal VIP.\n\n*3. Consigue Fans:* Usa "🎯 Enlace Fans" para copiar tu enlace único. Compártelo en tus redes (Instagram, TikTok, etc.). Cada fan que entre por ahí contará para tus ganancias.\n\n*4. Mira tus Ganancias:* En "💰 Mis Ganancias" verás cuánto llevas acumulado. Recuerda que el día 1 de cada mes recibes tu pago automático.\n\n*5. Calidad:* En "🧮 Cómo se calcula" tienes todas las reglas de comisiones y el bono por Estrellas.`;
  return await sendMessageWithButtons(env, chatId, txt, [[{ text: "🔙 Volver al Menú Principal", callback_data: "creator_menu" }]]);
}
  if (data === "creator_support") {
  try {
    const groupLinkRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/createChatInviteLink`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: env.CREATORS_GROUP_ID, name: `creator_${telegramId}` }) }).then(x => x.json());
    const groupLink = groupLinkRes.ok ? groupLinkRes.result.invite_link : null;
    if (!groupLink) throw new Error("No se pudo crear el enlace");
    
    const txt = `🆘 *Soporte para Creadoras*\n\nEste es tu espacio de ayuda. Entra al grupo para:\n• Resolver dudas técnicas (subir contenido, enlaces, wallet).\n• Ver los avisos de pago con su hash de transacción.\n• Hablar con el administrador y con otras creadoras.`;
    
    return await sendMessageWithButtons(env, chatId, txt, [[{ text: "🚪 Entrar al Grupo de Creadoras", url: groupLink }], [{ text: "🔙 Volver al Menú Principal", callback_data: "creator_menu" }]]);
  } catch (e) {
    return await sendMessageWithButtons(env, chatId, "⏳ El grupo de soporte no está disponible en este momento. Inténtalo más tarde.", [[{ text: "🔙 Volver al Menú Principal", callback_data: "creator_menu" }]]);
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
  if (data === "admin_ban_prompt") {
  await env.KV.put(`state:${telegramId}`, "awaiting_ban_id", { expirationTtl: 3600 });
  return await sendMessage(env, chatId, "🚫 Para banear a una creadora, envíame su ID de Telegram (el número que aparece en la lista).\n\n*Escribe /cancelar para salir.*");
}
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
  
  return await sendMessageWithButtons(env, chatId, `📈 *Estadísticas Generales*\n\nFans Totales: ${s.n}\nCreadoras Activas: ${c.n}\nSuscripciones Activas: ${act.n}\nIngresos del Mes: ${income.n.toFixed(2)} USDT`, [[{ text: "🔙 Volver al Menú Principal", callback_data: "admin_menu" }]]); 
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
if (page > 0) buttons.push([{ text: "⬅️ Página Anterior", callback_data: `admin_creators_page_${page - 1}` }]);
if ((page + 1) * limit < total.n) buttons.push([{ text: "Página Siguiente ➡️", callback_data: `admin_creators_page_${page + 1}` }]);
buttons.push([{ text: "🚫 Banear Creadora por ID", callback_data: "admin_ban_prompt" }]);
buttons.push([{ text: "🔙 Volver al Menú Principal", callback_data: "admin_menu" }]);
return await sendMessageWithButtons(env, chatId, t, buttons);
}
  if (data === "admin_creators") return await handleCallback({ ...cb, data: "admin_creators_page_0" }, env); // Ir a la página 1
  
  // Paginación Pagos
if (data.startsWith("admin_payments_page_")) {
  const page = parseInt(data.split("_")[3]) || 0;
  const limit = 5;
  const offset = page * limit;
  
  const now = new Date();
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  
  // Resumen del mes
  const fanPayments = await env.DB.prepare("SELECT COUNT(*) as n FROM payments WHERE period = ? AND subscriber_id != creator_id").bind(period).first();
  const totalRecaudado = fanPayments.n * 1.0;
  const totalCreadoras = await env.DB.prepare("SELECT COUNT(*) as n FROM payments WHERE period = ? AND subscriber_id = creator_id").bind(period).first();
  
  // Lista de pagos a creadoras
  const p = await env.DB.prepare("SELECT c.display_name, p.amount_usdt, p.tx_hash FROM payments p JOIN creators c ON c.id = p.creator_id WHERE p.subscriber_id = p.creator_id LIMIT ? OFFSET ?").bind(limit, offset).all();
  
  let t = `💵 *Ingresos y Pagos (Pág ${page + 1})*\n\n`;
  t += `📅 Mes: ${period}\n`;
  t += `👤 Fans que pagaron: ${fanPayments.n}\n`;
  t += `💰 Total recaudado: ${totalRecaudado.toFixed(2)} USDT\n`;
  t += `💸 Pagos a creadoras: ${totalCreadoras.n}\n\n`;
  
  if (p.results.length > 0) {
    t += `*Últimos pagos a creadoras:*\n`;
    for (const x of p.results) t += `• ${x.display_name}: ${x.amount_usdt.toFixed(2)} USDT\n  [Ver en BscScan](https://bscscan.com/tx/${x.tx_hash})\n`;
  } else {
    t += "No hay pagos a creadoras registrados este mes.";
  }
  
  const buttons = [];
  if (page > 0) buttons.push([{ text: "⬅️ Página anterior", callback_data: `admin_payments_page_${page - 1}` }]);
  if ((page + 1) * limit < totalCreadoras.n) buttons.push([{ text: "Página siguiente ➡️", callback_data: `admin_payments_page_${page + 1}` }]);
  buttons.push([{ text: "🔙 Volver al Menú Principal", callback_data: "admin_menu" }]);
  
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
      return await sendMessageWithButtons(env, chatId, "⏸️ *Registro Pausado*", [[{ text: "🔙 Volver al Menú Principal", callback_data: "admin_menu" }]]); 
    } else { 
      await env.KV.put("config:creator_registration", "open"); 
      return await sendMessageWithButtons(env, chatId, "▶️ *Registro Activado*", [[{ text: "🔙 Volver al Menú Principal", callback_data: "admin_menu" }]]); 
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
    [{ text: "💎 Suscribirme — 1 USDT", callback_data: "subscribe" }],
    [{ text: "📊 Mi Estado de Suscripción", callback_data: "status" }, { text: "📚 ¿Cómo funciona Lumen VIP?", callback_data: "how_it_works" }],
    [{ text: "🎨 Quiero ser Creadora", callback_data: "become_creator" }],
    [{ text: "🆘 Soporte", callback_data: "support_fan" }]
  ]); 
}
async function sendMenuFanActive(env, chatId) { 
  await sendMessageWithButtons(env, chatId, "👋 *¡Hola de nuevo, Fan VIP!*\n\nTu suscripción está activa. ¿Qué quieres hacer hoy?", [
    [{ text: "📊 Ver mi Estado de Suscripción", callback_data: "status" }],
    [{ text: "💎 Renovar mi Suscripción por 1 USDT", callback_data: "renew_sub" }],
    [{ text: "📚 ¿Cómo funciona Lumen VIP?", callback_data: "how_it_works" }, { text: "🆘 Soporte y Ayuda", callback_data: "support_fan" }],
    [{ text: "🎨 Quiero ser Creadora", callback_data: "become_creator" }]
  ]); 
}
async function sendMenuCreator(env, chatId) { 
  await sendMessageWithButtons(env, chatId, "👩‍🎨 *Menú de Creadora*\n\nElige una opción:", [
    [{ text: "📤 Subir Contenido al Canal VIP", callback_data: "creator_upload" }],
    [{ text: "📊 Mi Panel de Rendimiento", callback_data: "creator_panel" }, { text: "💰 Mis Ganancias Acumuladas", callback_data: "creator_earnings" }],
    [{ text: "🏦 Mi Wallet de Pagos", callback_data: "creator_wallet" }, { text: "🔗 Enlace de Acceso al Canal", callback_data: "creator_channel_link" }],
    [{ text: "🎯 Enlace de Captación para Fans", callback_data: "creator_ref_link" }, { text: "📜 Normas y Privacidad", callback_data: "creator_norms" }],
    [{ text: "🧮 Cómo se Calculan las Ganancias", callback_data: "creator_calc" }, { text: "📚 Guía y Tutorial de la Creadora", callback_data: "creator_tutorial" }],
    [{ text: "🆘 Soporte Técnico", callback_data: "creator_support" }]
  ]); 
}
async function sendMenuAdmin(env, chatId) { 
  const state = await env.KV.get("config:creator_registration") || "open"; 
  const pauseBtn = state === "open" ? "⏸️ Pausar Nuevas Creadoras" : "▶️ Reanudar Nuevas Creadoras"; 
  await sendMessageWithButtons(env, chatId, "⚙️ *Panel de Administración*\n\nElige una opción:", [
    [{ text: "📈 Estadísticas Generales", callback_data: "admin_stats" }],
    [{ text: "👥 Gestionar Creadoras", callback_data: "admin_creators" }, { text: "💵 Ingresos y Pagos", callback_data: "admin_payments" }],
    [{ text: pauseBtn, callback_data: "admin_pause" }]
  ]); 
}
async function checkReminders(env) {
  const now = new Date();
  
  // Buscamos suscripciones activas que vencen en 1, 3 o 7 días
  const subscriptions = await env.DB.prepare("SELECT s.*, u.telegram_id FROM subscriptions s JOIN subscribers u ON u.id = s.subscriber_id WHERE s.status = 'active'").all();
  
  for (const sub of subscriptions.results) {
    const expires = new Date(sub.expires_at);
    const diffDays = Math.ceil((expires - now) / (1000 * 60 * 60 * 24));
    
    let daysToWarn = 0;
    if (diffDays === 7) daysToWarn = 7;
    if (diffDays === 3) daysToWarn = 3;
    if (diffDays === 1) daysToWarn = 1;
    
    if (daysToWarn > 0) {
      // Comprobamos si ya le hemos enviado este aviso
      const kvKey = `reminder_${sub.subscriber_id}_${daysToWarn}`;
      const alreadySent = await env.KV.get(kvKey);
      
      if (!alreadySent) {
        // Enviamos el aviso y guardamos el candado en KV (caduca en 2 días)
        await sendMessage(env, sub.telegram_id, `⏳ *Aviso de Vencimiento*\n\nTu suscripción a Lumen VIP vence en *${daysToWarn} días*.\n\nPara no perder el acceso al contenido de todas las creadoras, puedes renovar ahora por 1 USDT.\n\n_(Los avisos se envían a las 12:00 UTC)._`);
        await env.KV.put(kvKey, "sent", { expirationTtl: 172800 }); // 2 días de caducidad
      }
    }
  }
}
