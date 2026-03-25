# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build args from docker-compose
ARG VITE_API_PORT=6666
ARG VITE_HUB_API_PORT=8000
ARG VITE_HUB_FRONTEND_PORT=80
ARG VITE_APP_SLUG=pmd

ENV VITE_API_PORT=$VITE_API_PORT
ENV VITE_HUB_API_PORT=$VITE_HUB_API_PORT
ENV VITE_HUB_FRONTEND_PORT=$VITE_HUB_FRONTEND_PORT
ENV VITE_APP_SLUG=$VITE_APP_SLUG

# Build the app
RUN npm run build

# Production stage
FROM nginx:alpine

# Copy built files from builder
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy custom nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
