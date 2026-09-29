/**
 * DEPENDENCIES
 * Consumed by: start.bat, scripts/docker-start.mjs
 * Consumes: @next/env (same loader the dashboard uses)
 * Risk-sensitive: NO — read-only startup warnings, never blocks startup
 * Notes: Catches a .env copied from .env.example. Its placeholder values cause
 *        "Unauthorised"/"Too many requests" (auth left on), encrypt saved
 *        Trading 212 keys with a publicly known secret, and lock the Telegram
 *        settings panel (environment values override the ones saved in the app).
 *        Usage: node scripts/check-env.mjs [--docker]
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const ENV_PLACEHOLDERS = new Set([
  'your-secret-key-change-in-production',
  'set-a-strong-random-secret',
  'your-telegram-bot-token',
  'your-chat-id',
]);

/** Returns plain-English problems; an empty list means the environment looks fine. */
export function findEnvProblems(env, { docker = false } = {}) {
  const problems = [];
  const isPlaceholder = key => ENV_PLACEHOLDERS.has(String(env[key] ?? '').trim());

  // Docker forces desktop mode in docker-compose.yml, so only check it natively.
  if (!docker && env.DISABLE_API_AUTH !== 'true') {
    problems.push('DISABLE_API_AUTH is not true, so the dashboard asks for a login. On a single-user PC, scans and settings saves then fail with "Unauthorised" or "Too many requests". Make the only DISABLE_API_AUTH line read DISABLE_API_AUTH=true (also check for .env.local or .env.production).');
  }
  const weakSecrets = ['NEXTAUTH_SECRET', 'ENCRYPTION_SECRET', 'CRON_SECRET', 'TELEGRAM_WEBHOOK_SECRET'].filter(isPlaceholder);
  if (weakSecrets.length > 0) {
    problems.push(`${weakSecrets.join(', ')} still use the example placeholder value. Saved Trading 212 keys are encrypted with ENCRYPTION_SECRET (or NEXTAUTH_SECRET), and the webhook secret guards inbound Telegram commands, so anyone who knows the example value could abuse them. Replace each with a long random value, then re-enter your Trading 212 keys in Settings.`);
  }
  if (isPlaceholder('TELEGRAM_BOT_TOKEN') || isPlaceholder('TELEGRAM_CHAT_ID')) {
    problems.push('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID still have example placeholder values. Telegram alerts will not send, and Settings > Notifications is locked ("Set via environment variable"). Delete those two lines from .env to set Telegram up in the app instead.');
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    createRequire(import.meta.url)('@next/env').loadEnvConfig(process.cwd(), false);
  } catch {
    process.exit(0); // Dependencies not installed yet: nothing reliable to check.
  }
  const problems = findEnvProblems(process.env, { docker: process.argv.includes('--docker') });
  if (problems.length > 0) {
    console.log('');
    console.log(' WARNING: your .env file needs attention:');
    for (const problem of problems) console.log(`   - ${problem}`);
    console.log('   After editing .env, close this window and start the dashboard again.');
    console.log('');
  }
  process.exit(0);
}
