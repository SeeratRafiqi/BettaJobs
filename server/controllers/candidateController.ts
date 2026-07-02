import { Request, Response } from 'express';
import { Op } from 'sequelize';
import sequelize from '../db/config.js';
import { Candidate, CvFile, CandidateMatrix, CandidateTag } from '../db/models/index.js';
import { BaseController } from '../db/base/BaseController.js';
import { upload } from '../middleware/upload.js';
import { randomUUID } from 'crypto';
import path from 'path';
import { existsSync, statSync } from 'fs';
import { qwenService } from '../services/qwen.js';
import { pdfParserService } from '../services/pdfParser.js';

export class CandidateController extends BaseController {
  protected model = Candidate;

  /**
   * Check if a name looks invalid (hash, too short, no letters, etc.)
   */
  private isInvalidName(name: string): boolean {
    if (!name || name.length < 2) return true;
    
    // Check if it looks like a hash (long alphanumeric string without spaces)
    if (name.length > 30 && /^[a-f0-9]+$/i.test(name.replace(/\s/g, ''))) {
      return true; // Looks like a hash
    }
    
    // Check if it has very few letters (mostly numbers/special chars)
    const letterCount = (name.match(/[a-zA-Z]/g) || []).length;
    if (letterCount < 2) {
      return true; // Not enough letters to be a real name
    }
    
    // Check if it's mostly special characters or numbers
    const specialCharCount = (name.match(/[^a-zA-Z0-9\s]/g) || []).length;
    if (specialCharCount > name.length * 0.5) {
      return true; // Too many special characters
    }
    
    return false;
  }

  /**
   * Extract name directly from CV text as fallback
   * Looks for the largest/most prominent text at the beginning
   */
  private extractNameFromText(cvText: string): string | null {
    if (!cvText || cvText.trim().length === 0) return null;
    
    // Get first 2000 characters (where name usually is)
    const headerText = cvText.substring(0, 2000);
    
    // Split into lines and find the most likely name line
    const lines = headerText.split(/\n+/).map(line => line.trim()).filter(line => line.length > 0);
    
    // Look for lines that:
    // 1. Are in the first 10 lines
    // 2. Have 2-4 words (typical name format)
    // 3. Start with capital letter
    // 4. Don't contain common CV keywords
    const nameKeywords = ['email', 'phone', 'address', 'resume', 'cv', 'experience', 'education', 'skills', 'objective'];
    
    for (let i = 0; i < Math.min(10, lines.length); i++) {
      const line = lines[i];
      const words = line.split(/\s+/);
      
      // Check if line looks like a name (2-4 words, starts with capital, no keywords)
      if (words.length >= 2 && words.length <= 4) {
        const hasKeywords = nameKeywords.some(keyword => line.toLowerCase().includes(keyword));
        const startsWithCapital = /^[A-Z]/.test(line);
        const hasEnoughLetters = (line.match(/[a-zA-Z]/g) || []).length >= 4;
        
        if (!hasKeywords && startsWithCapital && hasEnoughLetters) {
          // This looks like a name
          return line;
        }
      }
    }
    
    return null;
  }

