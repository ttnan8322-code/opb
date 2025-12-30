console.log("🔥 BOT.JS VERSION: CLEAN_LOGIN_V1");

import { Client, GatewayIntentBits, Collection } from "discord.js";
import { config } from "dotenv";
import { connectDB } from "./config/database.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

config();
await connectDB();

// Build intents. MessageContent is required for prefix message commands.
// Make sure you've enabled it on the Discord Developer Portal for the bot.
const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
];

const client = new Client({ intents });

client.commands = new Collection();

// Startup diagnostics: show configured intents and remind to enable Message Content
console.log('Configured gateway intents:', intents.map(i => i && i.toString ? i.toString() : i));
if (!intents.includes(GatewayIntentBits.MessageContent)) {
  console.warn('⚠️ Message Content intent is NOT included in the client setup. Message-based commands will NOT work unless this intent is enabled and also allowed in the Bot settings in the Discord Developer Portal.');
} else {
  console.log('✅ Message Content intent is included in the client configuration. Make sure it is also enabled in the Discord Developer Portal.');
}

// dynamically load commands
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const commandFiles = fs.readdirSync("./commands").filter(file => file.endsWith(".js"));

for (const file of commandFiles) {
  const imported = await import(`./commands/${file}`);
  const command = imported.default || imported; // normalize default vs named exports
  // compute a safe command name (lowercased) from the SlashCommandBuilder
  let cmdName;
  try {
    cmdName = (command.data && command.data.name) || (command.data && command.data.toJSON && command.data.toJSON().name) || file.replace(/\.js$/, "");
  } catch (e) {
    cmdName = file.replace(/\.js$/, "");
  }
  client.commands.set(String(cmdName).toLowerCase(), command);
  // register aliases if provided by the command module (e.g. ['inv','inventory'])
  if (command.aliases && Array.isArray(command.aliases)) {
    for (const a of command.aliases) {
      client.commands.set(String(a).toLowerCase(), command);
    }
  }
}

// Diagnostics: log loaded commands
console.log(`Loaded ${client.commands.size} command entries (including aliases).`);
console.log('Command keys:', [...client.commands.keys()].slice(0, 50).join(', '));
// simple message-based prefix handling: prefix is "op" (case-insensitive)
client.on("messageCreate", async (message) => {
  try {
    if (!message.content) return;
    if (message.author?.bot) return;

    const parts = message.content.trim().split(/\s+/);
    if (parts.length < 2) return;

    // prefix is the first token; must be 'op' case-insensitive
    if (parts[0].toLowerCase() !== "op") return;

    const commandName = parts[1].toLowerCase();
    const command = client.commands.get(commandName);

    if (!command) {
      return;
    }

    // call the same execute exported for slash commands; pass message and client
    await command.execute(message, client);
  } catch (err) {
    console.error("Error handling message command:", err);
  }
});

// dynamically load events
const eventFiles = fs.readdirSync("./events").filter(file => file.endsWith(".js"));

for (const file of eventFiles) {
  const event = await import(`./events/${file}`);
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args, client));
  } else {
    client.on(event.name, (...args) => event.execute(...args, client));
  }
}

// Optional: auto-register slash commands if explicitly enabled
if (process.env.REGISTER_COMMANDS_ON_START === 'true') {
  (async () => {
    try {
      console.log('REGISTER_COMMANDS_ON_START is true: importing deploy-commands.js to register slash commands...');
      await import('./deploy-commands.js');
      console.log('Slash command registration attempt finished.');
    } catch (err) {
      console.error('Error while auto-registering commands:', err && err.message ? err.message : err);
    }
  })();
}

if (!process.env.TOKEN) {
  console.error("❌ TOKEN is missing");
  process.exit(1);
}

console.log("🚀 Calling client.login() now…");

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("error", err => console.error("Client error:", err));
client.on("shardError", err => console.error("Shard error:", err));

await client.login(process.env.TOKEN);
