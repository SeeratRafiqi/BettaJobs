import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  getResolvedDialect,
  type ResolvedDialect,
} from './dialect.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const customLogger = (msg: string) => {
  const shouldLog =
    msg.toLowerCase().includes('error') ||
    /^\s*(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)/i.test(msg) ||
    /^\s*(START|COMMIT|ROLLBACK)/i.test(msg) ||
    process.env.DB_VERBOSE === 'true';

  if (shouldLog) {
    const truncatedMsg = msg.length > 500 ? msg.substring(0, 500) + '...' : msg;
    console.log(`[DB] ${truncatedMsg}`);
  }
};

const getLogging = () => {
  if (process.env.DB_VERBOSE === 'true') {
    return console.log;
  }
  if (process.env.DB_VERBOSE === 'false') {
    return false;
  }
  return process.env.NODE_ENV === 'development' ? customLogger : false;
};

const resolvedDialect = getResolvedDialect();

const poolConfig = {
  max: parseInt(process.env.DB_POOL_MAX || '10', 10),
  min: parseInt(process.env.DB_POOL_MIN || '2', 10),
  idle: parseInt(process.env.DB_POOL_IDLE || '10000', 10),
  acquire: 30000,
  evict: 1000,
};

const sequelize: Sequelize = (() => {
  if (resolvedDialect === 'postgres') {
    const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
    return new Sequelize(
      url?.pathname.slice(1) || process.env.DB_NAME || 'jobseek',
      decodeURIComponent(url?.username || process.env.DB_USER || 'postgres'),
      decodeURIComponent(url?.password || process.env.DB_PASSWORD || ''),
      {
        host: url?.hostname || process.env.DB_HOST || 'localhost',
        port: parseInt(url?.port || process.env.DB_PORT || '5432', 10),
        dialect: 'postgres',
        logging: getLogging(),
        pool: poolConfig,
      },
    );
  }
  throw new Error('Unsupported dialect');
})();

export default sequelize;
