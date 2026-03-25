# Build a small image with ping tools and FastAPI app
FROM python:3.12-slim

ARG APP_VERSION=0.0.0
LABEL version="${APP_VERSION}"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Install ping binary + curl for healthcheck
RUN apt-get update \
    && apt-get install -y --no-install-recommends iputils-ping traceroute curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copier VERSION (source unique de vérité)
COPY VERSION ./VERSION

COPY app ./app
COPY main.py ./

# Créer les répertoires de storage
RUN mkdir -p /app/storage /app/uploads

ENV APP_PORT=6666
EXPOSE 6666

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${APP_PORT:-6666}"]
