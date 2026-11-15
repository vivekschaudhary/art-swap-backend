# kindtree-swap-api
kindtree-swap-api

## Local stack

Run the database, storage and API locally with Docker Compose. The Compose file lives in `docker/` so Vercel doesn't read it as a deployment. Point Docker at it once per shell:

```
export COMPOSE_FILE=docker/docker-compose.yml
docker compose up -d --build --wait
```
