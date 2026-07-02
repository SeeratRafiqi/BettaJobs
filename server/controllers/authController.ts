import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { User } from '../db/models/User.js';
import { Candidate } from '../db/models/Candidate.js';
import { CompanyProfile } from '../db/models/CompanyProfile.js';
import { BaseController } from '../db/base/BaseController.js';
import { buildJwtAccessClaims, type AuthRequest, type UserRole } from '../middleware/auth.js';

/** Return a user-friendly message when the error is a DB connection failure. */
function normalizeDbError(error: any): { message: string; status: number } {
  const msg = error?.message || '';
  const isConnectionRefused =
    msg.includes('ECONNREFUSED') ||
    msg.includes('connect ECONNREFUSED') ||
    (error?.name === 'SequelizeConnectionRefusedError') ||
    (error?.name === 'SequelizeConnectionError');
  if (isConnectionRefused) {
    return {
      message:
        'Database is not available. The app requires PostgreSQL. Start PostgreSQL and set DATABASE_URL (or DB_HOST/DB_PORT/DB_USER/DB_PASSWORD) in .env, or see TROUBLESHOOTING.md.',
      status: 503,
    };
  }
  return { message: msg || 'Internal server error', status: error?.status || error?.statusCode || 500 };
}

function generateUUID(): string {
  // Simple UUID v4 generator (no external dependency needed)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class AuthController extends BaseController {
  protected model = User;

  async register(req: Request, res: Response) {
    await this.handleRequest(req, res, async () => {
      try {
        return await this.doRegister(req);
      } catch (err: any) {
        const { message, status } = normalizeDbError(err);
        const e: any = new Error(message);
        e.status = status;
        throw e;
      }
    });
  }

  private async doRegister(req: Request) {
    const { email, password, name, role } = req.body;

      // Validate required fields
      if (!email || !password || !name || !role) {
        const error: any = new Error('Email, password, name, and role are required');
        error.status = 400;
        throw error;
      }

      // Validate role
      if (!['candidate', 'company'].includes(role)) {
        const error: any = new Error('Role must be either "candidate" or "company"');
        error.status = 400;
        throw error;
      }

      // Validate password strength
      if (password.length < 8) {
        const error: any = new Error('Password must be at least 8 characters long');
        error.status = 400;
        throw error;
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        const error: any = new Error('Invalid email format');
        error.status = 400;
        throw error;
      }

      // Check if email already exists
      const existingUser = await User.findOne({ where: { email: email.toLowerCase() } });
      if (existingUser) {
        const error: any = new Error('An account with this email already exists');
        error.status = 409;
        throw error;
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);

      const userId = generateUUID();

      // Create user
      const user = await User.create({
        id: userId,
        username: email.toLowerCase(), // Use email as username
        password: hashedPassword,
        role: role as UserRole,
        email: email.toLowerCase(),
        name,
        email_verified: false,
      });

      // Create associated profile based on role
      if (role === 'candidate') {
        await Candidate.create({
          id: generateUUID(),
          user_id: user.id,
          name,
          email: email.toLowerCase(),
          phone: '',
          country: '',
          country_code: '',
        });
      } else if (role === 'company') {
        await CompanyProfile.create({
          id: generateUUID(),
          user_id: user.id,
          company_name: name,
        });
      }

      // Generate JWT token (same claims shape as Google OAuth — see buildJwtAccessClaims)
      const secret = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'default-secret';
      const token = jwt.sign(
        buildJwtAccessClaims({
          id: user.id,
          username: user.username,
          role: user.role,
          email: user.email,
          name: user.name,
          avatar: user.avatar,
          googleId: user.googleId,
          email_verified: user.email_verified,
        }),
        secret,
        { expiresIn: '7d' }
      );

      return {
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          avatar: user.avatar ?? null,
          googleId: user.googleId ?? null,
          email_verified: user.email_verified,
          auth_provider: user.googleId ? 'google' : 'local',
        },
      };
  }

  async login(req: Request, res: Response) {
    await this.handleRequest(req, res, async () => {
      try {
        return await this.doLogin(req);
      } catch (err: any) {
        const { message, status } = normalizeDbError(err);
        const e: any = new Error(message);
        e.status = status;
        throw e;
      }
    });
  }

  private async doLogin(req: Request) {
    const { email, username, password } = req.body;

      // Support both email and username login
      const loginIdentifier = email || username;

      if (!loginIdentifier || !password) {
        const error: any = new Error('Email and password are required');
        error.status = 400;
        throw error;
      }

      // Look up by email or username
      const user = await User.findOne({
        where: { email: loginIdentifier.toLowerCase() },
      }) || await User.findOne({
        where: { username: loginIdentifier },
      });

      if (!user) {
        const error: any = new Error('Invalid credentials');
        error.status = 401;
        throw error;
      }

      if (user.password == null) {
        const error: any = new Error('Invalid credentials');
        error.status = 401;
        throw error;
      }

      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) {
        const error: any = new Error('Invalid credentials');
        error.status = 401;
        throw error;
      }

      const secret = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'default-secret';
      const token = jwt.sign(
        buildJwtAccessClaims({
          id: user.id,
          username: user.username,
          role: user.role,
          email: user.email,
          name: user.name,
          avatar: user.avatar,
          googleId: user.googleId,
          email_verified: user.email_verified,
        }),
        secret,
        { expiresIn: '7d' }
      );

      return {
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          avatar: user.avatar ?? null,
          googleId: user.googleId ?? null,
          email_verified: user.email_verified,
          auth_provider: user.googleId ? 'google' : 'local',
        },
      };
  }

  async logout(req: Request, res: Response) {
    await this.handleRequest(req, res, async () => {
      return { message: 'Logged out successfully' };
    });
  }

  // POST /api/auth/refresh — issue a new access token from a valid (non-expired) token
  async refreshToken(req: AuthRequest, res: Response) {
    await this.handleRequest(req, res, async () => {
      if (!req.user) {
        throw Object.assign(new Error('Authentication required'), { status: 401 });
      }

      const user = await User.findByPk(req.user.id);
      if (!user) {
        throw Object.assign(new Error('User not found'), { status: 404 });
      }

      const secret = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'default-secret';
      const token = jwt.sign(
        buildJwtAccessClaims({
          id: user.id,
          username: user.username,
          role: user.role,
          email: user.email,
          name: user.name,
          avatar: user.avatar,
          googleId: user.googleId,
          email_verified: user.email_verified,
        }),
        secret,
        { expiresIn: '7d' }
      );

      return { token };
    });
  }

  async me(req: AuthRequest, res: Response) {
    await this.handleRequest(req, res, async () => {
      if (!req.user) {
        const error: any = new Error('Not authenticated');
        error.status = 401;
        throw error;
      }

      const user = await User.findByPk(req.user.id);
      if (!user) {
        const error: any = new Error('User not found');
        error.status = 404;
        throw error;
      }

      // Return user with linked profile info
      const result: any = {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatar: user.avatar ?? null,
        googleId: user.googleId ?? null,
        email_verified: user.email_verified,
        auth_provider: user.googleId ? 'google' : 'local',
      };

      if (user.role === 'candidate') {
        const candidate = await Candidate.findOne({ where: { user_id: user.id } });
        if (candidate) {
          result.candidateId = candidate.id;
          result.photoUrl = candidate.photo_url;
        }
      } else if (user.role === 'company') {
        const company = await CompanyProfile.findOne({ where: { user_id: user.id } });
        if (company) {
          result.companyId = company.id;
          result.companyName = company.company_name;
          result.logoUrl = company.logo_url;
        }
      }

      return result;
    });
  }
}

export const authController = new AuthController();
