FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js model-settings.js video-api.js cos-storage.js image-source.js video-download.js access-control.js README.md .env.example ./
COPY public ./public
ENV NODE_ENV=production
ENV AI_FLOW_PORT=4173
EXPOSE 4173
CMD ["node", "server.js"]
