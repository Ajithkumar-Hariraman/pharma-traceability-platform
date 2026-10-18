#!/bin/sh
set -eu
# Also run explicitly for existing volumes; creation is idempotent and credentials are not logged.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres --set=serialization_password="$SERIALIZATION_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE serialization_owner LOGIN PASSWORD %L', :'serialization_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'serialization_owner') \gexec
SELECT 'CREATE DATABASE serialization OWNER serialization_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'serialization') \gexec
REVOKE CONNECT ON DATABASE auth FROM PUBLIC;
REVOKE CONNECT ON DATABASE organization FROM PUBLIC;
REVOKE CONNECT ON DATABASE product FROM PUBLIC;
REVOKE CONNECT ON DATABASE batch FROM PUBLIC;
REVOKE CONNECT ON DATABASE serialization FROM PUBLIC;
GRANT CONNECT ON DATABASE serialization TO serialization_owner;
SQL
