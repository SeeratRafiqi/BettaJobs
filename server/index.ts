import './loadEnv.js';

// Polyfill crypto.hash for Node 18 (required by Vite 7)
import crypto from "node:crypto";
const createHash = crypto.createHash.bind(crypto);
if (typeof (crypto as any).hash !== "function") {
  (crypto as any).hash = (algorithm: string, data: string | Buffer | ArrayBufferView, encoding?: string) =>
    createHash(algorithm).update(Buffer.from(data as Buffer)).digest(encoding || "hex");
}

import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import sequelize from "./db/config.js";
import "./db/models/index.js"; // Initialize models
import { initializeDatabase } from "./db/init.js";
import { interviewController } from "./controllers/interviewController.js";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// CORS middleware - must come before body parsers
app.use((req, res, next) => {
  const origin = req.headers.origin;
  // Allow from configured origin, or same-origin dev/localhost
  const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').filter(Boolean);
  const isAllowed =
    !origin ||
    origin.includes('localhost') ||
    origin.includes('127.0.0.1') ||
    allowedOrigins.includes(origin);

  if (isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Initialize database (create DB, run migrations) if enabled via env vars
  try {
    await initializeDatabase();
  } catch (error) {
    log(`Database initialization failed: ${error}`, "error");
    // Continue anyway - might be intentional
  }

  // Test database connection
  try {
    await sequelize.authenticate();
    log("Database connection established successfully");
  } catch (error) {
    log(`Database connection failed: ${error}`, "error");
  }

  // Create body parsers
  const jsonParser = express.json({
    limit: '2mb', // allow large payloads (e.g. improved CV text for PDF export)
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  });

  const urlencodedParser = express.urlencoded({ extended: false });

  // Register body parsers BEFORE routes (but skip multipart for file uploads)
  // JSON parser for application/json requests
  app.use((req, res, next) => {
    const contentType = req.headers['content-type'] || '';
    // CRITICAL: Skip body parsing for multipart - multer will handle it in routes
    if (contentType.includes('multipart/form-data')) {
      return next();
    }
    // Apply JSON parser for JSON requests
    if (contentType.includes('application/json')) {
      return jsonParser(req, res, next);
    }
    next();
  });

  // URL encoded parser for form data (not multipart)
  app.use((req, res, next) => {
    const contentType = req.headers['content-type'] || '';
    // CRITICAL: Skip body parsing for multipart
    if (contentType.includes('multipart/form-data')) {
      return next();
    }
    // Apply urlencoded parser for form-urlencoded requests
    if (contentType.includes('application/x-www-form-urlencoded')) {
      return urlencodedParser(req, res, next);
    }
    next();
  });

  // Register routes AFTER body parsers
  // Multer in routes will handle multipart requests (body parsers skip them)
  await registerRoutes(httpServer, app);

  const interviewSweepEnabled = process.env.INTERVIEW_SWEEP_ENABLED !== "false";
  const interviewSweepMs = Number.parseInt(process.env.INTERVIEW_SWEEP_INTERVAL_MS || "", 10) || 5 * 60 * 1000;
  if (interviewSweepEnabled) {
    const runInterviewSweep = async () => {
      try {
        const result = await interviewController.processExpirySweep();
        if ((result.expiredCount || 0) > 0 || (result.reminderCount || 0) > 0) {
          log(`Interview sweep: expired=${result.expiredCount}, reminders=${result.reminderCount}`);
        }
      } catch (error) {
        log(`Interview sweep failed: ${error}`, "error");
      }
    };
    await runInterviewSweep();
    setInterval(runInterviewSweep, interviewSweepMs);
  }

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  const host = process.env.HOST || "0.0.0.0"; // Listen on all interfaces (0.0.0.0) instead of localhost
  
  httpServer.listen(
    port,
    host,
    () => {
      log(`serving on ${host}:${port}`);
    },
  ).on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log(`❌ Port ${port} is already in use. Please:`, "error");
      log(`   1. Stop other processes using port ${port}`, "error");
      log(`   2. Or change PORT in .env file`, "error");
      log(`   3. Check with: lsof -i :${port} or netstat -tulpn | grep ${port}`, "error");
      process.exit(1);
    } else {
      log(`Server error: ${err.message}`, "error");
      process.exit(1);
    }
  });
})();
