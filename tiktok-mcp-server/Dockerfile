FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_ENV=production DATA_FILE=/data/store.json
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "src/server.js"]
