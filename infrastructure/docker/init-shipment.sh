#!/bin/sh
set -eu
# Also run explicitly for existing volumes; creation is idempotent and credentials are not logged.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres --set=shipment_password="$SHIPMENT_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE shipment_owner LOGIN PASSWORD %L', :'shipment_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'shipment_owner') \gexec
SELECT format('ALTER ROLE shipment_owner PASSWORD %L', :'shipment_password') \gexec
SELECT 'CREATE DATABASE shipment OWNER shipment_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'shipment') \gexec
REVOKE CONNECT ON DATABASE auth FROM PUBLIC;
REVOKE CONNECT ON DATABASE organization FROM PUBLIC;
REVOKE CONNECT ON DATABASE product FROM PUBLIC;
REVOKE CONNECT ON DATABASE batch FROM PUBLIC;
REVOKE CONNECT ON DATABASE shipment FROM PUBLIC;
REVOKE CONNECT ON DATABASE serialization FROM PUBLIC;
GRANT CONNECT ON DATABASE shipment TO shipment_owner;
SQL
