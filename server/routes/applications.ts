import { Router } from 'express';
import { applicationController } from '../controllers/applicationController.js';
import {
  authenticateToken,
  requireCandidate,
  requireCompany,
  requireAnyRole,
  optionalAuth,
} from '../middleware/auth.js';

const router = Router();

// ========== PUBLIC / OPTIONAL AUTH — Job Browsing ==========
router.get('/browse', optionalAuth, (req, res) => applicationController.browseJobs(req, res));
router.get('/browse/:id', optionalAuth, (req, res) => applicationController.getJobPublic(req, res));

// ========== CANDIDATE — Applications ==========
router.post('/applications', authenticateToken, requireCandidate, (req, res) =>
  applicationController.apply(req, res)
);
router.get('/applications/mine', authenticateToken, requireCandidate, (req, res) =>
  applicationController.getMyApplications(req, res)
);
router.put('/applications/:id/withdraw', authenticateToken, requireCandidate, (req, res) =>
  applicationController.withdraw(req, res)
);

// ========== COMPANY — Review applications ==========
router.get('/applications/job/:jobId', authenticateToken, requireAnyRole('company', 'admin'), (req, res) =>
  applicationController.getForJob(req, res)
);
router.get('/applications/:id/resume/download', authenticateToken, requireAnyRole('company', 'admin'), (req, res) =>
  applicationController.downloadResume(req, res)
);
router.put('/applications/:id/status', authenticateToken, requireAnyRole('company', 'admin'), (req, res) =>
  applicationController.updateStatus(req, res)
);
router.get('/applications/company-stats', authenticateToken, requireCompany, (req, res) =>
  applicationController.getCompanyStats(req, res)
);

export default router;
