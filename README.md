# OnePieceBot

## Card Rank Stat Ranges

C ranks:
Power: 1 to 50
Attack range: 1 to 20
Health: 50 to 100

B ranks:
Power: 50 to 100
Attack range: 10 to 35
Health: 100 to 200

A Ranks:
Power: 100 to 250
Attack range: 20 to 50
Health: 150 to 250

S ranks:
Power: 200 to 400
Attack range: 30 to 70
Health: 200 to 400

SS ranks
Power: 300 to 500
Attack range: 50 to 120
Health 300 to 500

UR ranks
ALL of the above

(See attachments in the repo for file contents.)

## Deploy to Render (24/7) ✅



Note: If your host requires binding to a specific fixed port, you can set `DUMMY_PORT=3000` (default) and the app will attempt to start an additional dummy server on that port. The dummy server is optional and will not crash the app if the port is in use.
Local testing:

```bash
PORT=3000 node index.js
curl http://localhost:3000/health
```


## Bot Overview

- **Type:** English-language Discord game bot focused on collectible cards, pulls, duels, and player progression. Designed to run as either a full gateway bot (What I want) or an interactions-only webhook for hosts that block WebSocket egress.

- **Features:** Collectible card pulls, inventory and collection management, PvP duels, shop/purchases, daily rewards, quests and missions, crafting/upgrading, leaderboards and stats tracking.

- **Commands:** Slash commands and legacy message commands are implemented. See the `commands/` directory for a command-by-command implementation. Use the included `deploy-commands.js` script to register slash commands.

- **Permissions & Intents:** Requires basic bot scopes and these intents when using the gateway: `Guilds`, `GuildMessages`, `MessageContent`. For slash-commands-only mode, no Message Content intent is required; instead ensure `DISCORD_PUBLIC_KEY` and the `/interactions` endpoint are configured.

- **Database:** Uses MongoDB for persistent storage. The `models/` folder contains schema-like models (`Inventory`, `Balance`, `Pull`, `Quest`, etc.). Provide `MONGO_URI` as an environment variable. The DB stores user inventories, balances, pulls history, quests and other persistent game state.

- **Dashboard:** No built-in web dashboard in this repo. The codebase is structured so an external dashboard can interact with the bot via the database (read/write) or by calling custom APIs you add (or by sending Discord REST requests using the bot token).

- **APIs & Endpoints:** Exposes lightweight health endpoints: `GET /`, `GET /health`, `GET /_health`. If running in interactions/webhook mode, the app accepts `POST /interactions` for Discord interaction payloads. You can add custom HTTP routes in `server.js` or `index.js` as needed.

- **Scale & Architecture:** The application is mostly stateless outside of the MongoDB database. Horizontal scaling is supported for interactions and API endpoints. If you run the Discord gateway (WebSocket) you should be aware of session limits and identify whether you need a single gateway instance or sharding for larger guild counts. For web-only operation (interactions), the service is easy to scale behind a load balancer.

- **Logging & Monitoring:** The app logs to stdout/stderr for host collection. For production use, forward logs to an external log provider (Papertrail, Logflare, Datadog). Add process monitoring (PM2, Docker restart policies) and uptime checks (UptimeRobot) for extra reliability.

- **Secrets & Environment:** Keep secrets out of the repo. Required environment variables include `TOKEN`, `MONGO_URI`, , `CLIENT_ID`, and administrative IDs like `OWNER_ID`.

If you'd like, I can expand any of these sections into more detailed operational docs (example `docker-compose`, a monitoring guide, or a simple dashboard sketch).
If you'd like, I can add a `Procfile`, a `render.yaml` template, or step-by-step instructions for creating the Render service.

---

### Running as a Web Service (Render, Railway) without Gateway access 🚧

Some hosts block WebSocket egress from web service processes which prevents Discord gateway login. This repository now supports a fallback "interactions webhook" mode so the bot can handle slash commands via HTTP without maintaining a gateway connection.

Steps to use the fallback mode:

1. In the Discord Developer Portal, set your **Application's** Public Key into `DISCORD_PUBLIC_KEY` on your host's environment variables (hex encoded, as shown in the portal).
2. Ensure your service is reachable publicly and set the **Interactions** / Request URL for your application to `https://<your-service>/interactions` in the Discord Developer Portal.
3. Keep `TOKEN` set (required for command registration). Prefer registering slash commands manually using `npm run deploy` once instead of auto-registering every deploy to avoid rate limits.
4. If gateway login fails due to egress restrictions, the service will still accept `/interactions` POSTs and run the associated command handlers.

### Running in interactions-only mode (web-only)

If your host blocks WebSocket egress or you prefer to run the bot as a pure web service, set `DISABLE_GATEWAY=true` or `INTERACTIONS_ONLY=true` in your environment. This will skip the Discord gateway login and run the interactions webhook handler only.

- Ensure `DISCORD_PUBLIC_KEY` is set and your application interactions endpoint is configured to `https://<your-service>/interactions`.
- Register slash commands (use guild-scoped for fast testing): `GUILD_ID=<your_guild> npm run deploy` or run `node deploy-commands.js` locally.
- Use `/status` to verify `gateway_mode: "disabled"` when the gateway is intentionally disabled.

Notes:
- Message-based prefix commands ("op help") still require a gateway connection (Message Content intent) and will not work in webhook-only mode. Move to slash commands for full web-only compatibility.
- Keep your public key secret only in environment variables; do not commit it.

### Optional: Auto-register slash commands on start

If you'd like the app to automatically attempt to register slash commands at startup, set the environment variable `REGISTER_COMMANDS_ON_START=true` on Render. This will run `deploy-commands.js` once at startup. Be careful — registering often can hit rate limits (429). Recommended: run the registration manually when you add/modify commands (run `npm run deploy`), or set `REGISTER_COMMANDS_ON_START=true` only when you intentionally want to register commands.

Note: If you receive 429 responses while registering commands, wait the reported Retry-After interval before trying again. The code now includes retry/backoff logic but it's best not to repeatedly register on every deploy.

---

## Security notice ⚠️

I noticed a `.env` file with secrets in the repository. **If a bot token or other secret has been committed, rotate it immediately** from the Discord Developer Portal and any other provider (MongoDB, etc.). To remove the file from the repo and prevent future leaks:

```bash
git rm --cached .env
git commit -m "remove .env containing secrets"
git push
```

The project already contains `.gitignore` with `.env`, but removing the committed file and rotating secrets is required to secure the bot.
