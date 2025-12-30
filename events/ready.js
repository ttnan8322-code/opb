export const name = "clientReady";
export const once = true;

export async function execute(client) {
  console.log(`✅ Logged in as ${client.user.tag}`);
  globalThis.GATEWAY_MODE = 'connected';

  try {
    const { init } = await import('../lib/drops.js');
    await init(client);
    console.log('✅ Drop manager initialized');
  } catch (e) {
    console.error('Error initializing drop manager:', e && e.message ? e.message : e);
  }

  try {
    const { init: initReset } = await import('../lib/pullResetNotifier.js');
    await initReset(client);
    console.log('✅ Pull-reset notifier initialized');
  } catch (e) {
    console.error('Error initializing pull-reset notifier:', e && e.message ? e.message : e);
  }
}
