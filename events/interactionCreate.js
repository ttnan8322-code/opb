import Progress from "../models/Progress.js";
import { getCardById, getRankInfo } from "../cards.js";
import { buildCardEmbed, buildUserCardEmbed } from "../lib/cardEmbed.js";
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from "discord.js";
import { roundNearestFive } from "../lib/stats.js";

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

export async function execute(interaction, client) {
  // Diagnostics: log interactions to verify they arrive in runtime logs
  try {
    try {
      const isBtn = typeof interaction.isButton === 'function' ? interaction.isButton() : false;
      const isSel = typeof interaction.isStringSelectMenu === 'function' ? interaction.isStringSelectMenu() : false;
      console.log(`interactionCreate: type=${interaction.type} user=${interaction.user?.tag || interaction.user?.id} id=${interaction.id} isCommand=${interaction.isCommand ? interaction.isCommand() : false} isButton=${isBtn} isStringSelect=${isSel} customId=${interaction.customId || ''}`);
    } catch (e) {
      console.log('interactionCreate: unable to stringify interaction metadata', e && e.message ? e.message : e);
    }
    // handle component interactions (buttons) first
    // handle select menus first
    if (interaction.isStringSelectMenu && interaction.isStringSelectMenu()) {
      const id = interaction.customId || "";
      // collection select for sorting
      if (id.startsWith("collection_sort:")) {
        const parts = id.split(":");
        const ownerId = parts[1];
        if (interaction.user.id !== ownerId) return interaction.reply({ content: "Only the original requester can use this select.", ephemeral: true });

        const sortVal = interaction.values && interaction.values[0] ? interaction.values[0] : 'best';
        // build collection for user with this sort
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

        if (sortVal === 'best') items.sort((a, b) => computeScoreLocal(b.card, b.entry) - computeScoreLocal(a.card, a.entry));
        else if (sortVal === 'wtb') items.sort((a, b) => computeScoreLocal(a.card, a.entry) - computeScoreLocal(b.card, b.entry));
        else if (sortVal === 'lbtw') items.sort((a, b) => (b.entry.level || 0) - (a.entry.level || 0));
        else if (sortVal === 'lwtb') items.sort((a, b) => (a.entry.level || 0) - (b.entry.level || 0));
        else if (sortVal === 'rank') items.sort((a, b) => (getRankInfo(b.card.rank)?.value || 0) - (getRankInfo(a.card.rank)?.value || 0));
        else if (sortVal === 'nto') items.sort((a, b) => (b.entry.acquiredAt || 0) - (a.entry.acquiredAt || 0));
        else if (sortVal === 'otn') items.sort((a, b) => (a.entry.acquiredAt || 0) - (b.entry.acquiredAt || 0));

        const PAGE_SIZE = 5;
        const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
        const page = 0;
        const pageItems = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
        const lines = pageItems.map((it, idx) => {
          const card = it.card;
          const rank = getRankInfo(card.rank)?.name || (card.rank || "-");
          return `**${idx + 1}. ${card.name}** [${rank}]`;
        });

        const embed = new EmbedBuilder().setTitle('Collection').setDescription(lines.join('\n')).setFooter({ text: `Page ${page + 1}/${totalPages}` });

        // recreate sort menu and paging buttons
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
        const prevId = `collection_prev:${ownerId}:${sortVal}:${page}`;
        const nextId = `collection_next:${ownerId}:${sortVal}:${page}`;
        const infoId = `collection_info:${ownerId}:${sortVal}:${page}`;
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(prevId).setLabel('Previous').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(nextId).setLabel('Next').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(infoId).setLabel('ⓘ').setStyle(ButtonStyle.Primary)
        );

        await interaction.update({ embeds: [embed], components: [sortRow, row] });
        return;
      }

      // selection from a collection page (inspect a card from the current page)
      if (id.startsWith("collection_select:")) {
        const parts = id.split(":");
        const ownerId = parts[1];
        const sortKey = parts[2] || 'best';
        const page = parseInt(parts[3] || '0', 10) || 0;
        if (interaction.user.id !== ownerId) return interaction.reply({ content: "Only the original requester can use this select.", ephemeral: true });

        const progDoc = await Progress.findOne({ userId: ownerId });
        if (!progDoc || !progDoc.cards) return interaction.reply({ content: "You have no cards.", ephemeral: true });
        const cardsMap = progDoc.cards instanceof Map ? progDoc.cards : new Map(Object.entries(progDoc.cards || {}));
        const items = [];
        for (const [cardId, entry] of cardsMap.entries()) {
          const card = getCardById(cardId);
          if (!card) continue;
          items.push({ card, entry });
        }

        // normalize sort aliases
        let mode = sortKey;
        if (mode === 'level_desc' || mode === 'lbtw') mode = 'lbtw';
        if (mode === 'level_asc' || mode === 'lwtb') mode = 'lwtb';
        if (mode === "best") items.sort((a, b) => (1 * ((b.entry.level||0) - (a.entry.level||0))) || 0);
        else if (mode === "wtb") items.sort((a, b) => (a.entry.level||0) - (b.entry.level||0));

        const PAGE_SIZE = 5;
        const pageItems = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

        const selectedId = interaction.values && interaction.values[0];
        const card = getCardById(selectedId);
        if (!card) return interaction.reply({ content: "Card not found.", ephemeral: true });

        const ownedEntry = cardsMap.get(card.id) || null;
        const viewer = interaction.user;
        const embed = (ownedEntry && (ownedEntry.count||0) > 0) ? buildUserCardEmbed(card, ownedEntry, viewer) : buildCardEmbed(card, ownedEntry, viewer);

        const backId = `collection_back:${ownerId}:${sortKey}:${page}`;
        const backRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(backId).setLabel('Back').setStyle(ButtonStyle.Secondary));
        if (!embed) return interaction.update({ content: 'Unable to display card info.', ephemeral: true });
        await interaction.update({ embeds: [embed], components: [backRow] });
        return;
      }
    }

    if (interaction.isButton()) {
      const id = interaction.customId || "";
      // only handle known prefixes (include shop_ and duel_). Let per-message duel_* collectors handle duel interactions.
      if (!id.startsWith("info_") && !id.startsWith("collection_") && !id.startsWith("quest_") && !id.startsWith("help_") && !id.startsWith("drop_claim") && !id.startsWith("shop_") && !id.startsWith("duel_")) return;
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
              await interaction.reply({ content: `You own a higher version (${ownedHigher?.name || 'upgraded version'}) and cannot view this version.`, ephemeral: true });
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

        const userWeapon = winv.weapons instanceof Map ? winv.weapons.get(weaponId) : winv.weapons?.[weaponId];
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
        const userWeapon = winv ? (winv.weapons instanceof Map ? winv.weapons.get(weaponId) : winv.weapons?.[weaponId]) : null;

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
      else if (mode === "rank") items.sort((a, b) => (getRankInfo(b.card.rank)?.value || 0) - (getRankInfo(a.card.rank)?.value || 0));
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
            return { label: card.name, value: card.id, description: getRankInfo(card.rank)?.name || (card.rank || '') };
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
          const rank = getRankInfo(card.rank)?.name || (card.rank || "-");
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
    }
  } catch (err) {
    console.error("Error handling button interaction:", err);
    try {
      if (!interaction.replied) await interaction.reply({ content: "Error handling interaction.", ephemeral: true });
    } catch (e) {}
    return;
  }

  // fallback to chat input commands (slash)
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName.toLowerCase());
  if (!command) return;

  try {
    await command.execute(interaction, client);
  } catch (error) {
    console.error(error);
    try {
      if (!interaction.replied) await interaction.reply({ content: "There was an error executing this command.", ephemeral: true });
    } catch (e) {}
  }
}
