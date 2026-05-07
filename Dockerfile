FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package.json
RUN npm install --omit=dev

COPY public public
COPY src src

ENV HOST=0.0.0.0
ENV PORT=4173
EXPOSE 4173

CMD ["npm", "start"]