  async list(req: Request, res: Response) {
    await this.handleRequest(req, res, async () => {
      const { status, country, search, tags, minScore, sortBy } = req.query;

      const where: any = {};
      const include: any[] = [
        {
          model: CvFile,
          as: 'cvFiles',
          required: false,
        },
        {
          model: CandidateMatrix,
          as: 'matrices',
          required: false,
        },
        {
          model: CandidateTag,
          as: 'tags',
          required: false,
        },
      ];

      // Don't filter by status in include - filter after fetching
      // This ensures all candidates appear, then we filter by CV status

      if (country) {
        where.country = country;
      }

      if (search) {
        where[Op.or] = [
          { name: { [Op.like]: `%${search}%` } },
          { email: { [Op.like]: `%${search}%` } },
        ];
      }

      // Determine sort order
      const order: any[] = [];
      if (sortBy === 'recent') {
        order.push(['created_at', 'DESC']);
      } else {
        order.push(['created_at', 'DESC']); // Default to recent first
      }

      const candidates = await Candidate.findAll({ where, include, order });

      // Filter by status AFTER fetching (so all candidates are included)
      let filtered = candidates;
      if (status) {
        filtered = candidates.filter((c: any) => {
          const cvFile = c.cvFiles?.[0];
          return cvFile?.status === status;
        });
      }

      // Filter by tags if provided
      if (tags && Array.isArray(tags)) {
        filtered = filtered.filter((c: any) => {
          const candidateTags = c.tags?.map((t: any) => t.tag_name) || [];
          return tags.some((tag: string) => candidateTags.includes(tag));
        });
      }

      // Transform to frontend format
      const result = filtered.map((c: any) => {
        const cvFile = c.cvFiles?.[0];
        const matrix = c.matrices?.[0];
        const candidateTags = c.tags?.map((t: any) => t.tag_name) || [];

        return {
          id: c.id,
          name: c.name,
          email: c.email,
          phone: c.phone,
          country: c.country,
          countryCode: c.country_code,
          headline: c.headline,
          cvFile: cvFile
            ? {
                id: cvFile.id,
                candidateId: cvFile.candidate_id,
                filename: cvFile.filename,
                uploadedAt: cvFile.uploaded_at,
                status: cvFile.status,
                batchTag: cvFile.batch_tag,
                fileSize: cvFile.file_size,
              }
            : undefined,
          matrix: matrix
            ? {
                id: matrix.id,
                candidateId: matrix.candidate_id,
                skills: matrix.skills,
                roles: matrix.roles,
                totalYearsExperience: matrix.total_years_experience,
                domains: matrix.domains,
                education: matrix.education,
                languages: matrix.languages,
                locationSignals: matrix.location_signals,
                confidence: matrix.confidence,
                evidence: matrix.evidence,
                generatedAt: matrix.generated_at,
              }
            : undefined,
          createdAt: c.created_at,
          tags: candidateTags,
        };
      });

      // Filter by minScore if provided (would need match data)
      // For now, return all
      return result;
    });
  }

  async get(req: Request, res: Response) {
    await this.handleRequest(req, res, async () => {
      const { id } = req.params;

      const candidate = await Candidate.findByPk(id, {
        include: [
          { model: CvFile, as: 'cvFiles' },
          { model: CandidateMatrix, as: 'matrices' },
          { model: CandidateTag, as: 'tags' },
        ],
      });

      if (!candidate) {
        throw new Error('Candidate not found');
      }

      const c: any = candidate;
      const cvFile = c.cvFiles?.[0];
      const matrix = c.matrices?.[0];
      const candidateTags = c.tags?.map((t: any) => t.tag_name) || [];

      return {
        id: c.id,
        userId: c.user_id,
        name: c.name,
        email: c.email,
        phone: c.phone,
        country: c.country,
        countryCode: c.country_code,
        headline: c.headline,
        photoUrl: c.photo_url,
        bio: c.bio,
        linkedinUrl: c.linkedin_url,
        githubUrl: c.github_url,
        portfolioUrl: c.portfolio_url,
        cvFile: cvFile
          ? {
              id: cvFile.id,
              candidateId: cvFile.candidate_id,
              filename: cvFile.filename,
              uploadedAt: cvFile.uploaded_at,
              status: cvFile.status,
              batchTag: cvFile.batch_tag,
              fileSize: cvFile.file_size,
            }
          : undefined,
        matrix: matrix
          ? {
              id: matrix.id,
              candidateId: matrix.candidate_id,
              skills: matrix.skills,
              roles: matrix.roles,
              totalYearsExperience: matrix.total_years_experience,
              domains: matrix.domains,
              education: matrix.education,
              languages: matrix.languages,
              locationSignals: matrix.location_signals,
              confidence: matrix.confidence,
              evidence: matrix.evidence,
              generatedAt: matrix.generated_at,
            }
          : undefined,
        createdAt: c.created_at,
        tags: candidateTags,
      };
    });
  }

