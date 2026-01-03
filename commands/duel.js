import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import Balance from "../models/Balance.js";
import Duel from "../models/Duel.js";
import Progress from "../models/Progress.js";
// import WeaponInventory from "../models/WeaponInventory.js";
import { getCardById } from "../cards.js";
import { roundNearestFive, roundRangeToFive } from "../lib/stats.js";
import { computeTeamBoosts } from "../lib/boosts.js";
import { parseHaki, applyHakiStatBoosts, DEVIL_FRUIT_USERS } from "../lib/haki.js";
import Quest from "../models/Quest.js";

const DUEL_SESSIONS = global.__DUEL_SESSIONS ||= new Map();

export const data = new SlashCommandBuilder()
  .setName("duel")
  .setDescription("Challenge another user to a duel")
  .addUserOption(opt => opt.setName("opponent").setDescription("User to duel").setRequired(true));

export const category = "Combat";
export const description = "Challenge another user to a duel";

function dayWindow() { return Math.floor(Date.now() / (24*60*60*1000)); }

function makeEmbed(title, desc) {
  return new EmbedBuilder().setTitle(title).setDescription(desc).setColor(0xFFFFFF);
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export async function execute(interactionOrMessage) {
  const isInteraction = typeof interactionOrMessage.isCommand === "function" || typeof interactionOrMessage.isChatInputCommand === "function";
  const user = isInteraction ? interactionOrMessage.user : interactionOrMessage.author;
  const channel = isInteraction ? interactionOrMessage.channel : interactionOrMessage.channel;
  const userId = user.id;
  
  let opponent;
  if (isInteraction) {
    opponent = interactionOrMessage.options.getUser("opponent");
  } else {
    // Parse prefix: "op duel @user"
    const mentioned = interactionOrMessage.mentions.users.first();
    if (!mentioned) return channel.send("Please mention a user to duel.");
    opponent = mentioned;
  }

  if (opponent.id === userId) return channel.send("You can't duel yourself!");
  if (opponent.bot) return channel.send("You can't duel bots!");

  // Prevent users from being in more than one active duel at a time
  for (const sess of DUEL_SESSIONS.values()) {
    if (!sess) continue;
    try {
      if (sess.p1?.userId === userId || sess.p2?.userId === userId) {
        const reply = "You already have an active duel in progress.";
        if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true });
        return channel.send(reply);
      }
      if (sess.p1?.userId === opponent.id || sess.p2?.userId === opponent.id) {
        const reply = `${opponent.username} is already in an active duel.`;
        if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true });
        return channel.send(reply);
      }
    } catch (e) { /* ignore malformed sessions */ }
  }

  // Get both users' teams and check they have them
  const [p1Progress, p2Progress] = await Promise.all([
    Progress.findOne({ userId }),
    Progress.findOne({ userId: opponent.id })
  ]);

  if (!p1Progress || !p1Progress.team || p1Progress.team.length === 0) {
    const reply = "You need to have a team to duel. Use `/team add` to build your team.";
    if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true });
    return channel.send(reply);
  }

  if (!p2Progress) {
    const reply = "That user doesn't have an account yet. You can invite them to start with: `op start` or `/start`.";
    if (isInteraction) return interactionOrMessage.reply({ content: "That user doesn't have an account yet. They should run `op start` or `/start` to register.", ephemeral: true });
    return channel.send(opponent.username + " doesn't have an account yet. Tell them to run `op start` or `/start` to register.");
  }

  if (!p2Progress.team || p2Progress.team.length === 0) {
    const reply = `${opponent.username} doesn't have a team set up yet.`;
    if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true });
    return channel.send(reply);
  }

  // Check duel limits (3 per day with same person)
  const [p1Duel, p2Duel] = await Promise.all([
    Duel.findOne({ userId }),
    Duel.findOne({ userId: opponent.id })
  ]);

  const win = dayWindow();
  if (p1Duel) {
    if (p1Duel.duelWindow !== win) {
      p1Duel.duelWindow = win;
      p1Duel.duelOpponents = new Map();
    }
    const duelCount = p1Duel.duelOpponents.get(opponent.id) || 0;
    // Allow bot owner unlimited duels
    const ownerId = process.env.OWNER_ID;
    if (duelCount >= 3 && String(userId) !== String(ownerId)) {
      const reply = `You've already dueled ${opponent.username} 3 times today!`;
      if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true });
      return channel.send(reply);
    }
  }

  // Send challenge embed to opponent
  const embed = makeEmbed(
    "Duel Challenge",
    `${user} is challenging you to a duel!\n\nAccept the challenge to begin battle.`
  );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`duel_accept:${userId}`).setLabel("Accept").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`duel_decline:${userId}`).setLabel("Decline").setStyle(ButtonStyle.Danger)
  );

  const msg = await channel.send({ content: opponent.toString(), embeds: [embed], components: [row] });

  // Setup duel acceptance collector (30s timeout)
  const filter = (i) => i.user.id === opponent.id;
  const collector = msg.createMessageComponentCollector({ filter, time: 45000 });

  collector.on("collect", async i => {
    try { if (!i.deferred && !i.replied) await i.deferUpdate(); } catch (e) { if (!(e && e.code === 10062)) console.error('deferUpdate error', e); }

    if (i.customId.startsWith("duel_decline")) {
      try {
        await msg.edit({ embeds: [makeEmbed("❌ Duel Declined", `${opponent.username} declined the challenge.`)], components: [] });
      } catch (e) {}
      return;
    }

    if (i.customId.startsWith("duel_accept")) {
      // Start the duel
      try {
        await msg.edit({ embeds: [makeEmbed("⚔️ Duel Started", "Loading teams...")], components: [] });
      } catch (e) {}

      // Initialize duel session
      const sessionId = `${userId}_${opponent.id}_${Date.now()}`;
      
      // Get card details and health
      // Load weapon inventories for both players to apply equipped weapon boosts
      const WeaponInventory = (await import('../models/WeaponInventory.js')).default;
      const [p1Winv, p2Winv] = await Promise.all([
        WeaponInventory.findOne({ userId }),
        WeaponInventory.findOne({ userId: opponent.id })
      ]);

      const p1HasBanner = p1Winv && p1Winv.weapons && Array.from(p1Winv.weapons.values()).some(w => w.id === 'alvida_pirates_banner_c_01');
      const p2HasBanner = p2Winv && p2Winv.weapons && Array.from(p2Winv.weapons.values()).some(w => w.id === 'alvida_pirates_banner_c_01');

      function getEquippedWeaponForCard(winv, cardId) {
        if (!winv || !winv.weapons) return null;
        if (winv.weapons instanceof Map) {
          for (const [wid, w] of winv.weapons.entries()) {
            if (w && w.equippedTo === cardId) {
              const wcard = getCardById(wid);
              if (wcard) return { id: wid, card: wcard, ...w };
            }
          }
        } else {
          for (const [wid, w] of Object.entries(winv.weapons || {})) {
            if (w && w.equippedTo === cardId) {
              const wcard = getCardById(wid);
              if (wcard) return { id: wid, card: wcard, ...w };
            }
          }
        }
        return null;
      }

      // compute team-wide boosts (hp/atk/special) for p1
      const p1TeamBoosts = computeTeamBoosts(p1Progress.team || [], p1Progress.cards || null);
      const p1Cards = p1Progress.team.map(cardId => {
        const card = getCardById(cardId);
        const hasMap = p1Progress.cards && typeof p1Progress.cards.get === 'function';
        const progress = hasMap ? (p1Progress.cards.get(cardId) || { level: 0, xp: 0 }) : (p1Progress.cards[cardId] || { level: 0, xp: 0 });
        const level = progress.level || 0;
        const mult = 1 + (level * 0.01);
        let health = Math.round((card.health || 0) * mult);
        let attackMin = Math.round((card.attackRange?.[0] || 0) * mult);
        let attackMax = Math.round((card.attackRange?.[1] || 0) * mult);
        const special = card.specialAttack ? { ...card.specialAttack, range: [(card.specialAttack.range[0] || 0) * mult, (card.specialAttack.range[1] || 0) * mult] } : null;
        let power = Math.round((card.power || 0) * mult);

        // Apply equipped weapon boosts if present
        const equipped = getEquippedWeaponForCard(p1Winv, cardId);
        if (equipped && equipped.card && card.signatureWeapon === equipped.id) {
          const weaponCard = equipped.card;
          const weaponLevel = equipped.level || 1;
          const weaponLevelBoost = (weaponLevel - 1) * 0.01;
          // only apply 25% signature when card is listed as upgrade 2+ in weapon.signatureCards
          let sigBoost = 0;
          if (weaponCard.signatureCards && Array.isArray(weaponCard.signatureCards)) {
            const idx = weaponCard.signatureCards.indexOf(cardId);
            if (idx > 0) sigBoost = 0.25;
          }
          const totalWeaponBoost = 1 + weaponLevelBoost + sigBoost;

          if (weaponCard.boost) {
            const atkBoost = Math.round((weaponCard.boost.atk || 0) * totalWeaponBoost);
            const hpBoost = Math.round((weaponCard.boost.hp || 0) * totalWeaponBoost);
            power += atkBoost;
            attackMin += atkBoost;
            attackMax += atkBoost;
            health += hpBoost;
          }
        }

        // Apply team boosts
        if (p1TeamBoosts.atk) {
          const atkMul = 1 + (p1TeamBoosts.atk / 100);
          attackMin = Math.round(attackMin * atkMul);
          attackMax = Math.round(attackMax * atkMul);
          power = Math.round(power * atkMul);
        }
        if (p1TeamBoosts.hp) {
          const hpMul = 1 + (p1TeamBoosts.hp / 100);
          health = Math.round(health * hpMul);
        }
        if (special && p1TeamBoosts.special) {
          const spMul = 1 + (p1TeamBoosts.special / 100);
          special.range = [Math.round(special.range[0] * spMul), Math.round(special.range[1] * spMul)];
        }

        // Apply banner passive boost
        const bannerSignature = ['Alvida_c_01', 'heppoko_c_01', 'Peppoko_c_01', 'Poppoko_c_01', 'koby_c_01'];
        if (p1HasBanner && bannerSignature.includes(cardId)) {
          attackMin = Math.round(attackMin * 1.05);
          attackMax = Math.round(attackMax * 1.05);
          power = Math.round(power * 1.05);
          health = Math.round(health * 1.05);
        }

        // Ensure stats are rounded to nearest 5 for consistency
        let scaled = { attackRange: [Math.round(attackMin), Math.round(attackMax)], power: Math.round(power) };
        const hakiApplied = applyHakiStatBoosts(scaled, card, progress);
        scaled = hakiApplied.scaled;
        const finalPower = roundNearestFive(Math.round(scaled.power));
        const finalAttackMin = roundNearestFive(Math.round(scaled.attackRange[0] || 0));
        const finalAttackMax = roundNearestFive(Math.round(scaled.attackRange[1] || 0));
        const finalHealth = roundNearestFive(Math.round(health * (hakiApplied.haki.armament.multiplier || 1)));
        const hakiParsed = parseHaki(card);
        if (special && special.range) special.range = roundRangeToFive([Math.round(special.range[0] || 0), Math.round(special.range[1] || 0)]);

        // Track special usage and exhaustion state for match
        // Add stamina (max 3) and attackedLastTurn flag for stamina regen rules
        return { cardId, card, scaled: { attackRange: [finalAttackMin, finalAttackMax], specialAttack: special, power: finalPower }, health: finalHealth, maxHealth: finalHealth, level, usedSpecial: false, skipNextTurnPending: false, skipThisTurn: false, stamina: 3, attackedLastTurn: false, haki: hakiParsed, dodgeChance: (hakiParsed.observation.stars || 0) * 0.05 };
      });

      // compute team-wide boosts (hp/atk/special) for p2
      const p2TeamBoosts = computeTeamBoosts(p2Progress.team || [], p2Progress.cards || null);
      const p2Cards = p2Progress.team.map(cardId => {
        const card = getCardById(cardId);
        const hasMap = p2Progress.cards && typeof p2Progress.cards.get === 'function';
        const progress = hasMap ? (p2Progress.cards.get(cardId) || { level: 0, xp: 0 }) : (p2Progress.cards[cardId] || { level: 0, xp: 0 });
        const level = progress.level || 0;
        const mult = 1 + (level * 0.01);
        let health = Math.round((card.health || 0) * mult);
        let attackMin = Math.round((card.attackRange?.[0] || 0) * mult);
        let attackMax = Math.round((card.attackRange?.[1] || 0) * mult);
        const special = card.specialAttack ? { ...card.specialAttack, range: [Math.round((card.specialAttack.range[0] || 0) * mult), Math.round((card.specialAttack.range[1] || 0) * mult)] } : null;
        let power = Math.round((card.power || 0) * mult);

        // Apply equipped weapon boosts if present
        const equipped = getEquippedWeaponForCard(p2Winv, cardId);
        if (equipped && equipped.card && card.signatureWeapon === equipped.id) {
          const weaponCard = equipped.card;
          const weaponLevel = equipped.level || 1;
          const weaponLevelBoost = (weaponLevel - 1) * 0.01;
          let sigBoost = 0;
          if (weaponCard.signatureCards && Array.isArray(weaponCard.signatureCards)) {
            const idx = weaponCard.signatureCards.indexOf(cardId);
            if (idx > 0) sigBoost = 0.25;
          }
          const totalWeaponBoost = 1 + weaponLevelBoost + sigBoost;

          if (weaponCard.boost) {
            const atkBoost = Math.round((weaponCard.boost.atk || 0) * totalWeaponBoost);
            const hpBoost = Math.round((weaponCard.boost.hp || 0) * totalWeaponBoost);
            power += atkBoost;
            attackMin += atkBoost;
            attackMax += atkBoost;
            health += hpBoost;
          }
        }

        // Apply banner passive boost
        const bannerSignature = ['Alvida_c_01', 'heppoko_c_01', 'Peppoko_c_01', 'Poppoko_c_01', 'koby_c_01'];
        if (p2HasBanner && bannerSignature.includes(cardId)) {
          attackMin = Math.round(attackMin * 1.05);
          attackMax = Math.round(attackMax * 1.05);
          power = Math.round(power * 1.05);
          health = Math.round(health * 1.05);
        }

        let scaled = { attackRange: [Math.round(attackMin), Math.round(attackMax)], power: Math.round(power) };
        const hakiApplied = applyHakiStatBoosts(scaled, card, progress);
        scaled = hakiApplied.scaled;
        const finalPower = roundNearestFive(Math.round(scaled.power));
        const finalAttackMin = roundNearestFive(Math.round(scaled.attackRange[0] || 0));
        const finalAttackMax = roundNearestFive(Math.round(scaled.attackRange[1] || 0));
        const finalHealth = roundNearestFive(Math.round(health * (hakiApplied.haki.armament.multiplier || 1)));
        const hakiParsed = parseHaki(card);
        if (special && special.range) special.range = roundRangeToFive([Math.round(special.range[0] || 0), Math.round(special.range[1] || 0)]);

        return { cardId, card, scaled: { attackRange: [finalAttackMin, finalAttackMax], specialAttack: special, power: finalPower }, health: finalHealth, maxHealth: finalHealth, level, stamina: 3, attackedLastTurn: false, haki: hakiParsed, dodgeChance: (hakiParsed.observation.stars || 0) * 0.05 };
      });

      // Determine who goes first (highest power)
      const p1Power = p1Cards.reduce((s,c) => s + (c.scaled.power || 0), 0);
      const p2Power = p2Cards.reduce((s,c) => s + (c.scaled.power || 0), 0);
      const firstPlayer = p1Power >= p2Power ? userId : opponent.id;

      DUEL_SESSIONS.set(sessionId, {
        p1: { userId, user, cards: p1Cards, lifeIndex: 0, cardsMap: p1Progress.cards || null, teamBoosts: p1TeamBoosts },
        p2: { userId: opponent.id, user: opponent, cards: p2Cards, lifeIndex: 0, cardsMap: p2Progress.cards || null, teamBoosts: p2TeamBoosts },
        currentTurn: firstPlayer,
        sessionId,
        channelId: channel.id,
        msgId: msg.id,
      });

      // Start turn
      await startDuelTurn(sessionId, channel);
    }
  });

  collector.on("end", async (collected) => {
    if (collected.size === 0) {
      try {
        await msg.edit({ embeds: [makeEmbed("Duel Expired", "Challenge expired after 30 seconds.")], components: [] });
      } catch (e) {}
    }
  });

  if (isInteraction) {
    await interactionOrMessage.reply({ content: `Duel challenge sent to ${opponent}!`, ephemeral: true });
  }
}

