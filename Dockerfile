# Cloud Run image for the Issues Study Lab Flask broker.
FROM python:3.12-slim

# System deps -- pyMuPDF needs build basics on slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first for layer caching
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt gunicorn

# Copy what the runtime needs. readings/ is included so Cloud Run can
# serve /readings/<filename>; Netlify proxies that path through to here.
COPY server.py /app/
COPY cache_handles.json /app/
COPY pack_metadata.json /app/
COPY lab_corpus.json /app/
COPY question_to_cluster.json /app/
COPY extracted_docx /app/extracted_docx
COPY readings /app/readings

# Cloud Run sets PORT; default to 8080 for local docker run testing
ENV PORT=8080 PYTHONUNBUFFERED=1
EXPOSE 8080

# Gunicorn for production. 2 workers, threads default; bump if traffic grows.
CMD ["sh", "-c", "exec gunicorn --bind 0.0.0.0:${PORT} --workers 2 --threads 4 --timeout 180 server:app"]
