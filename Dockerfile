# # =========================
# # BUILD STAGE
# # =========================
# FROM node:22-bullseye-slim AS builder

# WORKDIR /app

# RUN corepack enable && corepack prepare pnpm@10.5.2 --activate

# COPY package.json pnpm-lock.yaml ./

# RUN pnpm install --frozen-lockfile

# COPY . .

# RUN pnpm build


# # =========================
# # PRODUCTION
# # =========================
# FROM node:22-bullseye-slim AS runner

# WORKDIR /app

# ENV NODE_ENV=production

# RUN corepack enable && corepack prepare pnpm@10.5.2 --activate

# COPY package.json pnpm-lock.yaml ./

# RUN pnpm install --prod --frozen-lockfile

# COPY --from=builder /app/dist ./dist
# COPY .env .env

# EXPOSE 3000

# CMD ["node", "dist/index.js"]






# # # Start from official Node.js LTS image
# # FROM node:20-bullseye-slim

# # # Install small set of system deps needed by native modules and curl for healthcheck
# # RUN apt-get update \
# #   && apt-get install -y --no-install-recommends build-essential ca-certificates curl git \
# #   && rm -rf /var/lib/apt/lists/*

# # # Create app directory
# # WORKDIR /usr/src/app

# # # Copy package manifest and pnpm lock to leverage Docker layer cache
# # COPY package.json pnpm-lock.yaml ./


# # RUN corepack enable \
# #   && corepack prepare pnpm@9.15.4 --activate \
# #   && pnpm install --frozen-lockfile

# # # Copy application source
# # COPY . .

# # # Create a non-root user and take ownership of app files
# # RUN groupadd -r appuser && useradd -r -g appuser -m appuser \
# #   && chown -R appuser:appuser /usr/src/app

# # USER appuser

# # # Environment
# # ENV NODE_ENV=production
# # ENV PORT=3000

# # EXPOSE 3000

# # # Start the app using the project's start script
# # CMD ["sh", "-c", "pnpm start"]





FROM node:22-bullseye-slim

# Install PostgreSQL + tools
RUN apt-get update && apt-get install -y \
    postgresql postgresql-contrib \
    build-essential git curl \
    postgresql-server-dev-all \
    && rm -rf /var/lib/apt/lists/*

# Install pgvector
RUN git clone https://github.com/pgvector/pgvector.git /tmp/pgvector && \
    cd /tmp/pgvector && \
    make && make install && \
    rm -rf /tmp/pgvector

# Setup Postgres user + data dir
RUN mkdir -p /var/lib/postgresql/data && \
    chown -R postgres:postgres /var/lib/postgresql

# Set working directory
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.5.2 --activate

# Copy app files
COPY package.json pnpm-lock.yaml ./
RUN pnpm install

COPY . .

RUN pnpm build

# Copy init script
COPY init.sql /docker-entrypoint-initdb.d/init.sql

# Expose app port
EXPOSE 3000

# Start BOTH Postgres + Node
CMD service postgresql start && \
    su postgres -c "psql -c 'CREATE EXTENSION IF NOT EXISTS vector;'" || true && \
    pnpm start
