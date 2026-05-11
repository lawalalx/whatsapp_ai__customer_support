# Using the custom Postgres (pgvector) image with this app

Quick steps:

1. Build or pull the DB image:

```bash
docker build -t myregistry.azurecr.io/postgres-pgvector:15 ../../postgres
docker pull myregistry.azurecr.io/postgres-pgvector:15
```

2. Run both services:

```bash
docker compose -f docker-compose.postgres.yml up -d --build
```

3. The compose file sets `DATABASE_URL` to `postgresql://root:mypostgres@db:5432/first_contact_db` for local compose runs. Adjust for production.
