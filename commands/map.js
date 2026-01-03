import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import SailProgress from "../models/SailProgress.js";

export const data = new SlashCommandBuilder()
  .setName("map")
  .setDescription("View your sailing progress map");

export async function execute(interactionOrMessage) {
  const isInteraction = typeof interactionOrMessage.isCommand === "function" || typeof interactionOrMessage.isChatInputCommand === "function";
  const user = isInteraction ? interactionOrMessage.user : interactionOrMessage.author;
  const channel = isInteraction ? interactionOrMessage.channel : interactionOrMessage.channel;
  const userId = user.id;

  const sailProgress = await SailProgress.findOne({ userId }) || new SailProgress({ userId });

  const progress = sailProgress.progress || 0;

  // Define islands and their episode ranges
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

  // Helper: get stars for episode
  const getStars = (ep) => {
    try {
      return sailProgress.stars.get(String(ep)) || 0;
    } catch (e) { return 0; }
  };

  // East Blue total (exclude islands marked as excludeFromEastBlue)
  let eastBlueTotal = 0;
  let eastBlueMax = 0;
  for (const isl of islands) {
    if (isl.excludeFromEastBlue) continue;
    const count = isl.end - isl.start + 1;
    eastBlueMax += count * 3;
    for (let e = isl.start; e <= isl.end; e++) eastBlueTotal += getStars(e);
  }

  const filledEast = eastBlueMax === 0 ? 0 : Math.floor((eastBlueTotal / eastBlueMax) * 8);
  const eastBar = '▰'.repeat(filledEast) + '▱'.repeat(8 - filledEast);

  const fields = [];
  fields.push({ name: 'East Blue saga', value: `${eastBlueTotal}/${eastBlueMax} ✭`, inline: false });
  fields.push({ name: '\u200b', value: eastBar, inline: false });

  // Per-island fields with progress bar and per-episode lines
  for (const isl of islands) {
    const epCount = isl.end - isl.start + 1;
    let islandStars = 0;
    for (let e = isl.start; e <= isl.end; e++) islandStars += getStars(e);
    const islandMax = epCount * 3;
    const islandFilled = islandMax === 0 ? 0 : Math.floor((islandStars / islandMax) * 8);
    const islandBar = '▰'.repeat(islandFilled) + '▱'.repeat(8 - islandFilled);

    // Episode lines
    let episodeLines = '';
    for (let e = isl.start; e <= isl.end; e++) {
      const stars = getStars(e);
      let status = '';
      if (e > progress) status = ' ⛓';
      else if (e < progress) status = ` ${stars}/3 ✭`;
      // if e === progress, leave no icon
      episodeLines += `Episode ${e}${status}\n`;
    }

    fields.push({ name: `**${isl.name}** ${islandStars}/${islandMax} ✭`, value: islandBar, inline: false });
    fields.push({ name: '\u200b', value: episodeLines.trim(), inline: false });
  }

  const embed = new EmbedBuilder()
    .setTitle('World Map')
    .setDescription('View your progress')
    .setThumbnail('https://files.catbox.moe/e4w287.webp')
    .addFields(fields)
    .setFooter({ text: 'page 1/1' });

  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`map_nav:back:${userId}`).setLabel('Back').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`map_nav:next:${userId}`).setLabel('Next').setStyle(ButtonStyle.Secondary)
  );

  if (isInteraction) {
    await interactionOrMessage.reply({ embeds: [embed], components: [nav] });
  } else {
    await channel.send({ embeds: [embed], components: [nav] });
  }
}

export const category = "Gameplay";
export const description = "View your sailing progress map";