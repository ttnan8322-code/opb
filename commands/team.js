import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import Progress from "../models/Progress.js";
import { cards, getCardById, getRankInfo, RANKS } from "../cards.js";
import { computeTeamBoosts, computeTeamBoostsDetailed } from "../lib/boosts.js";
import { roundNearestFive } from "../lib/stats.js";

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i-1][j] + 1,
        dp[i][j-1] + 1,
        dp[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

function findCardFuzzy(query) {
  if (!query) return null;
  query = query.toLowerCase();
  // exact id
  let c = cards.find(x => x.id.toLowerCase() === query);
  if (c) return c;
  // exact name
  c = cards.find(x => x.name.toLowerCase() === query);
  if (c) return c;
  // includes
  const includes = cards.filter(x => x.name.toLowerCase().includes(query) || x.id.toLowerCase().includes(query));
  if (includes.length === 1) return includes[0];
  if (includes.length > 1) return includes[0];
  // best levenshtein on name
  let best = null; let bestScore = Infinity;
  for (const card of cards) {
    const score = levenshtein(card.name.toLowerCase(), query);
    if (score < bestScore) { bestScore = score; best = card; }
  }
  return best;
}

export const data = new SlashCommandBuilder()
  .setName("team")
  .setDescription("View or manage your team")
  .addSubcommand(s => s.setName("view").setDescription("Show your current team"))
  .addSubcommand(s => s.setName("add").setDescription("Add a card to your team").addStringOption(o => o.setName("card").setDescription("Card id or name").setRequired(true)))
  .addSubcommand(s => s.setName("remove").setDescription("Remove a card from your team").addStringOption(o => o.setName("card").setDescription("Card id or name").setRequired(true)))
  .addSubcommand(s => s.setName("autoteam").setDescription("Automatically pick your strongest 3 cards"));

export async function execute(interactionOrMessage, client) {
  const isInteraction = typeof interactionOrMessage.isCommand === "function" || typeof interactionOrMessage.isChatInputCommand === "function";
  let user = isInteraction ? interactionOrMessage.user : interactionOrMessage.author;
  
  // Guard against missing user
  if (!user || !user.id) {
    console.error("Invalid user object in team command");
    return;
  }
  
  const channel = isInteraction ? interactionOrMessage.channel : interactionOrMessage.channel;
  let userId = user.id;

  // allow message form `op team view @user` or `op team @user` to inspect others
  if (!isInteraction) {
    const parts = interactionOrMessage.content.trim().split(/\s+/);
    // detect mention token in args (look for a token with digits)
    const maybeMention = parts.find((p, i) => i > 1 && /[0-9]{6,}/.test(p));
    if (maybeMention) {
      const id = maybeMention.replace(/[^0-9]/g, "");
      if (id) {
        userId = id;
        // try to set a simple username for display
        user = { id, username: maybeMention };
      }
    }
  }

  const prog = await Progress.findOne({ userId }) || new Progress({ userId, cards: {}, team: [] });

  let mode = "view";
  let arg = null;
  if (isInteraction) {
    mode = interactionOrMessage.options.getSubcommand();
    arg = interactionOrMessage.options.getString("card");
  } else {
    const parts = interactionOrMessage.content.trim().split(/\s+/);
    // support both `op team add X` and `op teamadd X` and `op autoteam`
    const token = (parts[1] || "").toLowerCase();
    if (token === "team") {
      mode = (parts[2] || "view").toLowerCase();
      arg = parts.slice(3).join(" ") || null;
    } else {
      // token might be 'teamadd' or 'teamremove' or 'autoteam' or 'teamview'
      if (token.startsWith("team") && token.length > 4) {
        mode = token.slice(4);
      } else {
        mode = token || "view";
      }
      arg = parts.slice(2).join(" ") || null;
    }
  }

  if (mode === "add") {
    const card = findCardFuzzy(arg);
    if (!card) return sendReply("Card not found.");
    const cardsMap = prog.cards instanceof Map ? prog.cards : new Map(Object.entries(prog.cards || {}));
    const entry = cardsMap.get(card.id) || { cardId: card.id, count: 0, xp: 0, level: 0 };
    if ((entry.count || 0) <= 0) return sendReply("You don't own that card.");
    // add to team if not present
    prog.team = prog.team || [];
    if (prog.team.includes(card.id)) return sendReply(`${card.name} is already in your team.`);
    if (prog.team.length >= 3) return sendReply("Team is full (3 cards). Remove a card first.");
    const newTeam = [...prog.team, card.id];
    await Progress.findOneAndUpdate({ userId }, { team: newTeam });
    return sendReply(`**${card.name}** added to your team.`);
  }

  if (mode === "remove") {
    const card = findCardFuzzy(arg);
    if (!card) return sendReply("Please state a valid card.");
    prog.team = prog.team || [];
    const idx = prog.team.indexOf(card.id);
    if (idx === -1) return sendReply(`${card.name} is not in your team.`);
    const newTeam = [...prog.team];
    newTeam.splice(idx, 1);
    await Progress.findOneAndUpdate({ userId }, { team: newTeam });
    return sendReply(`**${card.name}** removed from your team.`);
  }

  if (mode === "autoteam") {
    const cardsMap = prog.cards instanceof Map ? prog.cards : new Map(Object.entries(prog.cards || {}));
    const owned = [];
    for (const [cid, entry] of cardsMap.entries()) {
      const card = getCardById(cid);
      if (!card) continue;
      const level = entry.level || 0;
      const score = (card.power || 0) * (1 + level * 0.01);
      owned.push({ card, entry, score });
    }
    if (!owned.length) return sendReply("You have no cards to build a team.");
    owned.sort((a,b) => b.score - a.score);
    const newTeam = owned.slice(0,3).map(x => x.card.id);
    // If the strongest team is already set, say so
    const curTeam = prog.team || [];
    const same = newTeam.length === curTeam.length && newTeam.every((v, i) => v === curTeam[i]);
    if (same) {
      return sendReply("Strongest possible team is already set!");
    }
    // Use findOneAndUpdate to avoid version conflicts
    await Progress.findOneAndUpdate({ userId }, { team: newTeam });
    return sendReply("Team automatically set to strongest cards.");
  }

  // view
  const teamIds = prog.team || [];

  // compute and show team boosts (if any)
  const detailed = (teamIds && teamIds.length) ? computeTeamBoostsDetailed(teamIds, prog.cards) : { totals: { atk:0,hp:0,special:0 }, details: [] };
  const boosts = detailed.totals;

  // compute average rank color
  let avgRankVal = 0;
  for (const id of teamIds) {
    const c = getCardById(id);
    const r = c ? getRankInfo(c.rank) : null;
    avgRankVal += (r ? r.value : 1);
  }
  avgRankVal = teamIds.length ? avgRankVal / teamIds.length : 1;
  // find closest rank
  let chosenColor = 0xFFFFFF;
  let bestDiff = Infinity;
  for (const k in RANKS) {
    const r = RANKS[k];
    const d = Math.abs(r.value - avgRankVal);
    if (d < bestDiff) { bestDiff = d; chosenColor = r.color; }
  }

  // Ensure we have a proper Discord `User` for both target and requester
  let displayUser = user;
  try {
    if (!displayUser || typeof displayUser.displayAvatarURL !== "function" || !displayUser.username) {
      displayUser = await client.users.fetch(userId).catch(() => null);
    }
  } catch (e) {
    displayUser = displayUser || null;
  }

  const displayName = (displayUser && displayUser.username) ? displayUser.username : (user && user.username) ? user.username : `User ${userId}`;
  const avatarURL = (displayUser && typeof displayUser.displayAvatarURL === "function") ? displayUser.displayAvatarURL() : null;

  // Fetch requester user if needed
  let requesterUser = isInteraction ? interactionOrMessage.user : interactionOrMessage.author;
  try {
    if (!requesterUser || typeof requesterUser.displayAvatarURL !== "function") {
      requesterUser = await client.users.fetch(requesterUser.id).catch(() => requesterUser);
    }
  } catch (e) {
    // keep as is
  }

  const embed = new EmbedBuilder()
    .setTitle(`${displayName}'s Team`)
    .setColor(chosenColor)
    .setFooter({ text: `Requested by ${requesterUser.username}`, iconURL: requesterUser.displayAvatarURL ? requesterUser.displayAvatarURL() : null });

  if (!teamIds.length) {
    embed.setDescription("No team set. Use `op team add <card>` or `/team add <card>`.");
  } else {
    const fields = teamIds.map((id, i) => {
      const card = getCardById(id);
      const entry = (prog.cards instanceof Map ? prog.cards.get(id) : (prog.cards || {})[id]) || {};
      if (!card) return { name: `#${i+1}: Unknown`, value: `ID: ${id}`, inline: true };

      const level = entry.level || 0;
      const basePower = Math.round((card.power || 0) * (1 + level * 0.01));
      const baseHealth = Math.round((card.health || 0) * (1 + level * 0.01));

      const cardBoost = detailed.details.find(d => d && d.id === id) || { atk:0, hp:0, special:0 };
      const effectivePower = roundNearestFive(Math.round(basePower * (1 + cardBoost.atk / 100)));
      const effectiveHealth = roundNearestFive(Math.round(baseHealth * (1 + cardBoost.hp / 100)));

      const boostParts = [];
      if (cardBoost.atk) boostParts.push(`ATK+${cardBoost.atk}%`);
      if (cardBoost.hp) boostParts.push(`HP+${cardBoost.hp}%`);
      if (cardBoost.special) boostParts.push(`SP+${cardBoost.special}%`);

      const value = `ATK: ${effectivePower} | HP: ${effectiveHealth}${boostParts.length ? `\nBoost: ${boostParts.join('/')}` : ''}`;

      return {
        name: `#${i+1}: ${card.name} (${card.rank})`,
        value,
        inline: true
      };
    });

    embed.addFields(fields);

    // Add team boosts if any
    let boostDesc = '';
    if (boosts.atk) boostDesc += `ATK +${boosts.atk}%`;
    if (boosts.hp) boostDesc += (boostDesc ? ' • ' : '') + `HP +${boosts.hp}%`;
    if (boosts.special) boostDesc += (boostDesc ? ' • ' : '') + `SPECIAL +${boosts.special}%`;
    if (boostDesc) {
      embed.addFields({ name: 'Team Boosts', value: boostDesc, inline: false });
    }
  }

  if (isInteraction) await interactionOrMessage.reply({ embeds: [embed] }); else await channel.send({ embeds: [embed] });

  async function sendReply(msg) {
    if (isInteraction) return await interactionOrMessage.reply({ content: msg });
    else return await channel.send(msg);
  }
}

export const description = "Manage your 3-card team (view/add/remove/autoteam)";

export const aliases = ["teamadd", "teamremove", "teamview", "autoteam"];
