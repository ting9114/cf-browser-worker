FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# curl is needed for the HEALTHCHECK; the rest of Chromium's system
# libraries are installed by `playwright install --with-deps` below.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifest (and lockfile when present) first for better layer caching.
COPY package.json package-lock.json* ./

# Install npm deps without pulling Playwright's browsers yet.
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install

# Install Chromium + all required system libraries in one step.
# (--with-deps replaces the previous manual apt-get list.)
RUN npx playwright install --with-deps chromium

COPY src/ ./src/
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

EXPOSE 3002

ENV HEADED=false
ENV PORT=3002

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD curl -fsS "http://localhost:${PORT}/health" || exit 1

ENTRYPOINT ["./entrypoint.sh"]
