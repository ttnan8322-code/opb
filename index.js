// index.js now acts as a lightweight shim. Primary code is split into `bot.js` and `server.js`.
console.log('index.js shim — load bot.js to run the Discord bot.');
import './bot.js';
console.log("🔥 INDEX.JS VERSION: CLEAN_LOGIN_V1");

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

// Start a single HTTP server for health checks and interaction endpoints
// Render and uptime monitors can check /health even if Discord login hangs
import http from "http";

const PORT = Number(process.env.PORT || 3000);

async function startHealthServer(startPort) {
  const maxAttempts = 10;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const tryPort = startPort + attempt;
    const serverInstance = http.createServer((req, res) => {
      if (req.method === "GET" && (req.url === "/" || req.url === "/health" || req.url === "/_health")) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end("OK");
      }

      if (req.method === "GET" && req.url === "/status") {
        const payload = {
          status: "ok",
          port: tryPort,
          discord: client.user ? `${client.user.tag}` : null,
          discord_logged_in: !!client.user,
          gateway_mode: globalThis.GATEWAY_MODE || (client.user ? 'connected' : 'disconnected'),
          discord_uptime_ms: client.uptime || null,
          uptimeSeconds: Math.floor(process.uptime()),
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(payload));
      }

      // Interactions endpoint: used when running as a web service without a gateway connection
      if (req.method === "POST" && req.url === "/interactions") {
        // Read raw body
        let body = "";
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            // signature verification requires DISCORD_PUBLIC_KEY
            const sig = req.headers['x-signature-ed25519'];
            const ts = req.headers['x-signature-timestamp'];
            if (!sig || !ts || !process.env.DISCORD_PUBLIC_KEY) {
              console.warn('Interaction received but verification could not be performed (missing headers or DISCORD_PUBLIC_KEY).');
              res.writeHead(401);
              return res.end('invalid request');
            }

            const verifyResult = await (async () => {
              try {
                const nacl = await import('tweetnacl');
                const msg = Buffer.concat([Buffer.from(ts, 'utf8'), Buffer.from(body, 'utf8')]);
                const sigBuf = Buffer.from(sig, 'hex');
                const pubKey = Buffer.from(process.env.DISCORD_PUBLIC_KEY, 'hex');
                return nacl.sign.detached.verify(msg, sigBuf, pubKey);
              } catch (e) {
                console.error('Error during signature verification:', e && e.message ? e.message : e);
                return false;
              }
            })();

            if (!verifyResult) {
              console.warn('⚠️ Interaction signature verification failed.');
              res.writeHead(401);
              return res.end('invalid signature');
            }

            const payload = JSON.parse(body);
            // PING
            if (payload.type === 1) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ type: 1 }));
            }

            // Only handle APPLICATION_COMMAND (2)
            if (payload.type === 2 && payload.data && payload.data.name) {
              const name = payload.data.name.toLowerCase();
              const cmd = client.commands.get(name);
              if (!cmd) {
                console.warn('Received interaction for unknown command:', name);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ type: 4, data: { content: 'Command not found', flags: 64 } }));
              }

              // Build a minimal Interaction-like object compatible with our command handlers
              const interaction = {
                id: payload.id,
                token: payload.token,
                user: payload.member?.user || payload.user,
                isCommand: () => true,
                isChatInputCommand: () => true,
                options: {
                  getString: (n) => {
                    const opt = (payload.data.options || []).find(o => o.name === n);
                    return opt ? opt.value : null;
                  },
                  getInteger: (n) => {
                    const opt = (payload.data.options || []).find(o => o.name === n);
                    return opt ? parseInt(opt.value, 10) : null;
                  },
                  // add other getters as needed
                },
                reply: async (resp) => {
                  // Convert discord.js-style reply into raw interaction response
                  const data = {};
                  if (typeof resp === 'string') data.content = resp;
                  else if (resp && resp.content) data.content = resp.content;
                  else if (resp && resp.embeds) data.embeds = resp.embeds;
                  if (resp && resp.flags) data.flags = resp.flags;

                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  return res.end(JSON.stringify({ type: 4, data }));
                }
              };

              try {
                // execute command; commands may call interaction.reply which we handle above
                await cmd.execute(interaction, client);
                // If the command didn't call reply directly, send a default ack
                // (some commands might already have replied) — send nothing here to avoid double response.
              } catch (e) {
                console.error('Error executing command for interaction:', e && e.message ? e.message : e);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ type: 4, data: { content: 'Internal error', flags: 64 } }));
              }

              return;
            }

            // Other interaction types: just acknowledge
            res.writeHead(200);
            res.end();
          } catch (err) {
            console.error('Error handling interaction:', err && err.message ? err.message : err);
            res.writeHead(500);
            res.end('server error');
          }
        });

        return;
      }

      res.writeHead(404);
      res.end();
    });

    // attempt to listen
    try {
      await new Promise((resolve, reject) => {
        serverInstance.once('error', (err) => reject(err));
        serverInstance.listen(tryPort, () => resolve(tryPort));
      });
      console.log(`Health server listening on port ${tryPort}`);
      return tryPort;
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') {
        console.warn(`Port ${tryPort} is in use; trying next port...`);
        // continue loop to try next port
        continue;
      }
      // unknown error - rethrow
      throw err;
    }
  }
  throw new Error(`Unable to bind health server after ${maxAttempts} attempts starting at port ${startPort}`);
}

// Start the single HTTP server
(async () => {
  try {
    const boundPort = await startHealthServer(PORT);
    globalThis.HEALTH_SERVER_PORT = boundPort;
  } catch (err) {
    console.error('Failed to start health server:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();

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
