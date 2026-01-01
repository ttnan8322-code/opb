import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import Code from "../models/Code.js";
import Balance from "../models/Balance.js";
import Inventory from "../models/Inventory.js";
import Progress from "../models/Progress.js";
import { getCardById } from "../cards.js";

export const data = new SlashCommandBuilder()
  .setName("code")
  .setDescription("Redeem a promo code")
  .addStringOption(opt => opt.setName('code').setDescription('Code to redeem').setRequired(false));

export const category = "Economy";
export const description = "Redeem a code for rewards";

export async function execute(interactionOrMessage) {
  const isInteraction = typeof interactionOrMessage.isCommand === "function" || typeof interactionOrMessage.isChatInputCommand === "function";
  const user = isInteraction ? interactionOrMessage.user : interactionOrMessage.author;
  const channel = isInteraction ? interactionOrMessage.channel : interactionOrMessage.channel;
  const userId = user.id;

  let codeArg;
  if (isInteraction) {
    codeArg = interactionOrMessage.options.getString('code');
  } else {
    const parts = interactionOrMessage.content.trim().split(/\s+/);
    // op code <code>
    codeArg = parts.slice(2).join(' ');
  }

  if (!codeArg) {
    const reply = "Usage: op code <code> or /code <code>";
    if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true });
    return channel.send(reply);
  }

  const codeKey = String(codeArg).trim();

  // Ensure the code document exists (seed behavior) for NewYears2026
  let codeDoc = await Code.findOne({ code: 'NewYears2026' });
  if (!codeDoc) {
    const expires = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // 3 days
    codeDoc = new Code({ code: 'NewYears2026', expiresAt: expires, claimedBy: [] });
    await codeDoc.save().catch(() => {});
  }

  // Only support the one-time event code
  if (codeKey.toLowerCase() !== 'newyears2026') {
    const reply = `Unknown code: ${codeArg}`;
    if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true });
    return channel.send(reply);
  }

  // reload doc
  codeDoc = await Code.findOne({ code: 'NewYears2026' });
  if (!codeDoc) {
    const reply = "Code unavailable.";
    if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true });
    return channel.send(reply);
  }

  if (codeDoc.claimedBy && codeDoc.claimedBy.includes(userId)) {
    const reply = "You have already claimed this code.";
    if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true });
    return channel.send(reply);
  }

  if (codeDoc.expiresAt && new Date() > new Date(codeDoc.expiresAt)) {
    const reply = "This code has expired.";
    if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true });
    return channel.send(reply);
  }

  // Apply rewards
  // 10 C, 5 B, 3 A, 1 S chests
  await Balance.findOneAndUpdate(
    { userId },
    { $inc: { amount: 5000 } },
    { upsert: true }
  );

  await Inventory.findOneAndUpdate(
    { userId },
    {
      $inc: {
        'chests.C': 10,
        'chests.B': 5,
        'chests.A': 3,
        'chests.S': 1
      },
      $setOnInsert: {
        items: {},
        xpBottles: 0,
        xpScrolls: 0,
        xpBooks: 0
      }
    },
    { upsert: true }
  );

  // Give new card
  const cardId = 'luffy_z_newyears_2026';
  const card = getCardById(cardId);
  if (card) {
    let prog = await Progress.findOne({ userId });
    if (!prog) prog = new Progress({ userId, cards: {} });
    const cardsMap = prog.cards instanceof Map ? prog.cards : new Map(Object.entries(prog.cards || {}));
    const entry = cardsMap.get(card.id) || { count: 0, xp: 0, level: 0 };
    entry.count = (entry.count || 0) + 1;
    cardsMap.set(card.id, entry);
    prog.cards = cardsMap;
    prog.markModified('cards');
    await prog.save();
  }

  // mark claimed by this user
  codeDoc.claimedBy = codeDoc.claimedBy || [];
  codeDoc.claimedBy.push(userId);
  await codeDoc.save();

  const embed = new EmbedBuilder()
    .setTitle(`Successfully claimed Code!`)
    .setColor(0xFFFFFF)
    .setDescription(`**rewards**\n<:arrow:1432010265234247772> (10x) C Tier Chest\n<:arrow:1432010265234247772> (5x) B Tier Chest\n<:arrow:1432010265234247772>(3x) A Tier Chest\n<:arrow:1432010265234247772> (1x) S Tier Chest\n<:arrow:1432010265234247772> (NEW YEARS) Monkey D. Luffy card\n<:arrow:1432010265234247772> 5000 beli`)
    .setFooter({ text: `claimed by ${user.username}`, iconURL: user.displayAvatarURL() })

  if (isInteraction) return interactionOrMessage.reply({ embeds: [embed] });
  return channel.send({ embeds: [embed] });
}
