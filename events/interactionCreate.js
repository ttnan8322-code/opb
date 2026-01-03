import Progress from "../models/Progress.js";
import Balance from "../models/Balance.js";
import Inventory from "../models/Inventory.js";
// import WeaponInventory from "../models/WeaponInventory.js";
import { getCardById, getRankInfo, cards } from "../cards.js";
import { buildCardEmbed, buildUserCardEmbed } from "../lib/cardEmbed.js";
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags } from "discord.js";
import { roundNearestFive, roundRangeToFive } from "../lib/stats.js";
import { parseHaki, applyHakiStatBoosts } from "../lib/haki.js";

export const name = "interactionCreate";
export const once = false;

// use shared embed builder to keep UI consistent across commands and interactions

function getEvolutionChain(rootCard) {
  const chain = [];
  const visited = new Set();
  function walk(card) {
    if (!card || visited.has(card.id)) return;
    visited.add(card.id);
    chain.push(card.id);
    const ev = card.evolutions || [];
    for (const nextId of ev) {
      const next = getCardById(nextId);
      if (next) walk(next);
    }
  }
  walk(rootCard);
  return chain;
}

function getWeaponById(weaponId) {
  if (!weaponId) return null;
  const q = String(weaponId).toLowerCase();
  let weapon = cards.find((c) => (c.type === "weapon" || c.type === "banner") && c.id.toLowerCase() === q);
  if (weapon) return weapon;
  weapon = cards.find((c) => (c.type === "weapon" || c.type === "banner") && c.name.toLowerCase() === q);
  if (weapon) return weapon;
  weapon = cards.find((c) => (c.type === "weapon" || c.type === "banner") && c.name.toLowerCase().startsWith(q));
  if (weapon) return weapon;
  weapon = cards.find((c) => (c.type === "weapon" || c.type === "banner") && (c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)));
  return weapon || null;
}

// Sail helpers moved to module scope so other top-level functions can call them
async function endSailBattle(sessionId, channel, won) {
  const session = global.SAIL_SESSIONS.get(sessionId);
  if (!session) return;
  if (session.rewarded) return;
  session.rewarded = true;

  if (won) {
    const Balance = (await import("../models/Balance.js")).default;
    const Inventory = (await import("../models/Inventory.js")).default;
    const SailProgress = (await import("../models/SailProgress.js")).default;

    const balance = (await Balance.findOne({ userId: session.userId })) || new Balance({ userId: session.userId });
    const inventory = (await Inventory.findOne({ userId: session.userId })) || new Inventory({ userId: session.userId });
    const sailProgress = (await SailProgress.findOne({ userId: session.userId })) || new SailProgress({ userId: session.userId });

    let rewards = [];
    let episodeTitle = 'Episode 1';
    let nextProgress = 2;
    let resetToken = false;

    if (session.episode === 2) {
      episodeTitle = 'Episode 2';
      nextProgress = 3;
      const beli = Math.floor(Math.random() * 101) + 100;
      balance.balance += beli;
      const chests = Math.floor(Math.random() * 2) + 1;
      inventory.chests.C += chests;
      rewards = ['rika_c_01', 'roronoazoro_c_01'];
      if (sailProgress.difficulty === 'hard') {
        rewards.push('helmeppo_c_01');
        inventory.chests.B += 1;
      }
      if (session.secretStage && sailProgress && sailProgress.difficulty === 'hard') {
        const Progress = (await import("../models/Progress.js")).default;
        const progress = await Progress.findOne({ userId: session.userId });
        if (progress && progress.cards && typeof progress.cards.get === 'function') {
          if (progress.cards.has('roronoazoro_c_01')) {
            let entry = progress.cards.get('roronoazoro_c_01');
            entry.level = (entry.level || 0) + 25;
            progress.cards.set('roronoazoro_c_01', entry);
            await progress.save();
          } else {
            progress.cards.set('roronoazoro_c_01', { level: 25, xp: 0, count: 1 });
            await progress.save();
          }
        }
      }
    } else if (session.episode === 3) {
      episodeTitle = 'Episode 3';
      nextProgress = 4;
      const beli = Math.floor(Math.random() * 251) + 250; // 250-500
      balance.balance += beli;
      const chests = Math.floor(Math.random() * 2) + 1;
      inventory.chests.C += chests;
      // reset token exclusive to hard mode for Episode 3
      if (sailProgress.difficulty === 'hard') {
        balance.resetTokens = (balance.resetTokens || 0) + 1;
        resetToken = true;
      }
      rewards = [];
      if (sailProgress.difficulty === 'hard') {
        rewards.push('axehandmorgan_b_01');
        inventory.chests.B += 1;
      }
      // common rewards (cards/chests) may be added here if needed
    } else {
      const beli = Math.floor(Math.random() * 151) + 100;
      balance.balance += beli;
      const chests = Math.floor(Math.random() * 2) + 1;
      inventory.chests.C += chests;
      if (Math.random() < 0.5) {
        balance.resetTokens = (balance.resetTokens || 0) + 1;
        resetToken = true;
      }
      rewards = ['koby_c_01'];
      if (sailProgress.difficulty === 'hard') {
        rewards.push('Alvida_c_01', 'heppoko_c_01', 'Peppoko_c_01', 'Poppoko_c_01');
      }
      if (sailProgress.difficulty === 'hard' || sailProgress.difficulty === 'medium') {
        rewards.push('alvida_pirates_banner_blueprint_c_01');
      }
    }

    const Progress = (await import("../models/Progress.js")).default;
    const WeaponInventory = (await import("../models/WeaponInventory.js")).default;
    let progress = await Progress.findOne({ userId: session.userId }) || new Progress({ userId: session.userId, team: [], cards: new Map() });
    if (!progress.cards || typeof progress.cards.get !== 'function') {
      progress.cards = new Map(Object.entries(progress.cards || {}));
    }
    const hadZoroBefore = progress.cards && typeof progress.cards.get === 'function' ? progress.cards.has('roronoazoro_c_01') : false;
    let weaponInv = await WeaponInventory.findOne({ userId: session.userId });
    if (!weaponInv) weaponInv = new WeaponInventory({ userId: session.userId, blueprints: {}, weapons: {}, materials: {} });

    const converted = [];
    for (const cardId of rewards) {
      if (progress.cards.has(cardId)) {
        // Convert duplicate reward into XP (100 XP) which may cause level-ups
        converted.push(cardId);
        let entry = progress.cards.get(cardId);
        let totalXp = (entry.xp || 0) + 100;
        let newLevel = entry.level || 0;
        while (totalXp >= 100) {
          totalXp -= 100;
          newLevel += 1;
        }
        entry.xp = totalXp;
        entry.level = newLevel;
        progress.cards.set(cardId, entry);
      } else {
        progress.cards.set(cardId, { level: 1, xp: 0, count: 1 });
      }
    }

    await balance.save();
    await inventory.save();
    await weaponInv.save();

    // Ensure changes to Map-backed cards persist
    if (progress && progress.cards && typeof progress.cards.get === 'function') {
      progress.markModified && progress.markModified('cards');
    }

    // If this session included the final Zoro encounter and player won, add +25 levels to Zoro (Hard only)
    if (session.zoroFinal && sailProgress && sailProgress.difficulty === 'hard') {
      if (progress && progress.cards && typeof progress.cards.get === 'function') {
        if (progress.cards.has('roronoazoro_c_01')) {
          let entry = progress.cards.get('roronoazoro_c_01');
          entry.level = (entry.level || 0) + 25;
          progress.cards.set('roronoazoro_c_01', entry);
        } else {
          progress.cards.set('roronoazoro_c_01', { level: 25, xp: 0, count: 1 });
        }
        progress.markModified && progress.markModified('cards');
      }
    }

    await progress.save();

    let rewardsText = '';
    if (session.episode === 2) {
      const beli = Math.floor(Math.random() * 101) + 100;
      const chests = Math.floor(Math.random() * 2) + 1;
      rewardsText = `${beli} beli\n${chests} C tier chest${chests > 1 ? 's' : ''}`;
      if (sailProgress.difficulty === 'hard') rewardsText += '\n1 B tier chest';
    } else {
      const beli = Math.floor(Math.random() * 151) + 100;
      const chests = Math.floor(Math.random() * 2) + 1;
      rewardsText = `${beli} beli\n${chests} C tier chest${chests > 1 ? 's' : ''}${resetToken ? '\n1 reset token' : ''}`;
    }
    for (const cardId of rewards) {
      const card = getCardById(cardId);
      const name = card ? card.name : cardId;
      if (converted.includes(cardId)) rewardsText += `\n~~1x ${name}~~`; else rewardsText += `\n1x ${name}`;
    }
    if (converted.length > 0) {
      rewardsText += '\n\n' + converted.map(id => {
        const card = getCardById(id);
        return `You already own ${card ? card.name : id}, converted to 100 XP.`;
      }).join('\n');
    }
    if (session.secretStage) rewardsText += '\n\n**Secret Stage Bonus:** Roronoa Zoro +25 levels!';
    if (session.zoroFinal) {
      if (hadZoroBefore) rewardsText += '\n\n**Final Encounter:** You defeated Zoro — Roronoa Zoro +25 levels!';
      else rewardsText += '\n\n**Final Encounter:** You defeated Zoro — Roronoa Zoro obtained at Level 25!';
    }

    sailProgress.progress = nextProgress;
    await sailProgress.save();

    const embed = new EmbedBuilder()
      .setTitle('Victory!')
      .setDescription(`You completed ${episodeTitle}!`)
      .addFields({ name: 'Rewards', value: rewardsText, inline: false });

    // Add a sail button to progress to the next episode for Episode 2 and Episode 3
    const components = [];
    const rows = [];
    if (session.episode === 2) {
      const btns = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sail_battle_ep3:${session.userId}:start`).setLabel('Sail to Episode 3').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`sail:${session.userId}:map`).setLabel('Map').setStyle(ButtonStyle.Secondary)
      );
      rows.push(btns);
    } else if (session.episode === 3) {
      const btns = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sail_battle_ep4:${session.userId}:start`).setLabel('Sail to Episode 4').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`sail:${session.userId}:map`).setLabel('Map').setStyle(ButtonStyle.Secondary)
      );
      rows.push(btns);
    }

    if (rows.length) await channel.send({ embeds: [embed], components: rows }); else await channel.send({ embeds: [embed] });
  } else {
    // on defeat, show reason if timed out
    const reason = session.timedOut ? 'You were defeated because you took too long to act.' : 'You were defeated. Try again later.';
    const embed = new EmbedBuilder().setTitle('Defeat').setDescription(reason);
    // set cooldown (5 minutes) on starting sails after defeat
    try {
      const SailProgress = (await import("../models/SailProgress.js")).default;
      const sailProg = await SailProgress.findOne({ userId: session.userId }) || new SailProgress({ userId: session.userId });
      sailProg.lastSail = new Date();
      await sailProg.save();
    } catch (e) { console.error('Failed to set sail cooldown after defeat:', e); }
    await channel.send({ embeds: [embed] });
  }

  global.SAIL_SESSIONS.delete(sessionId);
}

async function enemyAttack(session, channel) {
  const aliveEnemies = session.enemies.filter(e => e.health > 0);
  if (aliveEnemies.length === 0) return;
  let targetIndex = 0;
  let maxPower = 0;
  session.cards.forEach((c, idx) => {
    if (c.health > 0 && c.scaled.power > maxPower) {
      maxPower = c.scaled.power;
      targetIndex = idx;
    }
  });
  const target = session.cards[targetIndex];
  let totalDamage = 0;
  const damageDetails = [];
  for (const enemy of aliveEnemies) {
    const damage = Math.floor(Math.random() * (enemy.attackRange[1] - enemy.attackRange[0] + 1)) + enemy.attackRange[0];
    target.health -= damage;
    totalDamage += damage;
    damageDetails.push(`${enemy.name} attacks for ${damage} damage!`);
    if (target.health < 0) target.health = 0;
    if (target.health <= 0) target.stamina = 0;
  }
  const attackEmbed = new EmbedBuilder()
    .setTitle('Enemy Attack')
    .setDescription(damageDetails.join('\n') + `\n\nTotal: ${totalDamage} damage!`);
  await channel.send({ embeds: [attackEmbed] });
}

async function performSailAttack(session, cardIndex, enemy, actionType, interaction) {
  const card = session.cards[cardIndex];
  let damage;
  if (actionType === 'attack') {
    damage = Math.floor(Math.random() * (card.scaled.attackRange[1] - card.scaled.attackRange[0] + 1)) + card.scaled.attackRange[0];
    card.stamina = Math.max(0, (card.stamina ?? 3) - 1);
  } else if (actionType === 'special') {
    const special = card.scaled.specialAttack;
    damage = Math.floor(Math.random() * (special.range[1] - special.range[0] + 1)) + special.range[0];
    card.stamina = Math.max(0, (card.stamina ?? 3) - 3);
    card.usedSpecial = true;
    card.skipNextTurnPending = true;
  }
  card.attackedLastTurn = true;
  enemy.health -= damage;
  if (enemy.health < 0) enemy.health = 0;
  const resultEmbed = new EmbedBuilder()
    .setTitle(actionType === 'special' ? `Special Attack: ${card.scaled.specialAttack.name}` : 'Attack Result')
    .setDescription(`${card.card.name} ${actionType}s ${enemy.name} for ${damage} damage!`);
  if (actionType === 'special' && card.scaled.specialAttack.gif) resultEmbed.setImage(card.scaled.specialAttack.gif);
  await interaction.update({ embeds: [resultEmbed], components: [] });
  setTimeout(async () => {
    await enemyAttack(session, interaction.channel);
    await startSailTurn(session.sessionId, interaction.channel);
  }, 2000);

}

