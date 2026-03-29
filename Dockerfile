# BH API Backend — Full espeak-ng + Claude API proxy
# Runs on Google Cloud Run (free tier)

FROM node:20-slim

# Install full espeak-ng with ALL language data
RUN apt-get update && \
    apt-get install -y --no-install-recommends espeak-ng && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Verify espeak-ng installation
RUN espeak-ng --version && \
    echo "Testing English:" && espeak-ng -q --ipa "hello" && \
    echo "Testing Arabic:" && espeak-ng -q --ipa -v ar "مرحبا" && \
    echo "Testing Hindi:" && espeak-ng -q --ipa -v hi "नमस्ते" && \
    echo "Testing Korean:" && espeak-ng -q --ipa -v ko "안녕하세요"

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./

# Cloud Run uses PORT env var
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
