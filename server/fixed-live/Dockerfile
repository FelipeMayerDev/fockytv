# fixed-live: yt-dlp + ffmpeg + werift publicando as lives fixas no
# broadcast-box (WHIP). Deve construir depois de `npm install` local? Não —
# as deps são instaladas aqui dentro mesmo (werift é JS puro).
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp standalone (binário PyInstaller, sem Python na imagem): muda toda
# hora (YouTube quebra versões velhas) — sem tag
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
      -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY index.js ./

ENV PORT=3000 BB_URL=http://broadcast-box:8080
CMD ["node", "index.js"]
