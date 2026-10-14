FROM python:3.12-slim-bookworm
RUN pip install --no-cache-dir uv==0.11.9
WORKDIR /app
COPY services/agent/pyproject.toml services/agent/uv.lock ./
RUN uv sync --frozen --no-dev
COPY services/agent/yours_agent ./yours_agent
RUN useradd --uid 10001 --create-home app
USER app
ENV ENVIRONMENT=production
ENV GOOGLE_GENAI_USE_VERTEXAI=true
ENV PORT=8080
EXPOSE 8080
CMD [".venv/bin/uvicorn", "yours_agent.service:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
