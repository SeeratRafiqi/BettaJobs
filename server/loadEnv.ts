/**
 * Load `.env` before other modules read process.env.
 * In development, allow .env to override pre-set shell vars (e.g. stray PORT=5001),
 * so the URL matches what developers expect from .env.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env');

dotenv.config({
  path: envPath,
  override: process.env.NODE_ENV !== 'production',
});