  async update(req: Request, res: Response) {
    await this.handleRequest(req, res, async () => {
      const { id } = req.params;
      const { name, email, phone, country, countryCode, headline } = req.body;

      const candidate = await Candidate.findByPk(id);
      if (!candidate) {
        const error: any = new Error('Candidate not found');
        error.status = 404;
        throw error;
      }

      await candidate.update({
        name,
        email,
        phone,
        country,
        country_code: countryCode || country,
        headline,
      });

      // Return updated candidate data
      const c: any = candidate;
      const cvFile = await CvFile.findOne({ where: { candidate_id: id } });
      const matrix = await CandidateMatrix.findOne({ where: { candidate_id: id } });
      const tags = await CandidateTag.findAll({ where: { candidate_id: id } });
      
      return {
        id: c.id,
        name: c.name,
        email: c.email,
        phone: c.phone,
        country: c.country,
        countryCode: c.country_code,
        headline: c.headline,
        cvFile: cvFile ? {
          id: cvFile.id,
          candidateId: cvFile.candidate_id,
          filename: cvFile.filename,
          uploadedAt: cvFile.uploaded_at,
          status: cvFile.status,
          batchTag: cvFile.batch_tag,
          fileSize: cvFile.file_size,
        } : undefined,
        matrix: matrix ? {
          id: matrix.id,
          candidateId: matrix.candidate_id,
          skills: matrix.skills,
          roles: matrix.roles,
          totalYearsExperience: matrix.total_years_experience,
          domains: matrix.domains,
          education: matrix.education,
          languages: matrix.languages,
          locationSignals: matrix.location_signals,
          confidence: matrix.confidence,
          evidence: matrix.evidence,
          generatedAt: matrix.generated_at,
        } : undefined,
        createdAt: c.created_at,
        tags: tags.map((t: any) => t.tag_name),
      };
    });
  }

