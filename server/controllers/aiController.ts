import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.js';
import { qwenService } from '../services/qwen.js';
import { pdfParserService } from '../services/pdfParser.js';
import { textToPdfBuffer } from '../services/pdfExport.js';
import { buildPdfFromOriginalTemplate } from '../services/pdfTemplateExport.js';
import { buildPdfWithProfessionalTemplate, buildPdfFromStructuredResume, type StructuredResumeData } from '../services/pdfResumeTemplate.js';
import { renderHtmlToPdfBuffer } from '../services/htmlPdf.js';
import {
  buildResumeHTMLTemplate,
  coerceTailoredStructuredForTemplate,
  dedupeCertLikeRows,
  normalizeParsedTailoredResume,
  tailoredStructuredResumeToPlainText,
  type TailoredStructuredResume,
  type TailoredResumeCertification,
} from '@shared/tailoredResumeHtml';
import path from 'node:path';
import { Candidate } from '../db/models/Candidate.js';
import { CvFile } from '../db/models/CvFile.js';
import { CandidateMatrix } from '../db/models/CandidateMatrix.js';
import { Job } from '../db/models/Job.js';
import { CompanyProfile } from '../db/models/CompanyProfile.js';
import { TailoredResume } from '../db/models/TailoredResume.js';
import { logUsage, logUsageFailure, inferErrorType } from '../services/usageService.js';

/**
 * Helper: get CV text for a candidate (reads from the PDF file on disk).
 */
async function getCvTextForCandidate(candidateId: string): Promise<string> {
  const cvFile = await CvFile.findOne({
    where: { candidate_id: candidateId },
    order: [['uploaded_at', 'DESC']],
  });

  if (!cvFile || !cvFile.file_path) {
    throw new Error('No CV found for this candidate. Please upload a CV first.');
  }

  return pdfParserService.extractText(cvFile.file_path);
}

