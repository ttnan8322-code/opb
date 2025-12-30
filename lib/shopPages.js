import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

export const pages = [
  {
    title: "Item Shop - Chests",
    image: "https://files.catbox.moe/ynr2er.webp",
    desc:
      "**To buy:** op buy `<item_name> <amount>` or `/buy`",
  },
  {
    title: "Item Shop - Items",
    image: "https://files.catbox.moe/1ucjus.webp",
    desc:
      "**To buy:** op buy `<item_name> <amount>` or `/buy`",
  },
  {
    title: "Item Shop - Materials",
    image: "https://files.catbox.moe/aly5iq.webp",
    desc:
      "**To buy:** op buy `<item_name> <amount>` or `/buy`",
  }
  ,
  {
    title: "Legendary Items",
    image: "https://files.catbox.moe/pbh2ya.webp",
    desc: "**To buy:** op buy `<item_name> <amount>` or `/buy`",
  }
];

export function buildEmbed(p) {
  return new EmbedBuilder().setTitle(p.title).setImage(p.image).setDescription(p.desc).setColor(0xFFFACD);
}

export function buildRow(userId, idx) {
  const prev = new ButtonBuilder().setCustomId(`shop_prev:${userId}:${idx}`).setLabel("Prev").setStyle(ButtonStyle.Secondary).setDisabled(idx <= 0);
  const next = new ButtonBuilder().setCustomId(`shop_next:${userId}:${idx}`).setLabel("Next").setStyle(ButtonStyle.Primary).setDisabled(idx >= pages.length - 1);
  return new ActionRowBuilder().addComponents(prev, next);
}

export default { pages, buildEmbed, buildRow };
