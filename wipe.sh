#!/bin/bash

# Ensure the script stops if any command fails
set -e

echo "Starting database wipe process..."

# 1. Load variables from .env file
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
    echo "Loaded .env file successfully."
else
    echo "Error: .env file not found!"
    exit 1
fi

# 2. Verify schema.sql exists
if [ ! -f schema.sql ]; then
    echo "Error: schema.sql file not found in the current directory!"
    exit 1
fi

# 3. Check if necessary DB variables exist
if [ -z "$DB_HOST" ] || [ -z "$DB_USER" ] || [ -z "$DB_PASSWORD" ] || [ -z "$DB_NAME" ]; then
    echo "Error: Missing database variables in .env file."
    exit 1
fi

echo "Connecting to the database ($DB_NAME at $DB_HOST)..."

# 4. Stream the DROP commands and the schema.sql file directly into the database
# Note: Using --skip-ssl to bypass local certificate errors. 
# (If your specific client complains about --skip-ssl, change it to --ssl-mode=DISABLED)
(
echo "SET FOREIGN_KEY_CHECKS = 0;"
echo "DROP TABLE IF EXISTS replies, posts, boards, direct_messages, users;"
echo "SET FOREIGN_KEY_CHECKS = 1;"
cat schema.sql
) | mariadb -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" --skip-ssl

echo "Database wiped and rebuilt successfully using schema.sql!"