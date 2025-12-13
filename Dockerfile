# Build a small image with ping tools and FastAPI app
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Install ping binary
RUN apt-get update \
    && apt-get install -y --no-install-recommends iputils-ping traceroute \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY main.py ./

ENV APP_PORT=6666
EXPOSE 6666

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${APP_PORT:-6666}"]
