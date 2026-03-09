FROM python:3.11-slim

# System deps: ffmpeg for WAV→MP3 conversion
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install CPU-only PyTorch first (keeps image ~1.5 GB smaller than CUDA)
RUN pip install --no-cache-dir \
    torch torchaudio --index-url https://download.pytorch.org/whl/cpu

# Install app dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download htdemucs_6s model weights at build time (~300 MB)
# This avoids downloading on cold start
RUN python -c "\
import demucs.api; \
s = demucs.api.Separator(model='htdemucs_6s', device='cpu'); \
print(f'Model cached: {s.model.__class__.__name__}') \
"

COPY main.py .

EXPOSE 8000

# Single worker — model is loaded per-process, jobs dict is shared
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]
