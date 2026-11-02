FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV FFMPEG_BIN=/usr/bin/ffmpeg
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js state-store.js model-settings.js video-api.js cos-storage.js image-source.js image-originals.js video-download.js access-control.js media-retention.js media-previews.js README.md .env.example ./
COPY public ./public
ENV NODE_ENV=production
ENV AI_FLOW_PORT=4173
EXPOSE 4173
CMD ["node", "server.js"]