/** Get the absolute file path of the candidate's latest CV for template-based PDF export. */
async function getCvFilePathForCandidate(candidateId: string): Promise<string> {
  const cvFile = await CvFile.findOne({
    where: { candidate_id: candidateId },
    order: [['uploaded_at', 'DESC']],
  });
  if (!cvFile?.file_path) throw new Error('No CV found for this candidate.');
  return path.isAbsolute(cvFile.file_path) ? cvFile.file_path : path.resolve(process.cwd(), cvFile.file_path);
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize a string for matching: trim, collapse whitespace, optional leading bullet.
 */
function normalizeForMatch(s: string): string {
  return s
    .trim()
    .replace(/^\s*[•\-*]\s*/, '') // strip leading bullet char
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Apply AI-suggested bullet replacements to CV text (original → improved).
 * Keeps the rest of the CV unchanged; only the suggested lines are replaced.
 * Tries exact match first, then flexible whitespace, then normalized (ignore leading bullet).
 */
function applyRevisedBullets(
  cvText: string,
  rewrittenBullets: { original: string; improved: string }[]
): string {
  let revised = cvText;
  for (const { original, improved } of rewrittenBullets) {
    if (!original || typeof improved !== 'string') continue;
    // 1) Exact match
    if (revised.includes(original)) {
      revised = revised.split(original).join(improved);
      continue;
    }
    // 2) Flexible whitespace: any run of whitespace matches as single space
    const normalizedOriginal = original.trim().replace(/\s+/g, ' ');
    let pattern = escapeRegex(normalizedOriginal).replace(/\\ /g, '\\s+');
    const re2 = new RegExp(pattern, 'gi');
    const before = revised;
    revised = revised.replace(re2, () => improved);
    if (revised !== before) continue;
    // 3) Allow optional leading bullet in CV (• - *) so "• Led team" matches "Led team"
    const norm = normalizeForMatch(original);
    if (!norm) continue;
    pattern = escapeRegex(norm).replace(/\\ /g, '\\s+');
    const re3 = new RegExp('(?:^|\\n)\\s*[•\\-*]?\\s*' + pattern, 'gim');
    revised = revised.replace(re3, () => improved);
  }
  return revised;
}

function parseStructuredResume(rawResponse: string): TailoredStructuredResume | null {
  try {
    const cleaned = rawResponse.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const requiredKeys = [
      'name',
      'email',
      'skills',
      'experience',
      'projects',
      'education',
      'certifications',
      'languages',
      'keyChanges',
    ];
    const missingKeys = requiredKeys.filter((key) => !(key in parsed));
    if (missingKeys.length > 0) {
      console.error('Structured resume missing keys:', missingKeys);
      return null;
    }
    const arrayKeys = [
      'experience',
      'projects',
      'education',
      'certifications',
      'awardsAndAchievements',
      'languages',
      'keyChanges',
    ];
    for (const key of arrayKeys) {
      if (!Array.isArray(parsed[key])) {
        (parsed as Record<string, unknown>)[key] = [];
      }
    }
    return normalizeParsedTailoredResume(parsed);
  } catch (e) {
    console.error('Failed to parse structured resume JSON:', e);
    return null;
  }
}

function normalizeCvListLine(line: string): string {
  return line
    .replace(/^\s*[•·▪◦\-*]\s*/, '')
    .replace(/^\s*\d+[\).\-\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeResumeSectionHeading(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 70) return false;
  if (/^[A-Z][A-Za-z\s/&-]{2,60}:?$/.test(t) && t.split(/\s+/).length <= 6) return true;
  if (/^[A-Z\s/&-]{3,60}:?$/.test(t)) return true;
  return false;
}

/** Matches AWARDS & ACHIEVEMENTS, Awards and Achievements, Honors, etc. */
const AWARDS_SECTION_HEADING =
  /^(awards?\s*(?:&|and)\s*achievements?|awards?|achievements?|honou?rs?|accomplishments?|recognitions?)\s*:?\s*$/i;

/** Comma-separated tool list (e.g. Figma, Flutter, HTML) — not an award title. */
function lineLooksLikeTechStackCommaList(line: string): boolean {
  const parts = line.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 4) return false;
  return parts.every((p) => p.length > 0 && p.length < 15);
}

function extractAwardsEntriesFromCvText(cvText: string): TailoredResumeCertification[] {
  const lines = cvText.split(/\r?\n/).map((l) => l.trim());
  const out: TailoredResumeCertification[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!AWARDS_SECTION_HEADING.test(lines[i])) continue;

    for (let j = i + 1; j < lines.length; j++) {
      const row = lines[j];
      if (!row) continue;
      if (AWARDS_SECTION_HEADING.test(row)) break;
      if (/^certifications?\s*:?\s*$/i.test(row) || /^licen[sc]es?\s*:?\s*$/i.test(row)) break;
      if (looksLikeResumeSectionHeading(row)) break;

      if (/^\s*[•·▪◦]/.test(row)) continue;
      if (/^\s*[-–—]\s/.test(row) || /^[-–—]\s/.test(row)) continue;
      if (/^\s*\d+[\).\-\s]+/.test(row)) continue;

      const cleaned = normalizeCvListLine(row);
      if (cleaned.length < 6) continue;
      if (/^page\s+\d+/i.test(cleaned)) continue;

      const first = cleaned.charAt(0);
      if (first >= 'a' && first <= 'z') continue;

      if (lineLooksLikeTechStackCommaList(cleaned)) continue;

      out.push({ name: cleaned, issuer: '', year: '', isRelevant: true });
    }
    return out;
  }
  return out;
}

