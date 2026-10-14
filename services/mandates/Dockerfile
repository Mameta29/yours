FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv==0.11.9
WORKDIR /app
COPY services/mandates/pyproject.toml services/mandates/uv.lock ./
RUN uv sync --frozen --no-dev
COPY services/mandates/yours_mandates ./yours_mandates
RUN useradd --uid 10001 --create-home app
USER app
ENV ENVIRONMENT=production
ENV PORT=8080
EXPOSE 8080
CMD [".venv/bin/uvicorn", "yours_mandates.service:from_environment", "--factory", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
