import { Client } from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const required = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'] as const;
const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
  process.exit(1);
}

const client = new Client({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 10000),
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

try {
  await client.connect();
  const result = await client.query<{
    current_database: string;
    current_user: string;
    server_addr: string | null;
    server_port: number | null;
  }>(`
    SELECT
      current_database(),
      current_user,
      inet_server_addr()::text AS server_addr,
      inet_server_port() AS server_port
  `);

  const row = result.rows[0];
  console.log('PostgreSQL connection OK');
  console.log(`database=${row.current_database}`);
  console.log(`user=${row.current_user}`);
  console.log(`server=${row.server_addr ?? process.env.DB_HOST}:${row.server_port ?? process.env.DB_PORT}`);
} catch (error: any) {
  console.error('PostgreSQL connection failed');
  console.error(`name=${error?.name ?? 'UnknownError'}`);
  console.error(`message=${error?.message ?? error}`);
  if (error?.code) console.error(`code=${error.code}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