async function startSailTurn(sessionId, channel) {
  const session = global.SAIL_SESSIONS.get(sessionId);
  if (!session) return;

  if (!session.cards || session.cards.length === 0) return;
  if (session.lifeIndex == null || session.lifeIndex >= session.cards.length || session.cards[session.lifeIndex].health <= 0) {
    const idx = session.cards.findIndex(c => c.health > 0);
    session.lifeIndex = idx === -1 ? session.cards.length : idx;
  }

  session.cards.forEach(c => { c.skipThisTurn = false; });
  session.cards.forEach(c => { if (c.skipNextTurnPending) { c.skipThisTurn = true; c.skipNextTurnPending = false; } });

  session.cards.forEach(c => {
    if (!c.attackedLastTurn) {
      c.stamina = Math.min(3, (c.stamina ?? 3) + 1);
    }
    c.attackedLastTurn = false;
  });

  // Ensure knocked-out cards have no stamina (stamina is irrelevant when dead)
  session.cards.forEach(c => { if (c.health <= 0) c.stamina = 0; });

  if (session.lifeIndex >= session.cards.length) {
    await endSailBattle(sessionId, channel, false);
    return;
  }

  const aliveEnemies = session.enemies.filter(e => e.health > 0);
  if (aliveEnemies.length === 0) {
    if (session.episode === 2) {
      // Episode 2 progression: Phase 1 = Helmeppo, Phase 2 = three Marines, Phase 3 = (if refused) Zoro final
      if (session.phase === 1) {
        session.enemies = [ { name: 'Helmeppo', health: 90, maxHealth: 90, attackRange: [12,18], power: 15 } ];
        session.phase = 2;
      } else if (session.phase === 2) {
        session.enemies = [
          { name: 'Marine', health: 80, maxHealth: 80, attackRange: [10,16], power: 12 },
          { name: 'Marine', health: 80, maxHealth: 80, attackRange: [10,16], power: 12 },
          { name: 'Marine', health: 80, maxHealth: 80, attackRange: [10,16], power: 12 }
        ];
        session.phase = 3;
      } else if (session.phase === 3 && session.hasZoro === false) {
        // Spawn final Zoro encounter for players who refused to help earlier
        session.enemies = [ { name: 'Roronoa Zoro', health: 210, maxHealth: 210, attackRange: [25,50], power: 35, specialAttack: { name: 'Oni Giri', range: [85,135] } } ];
        session.phase = 4;
        session.zoroFinal = true;
      } else {
        await endSailBattle(sessionId, channel, true);
        return;
      }
    } else if (session.episode === 3) {
      // Episode 3 progression: three Marines then Axe-hand Morgan
      if (session.phase === 1) {
        session.enemies = [
          { name: 'Marine', health: 65, maxHealth: 65, attackRange: [6,12], power: 8 },
          { name: 'Marine', health: 65, maxHealth: 65, attackRange: [6,12], power: 8 },
          { name: 'Marine', health: 65, maxHealth: 65, attackRange: [6,12], power: 8 }
        ];
        session.phase = 2;
      } else if (session.phase === 2) {
        session.enemies = [{ name: 'Axe-hand Morgan', health: 170, maxHealth: 170, attackRange: [15,35], power: 25 }];
        session.phase = 3;
      } else {
        await endSailBattle(sessionId, channel, true);
        return;
      }
    } else {
      if (session.phase === 1) {
        session.enemies = [{ name: 'Poppoko', health: 75, maxHealth: 75, attackRange: [10,15], power: 10 }];
        session.phase = 2;
      } else if (session.phase === 2) {
        session.enemies = [{ name: 'Alvida', health: 120, maxHealth: 120, attackRange: [10,20], power: 20 }];
        session.phase = 3;
      } else {
        await endSailBattle(sessionId, channel, true);
        return;
      }
    }

    const multiplier = session.difficulty === 'hard' ? 1.5 : session.difficulty === 'medium' ? 1.25 : 1;
    session.enemies.forEach(enemy => {
      enemy.health = roundNearestFive(enemy.health * multiplier);
      enemy.maxHealth = enemy.health;
      enemy.attackRange = [Math.ceil(enemy.attackRange[0] * multiplier), Math.ceil(enemy.attackRange[1] * multiplier)];
      enemy.power = Math.ceil(enemy.power * multiplier);
    });
  }

  // If the current side has no playable cards (all exhausted or skipped), auto-skip this turn
  const hasPlayable = session.cards.some(c => c.health > 0 && !(c.skipThisTurn) && ((c.stamina ?? 3) > 0));
  if (!hasPlayable) {
    // Inform player why enemies acted twice
    try { await channel.send({ content: "You had no stamina to act; the enemies attacked while you couldn't respond." }); } catch (e) {}
    // let enemies act and continue
    await enemyAttack(session, channel);
    await startSailTurn(sessionId, channel);
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('Sail Battle')
    .setDescription(`Phase ${session.phase}: Fight!`)
    .addFields(
      { name: 'Your Team', value: session.cards.map((c, idx) => `**${idx + 1}. ${c.card.name}** — HP: ${c.health}/${c.maxHealth} • Stamina: ${c.stamina ?? 3}/3`).join('\n'), inline: false },
      { name: 'Enemies', value: session.enemies.map(e => `**${e.name}** — HP: ${e.health}/${e.maxHealth}`).join('\n'), inline: false }
    );

  const attackButtons = session.cards.map((c, idx) =>
    new ButtonBuilder()
      .setCustomId(`sail_selectchar:${sessionId}:${idx}`)
      .setLabel(`${c.card.name}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(c.health <= 0 || (c.stamina ?? 3) <= 0)
  );

  const hakiButtons = session.cards.map((c, idx) =>
    new ButtonBuilder()
      .setCustomId(`sail_haki:${sessionId}:${idx}`)
      .setLabel('Haki')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(c.health <= 0 || (c.stamina ?? 3) <= 0)
  );

  const healButton = new ButtonBuilder()
    .setCustomId(`sail_heal:${sessionId}`)
    .setLabel('Heal')
    .setStyle(ButtonStyle.Success);

  const rows = [];
  for (let i = 0; i < attackButtons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(attackButtons.slice(i, i + 5)));
  }
  for (let i = 0; i < hakiButtons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(hakiButtons.slice(i, i + 5)));
  }
  rows.push(new ActionRowBuilder().addComponents(healButton));

  // Prevent duplicate immediate prompts (debounce very short repeated calls)
  const now = Date.now();
  if (session._lastEmbedSent && (now - session._lastEmbedSent) < 500) {
    return;
  }
  const msg = await channel.send({ embeds: [embed], components: rows });
  session.msgId = msg.id;
  session._lastEmbedSent = Date.now();
  // clear any existing turn timeout
  try { if (session.turnTimer) { clearTimeout(session.turnTimer); session.turnTimer = null; } } catch (e) {}

  // If there are playable actions, start a 30s timeout that causes an auto-loss
  if (hasPlayable) {
    session.turnTimer = setTimeout(async () => {
      try {
        const s = global.SAIL_SESSIONS.get(sessionId);
        if (!s) return;
        // only act if the message hasn't been superseded
        if (s.msgId === msg.id) {
          // mark timeout reason so endSailBattle can show accurate message
          s.timedOut = true;
          await endSailBattle(sessionId, channel, false);
        }
      } catch (e) { console.error('Sail turn timeout error:', e); }
    }, 45000);
  }
}

export async function execute(interaction, client) {
  try {
    // sail difficulty select
    if (interaction.isSelectMenu && interaction.isSelectMenu()) {
    const id = interaction.customId || "";
    if (id.startsWith("sail_difficulty:")) {
      const parts = id.split(":");
      const userId = parts[1];
      if (interaction.user.id !== userId) return interaction.reply({ content: "Only the original requester can use this select.", ephemeral: true });

      const selected = interaction.values && interaction.values[0];
      if (!selected) return;

      const SailProgress = (await import("../models/SailProgress.js")).default;
      let sailProgress = await SailProgress.findOne({ userId }) || new SailProgress({ userId });
      sailProgress.difficulty = selected;
      await sailProgress.save();

      await interaction.reply({ content: `Difficulty set to ${selected}.`, flags: MessageFlags.Ephemeral });
      return;
    }
  }

  if (interaction.isButton()) {
      const id = interaction.customId || "";
      // only handle known prefixes (include shop_ and duel_). Let per-message duel_* collectors handle duel interactions.
      if (!id.startsWith("info_") && !id.startsWith("collection_") && !id.startsWith("quest_") && !id.startsWith("help_") && !id.startsWith("drop_claim") && !id.startsWith("shop_") && !id.startsWith("duel_") && !id.startsWith("leaderboard_") && !id.startsWith("sail:") && !id.startsWith("sail_battle:") && !id.startsWith("sail_battle_ep2:") && !id.startsWith("sail_battle_ep3:") && !id.startsWith("sail_ep2_choice:") && !id.startsWith("sail_selectchar:") && !id.startsWith("sail_chooseaction:") && !id.startsWith("sail_selecttarget:") && !id.startsWith("sail_heal:") && !id.startsWith("sail_heal_item:") && !id.startsWith("sail_heal_card:") && !id.startsWith("sail_haki:") && !id.startsWith("map_nav:")) return;
      // ignore duel_* here so message-level collectors in `commands/duel.js` receive them
      if (id.startsWith("duel_")) return;

      const parts = id.split(":");
      if (parts.length < 2) return;
      const action = parts[0];
      const ownerId = parts[1];

      // HANDLE DROP CLAIMS: drop_claim:<token>
      if (id.startsWith("drop_claim")) {
        const token = parts[1];
        try {
          const drops = await import('../lib/drops.js');
          const res = await drops.claimDrop(token, interaction.user.id);
          if (!res.ok) {
            if (res.reason === 'not_found') return interaction.reply({ content: 'This drop has expired or was not found.', ephemeral: true });
            if (res.reason === 'already_claimed') return interaction.reply({ content: `This drop has already been claimed.`, ephemeral: true });
            return interaction.reply({ content: 'Unable to claim drop.', ephemeral: true });
          }

          // edit original message to disable button and mark claimed
          try {
            const ch = await interaction.client.channels.fetch(res.channelId).catch(() => null);
            if (ch && res.messageId) {
              const msg = await ch.messages.fetch(res.messageId).catch(() => null);
              if (msg) {
                const disabledButton = new ButtonBuilder().setCustomId(`drop_claim:${token}`).setLabel('Claimed').setStyle(ButtonStyle.Secondary).setDisabled(true);
                const disabledRow = new ActionRowBuilder().addComponents(disabledButton);
                // update embed footer to indicate claimed
                const embeds = msg.embeds || [];
                if (embeds && embeds[0]) {
                  const e = EmbedBuilder.from(embeds[0]);
                  const footerText = (e.data.footer && e.data.footer.text ? e.data.footer.text : '') + ` • Claimed by ${interaction.user.tag}`;
                  e.setFooter({ text: footerText });
                  await msg.edit({ embeds: [e], components: [disabledRow] }).catch(() => {});
                } else {
                  await msg.edit({ components: [disabledRow] }).catch(() => {});
                }
              }
            }
          } catch (e) {
            // ignore
            console.error('Error editing drop message after claim:', e && e.message ? e.message : e);
          }

          // Check if this was a duplicate card (converted to XP) or a new card
          if (res.result && !res.result.isNew) {
            const xpGain = res.result.xpGain || 0;
            const leveledText = res.result.leveled ? ' and leveled up!' : '!';
            await interaction.reply({ content: `You already own **${res.card.name}**! Converted to **${xpGain} XP**${leveledText}`, ephemeral: true });
          } else {
            await interaction.reply({ content: `You claimed **${res.card.name}** (Lv ${res.level}) — check your collection.`, ephemeral: true });
          }
          return;
        } catch (e) {
          console.error('drop claim handler error:', e && e.message ? e.message : e);
          return interaction.reply({ content: 'Error processing claim.', ephemeral: true });
        }
      }

      // HELP category buttons: help_cat:<category>:<userId>
      if (id.startsWith("help_cat")) {
        const parts = id.split(":");
        const category = parts[1];
        const userId = parts[2];
        if (interaction.user.id !== userId) {
          await interaction.reply({ content: "Only the original requester can use these buttons.", ephemeral: true });
          return;
        }

        // Static help groups (match commands provided by owner)
        const groups = {
          COMBAT: [
            { name: "team", desc: "view your team" },
            { name: "duel", desc: "challenge another user to a duel" },
            { name: "forfeit", desc: "forfeit an active duel" },
            { name: "team add", desc: "add a card to your team" },
            { name: "team remove", desc: "remove a card from your team" },
            { name: "autoteam", desc: "builds the best possible team (powerwise)" },
            { name: "upgrade", desc: "upgrade a card to its next rank" }
          ],
          ECONOMY: [
            { name: "balance", desc: "shows your balance and reset token count" },
            { name: "daily", desc: "claim daily rewards" },
            { name: "gamble", desc: "gamble an amount of beli" },
            { name: "mission", desc: "one piece trivia questions that give you rewards" },
            { name: "quests", desc: "view your daily and weekly quests" },
            { name: "sell", desc: "sell a card or item for beli" }
          ],
          COLLECTION: [
            { name: "info", desc: "view info about a card or item" },
            { name: "pull", desc: "pull a random card" },
            { name: "craft", desc: "craft items or combine materials" },
            { name: "chest", desc: "open your chests" },
            { name: "equip", desc: "equip a weapon or item to a card" },
            { name: "resetpulls", desc: "resets your card pull count" }
          ],
          GENERAL: [
            { name: "help", desc: "shows all bot commands" },
            { name: "inventory", desc: "view your inventory items" },
            { name: "level", desc: "use XP books/scrolls to level up a card" },
            { name: "user", desc: "shows your user profile" }
          ]
        };

        const groupKey = (category || '').toString().toUpperCase();
        if (!groups[groupKey]) {
          await interaction.reply({ content: "Category not found.", ephemeral: true });
          return;
        }

        const lines = groups[groupKey].map(c => `**${c.name}** — ${c.desc}`).join("\n") || "No commands";
        const label = (category || '').toString();
        const prettyLabel = label ? (label.charAt(0).toUpperCase() + label.slice(1).toLowerCase()) : 'Category';
        const embed = new EmbedBuilder()
          .setTitle(`${prettyLabel} Commands`)
          .setColor(0xFFFFFF)
          .setDescription(lines)
          .setFooter({ text: `Requested by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() });

        // build buttons for all categories, mark selected as primary
        const order = ["Combat", "Economy", "Collection", "General"];
        const allButtons = order.map(cat => new ButtonBuilder()
          .setCustomId(`help_cat:${cat.toUpperCase()}:${userId}`)
          .setLabel(cat)
          .setStyle(cat.toUpperCase() === groupKey ? ButtonStyle.Primary : ButtonStyle.Secondary)
        );

        const rows = [];
        for (let i = 0; i < allButtons.length; i += 5) {
          rows.push(new ActionRowBuilder().addComponents(...allButtons.slice(i, i + 5)));
        }

        await interaction.update({ embeds: [embed], components: rows });
        return;
      }

      // Leaderboard buttons: leaderboard_<mode>:<userId>
      if (id.startsWith('leaderboard_')) {
        const parts = id.split(":");
        const action = parts[0]; // e.g., leaderboard_level
        const ownerId = parts[1];
        if (interaction.user.id !== ownerId) {
          await interaction.reply({ content: 'Only the original requester can use these buttons.', ephemeral: true });
          return;
        }

        const mode = action.replace('leaderboard_', '');
        try {
          if (mode === 'level') {
            const Balance = (await import('../models/Balance.js')).default;
            const top = await Balance.find({}).sort({ level: -1, xp: -1 }).limit(10).lean();
            const lines = await Promise.all(top.map(async (b, idx) => {
              let name = b.userId;
              try { const u = await interaction.client.users.fetch(String(b.userId)).catch(() => null); if (u) name = u.username; } catch (e) {}
              return `**${idx + 1}. ${name}** — Level: ${b.level || 0}`;
            }));
            const embed = new EmbedBuilder().setTitle('Leaderboard — Level').setColor(0xFFFFFF).setDescription(lines.join('\n') || 'No data');
            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`leaderboard_level:${ownerId}`).setLabel('Level').setStyle(ButtonStyle.Primary),
              new ButtonBuilder().setCustomId(`leaderboard_wealth:${ownerId}`).setLabel('Wealth').setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId(`leaderboard_collection:${ownerId}`).setLabel('Collection').setStyle(ButtonStyle.Secondary)
            );
            await interaction.update({ embeds: [embed], components: [row] });
            return;
          }

          if (mode === 'wealth') {
            const Balance = (await import('../models/Balance.js')).default;
            const top = await Balance.find({}).sort({ amount: -1 }).limit(10).lean();
            const lines = await Promise.all(top.map(async (b, idx) => {
              let name = b.userId;
              try { const u = await interaction.client.users.fetch(String(b.userId)).catch(() => null); if (u) name = u.username; } catch (e) {}
              return `**${idx + 1}. ${name}** — ${b.amount || 0} beli¥`;
            }));
            const embed = new EmbedBuilder().setTitle('Leaderboard — Wealth').setColor(0xFFFFFF).setDescription(lines.join('\n') || 'No data');
            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`leaderboard_level:${ownerId}`).setLabel('Level').setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId(`leaderboard_wealth:${ownerId}`).setLabel('Wealth').setStyle(ButtonStyle.Primary),
              new ButtonBuilder().setCustomId(`leaderboard_collection:${ownerId}`).setLabel('Collection').setStyle(ButtonStyle.Secondary)
            );
            await interaction.update({ embeds: [embed], components: [row] });
            return;
          }

          if (mode === 'collection') {
            const Progress = (await import('../models/Progress.js')).default;
            const progs = await Progress.find({}).lean();
            const arr = progs.map(p => {
              const cards = p.cards || {};
              const count = (cards instanceof Object && !(cards instanceof Array)) ? Object.keys(cards).length : (cards.size || 0);
              return { userId: p.userId, count };
            });
            arr.sort((a, b) => b.count - a.count);
            const top = arr.slice(0, 10);
            const lines = await Promise.all(top.map(async (it, idx) => {
              let name = it.userId;
              try { const u = await interaction.client.users.fetch(String(it.userId)).catch(() => null); if (u) name = u.username; } catch (e) {}
              return `**${idx + 1}. ${name}** — ${it.count} unique cards`;
            }));
            const embed = new EmbedBuilder().setTitle('Leaderboard — Collection').setColor(0xFFFFFF).setDescription(lines.join('\n') || 'No data');
            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`leaderboard_level:${ownerId}`).setLabel('Level').setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId(`leaderboard_wealth:${ownerId}`).setLabel('Wealth').setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId(`leaderboard_collection:${ownerId}`).setLabel('Collection').setStyle(ButtonStyle.Primary)
            );
            await interaction.update({ embeds: [embed], components: [row] });
            return;
          }
        } catch (e) {
          console.error('Leaderboard handler error:', e && e.message ? e.message : e);
          await interaction.reply({ content: 'Error loading leaderboard.', ephemeral: true });
          return;
        }
      }

      // Handle sail buttons
      if (action === "sail") {
        const userId = ownerId;
        const subaction = parts[2];

        if (interaction.user.id !== userId) {
          await interaction.reply({ content: "Only the original requester can use these buttons.", ephemeral: true });
          return;
        }

        const SailProgress = (await import("../models/SailProgress.js")).default;
        const Progress = (await import("../models/Progress.js")).default;
        let sailProgress = await SailProgress.findOne({ userId }) || new SailProgress({ userId });
        let progress = await Progress.findOne({ userId }) || new Progress({ userId, team: [], cards: new Map() });

        // Normalize cards map for consistent access
        if (!progress.cards || typeof progress.cards.get !== 'function') {
          progress.cards = new Map(Object.entries(progress.cards || {}));
        }

        if (subaction === "sail") {
          // enforce cooldown after a defeat: 5 minutes
          if (sailProgress && sailProgress.lastSail) {
            try {
              const last = new Date(sailProgress.lastSail).getTime();
              const diff = Date.now() - last;
              const cooldown = 5 * 60 * 1000;
              if (diff < cooldown) {
                const remaining = Math.ceil((cooldown - diff) / 1000);
                await interaction.reply({ content: `You are on cooldown after defeat. Please wait ${remaining} seconds before sailing again.`, ephemeral: true });
                return;
              }
            } catch (e) { /* ignore parse errors */ }
          }
          // Progress to next episode
          if (sailProgress.progress === 0) {
            sailProgress.progress = 1;
            const stars = sailProgress.difficulty === 'medium' ? 2 : sailProgress.difficulty === 'hard' ? 3 : 1;
            sailProgress.stars.set('1', stars);
            await sailProgress.save();

              // compute xp amount based on difficulty
              const xpAmount = sailProgress.difficulty === 'hard' ? 30 : sailProgress.difficulty === 'medium' ? 20 : 10;

              // Send episode 1 embed (include XP info) - title format matches Episode 0 style
              const embed = new EmbedBuilder()
                .setColor('Blue')
                .setTitle(`**I'm Luffy! — Episode 1**`)
                .setDescription(`Luffy is found floating at sea by a cruise ship. After repelling an invasion by the Alvida Pirates, he meets a new ally, their chore boy Koby.\n\n**Possible rewards:**\n100 - 250 beli\n1 - 2 C tier chest${sailProgress.difficulty === 'hard' ? '\n1x Koby card\n1x Alvida card (Exclusive to Hard mode)\n1x Heppoko card (Exclusive to Hard mode)\n1x Peppoko card (Exclusive to Hard mode)\n1x Poppoko card (Exclusive to Hard mode)\n1x Alvida Pirates banner blueprint (C rank Item card, signature: alvida pirates, boosts stats by +5%)' : '\n1x Koby card'}${Math.random() < 0.5 ? '\n1 reset token' : ''}\n\n*XP awarded: +${xpAmount} to user and each team card.*`)
                .setImage('https://files.catbox.moe/zlda8y.webp');

            const buttons = new ActionRowBuilder()
              .addComponents(
                new ButtonBuilder()
                  .setCustomId(`sail_battle:${userId}:ready`)
                  .setLabel("I'm ready!")
                  .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                  .setCustomId(`sail:${userId}:map`)
                  .setLabel('Map')
                  .setStyle(ButtonStyle.Secondary)
              );

            await interaction.update({ embeds: [embed], components: [buttons] });
          } else if (sailProgress.progress === 1) {
            // Do not auto-advance to Episode 2 here. Require completing Episode 1 first.
            await interaction.reply({ content: 'You must complete Episode 1 to unlock Episode 2. Use the "I\'m ready!" button on Episode 1 to start the battle.', ephemeral: true });
            return;
          } else {
            await interaction.reply({ content: `Already at Episode ${sailProgress.progress}.`, ephemeral: true });
          }
        } else if (subaction === "map") {
          // Reuse the /map command so the episode Map button shows the same map view
          try {
            const mapCommand = await import('../commands/map.js');
            await mapCommand.execute(interaction);
          } catch (e) {
            console.error('Error invoking map command from sail button:', e && e.message ? e.message : e);
            await interaction.reply({ content: 'Error showing the map.', ephemeral: true });
          }
          return;
        }
      }

      // Handle sail_battle buttons
      if (action === "sail_battle") {
        const userId = ownerId;
        const subaction = parts[2];

        if (interaction.user.id !== userId) {
          await interaction.reply({ content: "Only the original requester can use these buttons.", ephemeral: true });
          return;
        }

        if (subaction === "ready") {
          // Start battle
          const Progress = (await import("../models/Progress.js")).default;
          const progress = await Progress.findOne({ userId });
          if (!progress || !progress.team || progress.team.length === 0) {
            await interaction.reply({ content: "You need a team to sail. Use /team to set your team.", ephemeral: true });
            return;
          }

          // Define enemies for phase 1: Heppoko and Peppoko
          const enemies = [
            { name: 'Heppoko', health: 70, maxHealth: 70, attackRange: [10,15], power: 10 },
            { name: 'Peppoko', health: 70, maxHealth: 70, attackRange: [10,15], power: 10 }
          ];

          // Get difficulty and apply enemy stat boost
          const SailProgress = (await import("../models/SailProgress.js")).default;
          const sailProgress = await SailProgress.findOne({ userId });
          const difficulty = (sailProgress && sailProgress.difficulty) || 'easy';
          const multiplier = difficulty === 'hard' ? 1.5 : difficulty === 'medium' ? 1.25 : 1;
          enemies.forEach(enemy => {
            enemy.health = roundNearestFive(enemy.health * multiplier);
            enemy.maxHealth = enemy.health;
            enemy.attackRange = [Math.ceil(enemy.attackRange[0] * multiplier), Math.ceil(enemy.attackRange[1] * multiplier)];
            enemy.power = Math.ceil(enemy.power * multiplier);
          });

          const sessionId = `sail_${userId}_${Date.now()}`;
          global.SAIL_SESSIONS = global.SAIL_SESSIONS || new Map();

          // Get user's cards
          const WeaponInventory = (await import('../models/WeaponInventory.js')).default;
          const winv = await WeaponInventory.findOne({ userId });
          const hasBanner = winv && winv.teamBanner === 'alvida_pirates_banner_c_01';
          const { computeTeamBoosts } = await import("../lib/boosts.js");
          const { getCardById } = await import("../cards.js");

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

          const p1TeamBoosts = computeTeamBoosts(progress.team || [], progress.cards || null, null);
          const p1Cards = progress.team.map(cardId => {
            const card = getCardById(cardId);
            const hasMap = progress.cards && typeof progress.cards.get === 'function';
            const progressCard = hasMap ? (progress.cards.get(cardId) || { level: 0, xp: 0 }) : (progress.cards[cardId] || { level: 0, xp: 0 });
            const level = progressCard.level || 0;
            const mult = 1 + (level * 0.01);
            let health = Math.round((card.health || 0) * mult);
            let attackMin = Math.round(((card.attackRange && card.attackRange[0]) || 0) * mult);
            let attackMax = Math.round(((card.attackRange && card.attackRange[1]) || 0) * mult);
            const special = card.specialAttack ? { ...card.specialAttack, range: [(card.specialAttack.range[0] || 0) * mult, (card.specialAttack.range[1] || 0) * mult] } : null;
            let power = Math.round((card.power || 0) * mult);

            const equipped = getEquippedWeaponForCard(winv, cardId);
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
            if (hasBanner && bannerSignature.includes(cardId)) {
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
            if (special && special.range) special.range = roundRangeToFive([Math.round(special.range[0] || 0), Math.round(special.range[1] || 0)]);

            const hakiParsed = parseHaki(card);
            return { cardId, card, scaled: { attackRange: [finalAttackMin, finalAttackMax], specialAttack: special, power: finalPower }, health: finalHealth, maxHealth: finalHealth, level, stamina: 3, usedSpecial: false, attackedLastTurn: false, haki: hakiParsed, dodgeChance: (hakiParsed.observation.stars || 0) * 0.05 };
          });

          global.SAIL_SESSIONS.set(sessionId, {
            userId,
            user: interaction.user,
            cards: p1Cards,
            lifeIndex: 0,
            enemies,
            phase: 1,
            sessionId,
            channelId: interaction.channel.id,
            msgId: null,
            difficulty
          });

          await startSailTurn(sessionId, interaction.channel);
        }
      }

      // Handle sail_battle_ep2 buttons
      if (action === "sail_battle_ep2") {
        const userId = ownerId;
        const subaction = parts[2];

        if (interaction.user.id !== userId) {
          await interaction.reply({ content: "Only the original requester can use these buttons.", flags: MessageFlags.Ephemeral });
          return;
        }

        if (subaction === "start") {
          // Start Episode 2: Zoro choice
          const embed = new EmbedBuilder()
            .setColor('Blue')
            .setDescription(`You encounter infamous pirate hunter Zoro, help him ?\n\n**If yes:**\nObtain 1x Roronoa Zoro card\nMove to stage 2\n-1 Karma\n\n**If no:**\nMove to stage 2\n Extra Secret stage\n+1 Karma`)
            .setImage('https://files.catbox.moe/y6pah3.webp');

          const buttons = new ActionRowBuilder()
            .addComponents(
              new ButtonBuilder()
                .setCustomId(`sail_ep2_choice:${userId}:yes`)
                .setLabel('Yes')
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId(`sail_ep2_choice:${userId}:no`)
                .setLabel('No')
                .setStyle(ButtonStyle.Danger)
            );

          await interaction.update({ embeds: [embed], components: [buttons] });
          try { console.log('sail_battle_ep2:start shown to', interaction.user.id); } catch (e) {}
        }
      }

      // Handle sail_battle_ep3 buttons
      if (action === "sail_battle_ep3") {
        const userId = ownerId;
        const subaction = parts[2];

        if (interaction.user.id !== userId) {
          await interaction.reply({ content: "Only the original requester can use these buttons.", ephemeral: true });
          return;
        }

        if (subaction === "start") {
          const embed = new EmbedBuilder()
            .setColor('Blue')
            .setTitle("**Morgan vs. Luffy! Who's This Mysterious Beautiful Young Girl? - Episode 3**")
            .setDescription(`Luffy and Zoro battle and defeat Morgan, Helmeppo and the Marines. Koby parts ways with Luffy to join the Marines, and Zoro joins Luffy's crew as a permanent crew member.\n\n**Possible rewards:**\n250 - 500 beli\n1 - 2 C chest\n1 B chest (Hard mode exclusive)\n1x Axe-hand Morgan card (Hard mode exclusive)`)
            .setImage('https://files.catbox.moe/8os33p.webp');

          const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`sail_battle_ep3:${userId}:ready`).setLabel("I'm ready!").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`sail:${userId}:map`).setLabel('Map').setStyle(ButtonStyle.Secondary)
          );

          await interaction.update({ embeds: [embed], components: [buttons] });
        }

        if (subaction === 'ready') {
          try {
            console.log('Calling startEpisode3Stage2 for', userId);
            await startEpisode3Stage2(userId, interaction);
          } catch (e) {
            console.error('Failed to start Episode3 Stage2:', e && e.message ? e.message : e);
            try { await interaction.followUp({ content: 'Error starting Episode 3 battle.', ephemeral: true }); } catch (err) {}
          }
        }
      }

      // Handle map navigation buttons (map_nav:back|next:<userId>)
      if (action === 'map_nav') {
        const sub = parts[2]; // back or next
        const userId = ownerId;
        if (interaction.user.id !== userId) return interaction.reply({ content: 'Only the original requester can use these buttons.', ephemeral: true });

        const SailProgress = (await import('../models/SailProgress.js')).default;
        const sailProgress = await SailProgress.findOne({ userId }) || new SailProgress({ userId });
        const progress = sailProgress.progress || 0;

        const islands = [
          { name: 'Goat Island', start: 1, end: 1 },
          { name: 'Shells Town', start: 2, end: 3 },
          { name: 'Orange Town', start: 4, end: 8 },
          { name: 'Syrup Village', start: 9, end: 18 },
          { name: 'Baratie', start: 19, end: 30 },
          { name: 'Arlong Park', start: 31, end: 44 },
          { name: 'Loguetown', start: 45, end: 53 },
          { name: 'Warship Island', start: 54, end: 61, excludeFromEastBlue: true }
        ];

        const getStars = (ep) => { try { return sailProgress.stars.get(String(ep)) || 0; } catch (e) { return 0; } };

        // compute East Blue totals (exclude warship)
        let eastBlueTotal = 0; let eastBlueMax = 0;
        for (const isl of islands) {
          if (isl.excludeFromEastBlue) continue;
          const count = isl.end - isl.start + 1; eastBlueMax += count * 3;
          for (let e = isl.start; e <= isl.end; e++) eastBlueTotal += getStars(e);
        }
        const filledEast = eastBlueMax === 0 ? 0 : Math.floor((eastBlueTotal / eastBlueMax) * 8);
        const eastBar = '▰'.repeat(filledEast) + '▱'.repeat(8 - filledEast);

        // split islands into two pages to avoid long output
        const page = sub === 'next' ? 2 : 1;
        const splitIndex = Math.ceil(islands.length / 2);
        const pageIslands = page === 1 ? islands.slice(0, splitIndex) : islands.slice(splitIndex);

        const fields = [];
        fields.push({ name: 'East Blue saga', value: `${eastBlueTotal}/${eastBlueMax} ✭`, inline: false });
        fields.push({ name: '\u200b', value: eastBar, inline: false });

        for (const isl of pageIslands) {
          const epCount = isl.end - isl.start + 1;
          let islandStars = 0;
          for (let e = isl.start; e <= isl.end; e++) islandStars += getStars(e);
          const islandMax = epCount * 3;
          const islandFilled = islandMax === 0 ? 0 : Math.floor((islandStars / islandMax) * 8);
          const islandBar = '▰'.repeat(islandFilled) + '▱'.repeat(8 - islandFilled);

          let episodeLines = '';
          for (let e = isl.start; e <= isl.end; e++) {
            const stars = getStars(e);
            let status = '';
            if (e > progress) status = ' ⛓';
            else if (e < progress) status = ` ${stars}/3 ✭`;
            episodeLines += `Episode ${e}${status}\n`;
          }

          fields.push({ name: `**${isl.name}** ${islandStars}/${islandMax} ✭`, value: islandBar, inline: false });
          fields.push({ name: '\u200b', value: episodeLines.trim(), inline: false });
        }

        const Embed = EmbedBuilder;
        const embed = new Embed()
          .setTitle('World Map')
          .setDescription(`View your progress — page ${page}/${2}`)
          .setThumbnail('https://files.catbox.moe/e4w287.webp')
          .addFields(fields)
          .setFooter({ text: `page ${page}/2` });

        // update buttons to allow toggling
        const backBtn = new ButtonBuilder().setCustomId(`map_nav:back:${userId}`).setLabel('Back').setStyle(ButtonStyle.Secondary).setDisabled(page === 1);
        const nextBtn = new ButtonBuilder().setCustomId(`map_nav:next:${userId}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page === 2);
        const row = new ActionRowBuilder().addComponents(backBtn, nextBtn);

        await interaction.update({ embeds: [embed], components: [row] });
        return;
      }

      // Handle sail_ep2_choice buttons
      if (action === "sail_ep2_choice") {
        const userId = ownerId;
        const choice = parts[2];

        if (interaction.user.id !== userId) {
          await interaction.reply({ content: "Only the original requester can use these buttons.", flags: MessageFlags.Ephemeral });
          return;
        }

        // Acknowledge the button immediately to avoid "interaction failed"
        try { await interaction.deferUpdate(); } catch (e) { /* ignore */ }

        try { console.log('sail_ep2_choice pressed by', interaction.user.id, 'owner', userId, 'choice', choice); } catch (e) {}

        const Progress = (await import("../models/Progress.js")).default;
        const progress = await Progress.findOne({ userId });

        if (choice === "yes") {
          // Help Zoro: get Zoro card, -1 karma, move to stage 2
          progress.karma = (progress.karma || 0) - 1;
          await progress.save();

          // Add Zoro card to inventory (use canonical card id)
          const Inventory = (await import("../models/Inventory.js")).default;
          const inventory = await Inventory.findOne({ userId }) || new Inventory({ userId });
          inventory.cards = inventory.cards || {};
          inventory.cards['roronoazoro_c_01'] = (inventory.cards['roronoazoro_c_01'] || 0) + 1;
          await inventory.save();

          // Start Stage 2 battle
          try {
            console.log('Calling startEpisode2Stage2 (yes) for', userId);
            await startEpisode2Stage2(userId, interaction, true);
          } catch (e) {
            console.error('Failed to start Episode2 Stage2 (yes):', e && e.message ? e.message : e);
            try { await interaction.followUp({ content: 'Error starting Episode 2 battle.', ephemeral: true }); } catch (err) {}
          }
        } else {
          // Don't help Zoro: +1 karma, schedule final Zoro encounter at the end
          progress.karma = (progress.karma || 0) + 1;
          await progress.save();

          // Always proceed to stage 2; final Zoro will appear after Helmeppo and Marines
          try {
            console.log('Calling startEpisode2Stage2 (no) for', userId);
            await startEpisode2Stage2(userId, interaction, false);
          } catch (e) {
            console.error('Failed to start Episode2 Stage2 (no):', e && e.message ? e.message : e);
            try { await interaction.followUp({ content: 'Error starting Episode 2 battle.', ephemeral: true }); } catch (err) {}
          }
        }
      }

      // Handle sail_selectchar buttons
      if (action === "sail_selectchar") {
        const sessionId = parts[1];
        const cardIndex = parseInt(parts[2]);
        const session = global.SAIL_SESSIONS.get(sessionId);
        if (session && session.turnTimer) { try { clearTimeout(session.turnTimer); session.turnTimer = null; } catch (e) {} }
        if (!session || session.userId !== interaction.user.id) return interaction.reply({ content: "Session not found or not your turn.", ephemeral: true });

        const card = session.cards[cardIndex];
        if (!card || card.health <= 0 || (card.stamina || 3) <= 0) return interaction.reply({ content: "Invalid card.", ephemeral: true });

        const embed = new EmbedBuilder()
          .setTitle('Choose Action')
          .setDescription(`Choose an action for ${card.card.name}.`);

        const attackButton = new ButtonBuilder()
          .setCustomId(`sail_chooseaction:${sessionId}:${cardIndex}:attack`)
          .setLabel('Attack')
          .setStyle(ButtonStyle.Primary);

        const specialButton = new ButtonBuilder()
          .setCustomId(`sail_chooseaction:${sessionId}:${cardIndex}:special`)
          .setLabel('Special')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!card.scaled.specialAttack || (card.stamina ?? 3) < 3 || card.usedSpecial);

        const row = new ActionRowBuilder().addComponents(attackButton, specialButton);

        await interaction.update({ embeds: [embed], components: [row] });
      }

      // Handle sail_haki buttons (open haki menu for card)
      if (action === "sail_haki") {
        const sessionId = parts[1];
        const cardIndex = parseInt(parts[2]);
        const session = global.SAIL_SESSIONS.get(sessionId);
        if (session && session.turnTimer) { try { clearTimeout(session.turnTimer); session.turnTimer = null; } catch (e) {} }
        if (!session || session.userId !== interaction.user.id) return interaction.reply({ content: "Session not found or not your turn.", ephemeral: true });
        const card = session.cards[cardIndex];
        if (!card) return interaction.reply({ content: 'Invalid card', ephemeral: true });

        const haki = card.haki || { armament: { stars:0 }, observation:{stars:0}, conqueror:{stars:0} };
        const opts = [];
        if (haki.observation && haki.observation.advanced) opts.push({ id: 'futuresight', label: 'Future Sight', cost: 1, style: ButtonStyle.Primary });
        if (haki.armament && haki.armament.advanced) opts.push({ id: 'ryou', label: 'Ryou', cost: 2, style: ButtonStyle.Danger });
        if (haki.conqueror && haki.conqueror.stars > 0) opts.push({ id: 'conqueror', label: 'Conqueror Strike', cost: 2, style: ButtonStyle.Success });
        if (haki.conqueror && haki.conqueror.advanced) opts.push({ id: 'conq_aoe', label: 'Conqueror AoE', cost: 3, style: ButtonStyle.Danger });

        if (opts.length === 0) return interaction.reply({ content: 'This character has no Haki abilities.', ephemeral: true });

        const embed = new EmbedBuilder().setTitle(`${card.card.name} — Haki`).setDescription('Choose a Haki ability to use. These do not consume your turn but cost stamina.');
        const buttons = opts.map(o => new ButtonBuilder().setCustomId(`sail_haki_use:${sessionId}:${cardIndex}:${o.id}`).setLabel(`${o.label} (Cost: ${o.cost})`).setStyle(o.style));
        const row = new ActionRowBuilder().addComponents(buttons.slice(0,5));
        await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
      }

      // Handle sail_chooseaction buttons
      if (action === "sail_chooseaction") {
        const sessionId = parts[1];
        const cardIndex = parseInt(parts[2]);
        const actionType = parts[3];
        const session = global.SAIL_SESSIONS.get(sessionId);
        if (session && session.turnTimer) { try { clearTimeout(session.turnTimer); session.turnTimer = null; } catch (e) {} }
        if (!session || session.userId !== interaction.user.id) return;
        const card = session.cards[cardIndex];
        if (!card) return;
        if (actionType === 'special') {
          if (!card.scaled.specialAttack || card.usedSpecial || (card.stamina ?? 3) < 3) return;
        }
        const aliveEnemies = session.enemies.filter(e => e.health > 0);
        if (aliveEnemies.length === 1) {
          await performSailAttack(session, cardIndex, aliveEnemies[0], actionType, interaction);
        } else {
          const embed = new EmbedBuilder()
            .setTitle('Select Target')
            .setDescription(`Choose a target for ${card.card.name}'s ${actionType}.`);
          const targetButtons = aliveEnemies.map((e, idx) =>
            new ButtonBuilder()
              .setCustomId(`sail_selecttarget:${sessionId}:${cardIndex}:${actionType}:${session.enemies.indexOf(e)}`)
              .setLabel(e.name)
              .setStyle(ButtonStyle.Primary)
          );
          const row = new ActionRowBuilder().addComponents(targetButtons);
          await interaction.update({ embeds: [embed], components: [row] });
        }
      }

      // Handle sail_selecttarget buttons
      if (action === "sail_selecttarget") {
        const sessionId = parts[1];
        const cardIndex = parseInt(parts[2]);
        const actionType = parts[3];
        const enemyIndex = parseInt(parts[4]);
        const session = global.SAIL_SESSIONS.get(sessionId);
        if (session && session.turnTimer) { try { clearTimeout(session.turnTimer); session.turnTimer = null; } catch (e) {} }
        if (!session || session.userId !== interaction.user.id) return;
        const enemy = session.enemies[enemyIndex];
        if (!enemy || enemy.health <= 0) return;
        await performSailAttack(session, cardIndex, enemy, actionType, interaction);
      }

      // Handle sail_heal buttons
      if (action === "sail_heal") {
        const sessionId = parts[1];
        const session = global.SAIL_SESSIONS.get(sessionId);
        if (session && session.turnTimer) { try { clearTimeout(session.turnTimer); session.turnTimer = null; } catch (e) {} }
        if (!session || session.userId !== interaction.user.id) return;
        const Inventory = (await import("../models/Inventory.js")).default;
        const inventory = await Inventory.findOne({ userId: session.userId }) || new Inventory({ userId: session.userId });
        const healingItems = ['meat', 'fish', 'sake', 'sea king meat'];
        const available = healingItems.filter(item => (inventory.items.get(item) || 0) > 0);
        if (available.length === 0) return interaction.reply({ content: 'No healing items available.', ephemeral: true });
        const embed = new EmbedBuilder()
          .setTitle('Select Healing Item')
          .setDescription('Choose an item to use.');
        const itemButtons = available.map(item =>
          new ButtonBuilder()
            .setCustomId(`sail_heal_item:${sessionId}:${item}`)
            .setLabel(item)
            .setStyle(ButtonStyle.Primary)
        );
        const row = new ActionRowBuilder().addComponents(itemButtons);
        await interaction.update({ embeds: [embed], components: [row] });
      }

      // Handle sail_heal_item buttons
      if (action === "sail_heal_item") {
        const sessionId = parts[1];
        const item = parts[2];
        const session = global.SAIL_SESSIONS.get(sessionId);
        if (session && session.turnTimer) { try { clearTimeout(session.turnTimer); session.turnTimer = null; } catch (e) {} }
        if (!session || session.userId !== interaction.user.id) return;
        const embed = new EmbedBuilder()
          .setTitle('Select Card to Heal')
          .setDescription(`Using ${item}. Choose a card to heal.`);
        const healButtons = session.cards.map((c, idx) =>
          new ButtonBuilder()
            .setCustomId(`sail_heal_card:${sessionId}:${item}:${idx}`)
            .setLabel(c.card.name)
            .setStyle(ButtonStyle.Primary)
            .setDisabled(c.health <= 0)
        );
        const row = new ActionRowBuilder().addComponents(healButtons);
        await interaction.update({ embeds: [embed], components: [row] });
      }

      // Handle sail_haki_use actions
      if (action === 'sail_haki_use') {
        const sessionId = parts[1];
        const cardIndex = parseInt(parts[2]);
        const ability = parts[3];
        const session = global.SAIL_SESSIONS.get(sessionId);
        if (session && session.turnTimer) { try { clearTimeout(session.turnTimer); session.turnTimer = null; } catch (e) {} }
        if (!session || session.userId !== interaction.user.id) return interaction.reply({ content: 'Session not found or not your turn.', ephemeral: true });
        const card = session.cards[cardIndex];
        if (!card) return interaction.reply({ content: 'Invalid card', ephemeral: true });

        // perform abilities (similar to duel)
        if (ability === 'ryou') {
          if ((card.stamina || 0) < 2) return interaction.reply({ content: 'Not enough stamina for Ryou.', ephemeral: true });
          card.stamina = Math.max(0, card.stamina - 2);
          session.ryou = session.ryou || {};
          session.ryou[session.userId] = { cardIdx: cardIndex, remaining: 1 };
          await interaction.reply({ content: `${interaction.user} used Ryou! Next incoming attack will redirect to ${card.card.name} and deal no damage.`, ephemeral: false });
          return;
        }
        if (ability === 'futuresight') {
          if ((card.stamina || 0) < 1) return interaction.reply({ content: 'Not enough stamina for Future Sight.', ephemeral: true });
          card.stamina = Math.max(0, card.stamina - 1);
          card.nextAttackGuaranteedDodge = true;
          await interaction.reply({ content: `${interaction.user} used Future Sight on ${card.card.name}! It will dodge the next incoming attack.`, ephemeral: false });
          return;
        }
        if (ability === 'conqueror') {
          if ((card.stamina || 0) < 2) return interaction.reply({ content: 'Not enough stamina for Conqueror.', ephemeral: true });
          card.stamina = Math.max(0, card.stamina - 2);
          const stars = (card.haki && card.haki.conqueror && card.haki.conqueror.stars) || 0;
          const threshold = 100 + (stars * 10);
          const knocked = [];
          for (const e of session.enemies) {
            if (e.health > 0 && e.health <= threshold) { e.health = 0; knocked.push(e.name); }
          }
          await interaction.reply({ content: `Conqueror used! Knocked out: ${knocked.length ? knocked.join(', ') : 'None'}`, ephemeral: false });
          return;
        }
        if (ability === 'conq_aoe') {
          if ((card.stamina || 0) < 3) return interaction.reply({ content: 'Not enough stamina for Conqueror AoE.', ephemeral: true });
          card.stamina = Math.max(0, card.stamina - 3);
          const stars = (card.haki && card.haki.conqueror && card.haki.conqueror.stars) || 0;
          const dmgPct = stars * 0.10;
          const dmg = Math.max(1, Math.round(card.maxHealth * dmgPct));
          for (const e of session.enemies) {
            if (e.health > 0) {
              e.health = Math.max(0, e.health - dmg);
            }
          }
          await interaction.reply({ content: `${interaction.user} used Advanced Conqueror AoE for ${dmg} damage to all enemies!`, ephemeral: false });
          return;
        }
      }

      // Handle sail_heal_card buttons
      if (action === "sail_heal_card") {
        const sessionId = parts[1];
        const item = parts[2];
        const cardIndex = parseInt(parts[3]);
        const session = global.SAIL_SESSIONS.get(sessionId);
        if (session && session.turnTimer) { try { clearTimeout(session.turnTimer); session.turnTimer = null; } catch (e) {} }
        if (!session || session.userId !== interaction.user.id) return;
        const card = session.cards[cardIndex];
        if (!card || card.health <= 0) return;
        const isSupport = String(card.card.type).toLowerCase() === 'support';
        let healPercent;
        if (item === 'meat') healPercent = isSupport ? 0.05 : 0.1;
        else if (item === 'fish') healPercent = isSupport ? 0.1 : 0.05;
        else if (item === 'sake') healPercent = isSupport ? 0.2 : 0.05;
        else if (item === 'sea king meat') healPercent = isSupport ? 0.05 : 0.2;
        const healAmount = Math.floor(card.maxHealth * healPercent);
        const actualHeal = Math.min(healAmount, card.maxHealth - card.health);
        card.health += actualHeal;
        session.cards.forEach((c, idx) => {
          if (idx !== cardIndex && c.health > 0) {
            c.stamina = Math.max(0, (c.stamina ?? 3) - 1);
          }
        });
        const Inventory = (await import("../models/Inventory.js")).default;
        const inventory = await Inventory.findOne({ userId: session.userId });
        if (inventory) {
          inventory.items.set(item, (inventory.items.get(item) || 0) - 1);
          await inventory.save();
        }
        const healEmbed = new EmbedBuilder()
          .setTitle('Heal Result')
          .setDescription(`Healed ${card.card.name} for ${actualHeal} HP! Current HP: ${card.health}/${card.maxHealth}`);
        await interaction.update({ embeds: [healEmbed], components: [] });
        setTimeout(async () => {
          await enemyAttack(session, interaction.channel);
          await startSailTurn(sessionId, interaction.channel);
        }, 2000);
      }

      // Handle quest view/claim buttons
      if (action === "quest_view") {
        // customId format from command: quest_view:<type>:<userId>
        const questType = parts[1]; // daily or weekly
        const userId = parts[2];

        if (interaction.user.id !== userId) {
          await interaction.reply({ content: "Only the original requester can use these buttons.", ephemeral: true });
          return;
        }

        const Quest = (await import("../models/Quest.js")).default;
        let questDoc = await Quest.getCurrentQuests(questType);
        
        if (!questDoc.quests.length) {
          const { generateQuests } = await import("../lib/quests.js");
          questDoc.quests = generateQuests(questType);
          await questDoc.save();
        }

        const questEmbed = await (await import("../commands/quests.js")).buildQuestEmbed(questDoc, interaction.user);

        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId(`quest_view:daily:${userId}`)
              .setLabel("Daily")
              .setStyle(questType === "daily" ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(`quest_view:weekly:${userId}`)
              .setLabel("Weekly")
              .setStyle(questType === "weekly" ? ButtonStyle.Primary : ButtonStyle.Secondary)
          );

        const claimRow = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId(`quest_claim:${userId}`)
              .setLabel("Claim Completed")
              .setStyle(ButtonStyle.Success)
          );

        await interaction.update({
          embeds: [questEmbed],
          components: [row, claimRow]
        });
        return;
      }

      if (action === "quest_claim") {
        const userId = parts[1];
        
        if (interaction.user.id !== userId) {
          await interaction.reply({ content: "Only the original requester can use these buttons.", ephemeral: true });
          return;
        }

        const Quest = (await import("../models/Quest.js")).default;
        const Balance = (await import("../models/Balance.js")).default;
        const { calculateQuestRewards } = await import("../lib/quests.js");

        // Get both daily and weekly quests
        const [dailyQuests, weeklyQuests] = await Promise.all([
          Quest.getCurrentQuests("daily"),
          Quest.getCurrentQuests("weekly")
        ]);

        let claimed = 0;
        let totalMoney = 0;
        let totalChests = [];
        let totalResetTokens = 0;

        // Process both quest sets
        for (const questDoc of [dailyQuests, weeklyQuests]) {
          const userProgress = questDoc.getUserProgress(userId);
          
          for (const quest of questDoc.quests) {
            const progress = userProgress.get(quest.id);
            if (!progress || progress.claimed || progress.current < quest.target) continue;

            // Calculate rewards
            const rewards = calculateQuestRewards(quest);
            totalMoney += rewards.money;
            totalChests.push(...rewards.chests);
            totalResetTokens += rewards.resetTokens;

            // Mark as claimed
            progress.claimed = true;
            userProgress.set(quest.id, progress);
            claimed++;
          }

          if (claimed > 0) {
            questDoc.progress.set(userId, userProgress);
            await questDoc.save();
          }
        }

        if (claimed === 0) {
          await interaction.reply({ 
            content: "You have no completed quests to claim.", 
            ephemeral: true 
          });
          return;
        }

        // Update user's balance, XP and inventory
        let bal = await Balance.findOne({ userId });
        if (!bal) bal = new Balance({ userId, amount: 500, xp: 0, level: 0 });

        bal.amount += totalMoney;
        bal.resetTokens = (bal.resetTokens || 0) + totalResetTokens;
        // Award XP for claiming quests (small amount per claimed quest)
        const XP_PER_QUEST = 5;
        bal.xp = (bal.xp || 0) + (claimed * XP_PER_QUEST);
        while ((bal.xp || 0) >= 100) {
          bal.xp -= 100;
          bal.level = (bal.level || 0) + 1;
        }
        await bal.save();

        // Add quest chests to user's inventory
        if (totalChests.length > 0) {
          const Inventory = (await import("../models/Inventory.js")).default;
          let inv = await Inventory.findOne({ userId });
          if (!inv) inv = new Inventory({ userId, items: {}, chests: { C:0, B:0, A:0, S:0 }, xpBottles: 0 });
          inv.chests = inv.chests || { C:0, B:0, A:0, S:0 };
          for (const c of totalChests) {
            const rank = String(c.rank || "C").toUpperCase();
            const count = parseInt(c.count || 0, 10) || 0;
            inv.chests[rank] = (inv.chests[rank] || 0) + count;
          }
          await inv.save();
        }

        const rewardEmbed = new EmbedBuilder()
          .setTitle("Quests Claimed!")
          .setColor(0xFFFFFF)
          .setDescription(
            `You claimed ${claimed} quest${claimed !== 1 ? 's' : ''}!\n\n` +
            `Rewards:\n` +
            `• ${totalMoney}¥\n` +
            (totalResetTokens > 0 ? `• ${totalResetTokens} Reset Token${totalResetTokens !== 1 ? 's' : ''}\n` : '') +
            (totalChests.length > 0 ? `• ${totalChests.map(c => `${c.count}× ${c.rank} Chest${c.count !== 1 ? 's' : ''}`).join(', ')}\n` : '')
          );

        await interaction.reply({ 
          embeds: [rewardEmbed], 
          ephemeral: true 
        });

        // Refresh the quest display
        const questDoc = interaction.message.embeds[0].title.toLowerCase().includes("daily") ? dailyQuests : weeklyQuests;
        const questEmbed = await (await import("../commands/quests.js")).buildQuestEmbed(questDoc, interaction.user);
        
        const components = interaction.message.components;
        await interaction.message.edit({
          embeds: [questEmbed],
          components
        });
        return;
      }

      // INFO paging: support info_prev/info_next customIds with index
      if (action === "info_prev" || action === "info_next") {
          const rootCardId = parts[2];
          const targetIndex = parseInt(parts[3] || "0", 10) || 0;
          const rootCard = getCardById(rootCardId);
          if (!rootCard) {
            await interaction.reply({ content: "Root card not found.", ephemeral: true });
            return;
          }

          const chain = getEvolutionChain(rootCard);
          const len = chain.length;
          if (len === 0) {
            await interaction.reply({ content: "No evolutions available for this card.", ephemeral: true });
            return;
          }

          const idx = ((targetIndex % len) + len) % len;
          const newCardId = chain[idx];
          const newCard = getCardById(newCardId);
          if (!newCard) {
            await interaction.reply({ content: "Evolution card not found.", ephemeral: true });
            return;
          }

          // fetch progress to check ownership
          const progDoc = await Progress.findOne({ userId: ownerId });
          const cardsMap = progDoc ? (progDoc.cards instanceof Map ? progDoc.cards : new Map(Object.entries(progDoc.cards || {}))) : new Map();
          const ownedEntry = cardsMap.get(newCard.id) || null;

          // build embed using shared builder so layout matches info command
          // Always show the base (unmodified) card embed for navigation —
          // keep user-specific stats separate and reachable via the "👤" button.
          const newEmbed = buildCardEmbed(newCard, ownedEntry, interaction.user);
          if (!ownedEntry || (ownedEntry.count || 0) <= 0) {
            newEmbed.setColor(0x2f3136);

            // Check if this card is a lower version of an upgrade owned by user
            // Only block when the user does NOT own the requested card
            const chainForPag = getEvolutionChain(newCard);
            let ownedHigherIdForPag = null;
            for (let i = chainForPag.indexOf(newCard.id) + 1; i < chainForPag.length; i++) {
              const higherCardId = chainForPag[i];
              const higherEntry = cardsMap.get(higherCardId);
              if (higherEntry && (higherEntry.count || 0) > 0) {
                ownedHigherIdForPag = higherCardId;
                break;
              }
            }
            if ((!ownedEntry || (ownedEntry.count || 0) <= 0) && ownedHigherIdForPag) {
              const ownedHigher = getCardById(ownedHigherIdForPag);
              await interaction.reply({ content: `You own a higher version (${(ownedHigher && ownedHigher.name) || 'upgraded version'}) and cannot view this version.`, ephemeral: true });
              return;
            }
          }

          // compute prev/next indices for this chain and attach buttons
          const prevIndex = (idx - 1 + len) % len;
          const nextIndex = (idx + 1) % len;
          const prevIdNew = `info_prev:${ownerId}:${rootCard.id}:${prevIndex}`;
          const nextIdNew = `info_next:${ownerId}:${rootCard.id}:${nextIndex}`;

          const btns = [
            new ButtonBuilder().setCustomId(prevIdNew).setLabel("Previous mastery").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(nextIdNew).setLabel("Next mastery").setStyle(ButtonStyle.Primary)
          ];

          // if the user owns this card, add the "Your stats" primary button
          if (ownedEntry && (ownedEntry.count || 0) > 0) {
            btns.push(
              new ButtonBuilder()
                .setCustomId(`info_userstats:${ownerId}:${newCard.id}`)
                .setLabel("👤")
                .setStyle(ButtonStyle.Secondary)
            );
          }

          const row = new ActionRowBuilder().addComponents(...btns);

          await interaction.update({ embeds: [newEmbed], components: [row] });
          return;
        }

      // SHOP pagination: shop_prev:<ownerId>:<idx> and shop_next:<ownerId>:<idx>
      if (action === "shop_prev" || action === "shop_next") {
        try {
          const { pages, buildEmbed, buildRow } = await import("../lib/shopPages.js");
          const rawIdx = parseInt(parts[2] || "0", 10) || 0;
          let newIndex = rawIdx;
          if (action === "shop_prev") newIndex = Math.max(0, rawIdx - 1);
          if (action === "shop_next") newIndex = Math.min(pages.length - 1, rawIdx + 1);

          const embed = buildEmbed(pages[newIndex]);
          const row = buildRow(ownerId, newIndex);

          await interaction.update({ embeds: [embed], components: [row] });
        } catch (e) {
          console.error('shop pagination handler error:', e && e.message ? e.message : e);
          try { await interaction.reply({ content: 'Error handling shop pagination.', ephemeral: true }); } catch (er) {}
        }
        return;
      }

      // INFO user stats: info_userstats:<userId>:<cardId>
      if (action === "info_userstats") {
        const cardId = parts[2];
        const userId = parts[1];

        if (interaction.user.id !== userId) {
          await interaction.reply({ content: "Only the original requester can use these buttons.", ephemeral: true });
          return;
        }

        const card = getCardById(cardId);
        if (!card) {
          await interaction.reply({ content: "Card not found.", ephemeral: true });
          return;
        }

        // fetch progress to check ownership
        const progDoc = await Progress.findOne({ userId });
        
        const cardsMap = progDoc ? (progDoc.cards instanceof Map ? progDoc.cards : new Map(Object.entries(progDoc.cards || {}))) : new Map();
        let ownedEntry = null;
        
        // Try to find the card in user's collection
        if (cardsMap instanceof Map) {
          ownedEntry = cardsMap.get(card.id) || cardsMap.get(String(card.id).toLowerCase()) || null;
          if (!ownedEntry) {
            for (const [k, v] of cardsMap.entries()) {
              if (String(k).toLowerCase() === String(card.id).toLowerCase()) {
                ownedEntry = v; 
                break;
              }
            }
          }
        }
        

        // Check if user owns the card
        if (!ownedEntry || (ownedEntry.count || 0) <= 0) {
          await interaction.reply({ content: "You don't own this card.", ephemeral: true });
          return;
        }

        // Get equipped weapon if any
        let equippedWeapon = null;
        const WeaponInventory = (await import("../models/WeaponInventory.js")).default;
        const winv = await WeaponInventory.findOne({ userId });
        if (winv && winv.weapons) {
          if (winv.weapons instanceof Map) {
            for (const [wid, w] of winv.weapons.entries()) {
              if (w.equippedTo === card.id) {
                const wcard = getCardById(wid);
                if (wcard) {
                  equippedWeapon = { id: wid, card: wcard, ...w };
                }
                break;
              }
            }
          } else {
            for (const [wid, w] of Object.entries(winv.weapons || {})) {
              if (w && w.equippedTo === card.id) {
                const wcard = getCardById(wid);
                if (wcard) {
                  equippedWeapon = { id: wid, card: wcard, ...w };
                }
                break;
              }
            }
          }
        }

        // Build user card embed
        const userEmbed = buildUserCardEmbed(card, ownedEntry, interaction.user, equippedWeapon);
        if (!userEmbed) {
          await interaction.reply({ content: "Unable to build user card stats.", ephemeral: true });
          return;
        }

        // Build buttons: back to base stats and previous/next
        const buttons = [];
        buttons.push(
          new ButtonBuilder()
            .setCustomId(`info_base:${userId}:${card.id}`)
            .setLabel("Base Stats")
            .setStyle(ButtonStyle.Secondary)
        );

        await interaction.update({ embeds: [userEmbed], components: [new ActionRowBuilder().addComponents(...buttons)] });
        return;
      }

      // INFO user weapon stats: info_userweapon:<userId>:<weaponId>
      if (action === "info_userweapon") {
        const weaponId = parts[2];
        const userId = parts[1];

        if (interaction.user.id !== userId) {
          await interaction.reply({ content: "Only the original requester can use these buttons.", ephemeral: true });
          return;
        }

        const WeaponInventory = (await import("../models/WeaponInventory.js")).default;
        const winv = await WeaponInventory.findOne({ userId });
        if (!winv) {
          await interaction.reply({ content: "You don't have any weapons.", ephemeral: true });
          return;
        }

        const userWeapon = winv.weapons instanceof Map ? winv.weapons.get(weaponId) : (winv.weapons && winv.weapons[weaponId]);
        if (!userWeapon) {
          await interaction.reply({ content: "You haven't crafted this weapon.", ephemeral: true });
          return;
        }

        const { buildUserWeaponEmbed } = await import("../lib/weaponEmbed.js");
        const weapon = getCardById(weaponId);
        if (!weapon) {
          await interaction.reply({ content: "Weapon not found.", ephemeral: true });
          return;
        }

        // Check if this is a signature weapon equipped to a card and whether the 25% applies
        // The 25% signature boost only applies when the equipped card appears at index > 0
        // in the weapon's `signatureCards` list (i.e. upgrade 2+), not the base form.
        let isSignatureBoosted = false;
        const weaponCard = getCardById(weaponId);
        if (userWeapon.equippedTo && weaponCard && Array.isArray(weaponCard.signatureCards)) {
          const equippedCard = getCardById(userWeapon.equippedTo);
          if (equippedCard) {
            const idx = weaponCard.signatureCards.indexOf(equippedCard.id);
            if (idx > 0) isSignatureBoosted = true;
          }
        }

        const embed = buildUserWeaponEmbed(weapon, userWeapon, interaction.user, isSignatureBoosted);
        if (!embed) {
          await interaction.reply({ content: "Unable to build weapon info.", ephemeral: true });
          return;
        }

        // Back button to base stats for weapon
        const back = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`info_weaponbase:${userId}:${weaponId}`).setLabel("Base Stats").setStyle(ButtonStyle.Secondary)
        );

        await interaction.update({ embeds: [embed], components: [back] });
        return;
      }

      // INFO base stats: info_base:<userId>:<cardId>
      if (action === "info_weaponbase") {
        const weaponId = parts[2];
        const userId = parts[1];

        if (interaction.user.id !== userId) {
          await interaction.reply({ content: "Only the original requester can use these buttons.", ephemeral: true });
          return;
        }

        const { buildWeaponEmbed, buildUserWeaponEmbed } = await import("../lib/weaponEmbed.js");
        const WeaponInventory = (await import("../models/WeaponInventory.js")).default;

        const weapon = getCardById(weaponId);
        if (!weapon) {
          await interaction.reply({ content: "Weapon not found.", ephemeral: true });
          return;
        }

        const embed = buildWeaponEmbed(weapon, interaction.user);

        // Check if user crafted it
        const winv = await WeaponInventory.findOne({ userId });
        const userWeapon = winv ? (winv.weapons instanceof Map ? winv.weapons.get(weaponId) : (winv.weapons && winv.weapons[weaponId])) : null;

        const buttons = [];
        if (userWeapon) {
          buttons.push(new ButtonBuilder().setCustomId(`info_userweapon:${userId}:${weaponId}`).setLabel("👤").setStyle(ButtonStyle.Secondary));
        }
        buttons.push(new ButtonBuilder().setCustomId(`info_weaponbase:${userId}:${weaponId}`).setLabel("Base Stats").setStyle(ButtonStyle.Secondary));

        const components = buttons.length ? [new ActionRowBuilder().addComponents(...buttons)] : [];
        await interaction.update({ embeds: [embed], components });
        return;
      }

      if (action === "info_base") {
        const cardId = parts[2];
        const userId = parts[1];

        if (interaction.user.id !== userId) {
          await interaction.reply({ content: "Only the original requester can use these buttons.", ephemeral: true });
          return;
        }

        const card = getCardById(cardId);
        if (!card) {
          await interaction.reply({ content: "Card not found.", ephemeral: true });
          return;
        }

        // fetch progress to check ownership
        const progDoc = await Progress.findOne({ userId });
        const cardsMap = progDoc ? (progDoc.cards instanceof Map ? progDoc.cards : new Map(Object.entries(progDoc.cards || {}))) : new Map();
        let ownedEntry = null;
        
        if (cardsMap instanceof Map) {
          ownedEntry = cardsMap.get(card.id) || cardsMap.get(String(card.id).toLowerCase()) || null;
          if (!ownedEntry) {
            for (const [k, v] of cardsMap.entries()) {
              if (String(k).toLowerCase() === String(card.id).toLowerCase()) {
                ownedEntry = v; 
                break;
              }
            }
          }
        }

        // Build base (unmodified) card embed — user-specific stats are shown
        // only when the user presses the "👤" (Your stats) button.
        const baseEmbed = buildCardEmbed(card, ownedEntry, interaction.user);
        if (!ownedEntry || (ownedEntry.count || 0) <= 0) {
          baseEmbed.setColor(0x2f3136);
        }

        // Rebuild evolution chain and get current position
        const chain = getEvolutionChain(card);
        const len = chain.length;
        
        // Build buttons: Previous/Next if multiple evolutions exist, plus User Stats if owned
        const buttons = [];
        if (len > 1) {
          const idx = 0;  // Always back to the first (base) card
          const prevIndex = (idx - 1 + len) % len;
          const nextIndex = (idx + 1) % len;
          const prevIdBase = `info_prev:${userId}:${card.id}:${prevIndex}`;
          const nextIdBase = `info_next:${userId}:${card.id}:${nextIndex}`;
          buttons.push(
            new ButtonBuilder()
              .setCustomId(prevIdBase)
              .setLabel("Previous mastery")
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId(nextIdBase)
              .setLabel("Next mastery")
              .setStyle(ButtonStyle.Primary)
          );
        }
        
        // Add Your Stats button if owned
        if (ownedEntry && (ownedEntry.count || 0) > 0) {
          buttons.push(
            new ButtonBuilder()
              .setCustomId(`info_userstats:${userId}:${card.id}`)
              .setLabel("👤")
              .setStyle(ButtonStyle.Secondary)
          );
        }

        const components = buttons.length > 0 ? [new ActionRowBuilder().addComponents(...buttons)] : [];
        await interaction.update({ embeds: [baseEmbed], components });
        return;
      }


      // COLLECTION pagination AND select menu handling
      if (action.startsWith("collection_")) {
        const sortKey = parts[2];
        const pageNum = parseInt(parts[3] || "0", 10) || 0;

        const progDoc = await Progress.findOne({ userId: ownerId });
        if (!progDoc || !progDoc.cards) {
          await interaction.reply({ content: "You have no cards.", ephemeral: true });
          return;
        }

        const cardsMap = progDoc.cards instanceof Map ? progDoc.cards : new Map(Object.entries(progDoc.cards || {}));
        const items = [];
        for (const [cardId, entry] of cardsMap.entries()) {
          const card = getCardById(cardId);
          if (!card) continue;
          items.push({ card, entry });
        }

        function computeScoreLocal(card, entry) {
          const level = entry.level || 0;
          const multiplier = 1 + level * 0.01;
          const power = (card.power || 0) * multiplier;
          const health = (card.health || 0) * multiplier;
          return power + health * 0.2;
        }

        // Normalize sort key aliases (some places use 'level_desc'/'level_asc')
      let mode = sortKey;
      if (mode === 'level_desc' || mode === 'lbtw') mode = 'lbtw';
      if (mode === 'level_asc' || mode === 'lwtb') mode = 'lwtb';

      if (mode === "best") items.sort((a, b) => computeScoreLocal(b.card, b.entry) - computeScoreLocal(a.card, a.entry));
      else if (mode === "wtb") items.sort((a, b) => computeScoreLocal(a.card, a.entry) - computeScoreLocal(b.card, b.entry));
      else if (mode === "lbtw") items.sort((a, b) => (b.entry.level || 0) - (a.entry.level || 0));
      else if (mode === "lwtb") items.sort((a, b) => (a.entry.level || 0) - (b.entry.level || 0));
      else if (mode === "rank") items.sort((a, b) => (((getRankInfo(b.card.rank) && getRankInfo(b.card.rank).value) || 0) - ((getRankInfo(a.card.rank) && getRankInfo(a.card.rank).value) || 0)));
      else if (mode === "nto") items.sort((a, b) => (b.entry.acquiredAt || 0) - (a.entry.acquiredAt || 0));
      else if (mode === "otn") items.sort((a, b) => (a.entry.acquiredAt || 0) - (b.entry.acquiredAt || 0));

        const PAGE_SIZE = 5;
        const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
        let newPage = pageNum;
        // If user clicked the info button for this page, show a select menu of the page's characters
        if (action === 'collection_info') {
          const pageItems = items.slice(pageNum * PAGE_SIZE, (pageNum + 1) * PAGE_SIZE);
          const options = pageItems.map((it, idx) => {
            const card = it.card;
            const _ri = getRankInfo(card.rank);
            return { label: card.name, value: card.id, description: (_ri && _ri.name) || (card.rank || '') };
          });
          const select = new StringSelectMenuBuilder().setCustomId(`collection_select:${ownerId}:${sortKey}:${pageNum}`).setPlaceholder('Select a character').addOptions(options);
          const rows = [new ActionRowBuilder().addComponents(select)];
          await interaction.update({ embeds: [], components: rows });
          return;
        }
        if (action === "collection_prev") newPage = Math.max(0, pageNum - 1);
        if (action === "collection_next") newPage = Math.min(totalPages - 1, pageNum + 1);
        if (action === "collection_back") newPage = pageNum; // simply re-render the same page (back target)

        // Compact page rendering: name + rank only (preserve new collection UI)
        const pageItems = items.slice(newPage * PAGE_SIZE, (newPage + 1) * PAGE_SIZE);
        const lines = pageItems.map((it, idx) => {
          const card = it.card;
          const _r = getRankInfo(card.rank);
          const rank = (_r && _r.name) || (card.rank || "-");
          return `**${newPage * PAGE_SIZE + idx + 1}. ${card.name}** [${rank}]`;
        });

        const embed = new EmbedBuilder().setTitle("Collection").setDescription(lines.join("\n")).setFooter({ text: `Page ${newPage + 1}/${totalPages}` });
        const prevIdNew = `collection_prev:${ownerId}:${sortKey}:${newPage}`;
        const nextIdNew = `collection_next:${ownerId}:${sortKey}:${newPage}`;
        const infoIdNew = `collection_info:${ownerId}:${sortKey}:${newPage}`;
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(prevIdNew).setLabel("Previous").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(nextIdNew).setLabel("Next").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(infoIdNew).setLabel('ⓘ').setStyle(ButtonStyle.Primary)
        );

        // Recreate sort dropdown so it persists across pagination
        const sortMenu = new StringSelectMenuBuilder()
          .setCustomId(`collection_sort:${ownerId}`)
          .setPlaceholder('Sort collection')
          .addOptions([
            { label: 'Best to Worst', value: 'best' },
            { label: 'Worst to Best', value: 'wtb' },
            { label: 'Level High → Low', value: 'lbtw' },
            { label: 'Level Low → High', value: 'lwtb' },
            { label: 'Rank High → Low', value: 'rank' },
            { label: 'Newest → Oldest', value: 'nto' },
            { label: 'Oldest → Newest', value: 'otn' }
          ]);
        const sortRow = new ActionRowBuilder().addComponents(sortMenu);

        await interaction.update({ embeds: [embed], components: [sortRow, row] });
        return;
      }

      // Handle craft_craft buttons
      if (action === "craft_craft") {
        const weaponId = parts[1];
        const userId = ownerId;

        if (interaction.user.id !== userId) {
          await interaction.reply({ content: "Only the original requester can use these buttons.", ephemeral: true });
          return;
        }

        const weapon = getWeaponById(weaponId);
        if (!weapon) {
          await interaction.reply({ content: "Weapon not found.", ephemeral: true });
          return;
        }

        const Progress = (await import("../models/Progress.js")).default;
        const progress = await Progress.findOne({ userId });
        if (!progress || !progress.cards || !progress.cards.get(weaponId)) {
          await interaction.reply({ content: "You don't have the blueprint for this weapon.", ephemeral: true });
          return;
        }

        const blueprintEntry = progress.cards.get(weaponId);
        if ((blueprintEntry.count || 0) <= 0) {
          await interaction.reply({ content: "You don't have the blueprint for this weapon.", ephemeral: true });
          return;
        }

        // Check materials
        const Inventory = (await import("../models/Inventory.js")).default;
        const inventory = await Inventory.findOne({ userId }) || new Inventory({ userId, items: new Map(), chests: { C:0, B:0, A:0, S:0 }, xpBottles: 0 });
        const requiredMaterials = weapon.materials || {};
        const missing = [];
        for (const [mat, qty] of Object.entries(requiredMaterials)) {
          const has = inventory.items.get(mat) || 0;
          if (has < qty) missing.push(`${mat} (${has}/${qty})`);
        }
        if (missing.length > 0) {
          await interaction.reply({ content: `Missing materials: ${missing.join(', ')}.`, ephemeral: true });
          return;
        }

        // Deduct materials
        for (const [mat, qty] of Object.entries(requiredMaterials)) {
          inventory.items.set(mat, (inventory.items.get(mat) || 0) - qty);
        }
        await inventory.save();

        // Remove blueprint
        blueprintEntry.count -= 1;
        if (blueprintEntry.count <= 0) {
          progress.cards.delete(weaponId);
        }
        await progress.save();

        // Add weapon to inventory
        const WeaponInventory = (await import("../models/WeaponInventory.js")).default;
        let winv = await WeaponInventory.findOne({ userId }) || new WeaponInventory({ userId, weapons: new Map() });
        if (!winv.weapons) winv.weapons = new Map();
        const existing = winv.weapons.get(weaponId) || { count: 0, equippedTo: null, teamBanner: null };
        existing.count += 1;
        winv.weapons.set(weaponId, existing);
        await winv.save();

        await interaction.reply({ content: `Successfully crafted ${weapon.name}!`, ephemeral: true });
      }
    }
  } catch (err) {
    console.error("Error handling button interaction:", err);
    try {
      if (!interaction.replied) await interaction.reply({ content: "Error handling interaction.", ephemeral: true });
    } catch (e) {}
    return;
  }

  // fallback to chat input commands (slash)
  if (interaction.isChatInputCommand && interaction.isChatInputCommand()) {
    const cmdName = (interaction.commandName || '').toLowerCase();
    const command = client.commands.get(cmdName);
    if (!command) {
      console.log('Command not found:', interaction.commandName);
      try { if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Command not found on this bot instance.', ephemeral: true }); } catch (e) {}
      return;
    }

    try {
      await command.execute(interaction, client);
    } catch (error) {
      console.error('Error executing command:', error && error.message ? error.message : error);
      try { if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'There was an error executing this command.', ephemeral: true }); } catch (e) {}
    }
  }
}

