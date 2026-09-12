# BCI's own standalone admin UI (Dashboard/Assets/Scopes/Scans/Findings/
# Reports/Engines/Quantum & PQC) -- a separate SPA from BQI's client,
# talking to bci-api directly (never through BQI's server). Built
# with VITE_BCI_API_URL baked in at build time (Vite env vars are inlined
# into the bundle, not readable at runtime), then served as static files.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_BCI_API_URL
ENV VITE_BCI_API_URL=$VITE_BCI_API_URL
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
# SPA fallback: react-router-dom uses history-mode routing, so a direct
# load/refresh of e.g. /assets must still serve index.html, not a 404.
RUN printf 'server {\n  listen 8080;\n  root /usr/share/nginx/html;\n  location / {\n    try_files $uri $uri/ /index.html;\n  }\n}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 8080
