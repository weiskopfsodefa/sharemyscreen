FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js media-config.js ./
COPY public ./public
EXPOSE 3000
CMD ["node", "server.js"]
