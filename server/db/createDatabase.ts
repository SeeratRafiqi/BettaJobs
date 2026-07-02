import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function quoteIdentifier(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function getUrl(value?: string) {
  return value ? new URL(value) : null;
}

export async function createDatabase() {
  const appUrl = getUrl(process.env.DATABASE_URL);
  const createUrl = getUrl(process.env.DB_CREATE_URL);

  const finalDbName = appUrl?.pathname.slice(1) || process.env.DB_NAME || 'jobseek';
  const host = createUrl?.hostname || appUrl?.hostname || process.env.DB_CREATE_HOST || process.env.DB_HOST || 'localhost';
  const port = parseInt(createUrl?.port || appUrl?.port || process.env.DB_CREATE_PORT || process.env.DB_PORT || '5432', 10);
  const maintenanceDb = createUrl?.pathname.slice(1) || process.env.DB_CREATE_DATABASE || 'postgres';

  const appUser = decodeURIComponent(appUrl?.username || process.env.DB_USER || 'postgres');
  const createUser = decodeURIComponent(createUrl?.username || process.env.DB_CREATE_USER || appUser);
  const createPassword = decodeURIComponent(createUrl?.password || process.env.DB_CREATE_PASSWORD || appUrl?.password || process.env.DB_PASSWORD || '');
  const owner = process.env.DB_CREATE_OWNER || appUser;

  const sequelize = new Sequelize(maintenanceDb, createUser, createPassword, {
    host,
    port,
    dialect: 'postgres',
    logging: false,
  });

  try {
    await sequelize.authenticate();
    console.log('Connected to PostgreSQL server');

    const [results] = await sequelize.query(
      'SELECT 1 FROM pg_database WHERE datname = ?',
      { replacements: [finalDbName] },
    );

    if (Array.isArray(results) && results.length === 0) {
      await sequelize.query(
        `CREATE DATABASE ${quoteIdentifier(finalDbName)} OWNER ${quoteIdentifier(owner)}`,
      );
      console.log(`Database '${finalDbName}' created successfully`);
    } else {
      console.log(`Database '${finalDbName}' already exists`);
    }
  } catch (error: any) {
    console.error('Failed to create database:', error.message);
    console.error('\nPlease create the database manually:');
    console.error(`CREATE DATABASE ${quoteIdentifier(finalDbName)} OWNER ${quoteIdentifier(owner)};`);
    console.error('\nOr set DB_CREATE_USER/DB_CREATE_PASSWORD to a PostgreSQL role that can create databases.');
    throw error;
  } finally {
    await sequelize.close().catch(() => undefined);
  }
}

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('/createDatabase.ts');

if (isDirectRun) {
  createDatabase()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
