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

const defaultPortFor = (d: ResolvedDialect) => (d === 'postgres' ? 5432 : 3306);

const sequelize: Sequelize = (() => {
  if (resolvedDialect === 'postgres') {
    return new Sequelize(
      process.env.DB_NAME ?? 'jobseek',
      process.env.DB_USER ?? 'wu_user',
      process.env.DB_PASSWORD ?? 'ymmv2NH^O1IQ',
      {
        host: process.env.DB_HOST ?? '47.250.126.192',
        port: parseInt(process.env.DB_PORT ?? '6543', 10),
        dialect: 'postgres',
        logging: getLogging(),
        pool: poolConfig,
      },
    );
  }
  throw new Error('Unsupported dialect');
})();

export default sequelize;
