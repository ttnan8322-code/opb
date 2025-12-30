import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import Balance from "../models/Balance.js";
import Duel from "../models/Duel.js";
import Progress from "../models/Progress.js";
import { getCardById } from "../cards.js";
import { roundNearestFive, roundRangeToFive } from "../lib/stats.js";
import { computeTeamBoosts } from "../lib/boosts.js";
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

  if (!p2Progress || !p2Progress.team || p2Progress.team.length === 0) {
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
    if (duelCount >= 3) {
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
  const collector = msg.createMessageComponentCollector({ filter, time: 30000 });

  collector.on("collect", async i => {
    await i.deferUpdate();

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

        // Ensure stats are rounded to nearest 5 for consistency
        const finalPower = roundNearestFive(Math.round(power));
        const finalAttackMin = roundNearestFive(Math.round(attackMin));
        const finalAttackMax = roundNearestFive(Math.round(attackMax));
        const finalHealth = roundNearestFive(Math.round(health));
        if (special && special.range) special.range = roundRangeToFive([Math.round(special.range[0] || 0), Math.round(special.range[1] || 0)]);

        // Track special usage and exhaustion state for match
        return { cardId, card, scaled: { attackRange: [finalAttackMin, finalAttackMax], specialAttack: special, power: finalPower }, health: finalHealth, maxHealth: finalHealth, level, usedSpecial: false, skipNextTurnPending: false, skipThisTurn: false };
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

        // Ensure stats are rounded to nearest 5 for consistency
        const finalPower = roundNearestFive(Math.round(power));
        const finalAttackMin = roundNearestFive(Math.round(attackMin));
        const finalAttackMax = roundNearestFive(Math.round(attackMax));
        const finalHealth = roundNearestFive(Math.round(health));
        if (special && special.range) special.range = roundRangeToFive([Math.round(special.range[0] || 0), Math.round(special.range[1] || 0)]);

        return { cardId, card, scaled: { attackRange: [finalAttackMin, finalAttackMax], specialAttack: special, power: finalPower }, health: finalHealth, maxHealth: finalHealth, level };
      });

      // Determine who goes first (highest power)
      const p1Power = Math.max(...p1Cards.map(c => c.scaled.power || 0));
      const p2Power = Math.max(...p2Cards.map(c => c.scaled.power || 0));
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
  normalizeLifeIndex(attacker);
  normalizeLifeIndex(defender);

  // Check if defender is alive
  if (defender.lifeIndex >= defender.cards.length) {
    // Attacker won
    await endDuel(sessionId, attacker, defender, channel);
    return;
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
    return `**${idx + 1}. ${name}**${extra} — HP: ${hp}/${c.maxHealth} ${renderHP(hp, c.maxHealth)}`;
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
      .setDisabled(card.health <= 0 || card.skipThisTurn);
  });

  const rows = [];
  for (let i = 0; i < charButtons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(charButtons.slice(i, i + 5)));
  }

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
  const collector = msg.createMessageComponentCollector({ filter, time: 30000 });

  collector.on("collect", async i => {
    if (!i.customId.startsWith("duel_selectchar")) return;
    
    await i.deferUpdate();
    const charIdx = parseInt(i.customId.split(":")[2]);

    // Check if selected character is dead
    if (attacker.cards[charIdx].health <= 0) {
      await i.followUp({ content: "That character is already defeated!", ephemeral: true });
      return;
    }

    // Selected character - now choose attack type
    await selectAttackType(sessionId, charIdx, msg, attacker, channel);
  });

  collector.on("end", async (collected) => {
    if (collected.size === 0) {
      // Timeout - skip turn
      session.currentTurn = defender.userId;
      // do not delete the message; reuse it for next turn
      await startDuelTurn(sessionId, channel);
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
  const embed = makeEmbed(
    "Choose Attack",
    `${card.card.name} is attacking!\n\n**Normal Attack:** ${normalRange[0]}-${normalRange[1]} damage\n${hasSpecial ? `**Special Attack:** ${card.card.specialAttack.name} (${specialRange[0]}-${specialRange[1]} damage)` : "No special attack available"}`
  );

  const buttons = [
    new ButtonBuilder().setCustomId(`duel_attack:${sessionId}:${charIdx}:normal`).setLabel("Normal").setStyle(ButtonStyle.Primary),
  ];

  if (hasSpecial) {
    buttons.push(new ButtonBuilder().setCustomId(`duel_attack:${sessionId}:${charIdx}:special`).setLabel("Special").setStyle(ButtonStyle.Danger));
  }

  const row = new ActionRowBuilder().addComponents(...buttons);

  try {
    await msg.edit({ embeds: [embed], components: [row] });
  } catch (e) {}

  const filter = (i) => i.user.id === attacker.userId;
  const collector = msg.createMessageComponentCollector({ filter, time: 30000 });

  collector.on("collect", async i => {
    if (!i.customId.startsWith("duel_attack")) return;
    
    await i.deferUpdate();
    const attackType = i.customId.split(":")[3];

    // Now select target
    await selectTarget(sessionId, charIdx, attackType, msg, attacker, defender, channel);
  });

  collector.on("end", async (collected) => {
    if (collected.size === 0) {
      // Timeout - skip turn
      session.currentTurn = defender.userId;
      await startDuelTurn(sessionId, channel);
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
  const collector = msg.createMessageComponentCollector({ filter, time: 30000 });

  collector.on("collect", async i => {
    if (!i.customId.startsWith("duel_target")) return;
    
    await i.deferUpdate();
    const targetIdx = parseInt(i.customId.split(":")[4]);

    // Execute attack
    await executeAttack(sessionId, charIdx, attackType, targetIdx, msg, attacker, defender, channel);
  });

  collector.on("end", async (collected) => {
    if (collected.size === 0) {
      // Timeout - skip turn
      session.currentTurn = defender.userId;
      await msg.delete().catch(() => {});
      await startDuelTurn(sessionId, channel);
    }
  });
}

async function executeAttack(sessionId, charIdx, attackType, targetIdx, msg, attacker, defender, channel) {
  const session = DUEL_SESSIONS.get(sessionId);
  if (!session) return;

  const attackerCard = attacker.cards[charIdx];
  const targetCard = defender.cards[targetIdx];
  const isP1 = attacker === session.p1;

  let damage = 0;
  let isMiss = false;
  let isSpecial = false;

  if (attackType === "normal") {
    // 5% miss chance
    if (Math.random() < 0.05) {
      isMiss = true;
    } else {
      const range = attackerCard.scaled ? attackerCard.scaled.attackRange : (attackerCard.card.attackRange || [0,0]);
      damage = randInt(range[0], range[1]);
    }
  } else {
    // Special attack button: guaranteed special attack when clicked
    const specialRange = attackerCard.scaled && attackerCard.scaled.specialAttack ? attackerCard.scaled.specialAttack.range : (attackerCard.card.specialAttack ? attackerCard.card.specialAttack.range : null);
    if (specialRange) {
      isSpecial = true;
      damage = randInt(specialRange[0], specialRange[1]);
      // mark that this card has used its special and schedule exhaustion next turn
      attackerCard.usedSpecial = true;
      attackerCard.skipNextTurnPending = true;
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
          const newBoosts = computeTeamBoosts(aliveIds, side.cardsMap || null);
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
  const winnerBal = await Balance.findOne({ userId: winner.userId }) || new Balance({ userId: winner.userId, amount: 0, xp: 0, level: 0 });
  const loserBal = await Balance.findOne({ userId: loser.userId }) || new Balance({ userId: loser.userId, amount: 0, xp: 0, level: 0 });

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
  winnerBal.xp = (winnerBal.xp || 0) + xpGain;
  await winnerBal.save();

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

  const embed = makeEmbed(
    "Duel Finished",
    `${winner.user.username} wins the duel!\n\nBounty: ${bounty}¥\nXP gained: ${xpGain}/100`
  );

  try {
    const msg = await channel.messages.fetch(session.msgId);
    await msg.reply({ embeds: [embed] });
  } catch (e) {
    await channel.send({ embeds: [embed] });
  }

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
