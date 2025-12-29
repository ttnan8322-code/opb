import Drop from "../models/Drop.js";
import { getRandomCardByProbability, getCardById } from "../cards.js";
import { buildDropEmbed } from "./cardEmbed.js";
import Progress from "../models/Progress.js";
import Balance from "../models/Balance.js";
import Quest from "../models/Quest.js";
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

const PULL_PROBABILITIES = { C: 60, B: 30, A: 8, S: 1, ITEM: 1 };
const RANK_XP = { C: 20, B: 50, A: 75, S: 100 };

const timers = new Map(); // guildId -> { timer, intervalMs }
const activeDrops = new Map(); // token -> { guildId, channelId, cardId, level, claimed, messageId, timeout }

function randomToken() {
  return Math.random().toString(36).slice(2, 10);
}

function sampleLevel(maxLevel = 50) {
  const lambda = 0.1;
  const weights = new Array(maxLevel);
  let sum = 0;
  for (let k = 1; k <= maxLevel; k++) {
    const w = Math.exp(-lambda * (k - 1));
    weights[k - 1] = w;
    sum += w;
  }
  const r = Math.random() * sum;
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (r <= acc) return i + 1;
  }
  return maxLevel;
}

async function sendDropNowForSetting(client, setting) {
  try {
    const channelId = setting.channelId;
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch || !ch.send) {
      console.warn(`Drop manager: unable to fetch channel ${channelId} for guild ${setting.guildId}`);
      return;
    }

    // pick a random card using same probabilities as pulls
    // Ensure we never send upgraded variants as drops (defensive check)
    let card = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      const c = getRandomCardByProbability(PULL_PROBABILITIES);
      if (!c) break;
      if (c.isUpgrade) continue;
      if (c.pullable === false) continue;
      card = c;
      break;
    }
    if (!card) {
      console.warn('Drop manager: no suitable card chosen for drop.');
      return;
    }

    const level = sampleLevel(50);
    const token = randomToken();

    const embed = buildDropEmbed(card, level, client.user);

    const claimButton = new ButtonBuilder().setCustomId(`drop_claim:${token}`).setLabel("Claim").setStyle(ButtonStyle.Success);
    const row = new ActionRowBuilder().addComponents(claimButton);

    const sent = await ch.send({ content: "A card has dropped! First to claim gets it.", embeds: [embed], components: [row] });

    // store active drop
    const expireMs = Math.max(setting.intervalMs || (5 * 60 * 1000), 5 * 60 * 1000);
    const timeout = setTimeout(() => {
      // expire the drop: remove from activeDrops and disable button
      const d = activeDrops.get(token);
      if (d && !d.claimed) {
        activeDrops.delete(token);
        (async () => {
          try {
            const ch = await client.channels.fetch(channelId).catch(() => null);
            if (!ch) return;
            const msg = await ch.messages.fetch(sent.id).catch(() => null);
            if (!msg) return;
            const disabledButton = new ButtonBuilder().setCustomId(`drop_claim:${token}`).setLabel('Expired').setStyle(ButtonStyle.Secondary).setDisabled(true);
            const disabledRow = new ActionRowBuilder().addComponents(disabledButton);
            await msg.edit({ components: [disabledRow] }).catch(() => {});
          } catch (e) {
            // ignore
          }
        })();
      }
    }, expireMs + 1000);

    activeDrops.set(token, {
      guildId: setting.guildId,
      channelId,
      cardId: card.id,
      level,
      claimed: false,
      messageId: sent.id,
      timeout,
    });

  } catch (e) {
    console.error('Drop manager send error:', e && e.message ? e.message : e);
  }
}