// Episode 2 helper functions

async function startEpisode2SecretStage(userId, interaction) {
  // Secret stage: Fight with Zoro
  const Progress = (await import("../models/Progress.js")).default;
  const progress = await Progress.findOne({ userId });
  if (!progress || !progress.team || progress.team.length === 0) {
    await interaction.reply({ content: "You need a team to sail. Use /team to set your team.", ephemeral: true });
    return;
  }

  // Zoro enemy
  const enemies = [
    { name: 'Roronoa Zoro', health: 210, maxHealth: 210, attackRange: [25, 50], power: 35, specialAttack: { name: "Oni Giri", range: [85, 135] }, usedSpecial: false }
  ];

  const sessionId = `sail_ep2_secret_${userId}_${Date.now()}`;
  global.SAIL_SESSIONS = global.SAIL_SESSIONS || new Map();

  // Get user's cards with boosts
  const WeaponInventory = (await import('../models/WeaponInventory.js')).default;
  const winv = await WeaponInventory.findOne({ userId });
  const hasBanner = winv && winv.teamBanner === 'alvida_pirates_banner_c_01';
  const { computeTeamBoosts } = await import("../lib/boosts.js");
  const { getCardById } = await import("../cards.js");

  const p1TeamBoosts = computeTeamBoosts(progress.team || [], progress.cards || null, winv);
  const p1Cards = progress.team.map(cardId => {
    const card = getCardById(cardId);
    const hasMap = progress.cards && typeof progress.cards.get === 'function';
    const progressCard = hasMap ? (progress.cards.get(cardId) || { level: 0, xp: 0 }) : (progress.cards[cardId] || { level: 0, xp: 0 });
    const level = progressCard.level || 0;
    const mult = 1 + (level * 0.01);
    let health = Math.round((card.health || 0) * mult);
    let attackMin = Math.round(((card.attackRange && card.attackRange[0]) || 0) * mult);
    let attackMax = Math.round(((card.attackRange && card.attackRange[1]) || 0) * mult);
    const special = card.specialAttack ? { ...card.specialAttack, range: [(card.specialAttack.range[0] || 0) * mult, (card.specialAttack.range[1] || 0) * mult] } : null;
    let power = Math.round((card.power || 0) * mult);

    // Apply team boosts
    if (p1TeamBoosts.atk) {
      const atkMul = 1 + (p1TeamBoosts.atk / 100);
      attackMin = Math.round(attackMin * atkMul);
      attackMax = Math.round(attackMax * atkMul);
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
    if (hasBanner && bannerSignature.includes(cardId)) {
      attackMin = Math.round(attackMin * 1.05);
      attackMax = Math.round(attackMax * 1.05);
      power = Math.round(power * 1.05);
      health = Math.round(health * 1.05);
    }

    const finalPower = roundNearestFive(Math.round(power));
    const baseAttackMin = Math.round(attackMin);
    const baseAttackMax = Math.round(attackMax);
    const finalAttackMin = (hasBanner && bannerSignature.includes(cardId)) ? baseAttackMin : roundNearestFive(baseAttackMin);
    const finalAttackMax = (hasBanner && bannerSignature.includes(cardId)) ? baseAttackMax : roundNearestFive(baseAttackMax);
    const finalHealth = roundNearestFive(Math.round(health));
    if (special && special.range) special.range = roundRangeToFive([Math.round(special.range[0] || 0), Math.round(special.range[1] || 0)]);

    return { cardId, card, scaled: { attackRange: [finalAttackMin, finalAttackMax], specialAttack: special, power: finalPower }, health: finalHealth, maxHealth: finalHealth, level, stamina: 3, usedSpecial: false, attackedLastTurn: false };
  });

  global.SAIL_SESSIONS.set(sessionId, {
    userId,
    user: interaction.user,
    cards: p1Cards,
    lifeIndex: 0,
    enemies,
    phase: 1,
    sessionId,
    channelId: interaction.channel.id,
    msgId: null,
    difficulty: 'hard', // Secret stage is always hard
    episode: 2,
    secretStage: true
  });

  await startSailTurn(sessionId, interaction.channel);
}

const startEpisode2Stage2 = async (userId, interaction, hasZoro) => {
  const Progress = (await import("../models/Progress.js")).default;
  const progress = await Progress.findOne({ userId });
  if (!progress || !progress.team || progress.team.length === 0) {
    try {
      await interaction.followUp({ content: "You need a team to sail. Use /team to set your team.", ephemeral: true });
    } catch (e) {
      await interaction.channel.send({ content: "You need a team to sail. Use /team to set your team." });
    }
    return;
  }

  // Initial enemy for Episode 2 Stage 2: start with Helmeppo (phase-based spawn will add Marines then Zoro)
  const enemies = [ { name: 'Helmeppo', health: 80, maxHealth: 80, attackRange: [12,18], power: 12 } ];

  // Get difficulty and apply enemy stat boost
  const SailProgress = (await import("../models/SailProgress.js")).default;
  const sailProgress = await SailProgress.findOne({ userId });
  const difficulty = (sailProgress && sailProgress.difficulty) || 'easy';
  const multiplier = difficulty === 'hard' ? 1.5 : difficulty === 'medium' ? 1.25 : 1;
  enemies.forEach(enemy => {
    enemy.health = roundNearestFive(enemy.health * multiplier);
    enemy.maxHealth = enemy.health;
    enemy.attackRange = [Math.ceil(enemy.attackRange[0] * multiplier), Math.ceil(enemy.attackRange[1] * multiplier)];
    enemy.power = Math.ceil(enemy.power * multiplier);
  });

  const sessionId = `sail_ep2_${userId}_${Date.now()}`;
  global.SAIL_SESSIONS = global.SAIL_SESSIONS || new Map();

  // mark last embed sent to avoid immediate duplicate prompts
  const now = Date.now();

  // Get user's cards
  const WeaponInventory = (await import('../models/WeaponInventory.js')).default;
  const winv = await WeaponInventory.findOne({ userId });
  const hasBanner = winv && winv.teamBanner === 'alvida_pirates_banner_c_01';
  const { computeTeamBoosts } = await import("../lib/boosts.js");
  const { getCardById } = await import("../cards.js");

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

  const p1TeamBoosts = computeTeamBoosts(progress.team || [], progress.cards || null, null);
  const p1Cards = progress.team.map(cardId => {
    const card = getCardById(cardId);
    const hasMap = progress.cards && typeof progress.cards.get === 'function';
    const progressCard = hasMap ? (progress.cards.get(cardId) || { level: 0, xp: 0 }) : (progress.cards[cardId] || { level: 0, xp: 0 });
    const level = progressCard.level || 0;
    const mult = 1 + (level * 0.01);
    let health = Math.round((card.health || 0) * mult);
    let attackMin = Math.round(((card.attackRange && card.attackRange[0]) || 0) * mult);
    let attackMax = Math.round(((card.attackRange && card.attackRange[1]) || 0) * mult);
    const special = card.specialAttack ? { ...card.specialAttack, range: [(card.specialAttack.range[0] || 0) * mult, (card.specialAttack.range[1] || 0) * mult] } : null;
    let power = Math.round((card.power || 0) * mult);

    const equipped = getEquippedWeaponForCard(winv, cardId);
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
    if (hasBanner && bannerSignature.includes(cardId)) {
      attackMin = Math.round(attackMin * 1.05);
      attackMax = Math.round(attackMax * 1.05);
      power = Math.round(power * 1.05);
      health = Math.round(health * 1.05);
    }

    const finalPower = roundNearestFive(Math.round(power));
    const baseAttackMin = Math.round(attackMin);
    const baseAttackMax = Math.round(attackMax);
    const finalAttackMin = (hasBanner && bannerSignature.includes(cardId)) ? baseAttackMin : roundNearestFive(baseAttackMin);
    const finalAttackMax = (hasBanner && bannerSignature.includes(cardId)) ? baseAttackMax : roundNearestFive(baseAttackMax);
    const finalHealth = roundNearestFive(Math.round(health));
    if (special && special.range) special.range = roundRangeToFive([Math.round(special.range[0] || 0), Math.round(special.range[1] || 0)]);

    return { cardId, card, scaled: { attackRange: [finalAttackMin, finalAttackMax], specialAttack: special, power: finalPower }, health: finalHealth, maxHealth: finalHealth, level, stamina: 3, usedSpecial: false, attackedLastTurn: false };
  });

  global.SAIL_SESSIONS.set(sessionId, {
    userId,
    user: interaction.user,
    cards: p1Cards,
    lifeIndex: 0,
    enemies,
    phase: 2,
    sessionId,
    channelId: interaction.channel.id,
    msgId: null,
    difficulty,
    episode: 2,
    hasZoro
  });

  // initialize debounce marker so startSailTurn won't immediately send another embed
  await startSailTurn(sessionId, interaction.channel);
};

// Start Episode 3: Morgan vs Luffy
const startEpisode3Stage2 = async (userId, interaction) => {
  const Progress = (await import("../models/Progress.js")).default;
  const progress = await Progress.findOne({ userId });
  if (!progress || !progress.team || progress.team.length === 0) {
    try {
      await interaction.followUp({ content: "You need a team to sail. Use /team to set your team.", ephemeral: true });
    } catch (e) {
      await interaction.channel.send({ content: "You need a team to sail. Use /team to set your team." });
    }
    return;
  }

  // Initial enemies: three Marines (Stage 2), then Axe-hand Morgan
  const enemies = [
    { name: 'Marine', health: 65, maxHealth: 65, attackRange: [6,12], power: 8 },
    { name: 'Marine', health: 65, maxHealth: 65, attackRange: [6,12], power: 8 },
    { name: 'Marine', health: 65, maxHealth: 65, attackRange: [6,12], power: 8 }
  ];

  const SailProgress = (await import("../models/SailProgress.js")).default;
  const sailProgress = await SailProgress.findOne({ userId });
  const difficulty = (sailProgress && sailProgress.difficulty) || 'easy';
  const multiplier = difficulty === 'hard' ? 1.5 : difficulty === 'medium' ? 1.25 : 1;
  enemies.forEach(enemy => {
    enemy.health = roundNearestFive(enemy.health * multiplier);
    enemy.maxHealth = enemy.health;
    enemy.attackRange = [Math.ceil(enemy.attackRange[0] * multiplier), Math.ceil(enemy.attackRange[1] * multiplier)];
    enemy.power = Math.ceil(enemy.power * multiplier);
  });

  const sessionId = `sail_ep3_${userId}_${Date.now()}`;
  global.SAIL_SESSIONS = global.SAIL_SESSIONS || new Map();

  const WeaponInventory = (await import('../models/WeaponInventory.js')).default;
  const winv = await WeaponInventory.findOne({ userId });
  const hasBanner = winv && winv.teamBanner === 'alvida_pirates_banner_c_01';
  const { computeTeamBoosts } = await import("../lib/boosts.js");
  const { getCardById } = await import("../cards.js");

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

  const p1TeamBoosts = computeTeamBoosts(progress.team || [], progress.cards || null, null);
  const p1Cards = progress.team.map(cardId => {
    const card = getCardById(cardId);
    const hasMap = progress.cards && typeof progress.cards.get === 'function';
    const progressCard = hasMap ? (progress.cards.get(cardId) || { level: 0, xp: 0 }) : (progress.cards[cardId] || { level: 0, xp: 0 });
    const level = progressCard.level || 0;
    const mult = 1 + (level * 0.01);
    let health = Math.round((card.health || 0) * mult);
    let attackMin = Math.round(((card.attackRange && card.attackRange[0]) || 0) * mult);
    let attackMax = Math.round(((card.attackRange && card.attackRange[1]) || 0) * mult);
    const special = card.specialAttack ? { ...card.specialAttack, range: [(card.specialAttack.range[0] || 0) * mult, (card.specialAttack.range[1] || 0) * mult] } : null;
    let power = Math.round((card.power || 0) * mult);

    const equipped = getEquippedWeaponForCard(winv, cardId);
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

    const bannerSignature = ['Alvida_c_01', 'heppoko_c_01', 'Peppoko_c_01', 'Poppoko_c_01', 'koby_c_01'];
    if (hasBanner && bannerSignature.includes(cardId)) {
      attackMin = Math.round(attackMin * 1.05);
      attackMax = Math.round(attackMax * 1.05);
      power = Math.round(power * 1.05);
      health = Math.round(health * 1.05);
    }

    const finalPower = roundNearestFive(Math.round(power));
    const baseAttackMin = Math.round(attackMin);
    const baseAttackMax = Math.round(attackMax);
    const finalAttackMin = (hasBanner && bannerSignature.includes(cardId)) ? baseAttackMin : roundNearestFive(baseAttackMin);
    const finalAttackMax = (hasBanner && bannerSignature.includes(cardId)) ? baseAttackMax : roundNearestFive(baseAttackMax);
    const finalHealth = roundNearestFive(Math.round(health));
    if (special && special.range) special.range = roundRangeToFive([Math.round(special.range[0] || 0), Math.round(special.range[1] || 0)]);

    return { cardId, card, scaled: { attackRange: [finalAttackMin, finalAttackMax], specialAttack: special, power: finalPower }, health: finalHealth, maxHealth: finalHealth, level, stamina: 3, usedSpecial: false, attackedLastTurn: false };
  });

  global.SAIL_SESSIONS.set(sessionId, {
    userId,
    user: interaction.user,
    cards: p1Cards,
    lifeIndex: 0,
    enemies,
    phase: 2,
    sessionId,
    channelId: interaction.channel.id,
    msgId: null,
    difficulty,
    episode: 3,
    hasMorgan: true
  });

  await startSailTurn(sessionId, interaction.channel);
};


