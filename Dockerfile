FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8000 \
    GUNICORN_WORKERS=4

WORKDIR /app

COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend ./backend
COPY prototype ./prototype

EXPOSE 8000

CMD ["sh", "-c", "gunicorn -w ${GUNICORN_WORKERS:-4} -b 0.0.0.0:${PORT:-8000} backend.app:app"]