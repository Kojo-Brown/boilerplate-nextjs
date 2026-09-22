FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat openssl
RUN corepack enable pnpm

# ── deps: install all dependencies ──────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY package.json ./
RUN pnpm install

# ── builder: generate Prisma client and build Next.js ───────────────────────
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN pnpm prisma generate

# Ensure public dir exists for standalone COPY even if empty in source
RUN mkdir -p public

ENV NEXT_TELEMETRY_DISABLED=1
ENV SKIP_ENV_VALIDATION=1
ENV NODE_ENV=production

RUN pnpm build

# ── runner: minimal production image ────────────────────────────────────────
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
RUN mkdir .next && chown nextjs:nodejs .next

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# The Content Security Policy's hashes of the prerendered documents' inline
# scripts, written by `pnpm build`. Copied explicitly because `output:
# "standalone"` only carries the files Next's own trace knows about, and this one
# is read at request time by src/proxy.ts. Without it the proxy finds no manifest,
# logs that it has not, and degrades the policy to report-only — the application
# still serves, with no enforcement, which is exactly the state this line exists
# to prevent. See docs/csp.md.
COPY --from=builder --chown=nextjs:nodejs /app/.next/csp-shell-hashes.json ./.next/csp-shell-hashes.json

# Prisma schema needed at runtime for migrations
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
