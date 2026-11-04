FROM node:20-slim

# yt-dlp handles supported video/audio sources; ffmpeg merges streams and
# converts audio to MP3. The standalone yt-dlp release requires Python 3.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates curl python3 ffmpeg \
    && curl -fL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
       -o /usr/local/bin/yt-dlp \
    && chmod 0755 /usr/local/bin/yt-dlp \
    && yt-dlp --version \
    && ffmpeg -version \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

RUN mkdir -p /app/session && chmod -R 777 /app/session

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "--max-old-space-size=400", "index.js"]
