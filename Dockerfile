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
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl3 \
    zlib1g \
    && rm -rf /var/lib/apt/lists/*

# Blitz runs containers as UID 1000/GID 1000
RUN groupadd -g 1000 telegram \
    && useradd -u 1000 -g 1000 -m -s /bin/sh telegram

COPY --from=builder \
    /src/telegram-bot-api/build/telegram-bot-api \
    /usr/local/bin/telegram-bot-api

RUN mkdir -p /data /data/temp \
    && chown -R 1000:1000 /data

USER 1000:1000

WORKDIR /data

EXPOSE 8081

CMD ["telegram-bot-api", \
     "--local", \
     "--http-port=8081", \
     "--dir=/data", \
     "--temp-dir=/data/temp"]