  async upload(req: Request, res: Response) {
    await this.handleRequest(req, res, async () => {
      const files = req.files as Express.Multer.File[];
      const batchTag = req.body.batchTag;

      if (!files || files.length === 0) {
        const error: any = new Error('No files uploaded');
        error.status = 400;
        throw error;
      }

      console.log(`[Upload] Processing ${files.length} files in parallel...`);

      const result = {
        successful: 0,
        failed: 0,
        duplicates: 0,
        files: [] as any[],
      };

      // Process files in parallel with concurrency control
      const CONCURRENCY_LIMIT = parseInt(process.env.UPLOAD_CONCURRENCY || '10', 10); // Process 10 files at a time
      
      // Helper function to process a single file
      const processFile = async (file: Express.Multer.File): Promise<any> => {
        const startTime = Date.now();
        const fileName = file.originalname;
        let failureReason = '';
        let failureStep = '';
        
        try {
          console.log(`\n[Upload] ========================================`);
          console.log(`[Upload] Starting processing: ${fileName}`);
          console.log(`[Upload] File size: ${file.size} bytes`);
          
          // Step 1: Validate file path
          failureStep = 'File Path Validation';
          if (!file.path) {
            failureReason = 'File path not provided by multer';
            throw new Error(failureReason);
          }
          console.log(`[Upload] ✓ Step 1: File path validated: ${file.path}`);

          // Step 2: Check if file exists on disk
          failureStep = 'File Existence Check';
          const absoluteFilePath = path.isAbsolute(file.path) ? file.path : path.resolve(file.path);
          
          if (!existsSync(absoluteFilePath)) {
            failureReason = `File was not saved to disk at: ${absoluteFilePath}`;
            throw new Error(failureReason);
          }
          console.log(`[Upload] ✓ Step 2: File exists on disk`);

          // Step 3: Validate file size
          failureStep = 'File Size Validation';
          const stats = statSync(absoluteFilePath);
          const actualFileSize = stats.size;

          if (actualFileSize === 0) {
            failureReason = `File on disk is 0 bytes. Multer reported size: ${file.size}, Actual size: ${actualFileSize}`;
            throw new Error(failureReason);
          }
          console.log(`[Upload] ✓ Step 3: File size validated: ${actualFileSize} bytes`);

          // Use actual file size from disk
          const fileSizeToStore = actualFileSize > 0 ? actualFileSize : file.size;

          // Step 4: Extract text from PDF
          failureStep = 'PDF Text Extraction';
          let candidateInfo;
          let cvText: string | null = null;
          
          try {
            console.log(`[Upload] → Step 4: Extracting text from PDF...`);
            cvText = await pdfParserService.extractText(absoluteFilePath);
            
            if (!cvText || cvText.trim().length === 0) {
              failureReason = 'PDF text extraction returned empty content - PDF may be corrupted, password-protected, or image-based';
              throw new Error(failureReason);
            }
            console.log(`[Upload] ✓ Step 4: Extracted ${cvText.length} characters from PDF`);
          } catch (error: any) {
            failureReason = `PDF text extraction failed: ${error.message}`;
            console.error(`[Upload] ✗ Step 4 FAILED: ${failureReason}`);
            throw new Error(`Failed to extract text from PDF. ${failureReason}`);
          }

          // Step 5: Extract candidate info using Qwen
          failureStep = 'Candidate Info Extraction (Qwen)';
          try {
            console.log(`[Upload] → Step 5: Extracting candidate info using Qwen AI...`);
            candidateInfo = await qwenService.extractCandidateInfo(cvText);
            console.log(`[Upload] ✓ Step 5: Extracted info - Name: "${candidateInfo.name}", Email: "${candidateInfo.email || 'N/A'}"`);
          } catch (error: any) {
            failureReason = `Qwen AI extraction failed: ${error.message}`;
            console.error(`[Upload] ✗ Step 5 FAILED: ${failureReason}`);
            throw new Error(`Failed to extract candidate information from CV using AI. ${failureReason}`);
          }

          // Step 6: Validate extracted name
          failureStep = 'Name Validation';
          const extractedName = candidateInfo.name?.trim();
          if (!extractedName || 
              extractedName === 'Unknown' || 
              extractedName.length < 2 ||
              this.isInvalidName(extractedName)) {
            // Try to extract name directly from CV text as a last resort
            const directName = this.extractNameFromText(cvText || '');
            if (directName && !this.isInvalidName(directName)) {
              console.log(`[Upload] → Step 6: Using directly extracted name: "${directName}" (Qwen returned: "${extractedName}")`);
              candidateInfo.name = directName;
            } else {
              failureReason = `Invalid name extracted: "${extractedName}". Name must be a real person's name (not a hash, filename, or invalid value)`;
              console.error(`[Upload] ✗ Step 6 FAILED: ${failureReason}`);
              throw new Error(failureReason);
            }
          }
          console.log(`[Upload] ✓ Step 6: Name validated: "${candidateInfo.name}"`);

          // Step 7: Check for duplicate email
          failureStep = 'Duplicate Email Check';
          const candidateEmail = candidateInfo.email?.toLowerCase().trim();
          
          if (candidateEmail && candidateEmail !== '' && candidateEmail.includes('@')) {
            console.log(`[Upload] → Step 7: Checking for duplicate email: ${candidateEmail}...`);
            // Case-insensitive comparison that works in PostgreSQL.
            const existingCandidate = await Candidate.findOne({ 
              where: sequelize.where(
                sequelize.fn('LOWER', sequelize.col('email')),
                candidateEmail
              )
            });
            
            if (existingCandidate) {
              failureReason = `Duplicate email detected: ${candidateEmail} (candidate already exists: ${existingCandidate.name})`;
              console.log(`[Upload] ✗ Step 7: ${failureReason}`);
              return {
                filename: fileName,
                progress: 100,
                status: 'duplicate',
                error: failureReason,
                failureStep: failureStep,
              };
            }
            console.log(`[Upload] ✓ Step 7: No duplicate email found`);
          } else {
            console.warn(`[Upload] ⚠ Step 7: No valid email found in CV. Cannot verify duplicates by email.`);
          }

          // Step 8: Create candidate record
          failureStep = 'Database - Create Candidate';
          const finalEmail = candidateEmail && candidateEmail.includes('@') 
            ? candidateEmail 
            : `${candidateInfo.name.toLowerCase().replace(/\s+/g, '.')}@example.com`;
          
          let candidate;
          try {
            console.log(`[Upload] → Step 8: Creating candidate record in database...`);
            candidate = await Candidate.create({
              id: randomUUID(),
              name: candidateInfo.name,
              email: finalEmail,
              phone: candidateInfo.phone || '+1' + Math.floor(Math.random() * 9000000000 + 1000000000),
              country: candidateInfo.country || 'US',
              country_code: candidateInfo.countryCode || 'US',
              headline: candidateInfo.headline,
            });
            console.log(`[Upload] ✓ Step 8: Candidate created with ID: ${candidate.id}`);
          } catch (dbError: any) {
            // Handle race condition: if another process created candidate with same email
            if (dbError.name === 'SequelizeUniqueConstraintError' || 
                dbError.message?.includes('duplicate') || 
                dbError.message?.includes('unique')) {
              failureReason = `Duplicate email detected during creation (race condition): ${finalEmail}`;
              console.log(`[Upload] ✗ Step 8: ${failureReason}`);
              return {
                filename: fileName,
                progress: 100,
                status: 'duplicate',
                error: failureReason,
                failureStep: failureStep,
              };
            }
            failureReason = `Database error creating candidate: ${dbError.message}`;
            console.error(`[Upload] ✗ Step 8 FAILED: ${failureReason}`);
            throw dbError;
          }

          // Step 9: Create CV file record
          failureStep = 'Database - Create CV File';
          try {
            console.log(`[Upload] → Step 9: Creating CV file record...`);
            const cvFile = await CvFile.create({
              id: randomUUID(),
              candidate_id: candidate.id,
              filename: fileName,
              file_path: absoluteFilePath,
              file_size: fileSizeToStore,
              status: 'uploaded',
              batch_tag: batchTag,
            });
            console.log(`[Upload] ✓ Step 9: CV file created with ID: ${cvFile.id}`);

            // Trigger async processing for matrix generation (in background)
            this.processCvAsync(cvFile.id).catch((err) => {
              console.error(`[Upload] Background processing failed for ${fileName}:`, err);
            });

            const duration = Date.now() - startTime;
            console.log(`[Upload] ✓ SUCCESS: ${fileName} processed in ${duration}ms`);
            console.log(`[Upload] ========================================\n`);

            return {
              filename: fileName,
              progress: 100,
              status: 'success',
            };
          } catch (dbError: any) {
            failureReason = `Database error creating CV file: ${dbError.message}`;
            console.error(`[Upload] ✗ Step 9 FAILED: ${failureReason}`);
            throw dbError;
          }
        } catch (error: any) {
          const duration = Date.now() - startTime;
          const errorMessage = error.message || 'Unknown error';
          failureReason = failureReason || errorMessage;
          
          console.error(`[Upload] ✗ FAILED: ${fileName}`);
          console.error(`[Upload]   Failure Step: ${failureStep}`);
          console.error(`[Upload]   Error: ${failureReason}`);
          console.error(`[Upload]   Duration: ${duration}ms`);
          if (error.stack) {
            console.error(`[Upload]   Stack: ${error.stack.substring(0, 500)}`);
          }
          console.log(`[Upload] ========================================\n`);
          
          return {
            filename: fileName,
            progress: 100,
            status: 'failed',
            error: failureReason,
            failureStep: failureStep,
          };
        }
      };

      // Process files in batches with concurrency control
      const processBatch = async (batch: Express.Multer.File[]) => {
        const results = await Promise.allSettled(batch.map(file => processFile(file)));
        return results.map((result, index) => {
          if (result.status === 'fulfilled') {
            return result.value;
          } else {
            return {
              filename: batch[index].originalname,
              progress: 100,
              status: 'failed',
              error: result.reason?.message || 'Unknown error',
            };
          }
        });
      };

      // Process all files in batches
      for (let i = 0; i < files.length; i += CONCURRENCY_LIMIT) {
        const batch = files.slice(i, i + CONCURRENCY_LIMIT);
        console.log(`[Upload] Processing batch ${Math.floor(i / CONCURRENCY_LIMIT) + 1}/${Math.ceil(files.length / CONCURRENCY_LIMIT)} (${batch.length} files)`);
        const batchResults = await processBatch(batch);
        result.files.push(...batchResults);
        
        // Update counters
        batchResults.forEach((fileResult) => {
          if (fileResult.status === 'success') {
            result.successful++;
          } else if (fileResult.status === 'duplicate') {
            result.duplicates++;
          } else {
            result.failed++;
          }
        });
      }

      console.log(`\n[Upload] ========================================`);
      console.log(`[Upload] UPLOAD SUMMARY`);
      console.log(`[Upload] ========================================`);
      console.log(`[Upload] Total files processed: ${files.length}`);
      console.log(`[Upload] Successful: ${result.successful}`);
      console.log(`[Upload] Duplicates: ${result.duplicates}`);
      console.log(`[Upload] Failed: ${result.failed}`);
      console.log(`[Upload] ========================================\n`);

      // Group failures by error type for better analysis
      const failedFiles = result.files.filter(f => f.status === 'failed');
      if (failedFiles.length > 0) {
        console.log(`\n[Upload] ========================================`);
        console.log(`[Upload] FAILURE ANALYSIS (${failedFiles.length} failed files)`);
        console.log(`[Upload] ========================================`);
        
        // Group by error message
        const errorGroups: Record<string, string[]> = {};
        failedFiles.forEach(file => {
          const errorKey = file.error || 'Unknown error';
          if (!errorGroups[errorKey]) {
            errorGroups[errorKey] = [];
          }
          errorGroups[errorKey].push(file.filename);
        });

        // Print grouped errors
        Object.entries(errorGroups).forEach(([error, filenames]) => {
          console.log(`\n[Upload] Error: ${error}`);
          console.log(`[Upload]   Count: ${filenames.length} file(s)`);
          console.log(`[Upload]   Files:`);
          filenames.forEach(filename => {
            console.log(`[Upload]     - ${filename}`);
          });
        });

        // Print detailed failure list
        console.log(`\n[Upload] ========================================`);
        console.log(`[Upload] DETAILED FAILURE LIST`);
        console.log(`[Upload] ========================================`);
        failedFiles.forEach((file, index) => {
          console.log(`\n[Upload] ${index + 1}. ${file.filename}`);
          console.log(`[Upload]    Status: ${file.status}`);
          console.log(`[Upload]    Failure Step: ${file.failureStep || 'Unknown'}`);
          console.log(`[Upload]    Error: ${file.error || 'No error message'}`);
        });
        console.log(`[Upload] ========================================\n`);
      }

      // Group duplicates
      const duplicateFiles = result.files.filter(f => f.status === 'duplicate');
      if (duplicateFiles.length > 0) {
        console.log(`\n[Upload] ========================================`);
        console.log(`[Upload] DUPLICATE FILES (${duplicateFiles.length} files)`);
        console.log(`[Upload] ========================================`);
        duplicateFiles.forEach((file, index) => {
          console.log(`[Upload] ${index + 1}. ${file.filename}`);
          console.log(`[Upload]    Reason: ${file.error || 'Duplicate email'}`);
        });
        console.log(`[Upload] ========================================\n`);
      }

      return result;
    });
  }

