#!/bin/sh
set -eu
# Also run explicitly for existing volumes; creation is idempotent and credentials are not logged.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres --set=product_password="$PRODUCT_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE product_owner LOGIN PASSWORD %L', :'product_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'product_owner') \gexec
SELECT 'CREATE DATABASE product OWNER product_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'product') \gexec
REVOKE CONNECT ON DATABASE auth FROM PUBLIC;
REVOKE CONNECT ON DATABASE organization FROM PUBLIC;
REVOKE CONNECT ON DATABASE product FROM PUBLIC;
GRANT CONNECT ON DATABASE product TO product_owner;
SQL
