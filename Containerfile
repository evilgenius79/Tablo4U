# --- STAGE 1: Builder ---
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files to leverage layer caching
COPY package.json package-lock.json* ./
RUN npm ci

# --- STAGE 2: Runtime ---
FROM node:20-slim

ENV NODE_ENV=production

# Install runtime system dependencies (ffmpeg) and clean up cache in one layer
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user and initialize required working directories
RUN groupadd -r appuser && useradd -r -g appuser appuser && \
    mkdir -p /app/data /app/recordings && \
    chown -R appuser:appuser /app

WORKDIR /app

# Copy built dependencies and source code with proper ownership
COPY --from=builder /app/node_modules ./node_modules
COPY --chown=appuser:appuser . .

# Ensure persistent and mount folders are owned by appuser
RUN chown -R appuser:appuser /app/data /app/recordings

# Switch to non-root user for security
USER appuser

EXPOSE 3400

CMD ["npm", "start"]