  private async processCvAsync(cvFileId: string) {
    try {
      const cvFile = await CvFile.findByPk(cvFileId);
      if (!cvFile) {
        console.error(`CV file not found: ${cvFileId}`);
        return;
      }

      // Validate file path and size
      if (!cvFile.file_path) {
        console.error(`CV file has no file path: ${cvFileId}`);
        await cvFile.update({ status: 'failed' });
        return;
      }

      if (!cvFile.file_size || cvFile.file_size === 0) {
        console.error(`CV file has zero size: ${cvFileId}, path: ${cvFile.file_path}`);
        await cvFile.update({ status: 'failed' });
        return;
      }

      // Update status to parsing
      await cvFile.update({ status: 'parsing' });

      // Extract text from PDF
      const cvText = await pdfParserService.extractText(cvFile.file_path);

      // Generate matrix using Qwen
      const matrixData = await qwenService.generateCandidateMatrix(cvText);

      // Save matrix
      await CandidateMatrix.create({
        id: randomUUID(),
        candidate_id: cvFile.candidate_id,
        cv_file_id: cvFileId,
        skills: matrixData.skills || [],
        roles: matrixData.roles || [],
        total_years_experience: matrixData.totalYearsExperience || 0,
        domains: matrixData.domains || [],
        education: matrixData.education || [],
        languages: matrixData.languages || [],
        location_signals: matrixData.locationSignals || {},
        confidence: matrixData.confidence || 0,
        evidence: matrixData.evidence || [],
        qwen_model_version: qwenService.getModelVersion(),
      });

      // Update CV file status
      await cvFile.update({
        status: 'matrix_ready',
        processed_at: new Date(),
      });

      // Trigger automatic match calculation for all published jobs
      await this.triggerMatchCalculationForAllJobs(cvFile.candidate_id);
    } catch (error: any) {
      console.error('CV processing failed:', error);
      const cvFile = await CvFile.findByPk(cvFileId);
      if (cvFile) {
        await cvFile.update({ status: 'failed' });
      }
    }
  }

