# =========================
# BUILD STAGE
# =========================
FROM node:22-bullseye-slim AS builder

WORKDIR /app

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@10.5.2 --activate

# Copy dependency files first (better Docker cache)
COPY package.json pnpm-lock.yaml ./

# Install all deps (including dev deps for TypeScript build)
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Build TypeScript
RUN pnpm build


# =========================
# PRODUCTION STAGE
# =========================
FROM node:22-bullseye-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@10.5.2 --activate

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install ONLY production dependencies
RUN pnpm install --prod --frozen-lockfile

# Copy built app only
COPY --from=builder /app/dist ./dist

# Optional:
# COPY --from=builder /app/uploads ./uploads
# COPY --from=builder /app/workspace ./workspace

EXPOSE 3000

CMD ["node", "dist/index.js"]


# # Start from official Node.js LTS image
# FROM node:20-bullseye-slim

# # Install small set of system deps needed by native modules and curl for healthcheck
# RUN apt-get update \
#   && apt-get install -y --no-install-recommends build-essential ca-certificates curl git \
#   && rm -rf /var/lib/apt/lists/*

# # Create app directory
# WORKDIR /usr/src/app

# # Copy package manifest and pnpm lock to leverage Docker layer cache
# COPY package.json pnpm-lock.yaml ./


# RUN corepack enable \
#   && corepack prepare pnpm@9.15.4 --activate \
#   && pnpm install --frozen-lockfile

# # Copy application source
# COPY . .

# # Create a non-root user and take ownership of app files
# RUN groupadd -r appuser && useradd -r -g appuser -m appuser \
#   && chown -R appuser:appuser /usr/src/app

# USER appuser

# # Environment
# ENV NODE_ENV=production
# ENV PORT=3000

# EXPOSE 3000

# # Start the app using the project's start script
# CMD ["sh", "-c", "pnpm start"]
