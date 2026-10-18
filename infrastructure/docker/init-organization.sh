#!/bin/sh
set -eu
# Also run explicitly for existing volumes; creation is idempotent and credentials are not logged.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres --set=organization_password="$ORGANIZATION_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE organization_owner LOGIN PASSWORD %L', :'organization_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'organization_owner') \gexec
SELECT 'CREATE DATABASE organization OWNER organization_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'organization') \gexec
REVOKE CONNECT ON DATABASE auth FROM PUBLIC;
REVOKE CONNECT ON DATABASE organization FROM PUBLIC;
GRANT CONNECT ON DATABASE organization TO organization_owner;
SQL