  private async triggerMatchCalculationForAllJobs(candidateId: string) {
    try {
      // Import here to avoid circular dependency
      const { Job, JobMatrix } = await import('../db/models/index.js');
      const { matchController } = await import('./matchController.js');
      
      // Get all published jobs with matrices
      const jobs = await Job.findAll({
        where: { status: 'published' },
        include: [
          {
            model: JobMatrix,
            as: 'matrix',
            required: true,
          },
        ],
      });

      // Calculate matches for each job
      for (const job of jobs) {
        await matchController.calculateMatchForCandidateAndJob(candidateId, job.id);
      }
    } catch (error: any) {
      console.error('Failed to trigger match calculation:', error);
    }
  }

  async delete(req: Request, res: Response) {
    await this.handleRequest(req, res, async () => {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      if (!id) {
        throw new Error('Candidate ID is required');
      }

      const candidate = await Candidate.findByPk(id);
      if (!candidate) {
        const error: any = new Error('Candidate not found');
        error.status = 404;
        throw error;
      }

      // Delete associated records (cascade)
      await CvFile.destroy({ where: { candidate_id: id } });
      await CandidateMatrix.destroy({ where: { candidate_id: id } });
      await CandidateTag.destroy({ where: { candidate_id: id } });
      
      // Delete candidate
      await candidate.destroy();

      return { message: 'Candidate deleted successfully' };
    });
  }

