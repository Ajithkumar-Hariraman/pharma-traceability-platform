#!/bin/sh
set -eu
# Also run explicitly for existing volumes; creation is idempotent and credentials are not logged.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres --set=traceability_password="$TRACEABILITY_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE traceability_owner LOGIN PASSWORD %L', :'traceability_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'traceability_owner') \gexec
SELECT 'CREATE DATABASE traceability OWNER traceability_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'traceability') \gexec
REVOKE CONNECT ON DATABASE auth FROM PUBLIC;
REVOKE CONNECT ON DATABASE organization FROM PUBLIC;
REVOKE CONNECT ON DATABASE product FROM PUBLIC;
REVOKE CONNECT ON DATABASE batch FROM PUBLIC;
REVOKE CONNECT ON DATABASE traceability FROM PUBLIC;
GRANT CONNECT ON DATABASE traceability TO traceability_owner;
SQL
