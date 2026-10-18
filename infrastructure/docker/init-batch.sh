#!/bin/sh
set -eu
# Also run explicitly for existing volumes; creation is idempotent and credentials are not logged.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres --set=batch_password="$BATCH_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE batch_owner LOGIN PASSWORD %L', :'batch_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'batch_owner') \gexec
SELECT 'CREATE DATABASE batch OWNER batch_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'batch') \gexec
REVOKE CONNECT ON DATABASE auth FROM PUBLIC;
REVOKE CONNECT ON DATABASE organization FROM PUBLIC;
REVOKE CONNECT ON DATABASE product FROM PUBLIC;
REVOKE CONNECT ON DATABASE batch FROM PUBLIC;
GRANT CONNECT ON DATABASE batch TO batch_owner;
SQL