async function scheduleSetting(client, setting) {
  const guildId = setting.guildId;
  // clear existing timer if any
  if (timers.has(guildId)) {
    const t = timers.get(guildId);
    clearInterval(t.timer);
    timers.delete(guildId);
  }
  if (!setting.enabled) return;
  const intervalMs = setting.intervalMs || 5 * 60 * 1000;
  const timer = setInterval(() => {
    // don't await in setInterval
    sendDropNowForSetting(client, setting).catch(() => {});
  }, intervalMs);
  timers.set(guildId, { timer, intervalMs, setting });
}

export async function init(client) {
  try {
    const settings = await Drop.find({ enabled: true });
    for (const s of settings) {
      await scheduleSetting(client, s);
    }
  } catch (e) {
    console.error('Drop manager init error:', e && e.message ? e.message : e);
  }
}

export async function setDropChannel(client, guildId, channelId, intervalMs = 5 * 60 * 1000, sendNow = true) {
  try {
    const s = await Drop.findOneAndUpdate({ guildId }, { guildId, channelId, intervalMs, enabled: true }, { upsert: true, new: true });
    await scheduleSetting(client, s);
    if (sendNow) await sendDropNowForSetting(client, s);
    return s;
  } catch (e) {
    console.error('Drop manager setDropChannel error:', e && e.message ? e.message : e);
    throw e;
  }
}

export async function clearDropChannel(client, guildId) {
  try {
    await Drop.deleteOne({ guildId });
    const t = timers.get(guildId);
    if (t) {
      clearInterval(t.timer);
      timers.delete(guildId);
    }
    return true;
  } catch (e) {
    console.error('Drop manager clearDropChannel error:', e && e.message ? e.message : e);
    return false;
  }
}

