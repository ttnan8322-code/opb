import { SlashCommandBuilder } from "discord.js";
import Balance from "../models/Balance.js";
import Inventory from "../models/Inventory.js";

export const data = new SlashCommandBuilder()
  .setName("buy")
  .setDescription("Buy an item from the shop")
  .addStringOption(opt => opt.setName("item").setDescription("Item name").setRequired(true))
  .addIntegerOption(opt => opt.setName("amount").setDescription("Amount to buy").setMinValue(1));

const SHOP = {
  chests: { C: 200, B: 500, A: 1000, S: 5000 },
  materials: {
    steel: 500, iron: 500, wood: 500, leather: 500, "ray skin": 500, titanium: 500, obsidian: 500, spring: 500, aluminum: 500, brass: 500, diamond: 1000
  },
  legendary: {
    "log pose": 25000,
    "map of the world": 25000,
    "diamond": 1000,
    "jolly roger flag": 25000,
    "summon": 50000,
    "conquorors haki": 50000,
    "observation haki": 30000,
    "armament haki": 30000
  },
  others: {
    "reset token": 800, "xp book": 500, "xp scroll": 60, "battle token": 60
  }
};

function findItem(name) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  // chests
  if (["c tier chest","c chest","c tier","c"].includes(n) || n === "c tier chest" || n === "c tier") return { type: 'chest', key: 'C', price: SHOP.chests.C };
  if (["b tier chest","b chest","b tier","b"].includes(n)) return { type: 'chest', key: 'B', price: SHOP.chests.B };
  if (["a tier chest","a chest","a tier","a"].includes(n)) return { type: 'chest', key: 'A', price: SHOP.chests.A };
  if (["s tier chest","s chest","s tier","s"].includes(n)) return { type: 'chest', key: 'S', price: SHOP.chests.S };

  // materials
  for (const k of Object.keys(SHOP.materials)) {
    if (n === k || n === k.replace(/\s+/g, "")) return { type: 'material', key: k, price: SHOP.materials[k] };
  }

  // legendary
  for (const k of Object.keys(SHOP.legendary)) {
    if (n === k || n === k.replace(/\s+/g, "")) return { type: 'legendary', key: k, price: SHOP.legendary[k] };
  }

  // others
  for (const k of Object.keys(SHOP.others)) {
    if (n === k || n === k.replace(/\s+/g, "")) return { type: 'other', key: k, price: SHOP.others[k] };
  }

  return null;
}

export async function execute(interactionOrMessage) {
  const isInteraction = typeof interactionOrMessage.isCommand === "function" || typeof interactionOrMessage.isChatInputCommand === "function";
  const user = isInteraction ? interactionOrMessage.user : interactionOrMessage.author;
  const channel = isInteraction ? interactionOrMessage.channel : interactionOrMessage.channel;
  const userId = user.id;

  let itemName, amount;
  if (isInteraction) {
    itemName = interactionOrMessage.options.getString('item');
    amount = interactionOrMessage.options.getInteger('amount') || 1;
  } else {
    const parts = interactionOrMessage.content.trim().split(/\s+/);
    // remove prefix and command
    parts.splice(0, 2);
    // expect: op buy "item name" amount OR op buy itemname amount
    if (parts.length === 0) return channel.send('Usage: op buy "item name" <amount>');
    // if first token starts with a quote, join until closing quote
    if (parts[0].startsWith('"')) {
      let joined = parts.join(' ');
      const m = joined.match(/^"([^"]+)"\s*(\d+)?/);
      if (m) {
        itemName = m[1];
        amount = m[2] ? parseInt(m[2], 10) : 1;
      } else {
        // fallback: use first token
        itemName = parts[0]; amount = 1;
      }
    } else {
      itemName = parts[0]; amount = parts[1] ? parseInt(parts[1], 10) : 1;
    }
  }

  if (!itemName) {
    const reply = 'Specify an item to buy.';
    if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true });
    return channel.send(reply);
  }

  amount = Math.max(1, parseInt(amount || 1, 10));

  const found = findItem(itemName);
  if (!found) {
    const reply = `Item "${itemName}" not found in the shop.`;
    if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true });
    return channel.send(reply);
  }

  const total = (found.price || 0) * amount;

  const bal = await Balance.findOne({ userId }) || new Balance({ userId, amount: 0 });
  if ((bal.amount || 0) < total) {
    const reply = `Insufficient funds. Need ${total}¥ but you have ${(bal.amount||0)}¥.`;
    if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true });
    return channel.send(reply);
  }

  // Deduct cost
  bal.amount = (bal.amount || 0) - total;
  await bal.save();

  // Add item to inventory
  const inv = await Inventory.findOne({ userId }) || new Inventory({ userId });
  if (found.type === 'chest') {
    const k = found.key;
    inv.chests = inv.chests || { C:0, B:0, A:0, S:0 };
    inv.chests[k] = (inv.chests[k] || 0) + amount;
  } else if (found.type === 'material' || found.type === 'legendary' || found.type === 'other') {
    const key = String(found.key).toLowerCase();
    // map certain names into inventory fields
    if (key === 'xp book') inv.xpBooks = (inv.xpBooks || 0) + amount;
    else if (key === 'xp scroll') inv.xpScrolls = (inv.xpScrolls || 0) + amount;
    else if (key === 'reset token') {
      const bal2 = await Balance.findOne({ userId }) || new Balance({ userId });
      bal2.resetTokens = (bal2.resetTokens || 0) + amount;
      await bal2.save();
    } else {
      // Use case-insensitive item storage to avoid duplicates
      const items = inv.items instanceof Map ? inv.items : new Map(Object.entries(inv.items || {}));
      const storageKey = key;
      
      // Find existing key case-insensitively to avoid duplicates
      let foundKey = null;
      if (typeof items.get === 'function') {
        for (const k of items.keys()) {
          if (String(k).toLowerCase() === storageKey) {
            foundKey = k;
            break;
          }
        }
      } else {
        for (const k of Object.keys(items || {})) {
          if (String(k).toLowerCase() === storageKey) {
            foundKey = k;
            break;
          }
        }
      }
      
      const useKey = foundKey || storageKey;
      const prev = Number(items.get ? items.get(useKey) : items[useKey] || 0);
      if (items.set) {
        items.set(useKey, prev + amount);
      } else {
        items[useKey] = prev + amount;
      }
      inv.items = items;
    }
  }

  await inv.save();

  // Record quest progress for buying items
  try {
    const Quest = (await import('../models/Quest.js')).default;
    const [dailyQuests, weeklyQuests] = await Promise.all([
      Quest.getCurrentQuests('daily'),
      Quest.getCurrentQuests('weekly')
    ]);
    if (dailyQuests && dailyQuests.recordAction) await dailyQuests.recordAction(userId, 'buy', amount);
    if (weeklyQuests && weeklyQuests.recordAction) await weeklyQuests.recordAction(userId, 'buy', amount);
  } catch (e) {
    // non-fatal
    console.error('Failed to record buy quest progress:', e && e.message ? e.message : e);
  }

  const reply = `Purchased ${amount} x ${found.key} for ${total}¥.`;
  if (isInteraction) return interactionOrMessage.reply({ content: reply });
  return channel.send(reply);
}

export const category = "Shop";
export const description = "Buy an item from the shop";
