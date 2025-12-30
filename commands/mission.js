import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import Balance from "../models/Balance.js";
import Inventory from "../models/Inventory.js";
import Quest from "../models/Quest.js";

export const data = new SlashCommandBuilder().setName("mission").setDescription("Daily trivia mission (5 questions)");
export const category = "Economy";
export const description = "Daily trivia mission";

const QUESTIONS = [
  { q: "What is Luffy's dream?", a: ["Be King of the Pirates","Become the strongest","Find One Piece","Own a ship"], correct: 0 },
  { q: "Who is the swordsman of the Straw Hats?", a: ["Sanji","Zoro","Usopp","Chopper"], correct: 1 },
  { q: "What fruit did Luffy eat?", a: ["Gomu Gomu no Mi","Mera Mera no Mi","Hito Hito no Mi","Bara Bara no Mi"], correct: 0 },
  { q: "Who is the doctor in Straw Hats?", a: ["Nami","Robin","Chopper","Franky"], correct: 2 },
  { q: "What is the name of the ship?", a: ["Thousand Sunny","Going Merry","Red Force","Oro Jackson"], correct: 1 },
  { q: "Who is the navigator?", a: ["Nami","Robin","Bon Clay","Vivi"], correct: 0 },
  { q: "Where is Zoro from?", a: ["Syrup Village","East Blue","Shimotsuki Village","Skypiea"], correct: 2 },
  { q: "Who uses the Black Leg style?", a: ["Sanji","Zoro","Luffy","Brook"], correct: 0 },
  { q: "Who taught Luffy to fight?", a: ["Rayleigh","Shanks","Whitebeard","Garp"], correct: 3 },
  { q: "Who is the archeologist?", a: ["Robin","Nico","Nami","Boa"], correct: 0 }
];

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

export async function execute(interactionOrMessage) {
  const isInteraction = typeof interactionOrMessage.isCommand === "function" || typeof interactionOrMessage.isChatInputCommand === "function";
  const user = isInteraction ? interactionOrMessage.user : interactionOrMessage.author;
  const channel = isInteraction ? interactionOrMessage.channel : interactionOrMessage.channel;
  const userId = user.id;

  let bal = await Balance.findOne({ userId });
  if (!bal) { bal = new Balance({ userId, amount: 500 }); }

  const now = Date.now();
  const last = bal.lastMission ? new Date(bal.lastMission).getTime() : 0;
  const daysSince = Math.floor((now - last) / (24*60*60*1000));
  if (last && daysSince === 0) {
    const reply = "You've already done today's mission.";
    if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true });
    return channel.send(reply);
  }

  // pick 5 random questions
  const pool = QUESTIONS.slice();
  const picked = [];
  while (picked.length < 5 && pool.length) {
    const idx = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(idx,1)[0]);
  }

  // interactive flow: ask sequentially
  let current = 0;
  let correctCount = 0;
  const answers = [];

  const askQuestion = async (msg) => {
    const q = picked[current];
    const embed = new EmbedBuilder()
      .setTitle(`Question ${current+1}`)
      .setColor(0x00BFFF)
      .setDescription(q.q)
      .addFields(
        { name: "A", value: q.a[0], inline: true },
        { name: "B", value: q.a[1], inline: true },
        { name: "C", value: q.a[2], inline: true },
        { name: "D", value: q.a[3], inline: true }
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mission_a:${userId}:${current}`).setLabel("A").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`mission_b:${userId}:${current}`).setLabel("B").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`mission_c:${userId}:${current}`).setLabel("C").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`mission_d:${userId}:${current}`).setLabel("D").setStyle(ButtonStyle.Primary)
    );

    if (msg) return msg.edit({ embeds: [embed], components: [row] });
    if (isInteraction) return interactionOrMessage.reply({ embeds: [embed], components: [row], fetchReply: true });
    return channel.send({ embeds: [embed], components: [row] });
  };

  // start
  const startMsg = await askQuestion(null);
  const collector = startMsg.createMessageComponentCollector({ time: 120000 });
  collector.on("collect", async i => {
    if (i.user.id !== userId) return i.reply({ content: "Not your mission.", ephemeral: true });
    const parts = i.customId.split(":");
    const choice = parts[0].split("_")[1];
    const q = picked[current];
    const idx = { a:0,b:1,c:2,d:3 }[choice];
    answers.push(idx);
    if (idx === q.correct) correctCount++;
    current++;
    if (current >= picked.length) {
      collector.stop();
      // award per-correct rewards
      let totalBeli = 0;
      const chestGain = { C:0,B:0,A:0 };
      for (let k=0;k<picked.length;k++) {
        if (answers[k] === picked[k].correct) {
          totalBeli += randInt(50,250);
          if (Math.random() <= 0.5) chestGain.C += randInt(1,2);
          if (Math.random() <= 0.1) chestGain.B += 1;
        }
      }
      // bonus for all correct
      if (correctCount === picked.length) {
        if (Math.random() <= 0.3) chestGain.C += 1;
        if (Math.random() <= 0.5) chestGain.B += 1;
        if (Math.random() <= 0.2) chestGain.A += 1;
      }

      bal.amount = (bal.amount || 0) + totalBeli;
      bal.lastMission = new Date();
      await bal.save();

      let inv = await Inventory.findOne({ userId });
      if (!inv) inv = new Inventory({ userId, items: {}, chests: { C:0,B:0,A:0,S:0 }, xpBottles:0 });
      inv.chests = inv.chests || { C:0,B:0,A:0,S:0 };
      inv.chests.C += chestGain.C;
      inv.chests.B += chestGain.B;
      inv.chests.A += chestGain.A;
      await inv.save();

      // Record quest progress for completing a mission (count each question as 1 mission)
      try {
        const [dailyQuests, weeklyQuests] = await Promise.all([
          Quest.getCurrentQuests("daily"),
          Quest.getCurrentQuests("weekly")
        ]);
        await Promise.all([
          dailyQuests.recordAction(userId, "mission", picked.length),
          weeklyQuests.recordAction(userId, "mission", picked.length)
        ]);
      } catch (e) {
        console.error("Failed to record mission quest progress:", e);
      }

      const resultEmbed = new EmbedBuilder()
        .setTitle("Mission Complete")
        .setColor(0x00FF7F)
        .setDescription(`You answered ${correctCount}/${picked.length} correctly. You earned ${totalBeli}¥.`)
        .addFields({ name: "Chests", value: `C: ${chestGain.C} • B: ${chestGain.B} • A: ${chestGain.A}` });

      return i.update({ embeds: [resultEmbed], components: [] });
    }
    // ask next question
    await i.update({ content: "Answer recorded.", embeds: [], components: [] });
    const nextMsg = await askQuestion(startMsg);
  });

}
