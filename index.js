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
// simple message-based prefix handling: prefix is "op" (case-insensitive)
client.on("messageCreate", async (message) => {
  try {
    // Diagnostics: log incoming messages (truncated) so you can confirm the bot receives them in Render logs
    const preview = (message.content || '').slice(0, 200).replace(/\n/g, ' ');
    console.log(`messageCreate from ${message.author?.tag || message.author?.id} (bot=${message.author?.bot}) preview="${preview}"`);

    if (!message.content) return;
    if (message.author?.bot) return;

    const parts = message.content.trim().split(/\s+/);
    if (parts.length < 2) return;

    // prefix is the first token; must be 'op' case-insensitive
    if (parts[0].toLowerCase() !== "op") return;

    const commandName = parts[1].toLowerCase();
    const command = client.commands.get(commandName);

    if (!command) {
      console.log(`Unknown message command requested: ${commandName}`);
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

// Start a small HTTP server FIRST so Render and uptime monitors (e.g., UptimeRobot)
// can check that the service is alive even if Discord login hangs. This avoids
// adding express as a dependency and works with Render's $PORT environment variable.
import http from "http";

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/health" || req.url === "/_health")) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("OK");
  }

  if (req.method === "GET" && req.url === "/status") {
    const payload = {
      status: "ok",
      port: PORT,
      discord: client.user ? `${client.user.tag}` : null,
      uptimeSeconds: Math.floor(process.uptime()),
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(payload));
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => console.log(`Health server listening on port ${PORT}`));

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

// Ensure we have a token and make login failures visible in Render logs
if (!process.env.TOKEN) {
  console.error("❌ TOKEN is not set in environment variables. Set TOKEN in your Render service settings.");
  // Keep the process alive so you can inspect the service; don't exit immediately
} else {
  console.log(`Found TOKEN of length ${process.env.TOKEN.length} characters — performing pre-login checks...`);

  // Diagnostic helpers: check DNS and the Discord REST API for token validity.
  const { lookup } = await import('dns/promises');

  const checkDiscordReachable = async () => {
    try {
      const addresses = await lookup('discord.com');
      console.log('✅ DNS lookup for discord.com succeeded:', addresses);
      return { ok: true };
    } catch (err) {
      console.error('❌ DNS lookup for discord.com failed:', err && err.message ? err.message : err);
      return { ok: false, error: err };
    }
  };

  const checkTokenRest = async (token) => {
    try {
      const resp = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bot ${token}` },
        method: 'GET',
      });
      if (resp.status === 200) {
        const body = await resp.json();
        console.log('✅ Token REST check succeeded, bot:', body.username ? `${body.username}#${body.discriminator || '????'}` : body);
        return { ok: true, body };
      }
      if (resp.status === 401) {
        console.error('❌ Token REST check failed: 401 Unauthorized — invalid token');
        return { ok: false, error: 'invalid_token', status: 401 };
      }
      console.error('❌ Token REST check returned status', resp.status);
      return { ok: false, status: resp.status };
    } catch (err) {
      console.error('❌ Token REST check threw an error:', err && err.message ? err.message : err);
      return { ok: false, error: err };
    }
  };

  (async () => {
    const dnsRes = await checkDiscordReachable();
    const tokenRes = await checkTokenRest(process.env.TOKEN);

    if (!dnsRes.ok) {
      console.error('Network/DNS check failed — outbound network to discord.com may be blocked from this environment.');
      // Keep process alive for debugging instead of exiting so Render shows the service as up
      // and you can inspect logs / try redeploying with network changes.
      // Optionally exit to fail the deployment: process.exit(1);
    }

    if (!tokenRes.ok) {
      if (tokenRes.error === 'invalid_token' || tokenRes.status === 401) {
        console.error('❌ The provided TOKEN is invalid. Rotate the bot token and update Render environment variables.');
        process.exit(1);
      }
      console.error('Token REST check failed:', tokenRes);
      // Continue and attempt websocket login; it may still succeed if REST is flaky.
    }

    // Add more event diagnostics for connection issues
    client.on('error', (err) => console.error('client error:', err));
    client.on('shardError', (err) => console.error('shard error:', err));
    client.on('shardDisconnect', (event, shardId) => console.warn('shard disconnect:', { event, shardId }));

    // Wrap login with a timeout so a hanging login doesn't indefinitely block deploy. Use 60s here.
    const loginWithTimeout = (token, ms = 60000) => {
      return Promise.race([
        client.login(token),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Discord login timed out')), ms)),
      ]);
    };

    try {
      console.log('Attempting websocket login (this may take a few seconds)...');
      await loginWithTimeout(process.env.TOKEN, 60000);
      console.log('✅ Discord login initiated — waiting for ready event...');
    } catch (err) {
      console.error('❌ Discord websocket login failed:', err && err.message ? err.message : err);
      // If login fails due to networking, don't immediately exit so you can debug; exit on invalid token was handled earlier.
      process.exit(1);
    }
  })();
}