export async function claimDrop(token, userId) {
  const entry = activeDrops.get(token);
  if (!entry) return { ok: false, reason: 'not_found' };
  if (entry.claimed) return { ok: false, reason: 'already_claimed', claimedBy: entry.claimedBy };

  // mark claimed synchronously to avoid races
  entry.claimed = true;
  entry.claimedBy = userId;
  if (entry.timeout) clearTimeout(entry.timeout);

  // perform DB award logic similar to pull
  try {
    let card = getCardById(entry.cardId);
    if (!card) {
      try {
        // Fallback: try case-insensitive id or name match to be more robust
        const { cards } = await import('../cards.js');
        const needle = String(entry.cardId || '').toLowerCase();
        card = cards.find(c => String(c.id || '').toLowerCase() === needle || String(c.name || '').toLowerCase() === needle) || null;
      } catch (e) {
        card = null;
      }
    }
    if (!card) {
      console.warn(`claimDrop: card not found for token=${token} cardId=${entry.cardId}`);
      return { ok: false, reason: 'card_not_found' };
    }

    // ensure user's progress doc
    let progDoc = await Progress.findOne({ userId });
    if (!progDoc) progDoc = new Progress({ userId, cards: {} });

    let userCardsMap;
    if (progDoc.cards instanceof Map) userCardsMap = progDoc.cards;
    else userCardsMap = new Map(Object.entries(progDoc.cards || {}));

    // Build upgrade chain (base -> evolutions)
    function getUpgradeChainSync(card) {
      const chain = [card];
      const visited = new Set([card.id]);
      let current = card;
      while (current && current.evolutions && current.evolutions.length > 0) {
        const nextCardId = current.evolutions[0];
        const nextCard = getCardById(nextCardId);
        if (!nextCard || visited.has(nextCard.id)) break;
        visited.add(nextCard.id);
        chain.push(nextCard);
        current = nextCard;
      }
      return chain;
    }

    const chain = getUpgradeChainSync(card);
    // If user already owns a higher/evolved version, treat this drop as a duplicate
    // and award XP to the highest owned version rather than granting an upgraded card.
    let highestOwnedId = null;
    for (let i = chain.length - 1; i >= 0; i--) {
      const c = chain[i];
      const e = userCardsMap.get(c.id);
      if (e && (e.count || 0) > 0) { highestOwnedId = c.id; break; }
    }

    let result = { isNew: false, xpGain: 0, leveled: false };

    if (highestOwnedId) {
      // Award XP to the existing highest-owned entry (duplicate conversion)
      const existing = userCardsMap.get(highestOwnedId);
      const ownedCard = getCardById(highestOwnedId);
      const xpGain = RANK_XP[(ownedCard.rank || 'C').toUpperCase()] || 0;
      existing.xp = (existing.xp || 0) + xpGain;
      result.xpGain = xpGain;
      result.isNew = false;
      while ((existing.xp || 0) >= 100) {
        existing.xp -= 100;
        existing.level = (existing.level || 0) + 1;
        result.leveled = true;
      }
      userCardsMap.set(highestOwnedId, existing);
      // persist and return info
      progDoc.cards = userCardsMap;
      progDoc.markModified('cards');
      await progDoc.save();

      // award balance XP to user as before
      try {
        let balDoc = await Balance.findOne({ userId });
        if (!balDoc) { balDoc = new Balance({ userId, amount: 500, xp: 0, level: 0 }); }
        balDoc.xp = (balDoc.xp || 0) + 1;
        while ((balDoc.xp || 0) >= 100) {
          balDoc.xp -= 100;
          balDoc.level = (balDoc.level || 0) + 1;
        }
        await balDoc.save();
      } catch (e) { /* non-fatal */ }

      return { ok: true, card: getCardById(highestOwnedId), level: entry.level, result, messageId: entry.messageId, channelId: entry.channelId, token };
    }

    // No higher owned version — award the dropped card (base behavior)
    const storedCard = card;
    const existing = userCardsMap.get(storedCard.id);

    if (existing && existing.count > 0) {
      const xpGain = RANK_XP[(storedCard.rank || 'C').toUpperCase()] || 0;
      existing.xp = (existing.xp || 0) + xpGain;
      result.xpGain = xpGain;
      result.isNew = false;
      while ((existing.xp || 0) >= 100) {
        existing.xp -= 100;
        existing.level = (existing.level || 0) + 1;
        result.leveled = true;
      }
      userCardsMap.set(storedCard.id, existing);
    } else {
      const newEntry = { count: 1, xp: 0, level: Math.min(50, entry.level || 1), acquiredAt: Date.now() };
      userCardsMap.set(storedCard.id, newEntry);
      result.isNew = true;
    }

    // write back
    progDoc.cards = userCardsMap;
    progDoc.markModified('cards');
    await progDoc.save();

    // update quests (best effort)
    try {
      const QuestModel = (await import('../models/Quest.js')).default;
      const [dailyQuests, weeklyQuests] = await Promise.all([
        QuestModel.getCurrentQuests('daily'),
        QuestModel.getCurrentQuests('weekly')
      ]);
      if (dailyQuests && dailyQuests.recordAction) await dailyQuests.recordAction(userId, 'pull', 1);
      if (weeklyQuests && weeklyQuests.recordAction) await weeklyQuests.recordAction(userId, 'pull', 1);
    } catch (e) { /* non-fatal */ }

    // award 1 xp to user balance
    try {
      let balDoc = await Balance.findOne({ userId });
      if (!balDoc) { balDoc = new Balance({ userId, amount: 500, xp: 0, level: 0 }); }
      balDoc.xp = (balDoc.xp || 0) + 1;
      while ((balDoc.xp || 0) >= 100) {
        balDoc.xp -= 100;
        balDoc.level = (balDoc.level || 0) + 1;
      }
      await balDoc.save();
    } catch (e) { /* non-fatal */ }

    return { ok: true, card: storedCard, level: entry.level, result, messageId: entry.messageId, channelId: entry.channelId, token };
  } catch (e) {
    console.error('claimDrop error:', e && e.message ? e.message : e);
    return { ok: false, reason: 'error', error: e };
  }
}

export default { init, setDropChannel, clearDropChannel, claimDrop };

