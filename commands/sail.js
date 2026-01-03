import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from "discord.js";
import SailProgress from "../models/SailProgress.js";
import Progress from "../models/Progress.js";
import Balance from "../models/Balance.js";
import Inventory from "../models/Inventory.js";
import { getCardById } from "../cards.js";

export const data = new SlashCommandBuilder()
  .setName("sail")
  .setDescription("Sail through the world and progress in the story");

export async function execute(interactionOrMessage) {
  const isInteraction = typeof interactionOrMessage.isCommand === "function" || typeof interactionOrMessage.isChatInputCommand === "function";
  const user = isInteraction ? interactionOrMessage.user : interactionOrMessage.author;
  const channel = isInteraction ? interactionOrMessage.channel : interactionOrMessage.channel;
  const userId = user.id;

  const progress = await Progress.findOne({ userId });
  const sailProgress = await SailProgress.findOne({ userId }) || new SailProgress({ userId });

  // enforce cooldown after defeat: 5 minutes
  if (sailProgress && sailProgress.lastSail) {
    try {
      const last = new Date(sailProgress.lastSail).getTime();
      const diff = Date.now() - last;
      const cooldown = 5 * 60 * 1000;
      if (diff < cooldown) {
        const remaining = Math.ceil((cooldown - diff) / 1000);
        if (isInteraction) return interactionOrMessage.reply({ content: `You are on cooldown after defeat. Please wait ${remaining} seconds before sailing again.`, ephemeral: true });
        return channel.send(`You are on cooldown after defeat. Please wait ${remaining} seconds before sailing again.`);
      }
    } catch (e) { /* ignore parse errors */ }
  }

  const teamSet = progress && progress.team && progress.team.length > 0;
  const teamNames = teamSet ? progress.team.map(id => {
    const card = getCardById(id);
    const rank = card ? card.rank : 'Unknown';
    const name = card ? card.name : id;
    return `**(${rank})** ${name}`;
  }).join('\n') : '';

  if (sailProgress.progress === 0) {
    // Show intro embed
    const embed = new EmbedBuilder()
      .setColor('Blue')
      .setDescription(`**Introduction - Episode 0**

This is where your journey starts, Pirate !
In this journey, you will be walking the same steps as Luffy into being the future pirate king!
Build your team, get your items ready and be ready to fight, because this will be a hard journey.. Or will it ? Choose the difficulty of your journey on the dropdown below. You can always change the difficulty later with command \`op settings\` or \`/settings\` if you ever change your mind.

As you progress, the enemies will get stronger. I recommend preserving your items for future stages.

**${user.username}'s Deck**
${teamSet ? teamNames : 'Deck not set, automatically set your deck with command \`op autoteam\`!'}

**Next Episode**
I'm Luffy! The Man Who Will Become the Pirate King!`)
      .setImage('https://files.catbox.moe/6953qz.gif');

    const buttons = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`sail:${userId}:sail`)
          .setLabel('Sail')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`sail:${userId}:map`)
          .setLabel('Map')
          .setStyle(ButtonStyle.Secondary)
      );

    const dropdown = new ActionRowBuilder()
      .addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`sail_difficulty:${userId}`)
          .setPlaceholder('Select difficulty')
          .addOptions(
            { label: 'Easy', value: 'easy' },
            { label: 'Medium', value: 'medium' },
            { label: 'Hard', value: 'hard' }
          )
      );

    if (isInteraction) {
      await interactionOrMessage.reply({ embeds: [embed], components: [buttons, dropdown] });
    } else {
      await channel.send({ embeds: [embed], components: [buttons, dropdown] });
    }
  } else if (sailProgress.progress === 1) {
    // Episode 1: Luffy meets Koby and fights Alvida Pirates

    // Award XP if not already awarded for this difficulty
    let progress = await Progress.findOne({ userId });
    if (!progress) {
      progress = new Progress({ userId, team: [], cards: new Map() });
    }
    // Ensure `cards` is a Map instance so `.get`/`.set` work reliably
    if (!progress.cards || typeof progress.cards.get !== 'function') {
      progress.cards = new Map(Object.entries(progress.cards || {}));
    }
    let xpAmount = 0;
    if (!sailProgress.awardedXp[sailProgress.difficulty]) {
      xpAmount = sailProgress.difficulty === 'hard' ? 30 : sailProgress.difficulty === 'medium' ? 20 : 10;
      // award to user xp and handle user level
      progress.userXp = (progress.userXp || 0) + xpAmount;
      let levelsGained = 0;
      while (progress.userXp >= 100) {
        progress.userXp -= 100;
        progress.userLevel = (progress.userLevel || 1) + 1;
        levelsGained++;
      }
      // Give level up rewards
      if (levelsGained > 0) {
        const balance = await Balance.findOne({ userId }) || new Balance({ userId });
        const inventory = await Inventory.findOne({ userId }) || new Inventory({ userId });
        let oldLevel = progress.userLevel - levelsGained;
        for (let lvl = oldLevel + 1; lvl <= progress.userLevel; lvl++) {
          balance.balance += lvl * 50;
          const rankIndex = Math.floor((lvl - 1) / 10);
          const ranks = ['C', 'B', 'A', 'S'];
          const currentRank = ranks[rankIndex] || 'S';
          const prevRank = ranks[rankIndex - 1];
          const chance = (lvl % 10 || 10) * 10;
          if (Math.random() * 100 < chance) {
            inventory.chests[currentRank] += 1;
          } else if (prevRank) {
            inventory.chests[prevRank] += 1;
          }
        }
        await balance.save();
        await inventory.save();
      }
      // Add XP to each card in the team using leveling logic from level.js
      for (const cardId of progress.team || []) {
        let entry = progress.cards.get(cardId) || { count: 0, xp: 0, level: 0 };
        if (!entry.count) entry.count = 1;
        // This ensures we don't lose existing level when adding xp
        // Keep xp as remainder (0-99) so awarding is constant per difficulty
        entry.xp = entry.xp || 0;
        // Each level is always 100 XP (flat, not increasing)
        let totalXp = (entry.xp || 0) + xpAmount;
        let newLevel = entry.level || 0;
        while (totalXp >= 100) {
          totalXp -= 100;
          newLevel += 1;
        }
        entry.xp = totalXp;
        entry.level = newLevel;
        // Update the Map and mark as modified
        progress.cards.set(cardId, entry);
        progress.markModified('cards');
      }
      await progress.save();
      sailProgress.awardedXp = sailProgress.awardedXp || {};
      sailProgress.awardedXp[sailProgress.difficulty] = true;
      await sailProgress.save();
    } else {
      xpAmount = sailProgress.difficulty === 'hard' ? 30 : sailProgress.difficulty === 'medium' ? 20 : 10;
    }

    const embed = new EmbedBuilder()
      .setColor('Blue')
      .setDescription(`*I'm Luffy! The Man Who Will Become the Pirate King! - episode 1*

Luffy is found floating at sea by a cruise ship. After repelling an invasion by the Alvida Pirates, he meets a new ally, their chore boy Koby.

**Possible rewards:**
100 - 250 beli
1 - 2 C tier chest${sailProgress.difficulty === 'hard' ? '\n1x Koby card\n1x Alvida card (Exclusive to Hard mode)\n1x Heppoko card (Exclusive to Hard mode)\n1x Peppoko card (Exclusive to Hard mode)\n1x Poppoko card (Exclusive to Hard mode)\n1x Alvida Pirates banner blueprint (C rank Item card, signature: alvida pirates, boosts stats by +5%)' : '\n1x Koby card'}${Math.random() < 0.5 ? '\n1 reset token' : ''}

*XP awarded: +${xpAmount} to user and each team card.*`)
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

    if (isInteraction) {
      await interactionOrMessage.reply({ embeds: [embed], components: [buttons] });
    } else {
      await channel.send({ embeds: [embed], components: [buttons] });
    }
  } else if (sailProgress.progress === 2) {
    // Episode 2: The Great Swordsman Appears! Pirate Hunter Roronoa Zoro

    // Award XP if not already awarded for this difficulty
    let progress = await Progress.findOne({ userId });
    if (!progress) {
      progress = new Progress({ userId, team: [], cards: new Map() });
    }
    // Ensure `cards` is a Map instance so `.get`/`.set` work reliably
    if (!progress.cards || typeof progress.cards.get !== 'function') {
      progress.cards = new Map(Object.entries(progress.cards || {}));
    }
    let xpAmount = 0;
    if (!sailProgress.awardedXp[`ep2_${sailProgress.difficulty}`]) {
      // Use the same constant mapping for Episode 2 as other episodes
      xpAmount = sailProgress.difficulty === 'hard' ? 30 : sailProgress.difficulty === 'medium' ? 20 : 10;
      // award to user xp and handle user level
      progress.userXp = (progress.userXp || 0) + xpAmount;
      let levelsGained = 0;
      while (progress.userXp >= 100) {
        progress.userXp -= 100;
        progress.userLevel = (progress.userLevel || 1) + 1;
        levelsGained++;
      }
      // Give level up rewards
      if (levelsGained > 0) {
        const balance = await Balance.findOne({ userId }) || new Balance({ userId });
        const inventory = await Inventory.findOne({ userId }) || new Inventory({ userId });
        let oldLevel = progress.userLevel - levelsGained;
        for (let lvl = oldLevel + 1; lvl <= progress.userLevel; lvl++) {
          balance.balance += lvl * 50;
          const rankIndex = Math.floor((lvl - 1) / 10);
          const ranks = ['C', 'B', 'A', 'S'];
          const currentRank = ranks[rankIndex] || 'S';
          const prevRank = ranks[rankIndex - 1];
          const chance = (lvl % 10 || 10) * 10;
          if (Math.random() * 100 < chance) {
            inventory.chests[currentRank] += 1;
          } else if (prevRank) {
            inventory.chests[prevRank] += 1;
          }
        }
        await balance.save();
        await inventory.save();
      }
      // Add XP to each card in the team using leveling logic from level.js
      for (const cardId of progress.team || []) {
        let entry = progress.cards.get(cardId) || { count: 0, xp: 0, level: 0 };
        if (!entry.count) entry.count = 1;
        // This ensures we don't lose existing level when adding xp
        // Keep xp as remainder (0-99) so awarding is constant per difficulty
        entry.xp = entry.xp || 0;
        // Each level is always 100 XP (flat, not increasing)
        let totalXp = (entry.xp || 0) + xpAmount;
        let newLevel = entry.level || 0;
        while (totalXp >= 100) {
          totalXp -= 100;
          newLevel += 1;
        }
        entry.xp = totalXp;
        entry.level = newLevel;
        // Update the Map and mark as modified
        progress.cards.set(cardId, entry);
        progress.markModified('cards');
      }
      await progress.save();
      sailProgress.awardedXp = sailProgress.awardedXp || {};
      sailProgress.awardedXp[`ep2_${sailProgress.difficulty}`] = true;
      await sailProgress.save();
    } else {
      xpAmount = sailProgress.difficulty === 'hard' ? 30 : sailProgress.difficulty === 'medium' ? 20 : 10;
    }

    const embed = new EmbedBuilder()
      .setColor('Blue')
      .setDescription(`*The Great Swordsman Appears! Pirate Hunter Roronoa Zoro - episode 2*

Luffy and Koby find Zoro captured in Shells Town's Marine base, with the Marines intending to execute him. Luffy and Koby work together to retrieve Zoro's katanas, as well as confront the tyrannical Marine Captain Morgan and his son Helmeppo.

**Possible rewards:**
100 - 200 beli
1 - 2 C chest
1x rika card
1x Roronoa Zoro card
1x Helmeppo card (Hard mode Exclusive)
1 B chest (Hard mode Exclusive)

*XP awarded: +${xpAmount} to user and each team card.*`)
      .setImage('https://files.catbox.moe/pdfqe1.webp');

    const buttons = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`sail_battle_ep2:${userId}:start`)
          .setLabel("Sail to Episode 2")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`sail:${userId}:map`)
          .setLabel('Map')
          .setStyle(ButtonStyle.Secondary)
      );

    if (isInteraction) {
      await interactionOrMessage.reply({ embeds: [embed], components: [buttons] });
    } else {
      await channel.send({ embeds: [embed], components: [buttons] });
    }
  } else if (sailProgress.progress === 3) {
    // Episode 3: Intro
    let progressDoc = await Progress.findOne({ userId });
    if (!progressDoc) progressDoc = new Progress({ userId, team: [], cards: new Map() });
    if (!progressDoc.cards || typeof progressDoc.cards.get !== 'function') {
      progressDoc.cards = new Map(Object.entries(progressDoc.cards || {}));
    }

    let xpAmount = 0;
    if (!sailProgress.awardedXp[`ep3_${sailProgress.difficulty}`]) {
      xpAmount = sailProgress.difficulty === 'hard' ? 30 : sailProgress.difficulty === 'medium' ? 20 : 10;
      // award xp to user and team cards (same pattern as other episodes)
      progressDoc.userXp = (progressDoc.userXp || 0) + xpAmount;
      let levelsGained = 0;
      while (progressDoc.userXp >= 100) {
        progressDoc.userXp -= 100;
        progressDoc.userLevel = (progressDoc.userLevel || 1) + 1;
        levelsGained++;
      }
      if (levelsGained > 0) {
        const balance = await Balance.findOne({ userId }) || new Balance({ userId });
        const inventory = await Inventory.findOne({ userId }) || new Inventory({ userId });
        let oldLevel = progressDoc.userLevel - levelsGained;
        for (let lvl = oldLevel + 1; lvl <= progressDoc.userLevel; lvl++) {
          balance.balance += lvl * 50;
          const rankIndex = Math.floor((lvl - 1) / 10);
          const ranks = ['C', 'B', 'A', 'S'];
          const currentRank = ranks[rankIndex] || 'S';
          const prevRank = ranks[rankIndex - 1];
          const chance = (lvl % 10 || 10) * 10;
          if (Math.random() * 100 < chance) {
            inventory.chests[currentRank] += 1;
          } else if (prevRank) {
            inventory.chests[prevRank] += 1;
          }
        }
        await balance.save();
        await inventory.save();
      }
      // award xp to team cards
      for (const cardId of progressDoc.team || []) {
        let entry = progressDoc.cards.get(cardId) || { count: 0, xp: 0, level: 0 };
        if (!entry.count) entry.count = 1;
        entry.xp = entry.xp || 0;
        let totalXp = (entry.xp || 0) + xpAmount;
        let newLevel = entry.level || 0;
        while (totalXp >= 100) {
          totalXp -= 100;
          newLevel += 1;
        }
        entry.xp = totalXp;
        entry.level = newLevel;
        progressDoc.cards.set(cardId, entry);
        progressDoc.markModified('cards');
      }
      await progressDoc.save();
      sailProgress.awardedXp = sailProgress.awardedXp || {};
      sailProgress.awardedXp[`ep3_${sailProgress.difficulty}`] = true;
      await sailProgress.save();
    } else {
      xpAmount = sailProgress.difficulty === 'hard' ? 40 : sailProgress.difficulty === 'medium' ? 30 : 20;
    }

    const embed = new EmbedBuilder()
      .setColor('Blue')
      .setTitle("Morgan vs. Luffy! Who's This Mysterious Beautiful Young Girl? - Episode 3")
      .setDescription(`Luffy and Zoro battle and defeat Morgan, Helmeppo and the Marines. Koby parts ways with Luffy to join the Marines, and Zoro joins Luffy's crew as a permanent crew member.\n\n**Possible rewards:**\n250 - 500 beli\n1 - 2 C chest\n1 B chest (Hard mode exclusive)\n1x Axe-hand Morgan card (Hard mode exclusive)\n\n*XP awarded: +${xpAmount} to user and each team card.*`)
      .setImage('https://files.catbox.moe/8os33p.webp');

    const buttons = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`sail_battle_ep3:${userId}:start`)
          .setLabel('Sail to Episode 3')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`sail:${userId}:map`)
          .setLabel('Map')
          .setStyle(ButtonStyle.Secondary)
      );

    if (isInteraction) {
      await interactionOrMessage.reply({ embeds: [embed], components: [buttons] });
    } else {
      await channel.send({ embeds: [embed], components: [buttons] });
    }
  } else {
    // Default: show a helpful progress message rather than a terse string
    const reply = `Your current sail progress: Episode ${sailProgress.progress}`;
    if (isInteraction) {
      await interactionOrMessage.reply({ content: reply, ephemeral: true });
    } else {
      await channel.send(reply);
    }
  }
}

export const category = "Gameplay";
export const description = "Sail through the world and progress in the story";