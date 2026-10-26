#!/bin/sh
set -eu
# Also run explicitly for existing volumes; creation is idempotent and credentials are not logged.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres --set=aggregation_password="$AGGREGATION_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE aggregation_owner LOGIN PASSWORD %L', :'aggregation_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aggregation_owner') \gexec
SELECT 'CREATE DATABASE aggregation OWNER aggregation_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'aggregation') \gexec
REVOKE CONNECT ON DATABASE auth FROM PUBLIC;
REVOKE CONNECT ON DATABASE organization FROM PUBLIC;
REVOKE CONNECT ON DATABASE product FROM PUBLIC;
REVOKE CONNECT ON DATABASE batch FROM PUBLIC;
REVOKE CONNECT ON DATABASE aggregation FROM PUBLIC;
REVOKE CONNECT ON DATABASE serialization FROM PUBLIC;
GRANT CONNECT ON DATABASE aggregation TO aggregation_owner;
SQL