async function startDuelTurn(sessionId, channel) {
  const session = DUEL_SESSIONS.get(sessionId);
  if (!session) return;

  const currentIsP1 = session.currentTurn === session.p1.userId;
  const attacker = currentIsP1 ? session.p1 : session.p2;
  const defender = currentIsP1 ? session.p2 : session.p1;

  // Normalize lifeIndex to first alive if necessary
  function normalizeLifeIndex(side) {
    if (!side.cards || side.cards.length === 0) return;
    if (side.lifeIndex == null || side.lifeIndex >= side.cards.length || side.cards[side.lifeIndex].health <= 0) {
      const idx = side.cards.findIndex(c => c.health > 0);
      side.lifeIndex = idx === -1 ? side.cards.length : idx;
    }
  }
  // convert any pending skip flags (cards that used special last match-turn) into active exhaustion for this turn
  // Clear any previous "skipThisTurn" flags (they should only apply for one turn),
  // then convert any pending skips into the active exhaustion for this current turn.
  attacker.cards.forEach(c => { c.skipThisTurn = false; });
  attacker.cards.forEach(c => { if (c.skipNextTurnPending) { c.skipThisTurn = true; c.skipNextTurnPending = false; } });

  // Stamina regen: each time it's your turn, your cards gain 1 stamina (max 3)
  // only if they did NOT attack last turn. After regen, clear attackedLastTurn flags.
  attacker.cards.forEach(c => {
    if (typeof c.stamina === 'number') {
      if (!c.attackedLastTurn && c.stamina < 3) c.stamina = Math.min(3, c.stamina + 1);
      // reset flag so cards can regen on subsequent turns if they refrain from attacking
      c.attackedLastTurn = false;
    } else {
      c.stamina = 3; c.attackedLastTurn = false;
    }
  });
  // Ensure any knocked-out cards have zero stamina (stamina irrelevant when dead)
  [session.p1, session.p2].forEach(side => {
    side.cards.forEach(c => { if (c.health <= 0) c.stamina = 0; });
  });
  normalizeLifeIndex(attacker);
  normalizeLifeIndex(defender);

  // Check if defender is alive
  if (defender.lifeIndex >= defender.cards.length) {
    // Attacker won
    await endDuel(sessionId, attacker, defender, channel);
    return;
  }

  // If attacker has no playable cards this turn, auto-skip to defender.
  const attackerHasPlayable = attacker.cards.some(c => c.health > 0 && !c.skipThisTurn && (typeof c.stamina !== 'number' || c.stamina > 0));
  const defenderHasPlayable = defender.cards.some(c => c.health > 0 && !c.skipThisTurn && (typeof c.stamina !== 'number' || c.stamina > 0));
  if (!attackerHasPlayable) {
    if (defenderHasPlayable) {
      session.currentTurn = defender.userId;
      await startDuelTurn(sessionId, channel);
      return;
    } else {
      // Both sides have no playable cards — end as a draw
      await endDuelDraw(sessionId, channel);
      return;
    }
  }

  // Helper to render HP bar
  function renderHP(cur, max, len = 10) {
    const ratio = max > 0 ? cur / max : 0;
    const filled = Math.max(0, Math.min(len, Math.round(ratio * len)));
    return '▬'.repeat(filled) + '▭'.repeat(len - filled);
  }

  // Build character list text with modern UI (no emojis)
  const lines = attacker.cards.map((c, idx) => {
    const name = c.card.name;
    const hp = Math.max(0, c.health);
    const extra = c.skipThisTurn ? ' (exhausted)' : '';
    const stam = (typeof c.stamina === 'number') ? c.stamina : 3;
    return `**${idx + 1}. ${name}**${extra} — HP: ${hp}/${c.maxHealth} ${renderHP(hp, c.maxHealth)} • <:stamina:1456082884732391570> ${stam}/3`;
  }).join('\n');

  const embed = makeEmbed(
    "Your Turn",
    `${attacker.user}, choose a character to attack with!\n\n${lines}`
  );

  // Buttons for characters (disable dead or exhausted ones)
  const charButtons = attacker.cards.map((card, idx) => {
    return new ButtonBuilder()
      .setCustomId(`duel_selectchar:${sessionId}:${idx}`)
      .setLabel(`${card.card.name}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(card.health <= 0 || card.skipThisTurn || (typeof card.stamina === 'number' && card.stamina <= 0));
  });

  // Determine if the attacker has any playable characters this turn
  const hasPlayable = attacker.cards.some(c => c.health > 0 && !c.skipThisTurn && (typeof c.stamina !== 'number' || c.stamina > 0));

  const rows = [];
  for (let i = 0; i < charButtons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(charButtons.slice(i, i + 5)));
  }

  // Add a single grey Haki button; clicking it will allow selecting a character if multiple support Haki
  const anyHakiPlayable = attacker.cards.some(card => (card.haki && (card.haki.armament.present || card.haki.observation.present || card.haki.conqueror.present)) && card.health > 0 && !(typeof card.stamina === 'number' && card.stamina <= 0));
  const hakiButton = new ButtonBuilder()
    .setCustomId(`duel_haki:${sessionId}:all`)
    .setLabel(`Haki`)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(!anyHakiPlayable);
  rows.push(new ActionRowBuilder().addComponents(hakiButton));

  // Always send a fresh message for the turn to avoid reusing the same interactive message
  let msg;
  try {
    msg = await channel.send({ embeds: [embed], components: rows });
    try { const session = DUEL_SESSIONS.get(sessionId); if (session) session.msgId = msg.id; } catch (e) {}
  } catch (e) {
    // fallback: try to reuse previous message if send fails
    try {
      const session = DUEL_SESSIONS.get(sessionId);
      if (session && session.msgId) {
        msg = await channel.messages.fetch(session.msgId).catch(() => null);
        if (msg) await msg.edit({ embeds: [embed], components: rows });
      }
    } catch (err) { /* ignore */ }
    if (!msg) {
      // As a last resort create a placeholder message
      msg = await channel.send({ embeds: [embed], components: rows }).catch(() => null);
    }
  }

  const filter = (i) => i.user.id === attacker.userId;
  const collector = msg.createMessageComponentCollector({ filter, time: 45000 });

  collector.on("collect", async i => {
    if (!i.customId.startsWith("duel_selectchar") && !i.customId.startsWith("duel_haki")) return;

    // Safe defer (interaction may be already replied/expired)
    try { if (!i.deferred && !i.replied) await i.deferUpdate(); } catch (e) { if (!(e && e.code === 10062)) console.error('deferUpdate error', e); }
    const parts = i.customId.split(":");
      const charPart = parts[2];
      let charIdx = null;
      if (i.customId.startsWith("duel_selectchar")) charIdx = parseInt(charPart);
      else if (i.customId.startsWith("duel_haki") && charPart !== 'all') charIdx = parseInt(charPart);

    if (i.customId.startsWith("duel_haki")) {
      // If single 'all' button, open selector for which character's haki to use
      if (charPart === 'all') {
        // Build selector buttons for characters that support haki
        const options = attacker.cards.map((c, idx) => ({ idx, name: c.card.name, has: !!(c.haki && (c.haki.armament.present || c.haki.observation.present || c.haki.conqueror.present)), alive: c.health > 0, playable: !(typeof c.stamina === 'number' && c.stamina <= 0) }));
        const entries = options.filter(o => o.has && o.alive && o.playable);
        if (entries.length === 0) {
          try { await i.followUp({ content: 'No playable characters with Haki available.', ephemeral: true }); } catch (e) {}
          return;
        }
        const { EmbedBuilder, ActionRowBuilder, ButtonBuilder } = await import('discord.js');
        const embed = new EmbedBuilder().setTitle('Choose Haki Character').setDescription('Select which character to open Haki menu for.').setColor(0x3498db);
        const btns = entries.map(e => new ButtonBuilder().setCustomId(`duel_haki_select:${sessionId}:${e.idx}`).setLabel(e.name).setStyle(ButtonStyle.Primary));
        const selRow = new ActionRowBuilder().addComponents(btns.slice(0,5));
        try { const follow = await i.followUp({ embeds: [embed], components: [selRow], ephemeral: true }); } catch (e) {}

        // Collector for selection
        const selFilter = (ii) => ii.user.id === attacker.userId && ii.customId && ii.customId.startsWith('duel_haki_select');
          const selCollector = i.channel.createMessageComponentCollector({ filter: selFilter, time: 20000 });
          selCollector.on('collect', async ii => {
            try { if (!ii.deferred && !ii.replied) await ii.deferUpdate(); } catch (err) { if (!(err && err.code === 10062)) console.error('defer err', err); }
            const selParts = ii.customId.split(':');
            const selIdx = parseInt(selParts[2]);
            try {
              await handleHakiMenu(sessionId, selIdx, msg, attacker, defender, channel, ii);
            } catch (err) {
              console.error('handleHakiMenu error', err);
              try { await ii.followUp({ content: 'An error occurred opening Haki menu.', ephemeral: true }); } catch (e) {}
            }
            selCollector.stop();
          });
        return;
      }
      // otherwise older per-character id (fallback)
      try {
        await handleHakiMenu(sessionId, charIdx, msg, attacker, defender, channel, i);
      } catch (err) {
        console.error('handleHakiMenu error', err);
        try { await i.followUp({ content: 'An error occurred opening Haki menu.', ephemeral: true }); } catch (e) {}
      }
      return;
    }

    // Check if selected character is dead
    if (charIdx == null || isNaN(charIdx) || attacker.cards[charIdx].health <= 0) {
      try { await i.followUp({ content: "That character is already defeated!", ephemeral: true }); } catch (e) {}
      return;
    }

    // Selected character - now choose attack type
    await selectAttackType(sessionId, charIdx, msg, attacker, channel);
  });

  collector.on("end", async (collected) => {
    if (collected.size === 0) {
      if (hasPlayable) {
        // Player had playable options but didn't act — they forfeit the duel
        try { await channel.send(`${attacker.user} did not act in time and forfeits the duel.`); } catch (e) {}
        const s = DUEL_SESSIONS.get(sessionId);
        if (s) s.timedOut = true;
        session.currentTurn = defender.userId;
        await endDuel(sessionId, defender, attacker, channel);
      } else {
        // No playable options — skip turn
        session.currentTurn = defender.userId;
        await startDuelTurn(sessionId, channel);
      }
    }
  });
}

async function selectAttackType(sessionId, charIdx, msg, attacker, channel) {
  const session = DUEL_SESSIONS.get(sessionId);
  if (!session) return;

  const defender = session.currentTurn === session.p1.userId ? session.p2 : session.p1;
  const card = attacker.cards[charIdx];

  const hasSpecial = !!card.card.specialAttack && !card.usedSpecial;
  const normalRange = card.scaled ? card.scaled.attackRange : (card.card.attackRange || [0,0]);
  const specialRange = card.scaled && card.scaled.specialAttack ? card.scaled.specialAttack.range : (card.card.specialAttack ? card.card.specialAttack.range : null);
  const stam = (typeof card.stamina === 'number') ? card.stamina : 3;
  const embed = makeEmbed(
    "Choose Attack",
    `${card.card.name} is attacking!\n\n**Normal Attack:** ${normalRange[0]}-${normalRange[1]} damage (Cost: <:stamina:1456082884732391570> 1)\n${hasSpecial ? `**Special Attack:** ${card.card.specialAttack.name} (${specialRange[0]}-${specialRange[1]} damage) (Cost: <:stamina:1456082884732391570> 3)` : "No special attack available"}\n\nStamina: <:stamina:1456082884732391570> ${stam}/3`
  );

  const buttons = [ new ButtonBuilder().setCustomId(`duel_attack:${sessionId}:${charIdx}:normal`).setLabel("Normal").setStyle(ButtonStyle.Primary) ];
  if (hasSpecial) {
    // Only allow special when card has enough stamina (3)
    const canUseSpecial = stam >= 3;
    buttons.push(new ButtonBuilder().setCustomId(`duel_attack:${sessionId}:${charIdx}:special`).setLabel("Special").setStyle(ButtonStyle.Danger).setDisabled(!canUseSpecial));
  }

  const row = new ActionRowBuilder().addComponents(...buttons);

  try {
    await msg.edit({ embeds: [embed], components: [row] });
  } catch (e) {}

  const filter = (i) => i.user.id === attacker.userId;
  const collector = msg.createMessageComponentCollector({ filter, time: 45000 });

  collector.on("collect", async i => {
    if (!i.customId.startsWith("duel_attack")) return;
    
    try { if (!i.deferred && !i.replied) await i.deferUpdate(); } catch (e) { if (!(e && e.code === 10062)) console.error('deferUpdate error', e); }
    const attackType = i.customId.split(":")[3];

    // Now select target
    await selectTarget(sessionId, charIdx, attackType, msg, attacker, defender, channel);
  });

  collector.on("end", async (collected) => {
    if (collected.size === 0) {
      const hasAttackOptions = (stam >= 1);
      if (hasAttackOptions) {
        try { await channel.send(`${attacker.user} did not act in time and forfeits the duel.`); } catch (e) {}
        const s = DUEL_SESSIONS.get(sessionId);
        if (s) s.timedOut = true;
        session.currentTurn = defender.userId;
        await endDuel(sessionId, defender, attacker, channel);
      } else {
        session.currentTurn = defender.userId;
        await startDuelTurn(sessionId, channel);
      }
    }
  });
}

async function selectTarget(sessionId, charIdx, attackType, msg, attacker, defender, channel) {
  const session = DUEL_SESSIONS.get(sessionId);
  if (!session) return;

  const attackerCard = attacker.cards[charIdx];

  // Build target selection
  const targetButtons = defender.cards.map((card, idx) => {
    return new ButtonBuilder()
      .setCustomId(`duel_target:${sessionId}:${charIdx}:${attackType}:${idx}`)
      .setLabel(`${card.card.name} (${card.health}HP)`)
      .setStyle(ButtonStyle.Secondary);
  });

  const embed = makeEmbed(
    "Select Target",
    `Choose which opponent character to attack!`
  );

  const rows = [];
  for (let i = 0; i < targetButtons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(targetButtons.slice(i, i + 5)));
  }

  try {
    await msg.edit({ embeds: [embed], components: rows });
  } catch (e) {}

  const filter = (i) => i.user.id === attacker.userId;
  const collector = msg.createMessageComponentCollector({ filter, time: 45000 });

  collector.on("collect", async i => {
    if (!i.customId.startsWith("duel_target")) return;
    
    try { if (!i.deferred && !i.replied) await i.deferUpdate(); } catch (e) { if (!(e && e.code === 10062)) console.error('deferUpdate error', e); }
    const targetIdx = parseInt(i.customId.split(":")[4]);

    // Execute attack
    await executeAttack(sessionId, charIdx, attackType, targetIdx, msg, attacker, defender, channel);
  });

  collector.on("end", async (collected) => {
    if (collected.size === 0) {
      // Timeout - treat as forfeit (target selection only shown when an attack was initiated)
      try { await channel.send(`${attacker.user} did not act in time and forfeits the duel.`); } catch (e) {}
      const s = DUEL_SESSIONS.get(sessionId);
      if (s) s.timedOut = true;
      session.currentTurn = defender.userId;
      await msg.delete().catch(() => {});
      await endDuel(sessionId, defender, attacker, channel);
    }
  });
}

async function handleHakiMenu(sessionId, charIdx, msg, attacker, defender, channel, interaction) {
  const session = DUEL_SESSIONS.get(sessionId);
  if (!session) return;
  const card = attacker.cards[charIdx];
  if (!card) {
    try { await interaction.followUp({ content: 'Invalid character', ephemeral: true }); } catch (e) {}
    return;
  }

  const haki = card.haki || { armament: { stars:0 }, observation:{stars:0}, conqueror:{stars:0} };
  const opts = [];
  // Advanced Observation -> Future Sight
  if (haki.observation && haki.observation.advanced) opts.push({ id: 'futuresight', label: 'Future Sight', cost: 1, style: ButtonStyle.Primary });
  // Advanced Armament -> Ryou
  if (haki.armament && haki.armament.advanced) opts.push({ id: 'ryou', label: 'Ryou', cost: 2, style: ButtonStyle.Danger });
  // Conqueror basic
  if (haki.conqueror && haki.conqueror.stars > 0) opts.push({ id: 'conqueror', label: 'Conqueror Strike', cost: 2, style: ButtonStyle.Success });
  // Conqueror AoE (available if card has conqueror at all) — base 5% even at 0 stars
  if (haki.conqueror && haki.conqueror.present) opts.push({ id: 'conq_aoe', label: 'Conqueror AoE', cost: 3, style: ButtonStyle.Danger });

  if (opts.length === 0) {
    try { await interaction.followUp({ content: 'This character has no Haki abilities.', ephemeral: true }); } catch (e) {}
    return;
  }

  const { EmbedBuilder, ActionRowBuilder, ButtonBuilder } = await import('discord.js');
  const embed = new EmbedBuilder().setTitle(`${card.card.name} — Haki Menu`).setDescription('Choose a Haki ability to use. These do not consume your turn but cost stamina.').setColor(0x3498db);

  const btns = opts.map(o => new ButtonBuilder().setCustomId(`duel_haki_use:${sessionId}:${charIdx}:${o.id}`).setLabel(`${o.label} (Cost: ${o.cost})`).setStyle(o.style));
  const row = new ActionRowBuilder().addComponents(btns.slice(0,5));
  try { await interaction.followUp({ embeds: [embed], components: [row], ephemeral: true }); } catch (e) {}

  // create a short-lived collector on the interaction reply by listening to the channel
  const collectorMsgFilter = (i) => i.user.id === attacker.userId && i.customId && i.customId.startsWith('duel_haki_use');
  const collector2 = interaction.channel.createMessageComponentCollector({ filter: collectorMsgFilter, time: 20000 });
  collector2.on('collect', async i => {
    if (!i.customId.startsWith('duel_haki_use')) return;
    try { if (!i.deferred && !i.replied) await i.deferUpdate(); } catch (e) { if (!(e && e.code === 10062)) console.error('deferUpdate error', e); }
    const parts = i.customId.split(':');
    const ability = parts[3];
    try {
      await performHakiAbility(sessionId, charIdx, ability, attacker, defender, channel, i);
    } catch (err) {
      console.error('performHakiAbility error', err);
      try { await i.followUp({ content: 'An error occurred performing Haki ability.', ephemeral: true }); } catch (e) {}
    }
    collector2.stop();
  });
}

async function performHakiAbility(sessionId, charIdx, ability, attacker, defender, channel, interaction) {
  const session = DUEL_SESSIONS.get(sessionId);
  if (!session) return;
  const sideKey = (attacker === session.p1) ? 'p1' : 'p2';
  const oppKey = sideKey === 'p1' ? 'p2' : 'p1';
  const card = attacker.cards[charIdx];
  if (!card) { try { await interaction.followUp({ content: 'Invalid card', ephemeral: true }); } catch(e){}; return; }

  const haki = card.haki || { armament: { stars:0 }, observation:{stars:0}, conqueror:{stars:0} };

  if (ability === 'ryou') {
    // cost 2 stamina
    if ((card.stamina || 0) < 2) { await interaction.followUp({ content: 'Not enough stamina for Ryou.', ephemeral: true }); return; }
    card.stamina = Math.max(0, card.stamina - 2);
    // set ryou flag on this side: next incoming attack from opponent will be redirected to this card and do zero damage
    session[sideKey].ryou = { cardIdx: charIdx, remaining: 1 };
    // send summary embed only and refresh main duel message/components
    try {
      const summary = new EmbedBuilder().setTitle('Ryou — Haki Used').setDescription(`${attacker.user} used **Ryou** with ${card.card.name}.\nStamina: ${card.stamina}/3\nEffect: Next incoming attack will be redirected to ${card.card.name} and deal no damage.`).setColor(0x3498db);
      await channel.send({ embeds: [summary] }).catch(() => {});
      const sess = DUEL_SESSIONS.get(sessionId);
      if (sess && sess.msgId) {
        const mainMsg = await channel.messages.fetch(sess.msgId).catch(() => null);
        if (mainMsg) {
          // rebuild components based on updated attacker.cards
          const charButtons = attacker.cards.map((c, idx) => new ButtonBuilder().setCustomId(`duel_selectchar:${sessionId}:${idx}`).setLabel(`${c.card.name}`).setStyle(ButtonStyle.Primary).setDisabled(c.health <= 0 || c.skipThisTurn || (typeof c.stamina === 'number' && c.stamina <= 0)));
          const rows = [];
          for (let i = 0; i < charButtons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(charButtons.slice(i, i + 5)));
          const anyHakiPlayable = attacker.cards.some(c => (c.haki && (c.haki.armament.present || c.haki.observation.present || c.haki.conqueror.present)) && c.health > 0 && !(typeof c.stamina === 'number' && c.stamina <= 0));
          const hakiButton = new ButtonBuilder().setCustomId(`duel_haki:${sessionId}:all`).setLabel(`Haki`).setStyle(ButtonStyle.Secondary).setDisabled(!anyHakiPlayable);
          rows.push(new ActionRowBuilder().addComponents(hakiButton));
          // rebuild embed text
          function renderHP(cur, max, len = 10) { const ratio = max > 0 ? cur / max : 0; const filled = Math.max(0, Math.min(len, Math.round(ratio * len))); return '▬'.repeat(filled) + '▭'.repeat(len - filled); }
          const lines = attacker.cards.map((c, idx) => { const name = c.card.name; const hp = Math.max(0, c.health); const extra = c.skipThisTurn ? ' (exhausted)' : ''; const stam = (typeof c.stamina === 'number') ? c.stamina : 3; return `**${idx + 1}. ${name}**${extra} — HP: ${hp}/${c.maxHealth} ${renderHP(hp, c.maxHealth)} • <:stamina:1456082884732391570> ${stam}/3`; }).join('\n');
          const embed = makeEmbed("Your Turn", `${attacker.user}, choose a character to attack with!\n\n${lines}`);
          await mainMsg.edit({ embeds: [embed], components: rows }).catch(() => {});
        }
      }
    } catch (e) {}
    // Refresh main duel embed so HP/stamina are visible and buttons remain active
    try {
      const sess = DUEL_SESSIONS.get(sessionId);
      if (sess && sess.msgId) {
        const mainMsg = await channel.messages.fetch(sess.msgId).catch(() => null);
        if (mainMsg) {
          function renderHP(cur, max, len = 10) { const ratio = max > 0 ? cur / max : 0; const filled = Math.max(0, Math.min(len, Math.round(ratio * len))); return '▬'.repeat(filled) + '▭'.repeat(len - filled); }
          const lines = attacker.cards.map((c, idx) => {
            const name = c.card.name;
            const hp = Math.max(0, c.health);
            const extra = c.skipThisTurn ? ' (exhausted)' : '';
            const stam = (typeof c.stamina === 'number') ? c.stamina : 3;
            return `**${idx + 1}. ${name}**${extra} — HP: ${hp}/${c.maxHealth} ${renderHP(hp, c.maxHealth)} • <:stamina:1456082884732391570> ${stam}/3`;
          }).join('\n');
          const embed = makeEmbed("Your Turn", `${attacker.user}, choose a character to attack with!\n\n${lines}`);
          await mainMsg.edit({ embeds: [embed], components: mainMsg.components }).catch(() => {});
        }
      }
    } catch (e) {}
    return;
  }

  if (ability === 'futuresight') {
    if ((card.stamina || 0) < 1) { await interaction.followUp({ content: 'Not enough stamina for Future Sight.', ephemeral: true }); return; }
    card.stamina = Math.max(0, card.stamina - 1);
    // mark futureSight on session so incoming attacks can reliably detect dodge
    try { session[sideKey] = session[sideKey] || {}; session[sideKey].futureSight = { cardIdx: charIdx }; } catch (e) {}
    card.nextAttackGuaranteedDodge = true;
    try {
      const summary = new EmbedBuilder().setTitle('Future Sight — Haki Used').setDescription(`${attacker.user} used **Future Sight** on ${card.card.name}.\nStamina: ${card.stamina}/3\nEffect: ${card.card.name} will dodge the next incoming attack.`).setColor(0x3498db);
      await channel.send({ embeds: [summary] }).catch(() => {});
      const sess = DUEL_SESSIONS.get(sessionId);
      if (sess && sess.msgId) {
        const mainMsg = await channel.messages.fetch(sess.msgId).catch(() => null);
        if (mainMsg) {
          const charButtons = attacker.cards.map((c, idx) => new ButtonBuilder().setCustomId(`duel_selectchar:${sessionId}:${idx}`).setLabel(`${c.card.name}`).setStyle(ButtonStyle.Primary).setDisabled(c.health <= 0 || c.skipThisTurn || (typeof c.stamina === 'number' && c.stamina <= 0)));
          const rows = [];
          for (let i = 0; i < charButtons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(charButtons.slice(i, i + 5)));
          const anyHakiPlayable = attacker.cards.some(c => (c.haki && (c.haki.armament.present || c.haki.observation.present || c.haki.conqueror.present)) && c.health > 0 && !(typeof c.stamina === 'number' && c.stamina <= 0));
          const hakiButton = new ButtonBuilder().setCustomId(`duel_haki:${sessionId}:all`).setLabel(`Haki`).setStyle(ButtonStyle.Secondary).setDisabled(!anyHakiPlayable);
          rows.push(new ActionRowBuilder().addComponents(hakiButton));
          function renderHP(cur, max, len = 10) { const ratio = max > 0 ? cur / max : 0; const filled = Math.max(0, Math.min(len, Math.round(ratio * len))); return '▬'.repeat(filled) + '▭'.repeat(len - filled); }
          const lines = attacker.cards.map((c, idx) => { const name = c.card.name; const hp = Math.max(0, c.health); const extra = c.skipThisTurn ? ' (exhausted)' : ''; const stam = (typeof c.stamina === 'number') ? c.stamina : 3; return `**${idx + 1}. ${name}**${extra} — HP: ${hp}/${c.maxHealth} ${renderHP(hp, c.maxHealth)} • <:stamina:1456082884732391570> ${stam}/3`; }).join('\n');
          const embed = makeEmbed("Your Turn", `${attacker.user}, choose a character to attack with!\n\n${lines}`);
          await mainMsg.edit({ embeds: [embed], components: rows }).catch(() => {});
        }
      }
    } catch (e) {}
    try {
      const sess = DUEL_SESSIONS.get(sessionId);
      if (sess && sess.msgId) {
        const mainMsg = await channel.messages.fetch(sess.msgId).catch(() => null);
        if (mainMsg) {
          function renderHP(cur, max, len = 10) { const ratio = max > 0 ? cur / max : 0; const filled = Math.max(0, Math.min(len, Math.round(ratio * len))); return '▬'.repeat(filled) + '▭'.repeat(len - filled); }
          const lines = attacker.cards.map((c, idx) => {
            const name = c.card.name; const hp = Math.max(0, c.health); const extra = c.skipThisTurn ? ' (exhausted)' : ''; const stam = (typeof c.stamina === 'number') ? c.stamina : 3;
            return `**${idx + 1}. ${name}**${extra} — HP: ${hp}/${c.maxHealth} ${renderHP(hp, c.maxHealth)} • <:stamina:1456082884732391570> ${stam}/3`;
          }).join('\n');
          const embed = makeEmbed("Your Turn", `${attacker.user}, choose a character to attack with!\n\n${lines}`);
          await mainMsg.edit({ embeds: [embed], components: mainMsg.components }).catch(() => {});
        }
      }
    } catch (e) {}
    return;
  }

  if (ability === 'conqueror') {
    if ((card.stamina || 0) < 2) { await interaction.followUp({ content: 'Not enough stamina for Conqueror Strike.', ephemeral: true }); return; }
    card.stamina = Math.max(0, card.stamina - 2);
    const stars = (card.haki && card.haki.conqueror && card.haki.conqueror.stars) || 0;
    const threshold = 100 + (stars * 10);
    const knocked = [];
    for (const c of defender.cards) {
      if (c.health > 0 && c.health <= threshold) {
        c.health = 0; c.stamina = 0; knocked.push(c.card.name);
      }
    }
    try {
      const summary = new EmbedBuilder().setTitle("Conqueror's Haki — Used").setDescription(`${attacker.user} used **Conqueror's Haki** with ${card.card.name}.\nStamina: ${card.stamina}/3\nKnocked out: ${knocked.length ? knocked.join(', ') : 'None'}`).setColor(0x3498db);
      await channel.send({ embeds: [summary] }).catch(() => {});
      const sess = DUEL_SESSIONS.get(sessionId);
      if (sess && sess.msgId) {
        const mainMsg = await channel.messages.fetch(sess.msgId).catch(() => null);
        if (mainMsg) {
          const charButtons = attacker.cards.map((c, idx) => new ButtonBuilder().setCustomId(`duel_selectchar:${sessionId}:${idx}`).setLabel(`${c.card.name}`).setStyle(ButtonStyle.Primary).setDisabled(c.health <= 0 || c.skipThisTurn || (typeof c.stamina === 'number' && c.stamina <= 0)));
          const rows = [];
          for (let i = 0; i < charButtons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(charButtons.slice(i, i + 5)));
          const anyHakiPlayable = attacker.cards.some(c => (c.haki && (c.haki.armament.present || c.haki.observation.present || c.haki.conqueror.present)) && c.health > 0 && !(typeof c.stamina === 'number' && c.stamina <= 0));
          const hakiButton = new ButtonBuilder().setCustomId(`duel_haki:${sessionId}:all`).setLabel(`Haki`).setStyle(ButtonStyle.Secondary).setDisabled(!anyHakiPlayable);
          rows.push(new ActionRowBuilder().addComponents(hakiButton));
          function renderHP(cur, max, len = 10) { const ratio = max > 0 ? cur / max : 0; const filled = Math.max(0, Math.min(len, Math.round(ratio * len))); return '▬'.repeat(filled) + '▭'.repeat(len - filled); }
          const lines = attacker.cards.map((c, idx) => { const name = c.card.name; const hp = Math.max(0, c.health); const extra = c.skipThisTurn ? ' (exhausted)' : ''; const stam = (typeof c.stamina === 'number') ? c.stamina : 3; return `**${idx + 1}. ${name}**${extra} — HP: ${hp}/${c.maxHealth} ${renderHP(hp, c.maxHealth)} • <:stamina:1456082884732391570> ${stam}/3`; }).join('\n');
          const embed = makeEmbed("Your Turn", `${attacker.user}, choose a character to attack with!\n\n${lines}`);
          await mainMsg.edit({ embeds: [embed], components: rows }).catch(() => {});
        }
      }
    } catch (e) {}
    try {
      const sess = DUEL_SESSIONS.get(sessionId);
      if (sess && sess.msgId) {
        const mainMsg = await channel.messages.fetch(sess.msgId).catch(() => null);
        if (mainMsg) {
          function renderHP(cur, max, len = 10) { const ratio = max > 0 ? cur / max : 0; const filled = Math.max(0, Math.min(len, Math.round(ratio * len))); return '▬'.repeat(filled) + '▭'.repeat(len - filled); }
          const lines = attacker.cards.map((c, idx) => {
            const name = c.card.name; const hp = Math.max(0, c.health); const extra = c.skipThisTurn ? ' (exhausted)' : ''; const stam = (typeof c.stamina === 'number') ? c.stamina : 3;
            return `**${idx + 1}. ${name}**${extra} — HP: ${hp}/${c.maxHealth} ${renderHP(hp, c.maxHealth)} • <:stamina:1456082884732391570> ${stam}/3`;
          }).join('\n');
          const embed = makeEmbed("Your Turn", `${attacker.user}, choose a character to attack with!\n\n${lines}`);
          await mainMsg.edit({ embeds: [embed], components: mainMsg.components }).catch(() => {});
        }
      }
    } catch (e) {}
    return;
  }

  if (ability === 'conq_aoe') {
    if ((card.stamina || 0) < 3) { await interaction.followUp({ content: 'Not enough stamina for Conqueror AoE.', ephemeral: true }); return; }
    card.stamina = Math.max(0, card.stamina - 3);
    const stars = (card.haki && card.haki.conqueror && card.haki.conqueror.stars) || 0;
    const base = 0.05; // 5% base even at 0 stars
    const dmgPct = base + (stars * 0.10);
    const dmg = Math.max(1, Math.round(card.maxHealth * dmgPct));
    for (const c of defender.cards) {
      if (c.health > 0) {
        c.health = Math.max(0, c.health - dmg);
        if (c.health <= 0) c.stamina = 0;
        // Devil Fruit negation: if defender card is DF user and does NOT have advanced conqueror, nullify DF effects
        if (DEVIL_FRUIT_USERS.has(c.cardId) && !(c.haki && c.haki.conqueror && c.haki.conqueror.advanced)) {
          c.dfNegated = true;
        }
      }
    }
    try {
      const killed = defender.cards.filter(c=>c.health<=0).map(c=>c.card.name);
      const summary = new EmbedBuilder().setTitle('Conqueror AoE — Haki Used').setDescription(`${attacker.user} used **Conqueror AoE** with ${card.card.name}.\nDamage per enemy: ${dmg}\nStamina: ${card.stamina}/3\nKilled: ${killed.length ? killed.join(', ') : 'None'}`).setColor(0x3498db);
      await channel.send({ embeds: [summary] }).catch(() => {});
      const sess = DUEL_SESSIONS.get(sessionId);
      if (sess && sess.msgId) {
        const mainMsg = await channel.messages.fetch(sess.msgId).catch(() => null);
        if (mainMsg) {
          const charButtons = attacker.cards.map((c, idx) => new ButtonBuilder().setCustomId(`duel_selectchar:${sessionId}:${idx}`).setLabel(`${c.card.name}`).setStyle(ButtonStyle.Primary).setDisabled(c.health <= 0 || c.skipThisTurn || (typeof c.stamina === 'number' && c.stamina <= 0)));
          const rows = [];
          for (let i = 0; i < charButtons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(charButtons.slice(i, i + 5)));
          const anyHakiPlayable = attacker.cards.some(c => (c.haki && (c.haki.armament.present || c.haki.observation.present || c.haki.conqueror.present)) && c.health > 0 && !(typeof c.stamina === 'number' && c.stamina <= 0));
          const hakiButton = new ButtonBuilder().setCustomId(`duel_haki:${sessionId}:all`).setLabel(`Haki`).setStyle(ButtonStyle.Secondary).setDisabled(!anyHakiPlayable);
          rows.push(new ActionRowBuilder().addComponents(hakiButton));
          function renderHP(cur, max, len = 10) { const ratio = max > 0 ? cur / max : 0; const filled = Math.max(0, Math.min(len, Math.round(ratio * len))); return '▬'.repeat(filled) + '▭'.repeat(len - filled); }
          const lines = attacker.cards.map((c, idx) => { const name = c.card.name; const hp = Math.max(0, c.health); const extra = c.skipThisTurn ? ' (exhausted)' : ''; const stam = (typeof c.stamina === 'number') ? c.stamina : 3; return `**${idx + 1}. ${name}**${extra} — HP: ${hp}/${c.maxHealth} ${renderHP(hp, c.maxHealth)} • <:stamina:1456082884732391570> ${stam}/3`; }).join('\n');
          const embed = makeEmbed("Your Turn", `${attacker.user}, choose a character to attack with!\n\n${lines}`);
          await mainMsg.edit({ embeds: [embed], components: rows }).catch(() => {});
        }
      }
    } catch (e) {}
    try {
      const sess = DUEL_SESSIONS.get(sessionId);
      if (sess && sess.msgId) {
        const mainMsg = await channel.messages.fetch(sess.msgId).catch(() => null);
        if (mainMsg) {
          function renderHP(cur, max, len = 10) { const ratio = max > 0 ? cur / max : 0; const filled = Math.max(0, Math.min(len, Math.round(ratio * len))); return '▬'.repeat(filled) + '▭'.repeat(len - filled); }
          const lines = attacker.cards.map((c, idx) => {
            const name = c.card.name; const hp = Math.max(0, c.health); const extra = c.skipThisTurn ? ' (exhausted)' : ''; const stam = (typeof c.stamina === 'number') ? c.stamina : 3;
            return `**${idx + 1}. ${name}**${extra} — HP: ${hp}/${c.maxHealth} ${renderHP(hp, c.maxHealth)} • <:stamina:1456082884732391570> ${stam}/3`;
          }).join('\n');
          const embed = makeEmbed("Your Turn", `${attacker.user}, choose a character to attack with!\n\n${lines}`);
          await mainMsg.edit({ embeds: [embed], components: mainMsg.components }).catch(() => {});
        }
      }
    } catch (e) {}
    return;
  }
}

async function executeAttack(sessionId, charIdx, attackType, targetIdx, msg, attacker, defender, channel) {
  const session = DUEL_SESSIONS.get(sessionId);
  if (!session) return;

  const attackerCard = attacker.cards[charIdx];
    let targetCard = defender.cards[targetIdx];
  const isP1 = attacker === session.p1;

  let damage = 0;
  let isMiss = false;
  let isSpecial = false;

  if (attackType === "normal") {
    // require 1 stamina for normal attack
    if ((typeof attackerCard.stamina !== 'number') || attackerCard.stamina < 1) {
      await msg.followUp({ content: "Not enough stamina to perform a normal attack!", ephemeral: true });
      return;
    }
    // base 5% miss chance + defender dodge chance from Observation Haki
    const defDodge = (targetCard && targetCard.dodgeChance) ? targetCard.dodgeChance : 0;
    const totalMissChance = 0.05 + defDodge;
    // Check session-level Future Sight (reliable dodge marker)
    try {
      const defenderKeyFS = (defender === session.p1) ? 'p1' : 'p2';
      const fs = session[defenderKeyFS] && session[defenderKeyFS].futureSight;
      if (fs && fs.cardIdx === targetIdx) {
        isMiss = true;
        // clear futureSight after it triggers
        try { delete session[defenderKeyFS].futureSight; } catch (e) {}
      }
    } catch (e) {}

    if (!isMiss && targetCard && targetCard.nextAttackGuaranteedDodge) {
      isMiss = true;
      targetCard.nextAttackGuaranteedDodge = false;
    } else if (!isMiss && Math.random() < totalMissChance) {
      isMiss = true;
    } else {
      const range = attackerCard.scaled ? attackerCard.scaled.attackRange : (attackerCard.card.attackRange || [0,0]);
      damage = randInt(range[0], range[1]);
      // stamina consumption handled at end of attack flow
    }
  } else {
    // Special attack button: guaranteed special attack when clicked
    const specialRange = attackerCard.scaled && attackerCard.scaled.specialAttack ? attackerCard.scaled.specialAttack.range : (attackerCard.card.specialAttack ? attackerCard.card.specialAttack.range : null);
    if (specialRange) {
      // require 3 stamina for special
      if ((typeof attackerCard.stamina !== 'number') || attackerCard.stamina < 3) {
        await msg.followUp({ content: "Not enough stamina to perform the special attack!", ephemeral: true });
        return;
      }
      isSpecial = true;
      damage = randInt(specialRange[0], specialRange[1]);
      // mark that this card has used its special and schedule exhaustion next turn
      attackerCard.usedSpecial = true;
      attackerCard.skipNextTurnPending = true;
      // stamina consumption handled at end of attack flow
    } else {
      // fallback to a normal attack if no special available
      const normalRange = attackerCard.scaled ? attackerCard.scaled.attackRange : (attackerCard.card.attackRange || [0,0]);
      damage = randInt(normalRange[0], normalRange[1]);
    }
  }

  // If target already dead, ignore and inform
  if (targetCard.health <= 0) {
    await msg.followUp({ content: "That target is already knocked out.", ephemeral: true });
    return;
  }

  // Ryou redirect: if the defender side has ryou active, redirect this incoming attack to the ryou card and deal zero damage
  try {
    const defenderKey = (defender === session.p1) ? 'p1' : 'p2';
    const ryou = session[defenderKey] && session[defenderKey].ryou;
    if (ryou && ryou.remaining > 0) {
      const redirectIdx = ryou.cardIdx;
      const redirectedCard = session[defenderKey].cards[redirectIdx];
      if (redirectedCard && redirectedCard.health > 0) {
        damage = 0;
        targetCard = redirectedCard;
        ryou.remaining = Math.max(0, ryou.remaining - 1);
        await channel.send(`${session[defenderKey].user} redirected the attack to ${redirectedCard.card.name} with Ryou — no damage taken!`);
      }
    }
  } catch (e) {}

  // Apply damage
  targetCard.health = Math.max(0, targetCard.health - damage);

  // Build result message
  const resultText = isMiss
    ? `${attackerCard.card.name} missed! 0 damage`
    : isSpecial
    ? `${attackerCard.card.name} used ${attackerCard.card.specialAttack ? attackerCard.card.specialAttack.name : 'special'}! ${damage} damage`
    : `${attackerCard.card.name} attacks for ${damage} damage`;

  // Render HP bar for target
  function renderHP(cur, max, len = 10) {
    const ratio = max > 0 ? cur / max : 0;
    const filled = Math.max(0, Math.min(len, Math.round(ratio * len)));
    return '▬'.repeat(filled) + '▭'.repeat(len - filled);
  }

  const hpBar = renderHP(Math.max(0, targetCard.health), targetCard.maxHealth);
  const resultEmbed = makeEmbed(
    "Attack Result",
    `${resultText}\n\n${targetCard.card.name} HP: ${Math.max(0, targetCard.health)}/${targetCard.maxHealth} ${hpBar}`
  );

  try {
    // Disable buttons on the main duel message so they cannot be pressed again
    try { await msg.edit({ components: [] }); } catch (e) {}
    // Send a new message for the result so the UI uses a fresh embed
    await channel.send({ embeds: [resultEmbed] }).catch(() => {});
  } catch (e) {}

  // If special attack happened and there's a gif, send a separate embed message with the gif
  if (isSpecial && attackerCard.card && attackerCard.card.specialAttack && attackerCard.card.specialAttack.gif) {
    try {
      const gifEmbed = makeEmbed(
        `${attackerCard.card.name} used ${attackerCard.card.specialAttack.name}!`,
        `${resultText}\n\n${targetCard.card.name} HP: ${Math.max(0, targetCard.health)}/${targetCard.maxHealth} ${hpBar}`
      );
      try { gifEmbed.setImage(attackerCard.card.specialAttack.gif); } catch (e) {}
      await channel.send({ embeds: [gifEmbed] }).catch(() => {});
    } catch (e) {}
  }

  // If target was KO'd, normalize defender lifeIndex to first alive
  if (targetCard.health <= 0) {
    // knocked out target should lose any remaining stamina
    targetCard.stamina = 0;
    const idx = defender.cards.findIndex(c => c.health > 0);
    defender.lifeIndex = idx === -1 ? defender.cards.length : idx;
    // If a Support card was killed, recompute that team's boosts and adjust scaled stats
    try {
      if (targetCard.card && String(targetCard.card.type).toLowerCase() === 'support') {
        const session = DUEL_SESSIONS.get(sessionId);
        if (session) {
          const sideKey = (defender === session.p1) ? 'p1' : 'p2';
          const side = session[sideKey];
          const oldBoosts = side.teamBoosts || { atk: 0, hp: 0, special: 0 };
          const aliveIds = side.cards.filter(c => c.health > 0).map(c => c.cardId);
          const newBoosts = computeTeamBoosts(aliveIds, side.cardsMap || null, null);
          session[sideKey].teamBoosts = newBoosts;

          const oldAtk = oldBoosts.atk || 0, oldHp = oldBoosts.hp || 0, oldSp = oldBoosts.special || 0;
          const newAtk = newBoosts.atk || 0, newHp = newBoosts.hp || 0, newSp = newBoosts.special || 0;
          const atkRatio = (1 + newAtk/100) / (1 + oldAtk/100);
          const hpRatio = (1 + newHp/100) / (1 + oldHp/100);
          const spRatio = (1 + newSp/100) / (1 + oldSp/100);

          const casualties = [];
          for (const c of side.cards) {
            // adjust attack/power
            if (c.scaled && c.scaled.attackRange) {
              c.scaled.attackRange[0] = Math.max(0, roundNearestFive(Math.round((c.scaled.attackRange[0] || 0) * atkRatio)));
              c.scaled.attackRange[1] = Math.max(0, roundNearestFive(Math.round((c.scaled.attackRange[1] || 0) * atkRatio)));
            }
            if (c.scaled && typeof c.scaled.power === 'number') c.scaled.power = Math.max(0, roundNearestFive(Math.round(c.scaled.power * atkRatio)));
            if (c.scaled && c.scaled.specialAttack && c.scaled.specialAttack.range) {
              const r0 = Math.max(0, Math.round((c.scaled.specialAttack.range[0] || 0) * spRatio));
              const r1 = Math.max(0, Math.round((c.scaled.specialAttack.range[1] || 0) * spRatio));
              c.scaled.specialAttack.range = roundRangeToFive([r0, r1]);
            }
            // adjust health
            c.maxHealth = Math.max(0, roundNearestFive(Math.round((c.maxHealth || 0) * hpRatio)));
            c.health = Math.min(c.health, c.maxHealth);
            if (c.health <= 0) {
              c.health = 0;
              c.stamina = 0;
              casualties.push(c.card.name);
            }
          }

          // normalize lifeIndex after casualties
          const newIdx = side.cards.findIndex(c => c.health > 0);
          side.lifeIndex = newIdx === -1 ? side.cards.length : newIdx;

          // inform players about boost change and any casualties
          const who = side.user ? side.user.username : sideKey;
          const notifParts = [];
          notifParts.push(`${who}'s support card was knocked out — team boosts recalculated.`);
          notifParts.push(`New boosts: ATK +${newAtk}% • HP +${newHp}% • SPECIAL +${newSp}%`);
          if (casualties.length) notifParts.push(`Casualties from boost removal: ${casualties.join(', ')}`);
          try { await channel.send(notifParts.join('\n')); } catch (e) {}
        }
      }
    } catch (e) { console.error('Error recalculating boosts after support KO:', e); }
  }

  // Delay and continue turn or switch to next player
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Deduct stamina and mark card as having attacked this turn
  try {
    if (isSpecial) attackerCard.stamina = Math.max(0, (attackerCard.stamina || 0) - 3);
    else attackerCard.stamina = Math.max(0, (attackerCard.stamina || 0) - 1);
    attackerCard.attackedLastTurn = true;
  } catch (e) {}

  // Check if all opponent's cards are dead
  const allDead = defender.cards.every(card => card.health <= 0);
  if (allDead) {
    // Attacker won
    await endDuel(sessionId, attacker, defender, channel);
  } else {
    // Switch to defender's turn
    session.currentTurn = defender.userId;
    await startDuelTurn(sessionId, channel);
  }
}

async function endDuel(sessionId, winner, loser, channel) {
  const session = DUEL_SESSIONS.get(sessionId);
  if (!session) return;

  // Calculate bounty and XP based on loser's level (level 0 => 0, level 1 => 10 XP)
  const winnerBal = await Balance.findOne({ userId: winner.userId }) || new Balance({ userId: winner.userId, amount: 0 });
  const loserBal = await Balance.findOne({ userId: loser.userId }) || new Balance({ userId: loser.userId, amount: 0 });
  const winnerProgress = await Progress.findOne({ userId: winner.userId }) || new Progress({ userId: winner.userId, team: [], cards: new Map() });

  const loserLevel = Math.max(0, loserBal.level || 0);
  // XP gained is 10 * loser level (cap by daily XP limit)
  const winDuel = await Duel.findOne({ userId: winner.userId });
  const win = dayWindow();
  const updatedWinDuel = winDuel || new Duel({ userId: winner.userId });
  if (updatedWinDuel.xpWindow !== win) {
    updatedWinDuel.xpWindow = win;
    updatedWinDuel.xpToday = 0;
  }
  if (updatedWinDuel.duelWindow !== win) {
    updatedWinDuel.duelWindow = win;
    updatedWinDuel.duelOpponents = new Map();
  }

  const desiredXp = loserLevel * 10;
  const xpRemaining = Math.max(0, 100 - (updatedWinDuel.xpToday || 0));
  const xpGain = Math.min(desiredXp, xpRemaining);
  updatedWinDuel.xpToday = (updatedWinDuel.xpToday || 0) + xpGain;
  updatedWinDuel.duelOpponents.set(loser.userId, (updatedWinDuel.duelOpponents.get(loser.userId) || 0) + 1);
  await updatedWinDuel.save();

  // Bounty scaled by loser level (100 per level)
  const bounty = loserLevel * 100;

  winnerBal.amount = (winnerBal.amount || 0) + bounty;
  winnerProgress.userXp = (winnerProgress.userXp || 0) + xpGain;
  // Level up
  let levelsGained = 0;
  while (winnerProgress.userXp >= 100) {
    winnerProgress.userXp -= 100;
    winnerProgress.userLevel = (winnerProgress.userLevel || 1) + 1;
    levelsGained++;
  }
  await winnerBal.save();
  await winnerProgress.save();

  // Record quest progress
  try {
    const [dailyQuests, weeklyQuests] = await Promise.all([
      Quest.getCurrentQuests("daily"),
      Quest.getCurrentQuests("weekly")
    ]);
    await Promise.all([
      dailyQuests.recordAction(winner.userId, "duel", 1),
      weeklyQuests.recordAction(winner.userId, "duel", 1)
    ]);
  } catch (e) {
    console.error("Failed to record duel quest progress:", e);
  }

  // Update loser's duel count
  const updatedLoseDuel = await Duel.findOne({ userId: loser.userId }) || new Duel({ userId: loser.userId });
  if (updatedLoseDuel.duelWindow !== win) {
    updatedLoseDuel.duelWindow = win;
    updatedLoseDuel.duelOpponents = new Map();
  }
  updatedLoseDuel.duelOpponents.set(winner.userId, (updatedLoseDuel.duelOpponents.get(winner.userId) || 0) + 1);
  await updatedLoseDuel.save();

  const finishNote = session && session.timedOut ? `${loser.user.username} did not act in time and forfeited the duel.` : `${winner.user.username} wins the duel!`;
  const embed = makeEmbed(
    "Duel Finished",
    `${finishNote}\n\nBounty: ${bounty}¥\nXP gained: ${xpGain}/100`
  );

  try {
    const msg = await channel.messages.fetch(session.msgId);
    await msg.reply({ embeds: [embed] });
  } catch (e) {
    await channel.send({ embeds: [embed] });
  }

  DUEL_SESSIONS.delete(sessionId);
}

async function endDuelDraw(sessionId, channel) {
  const session = DUEL_SESSIONS.get(sessionId);
  if (!session) return;
  const embed = makeEmbed("Duel Ended", "Both sides have no usable stamina — the duel ends in a draw.");
  try {
    const msg = await channel.messages.fetch(session.msgId).catch(() => null);
    if (msg) await msg.reply({ embeds: [embed] }); else await channel.send({ embeds: [embed] });
  } catch (e) { try { await channel.send({ embeds: [embed] }); } catch(_) {} }
  DUEL_SESSIONS.delete(sessionId);
}

export async function forfeitByUser(userId, channel, requester) {
  // find an active session with this user
  for (const [sid, sess] of DUEL_SESSIONS.entries()) {
    const p1 = sess.p1, p2 = sess.p2;
    if (p1.userId === userId || p2.userId === userId) {
      const loser = p1.userId === userId ? p1 : p2;
      const winner = p1.userId === userId ? p2 : p1;
      try {
        const embed = makeEmbed("Duel Forfeited", `${loser.user.username} has forfeited the duel. ${winner.user.username} wins.`);
        try {
          const msg = await channel.messages.fetch(sess.msgId);
          await msg.reply({ embeds: [embed] });
        } catch (e) {
          await channel.send({ embeds: [embed] });
        }
        await endDuel(sid, winner, loser, channel);
      } catch (e) {
        console.error("Error resolving forfeit:", e);
        if (requester && requester.reply) {
          try { await requester.reply({ content: 'Failed to forfeit the duel.', ephemeral: true }); } catch(e) {}
        }
      }
      return true;
    }
  }
  return false;
}
