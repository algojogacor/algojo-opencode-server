FROM node:22-slim

# Install git
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies + opencode
RUN npm install && npm install -g opencode-ai

# Copy server file
COPY opencode-server.js .

EXPOSE 3000

CMD ["node", "opencode-server.js"]
