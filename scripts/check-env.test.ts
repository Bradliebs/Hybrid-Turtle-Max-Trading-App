import { describe, expect, it } from 'vitest';
import { findEnvProblems } from './check-env.mjs';

const good = {
  DISABLE_API_AUTH: 'true', NEXTAUTH_SECRET: 'Zr8k2Lq9xQ7mN4pV1sT6wY3bC5dF0gH2', ENCRYPTION_SECRET: 'Zr8k2Lq9xQ7mN4pV1sT6wY3bC5dF0gH2',
  CRON_SECRET: 'a8F2kL9pQ3xZ7mN1', TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined,
};

describe('startup .env checks', () => {
  it('reports nothing for an installer-generated .env', () => {
    expect(findEnvProblems(good)).toEqual([]);
  });
  it('flags every problem in a .env copied from .env.example', () => {
    const copied = {
      DISABLE_API_AUTH: 'false', NEXTAUTH_SECRET: 'your-secret-key-change-in-production',
      ENCRYPTION_SECRET: 'your-secret-key-change-in-production', CRON_SECRET: 'set-a-strong-random-secret',
      TELEGRAM_BOT_TOKEN: 'your-telegram-bot-token', TELEGRAM_CHAT_ID: 'your-chat-id', TELEGRAM_WEBHOOK_SECRET: 'set-a-strong-random-secret',
    };
    const problems: string[] = findEnvProblems(copied);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain('DISABLE_API_AUTH');
    expect(problems[1]).toContain('NEXTAUTH_SECRET, ENCRYPTION_SECRET, CRON_SECRET, TELEGRAM_WEBHOOK_SECRET');
    expect(problems[2]).toContain('Telegram');
  });
  it('skips the login check in Docker, where compose forces desktop mode', () => {
    expect(findEnvProblems({ ...good, DISABLE_API_AUTH: 'false' }, { docker: true })).toEqual([]);
  });
  it('does not flag real Telegram values', () => {
    expect(findEnvProblems({ ...good, TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '42' })).toEqual([]);
  });
});
