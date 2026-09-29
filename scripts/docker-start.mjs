/**
 * DEPENDENCIES
 * Consumed by: Dockerfile (CMD)
 * Consumes: scripts/auto-migrate.mjs, prisma/seed.ts (via `prisma db seed`), next
 * Risk-sensitive: NO — container startup only; no trading logic
 * Notes: Docker equivalent of install.bat + start.bat for the app container.
 *        1. Applies migrations (same as the desktop launcher).
 *        2. Seeds the stock universe only when the Stock table is empty, so a
 *           fresh volume can scan, and user edits to an existing universe are
 *           never overwritten on restart.
 *        3. Serves on 0.0.0.0 inside the container. Docker cannot forward to a
 *           127.0.0.1-bound process; docker-compose.yml publishes the port on
 *           the host's 127.0.0.1 only, which keeps desktop mode loopback-only.
 */
import { execSync, spawn } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { findEnvProblems } from './check-env.mjs';

for (const problem of findEnvProblems(process.env, { docker: true })) console.warn(`[docker] WARNING: ${problem}`);

execSync('npm run db:auto-migrate', { stdio: 'inherit' });

let stockCount = -1;
const prisma = new PrismaClient();
try {
  stockCount = await prisma.stock.count();
} catch (error) {
  console.warn(`[docker] Could not count stocks; skipping first-run seed: ${error.message}`);
} finally {
  await prisma.$disconnect();
}

if (stockCount === 0) {
  console.log('[docker] Stock universe is empty — seeding tickers (first run only)...');
  try {
    execSync('npx prisma db seed', { stdio: 'inherit' });
  } catch {
    console.warn('[docker] Seed failed (non-fatal). Retry with: docker compose exec app npx prisma db seed');
  }
}

const port = process.env.PORT || '3000';
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '0.0.0.0', '-p', port], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.kill(signal));
server.on('exit', code => process.exit(code ?? 0));