function certificationBlobForMatch(c: TailoredResumeCertification): string {
  return [c.name, c.issuer, c.year]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mergeAwardsFromCvFallback(
  structured: TailoredStructuredResume,
  cvText: string
): TailoredStructuredResume {
  const existingAwards = structured.awardsAndAchievements;
  if (existingAwards && existingAwards.length > 0) {
    return structured;
  }

  const fromCv = extractAwardsEntriesFromCvText(cvText);
  if (!fromCv.length) return structured;

  const merged: TailoredResumeCertification[] = [...(structured.awardsAndAchievements ?? [])];

  for (const row of fromCv) {
    const b = certificationBlobForMatch(row);
    if (b.length < 12) continue;
    let duplicate = false;
    for (const ex of merged) {
      const eb = certificationBlobForMatch(ex);
      if (eb.length < 12) continue;
      if (eb === b || (eb.length >= 28 && b.length >= 28 && (eb.includes(b) || b.includes(eb)))) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) merged.push(row);
  }

  return {
    ...structured,
    awardsAndAchievements: dedupeCertLikeRows(merged),
  };
}

export class AiController {
  // ============================================================
  //  6.1  CV Review / Fixer (Candidate)
  // ============================================================
  async reviewCv(req: AuthRequest, res: Response) {
    try {
      const userId = req.user!.id;
      const { targetRole } = req.body || {};

      const candidate = await Candidate.findOne({ where: { user_id: userId } });
      if (!candidate) return res.status(404).json({ message: 'Candidate profile not found' });

      const cvText = await getCvTextForCandidate(candidate.id);
      if (!cvText || !cvText.trim()) {
        return res.status(400).json({
          message: 'No CV text found. Upload a CV first and wait for it to be processed.',
        });
      }

      try {
        const result = await qwenService.reviewCV(cvText, targetRole);
        // Normalize bullets (LLM may return camelCase or snake_case)
        const bullets = Array.isArray(result.rewrittenBullets)
          ? result.rewrittenBullets
          : Array.isArray((result as any).rewritten_bullets)
            ? (result as any).rewritten_bullets
            : [];
        // Always build revisedCvText from the uploaded CV: same content with only the suggested lines replaced
        const revisedCvText =
          bullets.length > 0 ? applyRevisedBullets(cvText, bullets) : undefined;
        const u = (result as any)._usage;
        logUsage(userId, 'cv_review', u ? { inputTokens: u.input_tokens, outputTokens: u.output_tokens, tokensUsed: u.total_tokens } : undefined).catch(() => {});
        const { _usage, ...rest } = result as any;
        return res.json({
          ...rest,
          rewrittenBullets: bullets,
          revisedCvText,
        });
      } catch (qwenError: any) {
        const msg = qwenError?.message || '';
        if (msg.includes('not configured') || msg.includes('API_KEY') || msg.includes('API key')) {
          const fallback: {
            score: number;
            sections: { section: string; issues: string[]; suggestions: string[] }[];
            rewrittenBullets: { original: string; improved: string }[];
            summary: string;
          } = {
            score: 0,
            sections: [
              {
                section: 'AI Review Unavailable',
                issues: ['AI-powered review requires an API key.'],
                suggestions: [
                  'Add ALIBABA_LLM_API_KEY (or DASHSCOPE_API_KEY) to your .env file to enable AI CV review.',
                  'Get a key from Alibaba Cloud DashScope / Qwen API.',
                ],
              },
            ],
            rewrittenBullets: [],
            summary:
              'AI CV review is not available because no API key is configured. Set ALIBABA_LLM_API_KEY in the server .env file and restart the app to enable detailed AI feedback on your CV.',
          };
          return res.status(200).json(fallback);
        }
        logUsageFailure(req.user!.id, 'cv_review', inferErrorType(qwenError)).catch(() => {});
        throw qwenError;
      }
    } catch (error: any) {
      console.error('[AI] CV Review failed:', error.message);
      return res.status(500).json({ message: error.message || 'CV review failed' });
    }
  }

  /**
   * Get revised CV text: candidate's uploaded CV with suggested bullet replacements applied.
   * Use when the client has rewrittenBullets but needs the full revised text (e.g. for PDF download).
   */
  async getRevisedCvText(req: AuthRequest, res: Response) {
    try {
      const userId = req.user!.id;
      const body = req.body || {};
      const bullets = Array.isArray(body.rewrittenBullets)
        ? body.rewrittenBullets
        : Array.isArray(body.rewritten_bullets)
          ? body.rewritten_bullets
          : [];
      const candidate = await Candidate.findOne({ where: { user_id: userId } });
      if (!candidate) return res.status(404).json({ message: 'Candidate profile not found' });
      const cvText = await getCvTextForCandidate(candidate.id);
      if (!cvText || !cvText.trim()) {
        return res.status(400).json({ message: 'No CV text found. Upload a CV first.' });
      }
      const revisedCvText = bullets.length > 0 ? applyRevisedBullets(cvText, bullets) : cvText;
      return res.json({ revisedCvText });
    } catch (error: any) {
      console.error('[AI] getRevisedCvText failed:', error.message);
      return res.status(500).json({ message: error.message || 'Failed to get revised CV text' });
    }
  }

  /**
   * Export improved CV as PDF using the professional template (section headers, spacing, bullets).
   * Tries structured extraction first for best layout; falls back to parsed-section template.
   */
  async exportCvReviewPdf(req: AuthRequest, res: Response) {
    try {
      const { revisedCvText } = req.body || {};
      if (!revisedCvText || typeof revisedCvText !== 'string') {
        return res.status(400).json({ message: 'revisedCvText is required. Run AI CV Review first and use the improved text.' });
      }
      const trimmed = revisedCvText.trim();
      let buffer: Buffer;
      try {
        const structured = await qwenService.extractStructuredResume(trimmed);
        if (structured && structured.name != null) {
          buffer = await buildPdfFromStructuredResume(structured as StructuredResumeData);
        } else {
          buffer = await buildPdfWithProfessionalTemplate(trimmed);
        }
      } catch (_) {
        buffer = await buildPdfWithProfessionalTemplate(trimmed);
      }
      const filename = `improved-cv-${Date.now()}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', String(buffer.length));
      res.setHeader('Cache-Control', 'no-store');
      res.send(buffer);
    } catch (error: any) {
      console.error('[AI] CV export PDF failed:', error.message);
      if (!res.headersSent) {
        return res.status(500).json({ message: error.message || 'Failed to generate PDF' });
      }
    }
  }

  // ============================================================
  //  6.2  CV Tailor for Specific Job (Candidate)
  // ============================================================
  async tailorCv(req: AuthRequest, res: Response) {
    try {
      const userId = req.user!.id;
      const { jobId } = req.body;

      if (!jobId) return res.status(400).json({ message: 'jobId is required' });

      const candidate = await Candidate.findOne({ where: { user_id: userId } });
      if (!candidate) return res.status(404).json({ message: 'Candidate profile not found' });

      const job = await Job.findByPk(jobId);
      if (!job) return res.status(404).json({ message: 'Job not found' });

      const cvText = await getCvTextForCandidate(candidate.id);

      const result = await qwenService.tailorCV(
        cvText,
        job.title,
        job.description,
        [...(job.must_have_skills || []), ...(job.nice_to_have_skills || [])]
      );
      const u = (result as any)._usage;
      logUsage(userId, 'tailor_resume', u ? { inputTokens: u.input_tokens, outputTokens: u.output_tokens, tokensUsed: u.total_tokens } : undefined).catch(() => {});
      const { _usage: _u, ...rest } = result as any;
      return res.json(rest);
    } catch (error: any) {
      console.error('[AI] CV Tailor failed:', error.message);
      return res.status(500).json({ message: error.message || 'CV tailoring failed' });
    }
  }

  /**
   * Tailor CV reordered: same content as your CV, only reordered for this job (no fabrication).
   * Returns tailoredCvText + keyChanges. Use for download and apply-with-tailored-CV.
   */
  async tailorCvReordered(req: AuthRequest, res: Response) {
    try {
      const userId = req.user!.id;
      const { jobId } = req.body;
      if (!jobId) return res.status(400).json({ message: 'jobId is required' });

      const candidate = await Candidate.findOne({ where: { user_id: userId } });
      if (!candidate) return res.status(404).json({ message: 'Candidate profile not found' });
      const job = await Job.findByPk(jobId);
      if (!job) return res.status(404).json({ message: 'Job not found' });

      const cvText = await getCvTextForCandidate(candidate.id);
      const skills = [...(job.must_have_skills || []), ...(job.nice_to_have_skills || [])];

      const result = await qwenService.tailorCVReordered(
        cvText,
        job.title,
        job.description || '',
        skills
      );
      const u = (result as any)._usage;
      logUsage(userId, 'tailor_resume', u ? { inputTokens: u.input_tokens, outputTokens: u.output_tokens, tokensUsed: u.total_tokens } : undefined).catch(() => {});
      const { _usage: _u, ...rest } = result as any;
      return res.json(rest);
    } catch (error: any) {
      console.error('[AI] Tailor CV reordered failed:', error.message);
      return res.status(500).json({ message: error.message || 'Tailoring failed' });
    }
  }

  /**
   * Tailor resume for job: apply CV review suggestions (improved bullets) then reorder/remove
   * irrelevant content for the job. No fabrication—only existing resume content reorganized.
   */
  async tailorResumeForJob(req: AuthRequest, res: Response) {
    try {
      const userId = req.user!.id;
      const { jobId } = req.body;
      if (!jobId) return res.status(400).json({ message: 'jobId is required' });

      const candidate = await Candidate.findOne({ where: { user_id: userId } });
      if (!candidate) return res.status(404).json({ message: 'Candidate profile not found' });
      const job = await Job.findByPk(jobId);
      if (!job) return res.status(404).json({ message: 'Job not found' });

      const cvText = await getCvTextForCandidate(candidate.id);
      const skills = [...(job.must_have_skills || []), ...(job.nice_to_have_skills || [])];

      const { content, usage: uStructured } = await qwenService.tailorResumeStructuredJson(
        cvText,
        job.description || '',
        job.title,
        skills
      );
      let totalInput = uStructured?.input_tokens ?? 0;
      let totalOutput = uStructured?.output_tokens ?? 0;

      const parsedStructured = parseStructuredResume(content);
      let structuredResume: TailoredStructuredResume | null = parsedStructured;
      let tailoredCvText = '';
      let keyChanges: string[] = [];

      if (parsedStructured) {
        structuredResume = mergeAwardsFromCvFallback(parsedStructured, cvText);
        keyChanges = structuredResume.keyChanges ?? [];
        tailoredCvText = tailoredStructuredResumeToPlainText(structuredResume);
      } else {
        const tailorResult = await qwenService.tailorCVReordered(
          cvText,
          job.title,
          job.description || '',
          skills
        );
        tailoredCvText = (tailorResult.tailoredCvText || '').replace(/\\n/g, '\n');
        keyChanges = tailorResult.keyChanges || [];
        totalInput += (tailorResult as any)._usage?.input_tokens ?? 0;
        totalOutput += (tailorResult as any)._usage?.output_tokens ?? 0;
      }

      const [record] = await TailoredResume.findOrCreate({
        where: { candidate_id: candidate.id, job_id: job.id },
        defaults: {
          candidate_id: candidate.id,
          job_id: job.id,
          tailored_cv_text: tailoredCvText,
          structured_resume: structuredResume ? JSON.stringify(structuredResume) : null,
        },
      });
      if (record) {
        await record.update({
          tailored_cv_text: tailoredCvText,
          structured_resume: structuredResume ? JSON.stringify(structuredResume) : null,
        });
      }

      logUsage(userId, 'tailor_resume', totalInput > 0 || totalOutput > 0 ? { inputTokens: totalInput, outputTokens: totalOutput, tokensUsed: totalInput + totalOutput } : undefined).catch(() => {});
      return res.json({
        tailoredCvText,
        keyChanges,
        jobTitle: job.title,
        ...(structuredResume ? { structuredResume } : {}),
      });
    } catch (error: any) {
      if (req.user?.id) logUsageFailure(req.user.id, 'tailor_resume', inferErrorType(error)).catch(() => {});
      console.error('[AI] tailorResumeForJob failed:', error.message);
      return res.status(500).json({ message: error.message || 'Tailoring failed' });
    }
  }

  /**
   * Get saved tailored resume for the current candidate and job (if any).
   * GET /tailored-resume/:jobId
   */
  async getTailoredResumeForJob(req: AuthRequest, res: Response) {
    try {
      const userId = req.user!.id;
      const jobId = req.params.jobId;
      if (!jobId) return res.status(400).json({ message: 'jobId is required' });
      const candidate = await Candidate.findOne({ where: { user_id: userId } });
      if (!candidate) return res.status(404).json({ message: 'Candidate profile not found' });
      const record = await TailoredResume.findOne({
        where: { candidate_id: candidate.id, job_id: jobId },
      });
      if (!record) return res.status(404).json({ message: 'No tailored resume saved for this job' });
      let structuredResume: unknown = null;
      if (record.structured_resume) {
        try {
          const raw = JSON.parse(record.structured_resume);
          if (raw && typeof raw === 'object') {
            const coerced = coerceTailoredStructuredForTemplate(raw);
            if (coerced) {
              const cvText = await getCvTextForCandidate(candidate.id);
              structuredResume = mergeAwardsFromCvFallback(coerced, cvText);
            } else {
              structuredResume = raw;
            }
          }
        } catch (_) {
          /* ignore */
        }
      }
      return res.json({
        tailoredCvText: record.tailored_cv_text,
        structuredResume: structuredResume ?? undefined,
      });
    } catch (error: any) {
      console.error('[AI] getTailoredResumeForJob failed:', error.message);
      return res.status(500).json({ message: error.message || 'Failed to get tailored resume' });
    }
  }

  /**
   * Export tailored resume as PDF using a professional template (Canva/Overleaf style).
   * Body: { tailoredCvText: string, useOriginalTemplate?: boolean } — if useOriginalTemplate is true, uses candidate's uploaded CV as base.
   */
  async exportTailoredResumeWithTemplate(req: AuthRequest, res: Response) {
    try {
      const userId = req.user!.id;
      const { tailoredCvText, useOriginalTemplate, structuredResume, highlightTerms } = req.body || {};
      const pdfHighlightTerms = Array.isArray(highlightTerms)
        ? highlightTerms.map((t: unknown) => String(t)).filter(Boolean)
        : [];
      let buffer: Buffer;

      if (useOriginalTemplate) {
        if (!tailoredCvText || typeof tailoredCvText !== 'string') {
          return res.status(400).json({ message: 'tailoredCvText is required' });
        }
        const candidate = await Candidate.findOne({ where: { user_id: userId } });
        if (!candidate) return res.status(404).json({ message: 'Candidate profile not found' });
        const originalPath = await getCvFilePathForCandidate(candidate.id);
        buffer = await buildPdfFromOriginalTemplate(originalPath, tailoredCvText.trim());
      } else {
        const tailoredCoerced = coerceTailoredStructuredForTemplate(structuredResume);
        if (tailoredCoerced) {
          let forPdf = tailoredCoerced;
          try {
            const candidate = await Candidate.findOne({ where: { user_id: userId } });
            if (candidate) {
              const cvText = await getCvTextForCandidate(candidate.id);
              if (cvText?.trim()) forPdf = mergeAwardsFromCvFallback(tailoredCoerced, cvText);
            }
          } catch (_) {
            /* use tailoredCoerced */
          }
          const html = buildResumeHTMLTemplate(forPdf, {
            highlightTerms: pdfHighlightTerms.length ? pdfHighlightTerms : undefined,
          });
          buffer = await renderHtmlToPdfBuffer(html);
        } else {
          if (!tailoredCvText || typeof tailoredCvText !== 'string') {
            return res.status(400).json({ message: 'tailoredCvText is required when structured resume is not available' });
          }
          const trimmed = tailoredCvText.trim();
          if (structuredResume && typeof structuredResume === 'object' && (structuredResume as StructuredResumeData).name != null) {
            const sr = structuredResume as StructuredResumeData & { skills?: unknown };
            if (Array.isArray(sr.skills)) {
              buffer = await buildPdfFromStructuredResume(structuredResume as StructuredResumeData);
            } else {
              buffer = await buildPdfWithProfessionalTemplate(trimmed);
            }
          } else {
            buffer = await buildPdfWithProfessionalTemplate(trimmed);
          }
        }
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="tailored-resume.pdf"');
      res.send(buffer);
    } catch (error: any) {
      console.error('[AI] exportTailoredResumeWithTemplate failed:', error.message);
      if (error.message?.includes('not found')) {
        return res.status(404).json({ message: error.message });
      }
      return res.status(500).json({ message: error.message || 'PDF export failed' });
    }
  }

  // ============================================================
  //  6.3  Cover Letter Writer (Candidate)
  // ============================================================
  async generateCoverLetter(req: AuthRequest, res: Response) {
    try {
      const userId = req.user!.id;
      const { jobId, tone } = req.body;

      if (!jobId) return res.status(400).json({ message: 'jobId is required' });

      const candidate = await Candidate.findOne({ where: { user_id: userId } });
      if (!candidate) return res.status(404).json({ message: 'Candidate profile not found' });

      const job = await Job.findByPk(jobId, {
        include: [{ model: CompanyProfile, as: 'companyProfile' }],
      });
      if (!job) return res.status(404).json({ message: 'Job not found' });

      const cvText = await getCvTextForCandidate(candidate.id);
      const companyName = (job as any).companyProfile?.company_name || job.company || 'the company';

      try {
        const result = await qwenService.generateCoverLetter(
          cvText,
          job.title,
          job.description,
          companyName,
          tone || 'formal'
        );
        return res.json(result);
      } catch (qwenError: any) {
        const msg = qwenError?.message || '';
        if (msg.includes('not configured') || msg.includes('API_KEY') || msg.includes('API key')) {
          return res.status(200).json({
            coverLetter: 'AI cover letter is not available because no API key is set.\n\nTo enable it: add ALIBABA_LLM_API_KEY to the server .env file (in the job-matcher folder) and restart the app. You can get a free key at https://modelstudio.console.alibabacloud.com/\n\nYou can write your cover letter above and apply without AI.',
            alternateVersions: [],
          });
        }
        throw qwenError;
      }
    } catch (error: any) {
      console.error('[AI] Cover letter generation failed:', error.message);
      return res.status(500).json({ message: error.message || 'Cover letter generation failed' });
    }
  }

  // ============================================================
  //  6.4  Job Posting Fixer / Optimizer (Company)
  // ============================================================
  async reviewJobPosting(req: AuthRequest, res: Response) {
    try {
      const { title, description, mustHaveSkills, niceToHaveSkills } = req.body;

      if (!title || !description) {
        return res.status(400).json({ message: 'title and description are required' });
      }

      const result = await qwenService.reviewJobPosting(
        title,
        description,
        mustHaveSkills || [],
        niceToHaveSkills || []
      );

      return res.json(result);
    } catch (error: any) {
      console.error('[AI] Job posting review failed:', error.message);
      return res.status(500).json({ message: error.message || 'Job posting review failed' });
    }
  }

  // ============================================================
  //  6.5  Job Description Generator (Company)
  // ============================================================
  async generateJobDescription(req: AuthRequest, res: Response) {
    try {
      const userId = req.user!.id;
      const { title, skills, seniorityLevel, locationType, industry } = req.body;

      if (!title) return res.status(400).json({ message: 'title is required' });

      // Optionally fetch company description
      const company = await CompanyProfile.findOne({ where: { user_id: userId } });
      const companyDescription = company?.description || undefined;

      const result = await qwenService.generateJobDescription(
        title,
        skills,
        seniorityLevel,
        locationType,
        industry,
        companyDescription
      );

      return res.json(result);
    } catch (error: any) {
      console.error('[AI] Job description generation failed:', error.message);
      return res.status(500).json({ message: error.message || 'Job description generation failed' });
    }
  }

  // ============================================================
  //  6.6  Interview Question Generator (Company)
  // ============================================================
  async generateInterviewQuestions(req: AuthRequest, res: Response) {
    try {
      const { jobId, candidateId, questionTypes, difficulty } = req.body;

      if (!jobId) return res.status(400).json({ message: 'jobId is required' });

      const job = await Job.findByPk(jobId);
      if (!job) return res.status(404).json({ message: 'Job not found' });

      // Ensure company users can only generate interview questions for their own jobs
      if (req.user?.role === 'company') {
        const company = await CompanyProfile.findOne({ where: { user_id: req.user.id } });
        if (!company || job.company_id !== company.id) {
          return res.status(403).json({ message: 'Access denied: this job does not belong to your company' });
        }
      }

      let cvText: string | undefined;
      if (candidateId) {
        try {
          cvText = await getCvTextForCandidate(candidateId);
        } catch {
          // If CV not found for candidate, generate generic questions
          cvText = undefined;
        }
      }

      const result = await qwenService.generateInterviewQuestions(
        job.title,
        job.description,
        [...(job.must_have_skills || []), ...(job.nice_to_have_skills || [])],
        cvText,
        questionTypes || ['technical', 'behavioral', 'situational'],
        difficulty || 'mixed'
      );

      return res.json(result);
    } catch (error: any) {
      console.error('[AI] Interview questions generation failed:', error.message);
      return res.status(500).json({ message: error.message || 'Interview questions generation failed' });
    }
  }

  // ============================================================
  //  6.7  Candidate Summary / Pitch Generator (Company)
  // ============================================================
  async generateCandidateSummary(req: AuthRequest, res: Response) {
    try {
      const { candidateId, jobId } = req.body;

      if (!candidateId || !jobId) {
        return res.status(400).json({ message: 'candidateId and jobId are required' });
      }

      const candidate = await Candidate.findByPk(candidateId);
      if (!candidate) return res.status(404).json({ message: 'Candidate not found' });

      const job = await Job.findByPk(jobId);
      if (!job) return res.status(404).json({ message: 'Job not found' });

      const cvText = await getCvTextForCandidate(candidateId);

      const result = await qwenService.generateCandidateSummary(
        candidate.name,
        cvText,
        job.title,
        job.description
      );

      return res.json(result);
    } catch (error: any) {
      console.error('[AI] Candidate summary generation failed:', error.message);
      return res.status(500).json({ message: error.message || 'Candidate summary generation failed' });
    }
  }

  // ============================================================
  //  6.8  Skill Gap Analysis (Candidate)
  // ============================================================
  async analyzeSkillGaps(req: AuthRequest, res: Response) {
    try {
      const userId = req.user!.id;
      const { targetRole, targetJobIds } = req.body;

      const candidate = await Candidate.findOne({ where: { user_id: userId } });
      if (!candidate) return res.status(404).json({ message: 'Candidate profile not found' });

      // Get candidate's matrix for current skills
      const matrix = await CandidateMatrix.findOne({
        where: { candidate_id: candidate.id },
        order: [['generated_at', 'DESC']],
      });

      const skills = matrix?.skills || [];
      const experience = matrix?.total_years_experience || 0;

      // Optionally get target job descriptions
      let jobDescriptions: string[] | undefined;
      if (targetJobIds?.length) {
        const jobs = await Job.findAll({ where: { id: targetJobIds } });
        jobDescriptions = jobs.map(
          (j) => `${j.title}: ${j.description?.substring(0, 1000)}`
        );
      }

      const result = await qwenService.analyzeSkillGaps(
        skills,
        experience,
        targetRole,
        jobDescriptions
      );

      return res.json(result);
    } catch (error: any) {
      console.error('[AI] Skill gap analysis failed:', error.message);
      return res.status(500).json({ message: error.message || 'Skill gap analysis failed' });
    }
  }

  // ============================================================
  //  6.9  Salary Estimator (Any role)
  // ============================================================
  async estimateSalary(req: AuthRequest, res: Response) {
    try {
      const { role, skills, yearsExperience, country, city } = req.body;

      if (!role || !country) {
        return res.status(400).json({ message: 'role and country are required' });
      }

      const result = await qwenService.estimateSalary(
        role,
        skills || [],
        yearsExperience || 0,
        country,
        city
      );

      return res.json(result);
    } catch (error: any) {
      console.error('[AI] Salary estimation failed:', error.message);
      return res.status(500).json({ message: error.message || 'Salary estimation failed' });
    }
  }

  // ============================================================
  //  6.10  AI Chat Assistant (Any role)
  // ============================================================
  async chat(req: AuthRequest, res: Response) {
    try {
      const { message, conversationHistory } = req.body;

      if (!message) return res.status(400).json({ message: 'message is required' });

      const context = req.user
        ? {
            userRole: req.user.role,
            userName: req.user.name || req.user.username,
          }
        : undefined;

      const result = await qwenService.chatAssistant(
        message,
        conversationHistory || [],
        context
      );

      return res.json(result);
    } catch (error: any) {
      console.error('[AI] Chat failed:', error.message);
      return res.status(500).json({ message: error.message || 'AI chat failed' });
    }
  }
}

export const aiController = new AiController();
