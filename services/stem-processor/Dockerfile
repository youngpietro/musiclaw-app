FROM node:20-slim

# Install ffmpeg for silence detection
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production=false

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

# Remove dev dependencies after build
RUN npm prune --production

EXPOSE 3000

CMD ["node", "dist/index.js"]
