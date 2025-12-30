import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import Balance from "../models/Balance.js";
import Pull from "../models/Pull.js";
import Quest from "../models/Quest.js";
import Duel from "../models/Duel.js";

export const data = new SlashCommandBuilder()
  .setName("timers")
  .setDescription("Show your OP timers: quests, pulls, missions, gambling, daily");

export async function execute(interactionOrMessage) {
  const isInteraction = typeof interactionOrMessage.isCommand === "function" || typeof interactionOrMessage.isChatInputCommand === "function";
  const user = isInteraction ? interactionOrMessage.user : interactionOrMessage.author;
  const channel = isInteraction ? interactionOrMessage.channel : interactionOrMessage.channel;
  const userId = user.id;

  const now = Date.now();
  const lines = [];

  // Daily quests and Weekly quests (expiresAt)
  try {
    const daily = await Quest.getCurrentQuests("daily");
    const weekly = await Quest.getCurrentQuests("weekly");
    if (daily && daily.expiresAt) {
      const ms = daily.expiresAt.getTime() - now;
      if (ms > 0) lines.push(`• Daily quests reset in: ${formatMs(ms)}`);
      else lines.push(`• Daily quests: resetting soon`);
    }
    if (weekly && weekly.expiresAt) {
      const ms = weekly.expiresAt.getTime() - now;
      if (ms > 0) lines.push(`• Weekly quests reset in: ${formatMs(ms)}`);
      else lines.push(`• Weekly quests: resetting soon`);
    }
  } catch (e) {
    console.error("Failed to fetch quests for timers:", e);
  }

  // Pull reset (8h window)
  try {
    const WINDOW_MS = 8 * 60 * 60 * 1000;
    const pull = await Pull.findOne({ userId });
    if (pull) {
      const nextReset = (pull.window + 1) * WINDOW_MS;
      const ms = nextReset - now;
      if (ms > 0) lines.push(`• Pulls reset in: ${formatMs(ms)}`);
      else lines.push(`• Pulls: resetting soon`);
    } else {
      lines.push(`• Pulls: you have full pulls (no active window)`);
    }
  } catch (e) {}

  // Missions, Gambling, Daily, Duel XP (per-user fields in Balance)
  try {
    let bal = await Balance.findOne({ userId });
    if (!bal) bal = new Balance({ userId });
    const duel = await Duel.findOne({ userId });

    // Missions: lastMission + 24h
    if (bal.lastMission) {
      const next = new Date(bal.lastMission).getTime() + (24*60*60*1000);
      const ms = next - now;
      if (ms > 0) lines.push(`• Mission available in: ${formatMs(ms)}`);
      else lines.push(`• Mission: available now`);
    } else {
      lines.push(`• Mission: available now`);
    }

    // Gambling: daily window
    const dayMs = 24*60*60*1000;
    const win = bal.gambleWindow || Math.floor(now / dayMs);
    const nextGambleReset = (win + 1) * dayMs;
    const msG = nextGambleReset - now;
    lines.push(`• Gambling resets in: ${formatMs(msG)} • Gambles today: ${bal.gamblesToday || 0}/10`);

    // Duel XP tracking (max 100 per day)
    if (duel) {
      const duelWin = duel.xpWindow || Math.floor(now / dayMs);
      if (duelWin !== Math.floor(now / dayMs)) {
        lines.push(`• Duel XP: 0/100 (resets soon)`);
      } else {
        lines.push(`• Duel XP: ${duel.xpToday || 0}/100`);
      }
    } else {
      lines.push(`• Duel XP: 0/100`);
    }

    // Daily command availability
    if (bal.lastDaily) {
      const next = new Date(bal.lastDaily).getTime() + (24*60*60*1000);
      const ms = next - now;
      if (ms > 0) lines.push(`• Daily available in: ${formatMs(ms)} • Streak: ${bal.dailyStreak || 0}/5`);
      else lines.push(`• Daily: available now`);
    } else {
      lines.push(`• Daily: available now`);
    }
  } catch (e) {
    console.error("Failed to fetch balance for timers:", e);
  }

  // Format timer output with minimal spacing
  const dailyQuestLine = lines.find(l => l.startsWith('• Daily quests'));
  const weeklyQuestLine = lines.find(l => l.startsWith('• Weekly quests'));
  const pullLine = lines.find(l => l.startsWith('• Pulls'));
  const missionLine = lines.find(l => l.startsWith('• Mission'));
  const gamblingLine = lines.find(l => l.startsWith('• Gambling'));
  const dailyLine = lines.find(l => l.startsWith('• Daily available') || l.startsWith('• Daily:'));

  // Extract time values from lines
  const extractTime = (line) => {
    const match = line ? line.match(/in: (.+?)(?:\s*•|$)/) : null;
    if (match) return match[1];
    // If line says "available now", return "0s"
    if (line && line.includes('available now')) return '0s';
    return 'resetting soon';
  };

  const extractGamblingCount = (line) => {
    const match = line ? line.match(/Gambles today: (\d+\/\d+)/) : null;
    return match ? match[1] : '0/10';
  };

  const extractDailyCount = (line) => {
    const match = line ? line.match(/Streak: (\d+\/\d+)/) : null;
    return match ? match[1] : '0/5';
  };

  const dailyQuestTime = extractTime(dailyQuestLine);
  const weeklyQuestTime = extractTime(weeklyQuestLine);
  const pullTime = extractTime(pullLine);
  const missionTime = extractTime(missionLine);
  const gamblingTime = extractTime(gamblingLine);
  const gamblingCount = extractGamblingCount(gamblingLine);
  const dailyTime = extractTime(dailyLine);
  const dailyCount = extractDailyCount(dailyLine);

  const header = `Here are all the bot timers!`;
  const text = `${header}
**Daily quests:** resets in \`${dailyQuestTime}\`
**Weekly quests:** resets in \`${weeklyQuestTime}\`
**Pulls:** resets in \`${pullTime}\`
**Missions:** resets in \`${missionTime}\`
**Gambling:** resets in \`${gamblingTime}\`. ${gamblingCount}
**Daily rewards:** available in \`${dailyTime}\`. ${dailyCount}`;

  if (isInteraction) return interactionOrMessage.reply({ content: text });
  return channel.send({ content: text });
}

function formatMs(ms) {
  if (ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (sec) parts.push(`${sec}s`);
  return parts.join(" ");
}
