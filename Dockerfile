
# Build Telegram Local Bot API
FROM debian:bookworm AS builder

RUN apt-get update && apt-get install -y \
    git cmake g++ make pkg-config \
    zlib1g-dev libssl-dev gperf \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

RUN git clone --recursive --depth 1 \
    https://github.com/tdlib/telegram-bot-api.git

WORKDIR /src/telegram-bot-api

RUN mkdir build \
    && cd build \
    && cmake -DCMAKE_BUILD_TYPE=Release .. \
    && cmake --build . --target telegram-bot-api -j2

# Final runtime
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y \
    ca-certificates \
    ffmpeg \
    python3 \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp in an isolated Python environment
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir yt-dlp

# Create non-root user
RUN groupadd -g 1000 app \
    && useradd -u 1000 -g 1000 -m -s /bin/sh app

COPY --from=builder \
    /src/telegram-bot-api/build/telegram-bot-api \
    /usr/local/bin/telegram-bot-api

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

RUN mkdir -p /data/temp /data/jobs \
    && chown -R 1000:1000 /app /data

ENV PATH="/opt/venv/bin:$PATH"
ENV PORT=8080

USER 1000:1000

EXPOSE 8080

CMD ["node", "server.js"]
