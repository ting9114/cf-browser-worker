FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# System dependencies for Chrome + Xvfb
RUN apt-get update && apt-get install -y \
    wget curl gnupg unzip \
    fonts-liberation libasound2 libatk-bridge2.0-0 libatspi2.0-0 \
    libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 libgbm1 libgcc-s1 \
    libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
    libpangocairo-1.0-0 libstdc++6 libx11-6 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libxss1 libxtst6 xdg-utils \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .

# Install npm dependencies (skip browser download during npm install)
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install

# Now download Playwright's Chromium (env var NOT persisted, so install works)
RUN npx playwright install --with-deps chromium

COPY src/ ./src/
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

EXPOSE 3001

ENV HEADED=false
ENV PORT=3001

ENTRYPOINT ["./entrypoint.sh"]
