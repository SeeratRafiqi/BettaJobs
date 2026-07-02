import { Client } from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

const host = process.env.DB_CREATE_HOST || required('DB_HOST');
const port = Number(process.env.DB_CREATE_PORT || process.env.DB_PORT || 5432);
const databaseName = process.env.DB_CREATE_NAME || required('DB_NAME');
const owner = process.env.DB_CREATE_OWNER || required('DB_USER');
const adminUser = process.env.DB_CREATE_USER || required('DB_USER');
const adminPassword = process.env.DB_CREATE_PASSWORD || required('DB_PASSWORD');
const maintenanceDb = process.env.DB_CREATE_DATABASE || 'postgres';

const client = new Client({
  host,
  port,
  database: maintenanceDb,
  user: adminUser,
  password: adminPassword,
  connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 10000),
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

try {
  await client.connect();

  const exists = await client.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [databaseName],
  );

  if (exists.rowCount && exists.rowCount > 0) {
    console.log(`Database already exists: ${databaseName}`);
  } else {
    await client.query(
      `CREATE DATABASE ${quoteIdentifier(databaseName)} OWNER ${quoteIdentifier(owner)}`,
    );
    console.log(`Database created: ${databaseName}`);
    console.log(`Owner: ${owner}`);
  }
} catch (error: any) {
  console.error('Failed to create PostgreSQL database');
  console.error(`message=${error?.message ?? error}`);
  if (error?.code) console.error(`code=${error.code}`);
  console.error('\nRequired env: DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD');
  console.error('Optional admin env: DB_CREATE_USER, DB_CREATE_PASSWORD, DB_CREATE_DATABASE');
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
