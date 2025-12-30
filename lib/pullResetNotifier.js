import ResetSetting from "../models/ResetSetting.js";

const WINDOW_MS = 8 * 60 * 60 * 1000; // 8 hours
const timers = new Map(); // guildId -> { timeout, interval }

function nextWindowTimeoutMs(from = Date.now()) {
  const next = (Math.floor(from / WINDOW_MS) + 1) * WINDOW_MS;
  return Math.max(0, next - from);
}

async function sendResetNotification(client, setting) {
  try {
    const ch = await client.channels.fetch(setting.channelId).catch(() => null);
    if (!ch || !ch.send) return;
    const content = "<@&1389619213492158464> Pulls have been reset! you can start pulling in command channels.";
    await ch.send({ content }).catch(() => {});
  } catch (e) {
    console.error('pullResetNotifier send error:', e && e.message ? e.message : e);
  }
}

async function scheduleSetting(client, s) {
  const guildId = s.guildId;
  // clear existing timers
  if (timers.has(guildId)) {
    const t = timers.get(guildId);
    if (t.timeout) clearTimeout(t.timeout);
    if (t.interval) clearInterval(t.interval);
    timers.delete(guildId);
  }
  if (!s || !s.enabled) return;
  const msToNext = nextWindowTimeoutMs();
  // set timeout to sync with global window boundary
  const timeout = setTimeout(async () => {
    // send first notification at window boundary
    await sendResetNotification(client, s);
    // then set interval every WINDOW_MS
    const interval = setInterval(() => {
      sendResetNotification(client, s).catch(() => {});
    }, WINDOW_MS);
    timers.set(guildId, { timeout: null, interval });
  }, msToNext);
  timers.set(guildId, { timeout, interval: null });
}

export async function init(client) {
  try {
    const settings = await ResetSetting.find({ enabled: true });
    for (const s of settings) {
      await scheduleSetting(client, s);
    }
  } catch (e) {
    console.error('pullResetNotifier init error:', e && e.message ? e.message : e);
  }
}

export async function setResetChannel(client, guildId, channelId) {
  try {
    const s = await ResetSetting.findOneAndUpdate({ guildId }, { guildId, channelId, enabled: true }, { upsert: true, new: true });
    await scheduleSetting(client, s);
    return s;
  } catch (e) {
    console.error('pullResetNotifier setResetChannel error:', e && e.message ? e.message : e);
    throw e;
  }
}

export async function clearResetChannel(client, guildId) {
  try {
    await ResetSetting.deleteOne({ guildId });
    const t = timers.get(guildId);
    if (t) {
      if (t.timeout) clearTimeout(t.timeout);
      if (t.interval) clearInterval(t.interval);
      timers.delete(guildId);
    }
    return true;
  } catch (e) {
    console.error('pullResetNotifier clearResetChannel error:', e && e.message ? e.message : e);
    return false;
  }
}

export default { init, setResetChannel, clearResetChannel };
