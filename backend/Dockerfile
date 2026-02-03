# Build a small FastAPI image
FROM python:3.11-slim

WORKDIR /app

# System deps for textract backends (mammoth/docx parsing uses libreoffice deps; keep minimal)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libxml2 libxslt1.1 antiword unrtf poppler-utils && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

ENV PYTHONUNBUFFERED=1

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
