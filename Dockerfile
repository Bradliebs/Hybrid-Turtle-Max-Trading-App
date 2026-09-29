# DEPENDENCIES
# Consumed by: docker-compose.yml, docs/DEPLOYMENT.md
# Consumes: package.json, package-lock.json, Next.js app, Prisma schema
# Risk-sensitive: NO
# Last modified: 2026-09-26
# Notes: Builds the current stable SQLite-backed runtime for local/container deployment.
#        Startup is scripts/docker-start.mjs (migrate, first-run seed, serve on 0.0.0.0).

FROM node:22-bookworm AS deps
WORKDIR /app
ENV DATABASE_URL=file:./dev.db
COPY package.json package-lock.json prisma.config.ts ./
# npm ci runs the postinstall `prisma generate`, which needs the schema present.
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN npm ci

FROM node:22-bookworm AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Build-time placeholder only; the real value comes from docker-compose / .env at runtime.
ENV DATABASE_URL=file:./dev.db
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run db:generate
RUN npm run build

FROM node:22-bookworm AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
COPY --from=builder /app ./
EXPOSE 3000
# Migrates, seeds an empty stock universe on first run, then serves on 0.0.0.0.
CMD ["node", "scripts/docker-start.mjs"]