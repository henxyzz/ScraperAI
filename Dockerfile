FROM node:20-alpine

WORKDIR /app

# Copy root package.json
COPY package.json ./

# Copy client
COPY client/package.json ./client/

# Install root dependencies
RUN npm install --production

# Install client dependencies and build
COPY client/ ./client/
RUN cd client && npm install && npm run build

# Copy server files
COPY server.js ./
COPY api/ ./api/
COPY .env.example ./.env.example

# Create data directory for persistence
RUN mkdir -p data

EXPOSE 8080

ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "server.js"]
