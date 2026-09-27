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


FROM debian:bookworm

RUN apt-get update && apt-get install -y \
    ca-certificates \
    nodejs \
    npm \
    ffmpeg \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install \
    --break-system-packages \
    yt-dlp

RUN groupadd -g 1000 telegram \
    && useradd -u 1000 -g 1000 -m -s /bin/sh telegram

COPY --from=builder \
    /src/telegram-bot-api/build/telegram-bot-api \
    /usr/local/bin/telegram-bot-api

WORKDIR /app

COPY blitz-cdn-proxy.js /app/blitz-cdn-proxy.js
COPY server.js /app/server.js
COPY start.sh /app/start.sh

RUN chmod +x /app/start.sh

RUN mkdir -p /data/temp \
    && chown -R 1000:1000 /data /app

USER 1000:1000

EXPOSE 8080

CMD ["/app/start.sh"]