  async getMatrix(req: Request, res: Response) {
    await this.handleRequest(req, res, async () => {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      if (!id) {
        throw new Error('Candidate ID is required');
      }

      const matrix = await CandidateMatrix.findOne({
        where: { candidate_id: id },
      });

      if (!matrix) {
        const error: any = new Error('Matrix not found');
        error.status = 404;
        throw error;
      }

      return {
        id: matrix.id,
        candidateId: matrix.candidate_id,
        skills: matrix.skills,
        roles: matrix.roles,
        totalYearsExperience: matrix.total_years_experience,
        domains: matrix.domains,
        education: matrix.education,
        languages: matrix.languages,
        locationSignals: matrix.location_signals,
        confidence: matrix.confidence,
        evidence: matrix.evidence,
        generatedAt: matrix.generated_at,
      };
    });
  }

  async rerunMatching(req: Request, res: Response) {
    await this.handleRequest(req, res, async () => {
      const candidateId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const regenerateMatrix = req.query.regenerateMatrix === 'true' || req.body?.regenerateMatrix === true;

      if (!candidateId) {
        throw new Error('Candidate ID is required');
      }

      // Verify candidate exists
      const candidate = await Candidate.findByPk(candidateId, {
        include: [
          { model: CandidateMatrix, as: 'matrices', required: false },
          { model: CvFile, as: 'cvFiles', required: false },
        ],
      });

      if (!candidate) {
        const error: any = new Error('Candidate not found');
        error.status = 404;
        throw error;
      }

      const matrices = (candidate as any).matrices;
      if (!matrices || matrices.length === 0) {
        const error: any = new Error('Candidate has no matrix. CV must be processed first.');
        error.status = 400;
        throw error;
      }

      console.log(`[CandidateController] Re-running matching for candidate ${candidateId} (${candidate.name}), regenerateMatrix=${regenerateMatrix}`);

      // Trigger the full pipeline in background
      (async () => {
        try {
          // Step 1: Optionally regenerate the candidate matrix with improved LLM prompt
          if (regenerateMatrix) {
            const cvFile = (candidate as any).cvFiles?.[0];
            if (cvFile && cvFile.raw_text) {
              console.log(`[CandidateController] Step 1: Regenerating candidate matrix via LLM...`);
              const newMatrix = await qwenService.generateCandidateMatrix(cvFile.raw_text);
              
              // Update existing matrix
              const existingMatrix = matrices[0];
              await existingMatrix.update({
                skills: newMatrix.skills || [],
                roles: newMatrix.roles || [],
                total_years_experience: newMatrix.totalYearsExperience || 0,
                domains: newMatrix.domains || [],
                education: newMatrix.education || [],
                languages: newMatrix.languages || [],
                location_signals: newMatrix.locationSignals || {},
                evidence: newMatrix.evidence || [],
                confidence: newMatrix.confidence || 0,
                generated_at: new Date(),
              });
              
              console.log(`[CandidateController] ✓ Matrix regenerated with ${newMatrix.skills?.length || 0} skills, ${newMatrix.domains?.length || 0} domains`);
            } else {
              console.warn(`[CandidateController] Cannot regenerate matrix: no CV text available`);
            }
          }

          // Step 2: Calculate matches against all jobs using LLM
          console.log(`[CandidateController] Step 2: Running LLM-based matching against all jobs...`);
          await this.triggerMatchCalculationForAllJobs(candidateId);
          console.log(`[CandidateController] ✓ Matching complete for candidate ${candidateId}`);
        } catch (err) {
          console.error(`[CandidateController] ✗ Re-run failed for candidate ${candidateId}:`, err);
        }
      })();

      return { message: 'Matching re-run initiated (LLM-based evaluation)', candidateId, regenerateMatrix };
    });
  }
}

export const candidateController = new CandidateController();
