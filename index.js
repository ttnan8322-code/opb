import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import nacl from 'tweetnacl';
import { Client, GatewayIntentBits } from 'discord.js';

// Minimal index.js: one Discord client, single Express health server.

const PORT = Number(process.env.PORT || 3000);

const DISABLE_GATEWAY = !!(process.env.DISABLE_GATEWAY || process.env.INTERACTIONS_ONLY);

let client;
if (!DISABLE_GATEWAY) {
  client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

  client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
  });

  client.on('error', (err) => console.error('Client error:', err));

  if (!process.env.TOKEN) {
    console.error('TOKEN is missing in environment');
    process.exit(1);
  }

  // Call login exactly once.
  client.login(process.env.TOKEN).catch(err => {
    console.error('Failed to login:', err);
    process.exit(1);
  });
} else {
  console.log('DISABLE_GATEWAY is set — running in interactions-only (webhook) mode');
}

// Simple Express health server so Render sees an open HTTP port.
const app = express();

// Need raw body for Discord signature verification
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

app.get(['/', '/health', '/_health'], (req, res) => res.status(200).send('OK'));

// Load slash commands into a map for webhook dispatching
const commands = new Map();
try {
  const cmdDir = path.resolve('./commands');
  if (fs.existsSync(cmdDir)) {
    const files = fs.readdirSync(cmdDir).filter(f => f.endsWith('.js'));
    for (const file of files) {
      try {
        const mod = await import(`./commands/${file}`);
        if (mod && mod.data && typeof mod.execute === 'function') {
          // data may be a SlashCommandBuilder
          const name = (mod.data && mod.data.name) || (mod.data && typeof mod.data.getName === 'function' && mod.data.getName()) || (mod.data && mod.data.toJSON && mod.data.toJSON().name);
          if (name) commands.set(name, mod);
        }
      } catch (e) {
        console.error('Failed loading command', file, e && e.message ? e.message : e);
      }
    }
    console.log(`Loaded ${commands.size} commands for webhook handling`);
  }
} catch (e) {
  console.error('Error loading commands for interactions webhook:', e && e.message ? e.message : e);
}

// Helper: verify Discord interaction signature
function verifyDiscordRequest(req) {
  const signature = req.get('x-signature-ed25519');
  const timestamp = req.get('x-signature-timestamp');
  if (!signature || !timestamp || !req.rawBody) return false;
  try {
    const publicKey = process.env.DISCORD_PUBLIC_KEY || '';
    if (!publicKey) {
      console.warn('DISCORD_PUBLIC_KEY not set; cannot verify interaction signature');
      return false;
    }
    const msg = Buffer.concat([Buffer.from(timestamp, 'utf8'), Buffer.from(req.rawBody)]);
    const sig = Buffer.from(signature, 'hex');
    const pubKey = Buffer.from(publicKey, 'hex');
    return nacl.sign.detached.verify(new Uint8Array(msg), new Uint8Array(sig), new Uint8Array(pubKey));
  } catch (e) {
    console.error('Signature verification error:', e && e.message ? e.message : e);
    return false;
  }
}

// Helper: send interaction response to Discord (callback)
async function sendInteractionResponse(id, token, body) {
  const url = `https://discord.com/api/v10/interactions/${id}/${token}/callback`;
  // Normalize embeds and components if they are builder instances
  if (body && body.embeds) body.embeds = body.embeds.map(e => (e && typeof e.toJSON === 'function') ? e.toJSON() : e);
  if (body && body.components) body.components = body.components.map(c => (c && typeof c.toJSON === 'function') ? c.toJSON() : c);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 4, data: body })
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error('Failed to send interaction response', res.status, txt);
    }
  } catch (e) {
    console.error('Error sending interaction response:', e && e.message ? e.message : e);
  }
}

app.post('/interactions', async (req, res) => {
  // Verify signature
  if (!verifyDiscordRequest(req)) {
    return res.status(401).send('invalid request signature');
  }

  const payload = req.body;
  // PING
  if (payload.type === 1) return res.json({ type: 1 });

  // APPLICATION_COMMAND
  if (payload.type === 2) {
    const name = payload.data && payload.data.name;
    const cmd = commands.get(name);
    if (!cmd) {
      // reply with ephemeral message
      await sendInteractionResponse(payload.id, payload.token, { content: `Command not found: ${name}`, flags: 64 });
      return res.status(200).end();
    }

    // Build a minimal interaction-like object with reply helpers that call Discord callback
    const interaction = {
      id: payload.id,
      token: payload.token,
      user: (payload.member && payload.member.user) || payload.user || { id: payload.member?.user?.id || 'unknown', username: 'unknown', displayAvatarURL: () => '' },
      channel: {},
      isChatInputCommand: () => true,
      isCommand: () => true,
      commandName: name,
      options: payload.data.options || [],
      reply: async (body) => await sendInteractionResponse(payload.id, payload.token, body),
      deferReply: async () => {
        // DEFERRED CHANNEL MESSAGE WITH SOURCE
        const url = `https://discord.com/api/v10/interactions/${payload.id}/${payload.token}/callback`;
        await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 5 }) });
      }
    };

    try {
      // call command's execute; allow it to call interaction.reply which will POST to Discord
      await cmd.execute(interaction, client);
    } catch (e) {
      console.error('Command execution error:', e && e.message ? e.message : e);
      await sendInteractionResponse(payload.id, payload.token, { content: 'Internal error running command', flags: 64 });
    }
    return res.status(200).end();
  }

  // unsupported interaction type
  return res.status(400).send('unsupported interaction type');
});

app.listen(PORT, () => {
  console.log(`Health server and interactions webhook listening on port ${PORT}`);
});
