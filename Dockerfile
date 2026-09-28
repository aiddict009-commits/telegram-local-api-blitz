
# Build Telegram Local Bot API
FROM debian:bookworm AS builder

RUN apt-get update && apt-get install -y \
    git \
    cmake \
    g++ \
    make \
    pkg-config \
    zlib1g-dev \
    libssl-dev \
    gperf \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

RUN git clone --recursive --depth 1 \
    https://github.com/tdlib/telegram-bot-api.git

WORKDIR /src/telegram-bot-api

RUN mkdir build \
    && cd build \
    && cmake -DCMAKE_BUILD_TYPE=Release .. \
    && cmake --build . --target telegram-bot-api -j2

# Runtime image
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y \
    ca-certificates \
    ffmpeg \
    python3 \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp in a virtual environment
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir yt-dlp

# Copy Telegram Local Bot API
COPY --from=builder \
    /src/telegram-bot-api/build/telegram-bot-api \
    /usr/local/bin/telegram-bot-api

WORKDIR /app

COPY package.json ./
COPY server.js ./

# Prepare temporary storage and permissions
RUN mkdir -p /data/temp /data/jobs \
    && chown -R node:node /app /data

ENV PATH="/opt/venv/bin:$PATH"
ENV PORT=8080

USER node:node

EXPOSE 8080

CMD ["node", "server.js"]
