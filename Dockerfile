FROM node:18-slim

RUN apt-get update && apt-get install -y ghostscript poppler-utils && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 10000
CMD ["node", "server.js"]
