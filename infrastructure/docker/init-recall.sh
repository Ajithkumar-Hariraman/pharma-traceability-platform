#!/bin/sh
set -eu
# Also run explicitly for existing volumes; creation is idempotent and credentials are not logged.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres --set=recall_password="$RECALL_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE recall_owner LOGIN PASSWORD %L', :'recall_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'recall_owner') \gexec
SELECT format('ALTER ROLE recall_owner PASSWORD %L', :'recall_password') \gexec
SELECT 'CREATE DATABASE recall OWNER recall_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'recall') \gexec
REVOKE CONNECT ON DATABASE auth FROM PUBLIC;
REVOKE CONNECT ON DATABASE organization FROM PUBLIC;
REVOKE CONNECT ON DATABASE product FROM PUBLIC;
REVOKE CONNECT ON DATABASE batch FROM PUBLIC;
REVOKE CONNECT ON DATABASE recall FROM PUBLIC;
REVOKE CONNECT ON DATABASE serialization FROM PUBLIC;
GRANT CONNECT ON DATABASE recall TO recall_owner;
SQL
