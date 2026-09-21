# Build only from the narrow ml/ context with its deny-by-default .dockerignore.
# Optional Linux CPU image: the Mac runtime is verified separately.
FROM python:3.11-slim-bookworm@sha256:a36c24f9cbdf4fd0f52d67f0823eeac19c2028c637cecc392d97f980d4fec56b
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 MODEL_PATH=/models/model.pt
WORKDIR /app
COPY requirements-runtime.txt /app/requirements-runtime.txt
RUN python -m pip install torch==2.14.0 torchvision==0.29.0 --index-url https://download.pytorch.org/whl/cpu \
    && python -m pip install -r /app/requirements-runtime.txt
COPY __init__.py runtime.py service.py contract.py serve.py healthcheck.py model-contract.json /app/ml/
USER 10001:10001
EXPOSE 8001
HEALTHCHECK --interval=15s --timeout=7s --start-period=45s --retries=3 \
    CMD ["python", "-m", "ml.healthcheck"]
ENTRYPOINT ["python", "-m", "ml.serve"]
CMD ["--host", "0.0.0.0", "--port", "8001", "--checkpoint", "/models/model.pt"]
