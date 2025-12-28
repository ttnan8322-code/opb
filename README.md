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

- Create a **Web Service** on Render and connect your GitHub repository.
- In Render, set the environment variables: `TOKEN`, `MONGO_URI`, `CLIENT_ID`, `OWNER_ID`, etc. **Do not** commit your `.env` to the repo.
- Render runs the service and provides a public URL. The bot listens on `process.env.PORT` so Render's port routing works automatically.
- The app exposes a lightweight health endpoint: `GET /`, `GET /health` and `GET /_health` which return HTTP 200 `OK`.
- Use UptimeRobot to ping your Render service URL (e.g., `https://your-service.onrender.com/health`) every 5 minutes to keep it continuously running.

Local testing:

```bash
PORT=3000 node index.js
curl http://localhost:3000/health
```

---

If you'd like, I can add a `Procfile`, a `render.yaml` template, or step-by-step instructions for creating the Render service.

### Optional: Auto-register slash commands on start

If you'd like the app to automatically attempt to register slash commands at startup, set the environment variable `REGISTER_COMMANDS_ON_START=true` on Render. This will run `deploy-commands.js` once at startup. Be careful — registering often can hit rate limits (429). Recommended: Run this manually when you add/modify commands, or use the `register` npm script.

---

## Security notice ⚠️

I noticed a `.env` file with secrets in the repository. **If a bot token or other secret has been committed, rotate it immediately** from the Discord Developer Portal and any other provider (MongoDB, etc.). To remove the file from the repo and prevent future leaks:

```bash
git rm --cached .env
git commit -m "remove .env containing secrets"
git push
```

The project already contains `.gitignore` with `.env`, but removing the committed file and rotating secrets is required to secure the bot.
