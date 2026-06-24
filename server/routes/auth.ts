import { Router, type Request, type Response, type NextFunction } from 'express';
import express from 'express';
import jwt from 'jsonwebtoken';
import { authController } from '../controllers/authController.js';
import { authenticateToken, buildJwtAccessClaims } from '../middleware/auth.js';
import { registerLimiter } from '../middleware/rateLimit.js';
import { validateBody, registerSchema, loginSchema } from '../middleware/validate.js';
import { User } from '../db/models/User.js';
import passport from '../utils/passport.js';
import { resolveFrontendBaseUrl } from '../utils/frontendBase.js';

const router = Router();

function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim());
}

/** Public: lets the SPA show "Continue with Google" only when the server is configured. */
router.get('/google/enabled', (_req: Request, res: Response) => {
  res.json({ enabled: googleConfigured() });
});

router.post('/register', registerLimiter, express.json(), validateBody(registerSchema), (req, res) =>
  authController.register(req, res)
);
router.post('/login', express.json(), validateBody(loginSchema), (req, res) =>
  authController.login(req, res)
);
router.post('/logout', (req, res) => authController.logout(req, res));
router.post('/refresh', authenticateToken, (req, res) => authController.refreshToken(req as any, res));
router.get('/me', authenticateToken, (req, res) => authController.me(req as any, res));

router.get('/google', (req: Request, res: Response, next: NextFunction) => {
  if (!googleConfigured()) {
    return res.status(503).json({
      message: 'Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
    });
  }
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account',
  })(req, res, next);
});

router.get('/google/callback', (req: Request, res: Response, next: NextFunction) => {
  if (!googleConfigured()) {
    const base = resolveFrontendBaseUrl(req);
    return res.redirect(302, `${base}/login?error=google_auth&message=${encodeURIComponent('Google sign-in is not configured')}`);
  }

  passport.authenticate('google', (err: Error | null, user: User | false | undefined) => {
    void finalizeGoogleCallback(req, res, err, user);
  })(req, res, next);
});

async function finalizeGoogleCallback(
  req: Request,
  res: Response,
  err: Error | null,
  user: User | false | undefined
) {
  const frontendBase = resolveFrontendBaseUrl(req);

  const redirectLogin = (message: string) =>
    res.redirect(
      302,
      `${frontendBase}/login?error=google_auth&message=${encodeURIComponent(message)}`
    );

  try {
    if (err) {
      console.error('[auth/google/callback]', err);
      return redirectLogin(err.message || 'Google sign-in failed');
    }
    if (!user) {
      return redirectLogin('Sign-in was cancelled or failed');
    }

    const fresh = await User.findByPk(user.id);
    if (!fresh) {
      return redirectLogin('User account could not be loaded');
    }

    const secret = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'default-secret';
    const token = jwt.sign(
      buildJwtAccessClaims({
        id: fresh.id,
        username: fresh.username,
        role: fresh.role,
        email: fresh.email,
        name: fresh.name,
        avatar: fresh.avatar,
        googleId: fresh.googleId,
        email_verified: fresh.email_verified,
      }),
      secret,
      { expiresIn: '7d' }
    );

    const params = new URLSearchParams();
    params.set('token', token);
    const dest = `${frontendBase}/auth/google/callback#${params.toString()}`;

    const redirectOk = () => res.redirect(302, dest);
    if (req.session) {
      req.session.destroy((destroyErr) => {
        if (destroyErr) {
          console.error('[auth/google/callback] session destroy', destroyErr);
        }
        redirectOk();
      });
    } else {
      redirectOk();
    }
  } catch (e: any) {
    console.error('[auth/google/callback]', e);
    return redirectLogin(e?.message || 'Unexpected error');
  }
}

export default router;
