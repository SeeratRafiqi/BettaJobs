import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

interface QwenResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

// ============================================================
//  AI INTERVIEW CONDUCTOR — State machine types (exported for controller use)
// ============================================================

export type InterviewPhase =
  | 'greeting'
  | 'small_talk'
  | 'context_setting'
  | 'ready_check'
  | 'interview'
  | 'closing';

export interface InterviewState {
  phase: InterviewPhase;
  questionIndex: number;
  smallTalkTurns: number;
  conversationHistory: { role: 'user' | 'assistant'; content: string }[];
  questions: string[];
  candidateName: string;
  jobTitle: string;
  interviewerName?: string;
  preferredLanguage?: string;
  /** Set when we offered reschedule due to technical issues; next "yes" ends the call. */
  rescheduleOffered?: boolean;
}

export class QwenService {
  private apiKey: string;
  private apiUrl: string;
  private model: string;
  private maxRetries: number = 3;

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

  constructor() {
    this.apiKey = process.env.ALIBABA_LLM_API_KEY || process.env.DASHSCOPE_API_KEY || '';
    this.apiUrl = process.env.ALIBABA_LLM_API_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    this.model = process.env.QWEN_MODEL || 'qwen-turbo';

    if (!this.apiKey) {
      console.warn('ALIBABA_LLM_API_KEY (or DASHSCOPE_API_KEY) not set. AI features disabled.');
    }
  }

  /** Token usage from Alibaba DashScope (when available). Used for real-time cost. */
  private static normalizeUsage(raw: any): { input_tokens: number; output_tokens: number; total_tokens: number } | undefined {
    if (!raw) return undefined;
    const input = Number(raw.prompt_tokens ?? raw.input_tokens ?? 0) || 0;
    const output = Number(raw.completion_tokens ?? raw.output_tokens ?? 0) || 0;
    const total = Number(raw.total_tokens) || input + output;
    return total > 0 ? { input_tokens: input, output_tokens: output, total_tokens: total } : undefined;
  }

  /** One attempt: call API and return content + optional token usage. */
  private async callQwenOnce(prompt: string, jsonMode: boolean): Promise<{ content: string; usage?: { input_tokens: number; output_tokens: number; total_tokens: number } }> {
    const endpoint = this.apiUrl.endsWith('/chat/completions')
      ? this.apiUrl
      : `${this.apiUrl}/chat/completions`;
    const requestBody: any = {
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
    };
    if (jsonMode) requestBody.response_format = { type: 'json_object' };

    const response = await axios.post<QwenResponse>(endpoint, requestBody, {
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      timeout: 60000,
    });

    const usage = QwenService.normalizeUsage((response.data as any).usage);
    if (usage) {
      console.log(`[Qwen] Token usage:`, usage);
    }

    const content = response.data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty response from Qwen API');

    if (jsonMode) {
      try {
        const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) || content.match(/```\n([\s\S]*?)\n```/);
        const jsonString = jsonMatch ? jsonMatch[1] : content;
        const parsed = JSON.parse(jsonString);
        return { content: JSON.stringify(parsed), usage };
      } catch {
        return { content, usage };
      }
    }
    return { content, usage };
  }

  private async callQwen(prompt: string, jsonMode: boolean = true): Promise<string> {
    if (!this.apiKey) {
      throw new Error('ALIBABA_LLM_API_KEY not configured. Set it in .env for AI features.');
    }
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        console.log(`[Qwen] API call attempt ${attempt}/${this.maxRetries}`);
        const { content } = await this.callQwenOnce(prompt, jsonMode);
        return content;
      } catch (error: any) {
        lastError = error;
        console.error(`[Qwen] API call failed (attempt ${attempt}/${this.maxRetries}):`, error.message);
        if (attempt < this.maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
        }
      }
    }
    throw lastError || new Error('Qwen API call failed after retries');
  }

  /** Like callQwen but returns token usage when Alibaba provides it (for real-time cost). */
  private async callQwenWithUsage(prompt: string, jsonMode: boolean = true): Promise<{ content: string; usage?: { input_tokens: number; output_tokens: number; total_tokens: number } }> {
    if (!this.apiKey) {
      throw new Error('ALIBABA_LLM_API_KEY not configured. Set it in .env for AI features.');
    }
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.callQwenOnce(prompt, jsonMode);
      } catch (error: any) {
        lastError = error;
        if (attempt < this.maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
        }
      }
    }
    throw lastError || new Error('Qwen API call failed after retries');
  }

  /**
   * Call Qwen with full conversation history (system + user/assistant messages).
   * Use this when the model needs to see prior turns to stay in context (e.g. voice interview).
   * Returns content and usage for cost tracking.
   */
  private async callQwenWithMessages(
    systemPrompt: string,
    messages: { role: 'user' | 'assistant'; content: string }[],
    jsonMode: boolean = true
  ): Promise<{ content: string; usage?: { input_tokens: number; output_tokens: number; total_tokens: number } }> {
    if (!this.apiKey) {
      throw new Error('ALIBABA_LLM_API_KEY not configured. Set it in .env for AI features.');
    }
    const endpoint = this.apiUrl.endsWith('/chat/completions')
      ? this.apiUrl
      : `${this.apiUrl}/chat/completions`;
    const fullMessages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];
    const requestBody: any = {
      model: this.model,
      messages: fullMessages,
    };
    if (jsonMode) {
      requestBody.response_format = { type: 'json_object' };
    }
    const response = await axios.post<QwenResponse>(endpoint, requestBody, {
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      timeout: 60000,
    });
    const usage = QwenService.normalizeUsage((response.data as any).usage);
    const content = response.data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty response from Qwen API');
    let out = content;
    if (jsonMode) {
      try {
        const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) || content.match(/```\n([\s\S]*?)\n```/);
        const jsonString = jsonMatch ? jsonMatch[1] : content;
        const parsed = JSON.parse(jsonString);
        out = JSON.stringify(parsed);
      } catch {
        // keep out = content
      }
    }
    return { content: out, usage };
  }

  async extractCandidateInfo(cvText: string): Promise<{
    name: string;
    email?: string;
    phone?: string;
    country?: string;
    countryCode?: string;
    headline?: string;
  }> {
    // Use more text (first 5000 chars) to ensure we capture the name and contact info
    // Most CVs have name and contact info in the first 1000-2000 chars, but some have longer headers
    const cvTextToUse = cvText.substring(0, 5000);
    
    console.log(`[Qwen] Extracting candidate info from CV (using ${cvTextToUse.length} chars of ${cvText.length} total)`);
    console.log(`[Qwen] First 500 chars of CV: ${cvTextToUse.substring(0, 500)}`);
    
    const prompt = `You are a CV parsing expert. Extract the candidate's personal information from this CV:

${cvTextToUse}

Extract the following information:
- Full name (the candidate's actual name, not the filename - look for the largest/most prominent name at the top of the CV)
- Email address (if available)
- Phone number (if available, include country code)
- Country (current location or country code)
- Country code (2-letter ISO code like "US", "UK", "SG", etc.)
- Professional headline or title (if available, e.g., "Senior Software Engineer", "Data Analyst Intern")
  * Look for phrases like "Data Analyst Intern", "Seeking Software Engineer Intern position"
  * This is critical for matching - an intern candidate should have "Intern" in their headline
  * If the CV says "seeking X position" or mentions internship/trainee role, include that in the headline

Return a JSON object with this exact structure:
{
  "name": "John Doe",
  "email": "john.doe@example.com",
  "phone": "+1234567890",
  "country": "United States",
  "countryCode": "US",
  "headline": "Senior Software Engineer"
}

CRITICAL RULES FOR NAME EXTRACTION:
- The name MUST be extracted from the CV content itself, NEVER from the filename
- Look at the very top of the CV - the candidate's name is usually the largest, most prominent text
- The name should be a real person's name (2-4 words typically, containing letters)
- DO NOT use hash-like strings, file paths, or random alphanumeric sequences as names
- If the name looks like a hash (long string of letters/numbers), it's WRONG - look harder in the CV
- The name should start with a capital letter and contain proper name-like words
- If you truly cannot find a valid name in the CV content, return "Unknown" (but this should be rare)

IMPORTANT:
- headline: Extract the candidate's current or desired role/title. If the CV mentions "seeking Data Analyst Intern position" or similar, include "Intern" in the headline
- If any field is not found in the CV, use null for that field (except name - try harder to find it)
- Return ONLY valid JSON, no additional text or markdown formatting

Return ONLY valid JSON, no additional text.`;

    try {
      // callQwen with jsonMode=true returns a JSON string
      const responseJson = await this.callQwen(prompt, true);
      console.log(`[Qwen] Raw response (JSON string): ${responseJson}`);
      
      // Parse the JSON string returned by callQwen
      let parsed: any;
      try {
        parsed = JSON.parse(responseJson);
      } catch (parseError: any) {
        // If parsing fails, try to clean markdown code blocks
        console.warn(`[Qwen] Initial parse failed, trying to clean response: ${parseError.message}`);
        let cleanedResponse = responseJson.trim();
        if (cleanedResponse.startsWith('```json')) {
          cleanedResponse = cleanedResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
        } else if (cleanedResponse.startsWith('```')) {
          cleanedResponse = cleanedResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
        }
        parsed = JSON.parse(cleanedResponse);
      }
      
      console.log(`[Qwen] Parsed candidate info:`, parsed);
      
      // Validate and clean the extracted name
      let extractedName = parsed.name?.trim() || '';
      
      // Validate name - reject if it looks like a hash or invalid
      if (!extractedName || 
          extractedName === 'Unknown' ||
          extractedName.length < 2 ||
          this.isInvalidName(extractedName)) {
        console.warn(`[Qwen] WARNING: Extracted name "${extractedName}" appears invalid. First 500 chars: ${cvTextToUse.substring(0, 500)}`);
        // Try to extract name directly from text
        const directName = this.extractNameFromText(cvTextToUse);
        if (directName && !this.isInvalidName(directName)) {
          console.log(`[Qwen] Using directly extracted name: ${directName}`);
          extractedName = directName;
        } else {
          extractedName = 'Unknown';
        }
      }
      
      const result = {
        name: extractedName,
        email: parsed.email || undefined,
        phone: parsed.phone || undefined,
        country: parsed.country || 'US',
        countryCode: parsed.countryCode || 'US',
        headline: parsed.headline || undefined,
      };
      
      // If name is still "Unknown", log a warning
      if (result.name === 'Unknown') {
        console.warn(`[Qwen] WARNING: Could not extract valid name from CV. First 500 chars: ${cvTextToUse.substring(0, 500)}`);
      }
      
      console.log(`[Qwen] Final extracted info:`, result);
      return result;
    } catch (error: any) {
      console.error('[Qwen] Failed to extract candidate info from CV:', error);
      console.error('[Qwen] Error details:', error.message);
      if (error.stack) {
        console.error('[Qwen] Error stack:', error.stack);
      }
      if (error.response) {
        console.error('[Qwen] API response:', error.response.data);
      }
      // Fallback to defaults
      return {
        name: 'Unknown',
        country: 'US',
        countryCode: 'US',
      };
    }
  }

  async generateCandidateMatrix(cvText: string): Promise<any> {
    const prompt = `You are a CV parsing expert. Extract ALL structured information from this CV thoroughly and accurately.

${cvText}

Return a JSON object with this exact structure:
{
  "skills": [{"name": "JavaScript", "level": "advanced", "yearsOfExperience": 5}],
  "roles": ["Software Engineer", "Tech Lead"],
  "totalYearsExperience": 8,
  "domains": ["FinTech", "SaaS", "AI/ML", "Web Development"],
  "education": [{"degree": "BSc Computer Science", "institution": "MIT", "year": 2015}],
  "languages": [{"language": "English", "proficiency": "Native"}],
  "locationSignals": {
    "currentCountry": "US",
    "willingToRelocate": true,
    "preferredLocations": ["US", "UK"]
  },
  "evidence": [
    {"id": "ev-1", "text": "Led team of 5 engineers...", "category": "Leadership", "source": "Work Experience"}
  ],
  "confidence": 85
}

CRITICAL EXPERIENCE EXTRACTION RULES:
1. "totalYearsExperience" counts ONLY paid/professional work experience:
   - Full-time employment ✅
   - Part-time employment ✅
   - Freelance / contract / consulting work (paid client work) ✅
   - Internships at a company (count actual duration) ✅
   - Co-op / work-integrated learning at a company ✅
2. DO NOT count these as professional experience:
   - University/college club roles (e.g., "Machine Learning Lead at GDG UPM") ❌
   - Hackathon participations ❌
   - Course/university group projects ❌
   - Personal/side projects (not paid) ❌
   - Volunteer roles ❌
   - Event organizing, emcee, committee roles ❌
   - Workshop participation ❌
3. Calculate total years by summing durations of ONLY paid/professional work
4. Be ACCURATE — count months and convert to years. Round to nearest integer.
   - E.g., 5 months internship = 0.4 years → round to 0
   - E.g., 8 months internship + 6 months job = 1.2 years → round to 1
   - E.g., 18 months of employment = 1.5 → round to 2
5. Look at dates carefully: if someone worked from Jan 2022 to Dec 2024, that is 3 years
6. If a candidate is a current student with only a short internship, totalYearsExperience should likely be 0 or 1

CRITICAL SKILL EXTRACTION RULES:
1. Extract EVERY technical skill mentioned — include ALL programming languages, frameworks, libraries, tools, platforms, databases, cloud services, APIs, methodologies
2. Include BOTH explicit skills AND implied skills:
   - If CV mentions "built chatbot using OpenAI API" → extract skills: "OpenAI API", "LLM", "Chatbot Development", "Generative AI"
   - If CV mentions "fine-tuned BERT model" → extract: "BERT", "NLP", "Transfer Learning", "Deep Learning", "Machine Learning"
   - If CV mentions "RAG pipeline" → extract: "RAG", "LLM", "Vector Database", "Information Retrieval"
   - If CV mentions "trained neural networks" → extract: "Neural Networks", "Deep Learning", "Machine Learning"
   - If CV mentions "deployed on AWS Lambda" → extract: "AWS", "AWS Lambda", "Serverless", "Cloud Computing"
   - If CV mentions "React dashboard" → extract: "React", "JavaScript", "Frontend Development"
   - If CV mentions "Node.js backend" or "Express API" → extract: "Node.js", "Express.js", "Backend Development", "REST API"
   - If CV mentions "full-stack" or built both frontend + backend → extract: "Full-Stack Development"
3. For AI/ML candidates, specifically look for and extract:
   - LLM-related: LLM, GPT, OpenAI, Claude, Prompt Engineering, Fine-tuning, RAG, LangChain, Vector DB, Embeddings
   - ML frameworks: TensorFlow, PyTorch, Scikit-learn, Keras, Hugging Face, Transformers
   - ML domains: NLP, Computer Vision, Generative AI, Reinforcement Learning, Data Science
   - Data tools: Pandas, NumPy, Jupyter, MLflow, Weights & Biases
4. Set skill levels based on EVIDENCE in the CV:
   - "expert": 5+ years professional use with deep specialization
   - "advanced": 3-5 years professional use OR 2+ years with significant production projects
   - "intermediate": 1-3 years professional use OR extensive project/academic use
   - "beginner": Only used in coursework, hackathons, or basic exposure
   - IMPORTANT: University course projects and hackathons indicate "beginner" to "intermediate" at most
   - Only rate as "advanced" or "expert" if there is evidence of professional/production use
5. Include the number of years of experience for each skill if inferable

CRITICAL DOMAIN EXTRACTION:
- Extract ALL relevant industry domains AND technology domains
- Technology domains: "AI/ML", "Generative AI", "Web Development", "Mobile Development", "Cloud Computing", "Data Engineering", "DevOps", "Cybersecurity", "Blockchain", etc.
- Industry domains: "FinTech", "Healthcare", "E-commerce", "SaaS", "Education", "Gaming", etc.
- Be thorough: if candidate worked on AI projects, include "AI/ML" AND "Generative AI" (if applicable) in domains

CRITICAL ROLES EXTRACTION:
- Extract all roles the candidate has held
- Include the most senior / most recent role prominently
- Include both formal job titles AND functional roles (e.g., if someone did full-stack work, include "Full-Stack Developer")

Return ONLY valid JSON, no additional text.`;

    const response = await this.callQwen(prompt, true);
    return JSON.parse(response);
  }

  async generateJobMatrix(
    title: string,
    description: string,
    mustHaveSkills: string[],
    niceToHaveSkills: string[]
  ): Promise<any> {
    const prompt = `Analyze this job posting and extract structured requirements. Be THOROUGH — extract every technical requirement.

Title: ${title}
Description: ${description}
Must-have skills: ${mustHaveSkills.join(', ')}
Nice-to-have skills: ${niceToHaveSkills.join(', ')}

Return a JSON object with this exact structure:
{
  "requiredSkills": [{"skill": "JavaScript", "weight": 85}],
  "preferredSkills": [{"skill": "TypeScript", "weight": 60}],
  "experienceWeight": 20,
  "locationWeight": 15,
  "domainWeight": 10,
  "semanticKeywords": ["generative AI", "large language models", "machine learning", "backend development"]
}

CRITICAL RULES:
1. The "weight" field (0-100) indicates how IMPORTANT each skill is for THIS specific job
2. CORE/PRIMARY skills MUST have weight 85-95
3. SECONDARY skills should have weight 60-80
4. GENERIC skills should have weight 30-50
5. Do NOT include pure soft skills in requiredSkills — only technical skills
6. Use EXACT technology names — "React" ≠ "React Native", "Angular" ≠ "AngularJS"

MATCHING WEIGHT RULES (experienceWeight, locationWeight, domainWeight):
- These control how much each factor matters when matching candidates to this job
- experienceWeight MUST vary by seniority level:
  * INTERNSHIP roles (title contains "Intern" or 0 years required): experienceWeight = 5 (experience barely matters)
  * JUNIOR roles (1-2 years required): experienceWeight = 10
  * MID-LEVEL roles (2-5 years required): experienceWeight = 20
  * SENIOR roles (5+ years required): experienceWeight = 25
  * LEAD/PRINCIPAL roles (7+ years required): experienceWeight = 30
- For internships, skills matter most — set experienceWeight LOW (5)

IMPORTANT — "semanticKeywords" field:
- Extract 5-15 semantic keywords/phrases that describe what this job is REALLY about
- Include technology themes: "generative AI", "machine learning", "full-stack web development", "cloud infrastructure"
- Include domain themes: "fintech", "healthcare", "SaaS"
- Include methodology themes: "agile", "microservices architecture", "CI/CD"
- These keywords help with semantic matching — a candidate with "LLM" experience should match a "Generative AI" job
- Think broadly: what kind of technical background would be ideal for this role?

For AI/ML jobs specifically:
- Include both specific skills (e.g., "PyTorch", "LangChain") AND broader categories (e.g., "Deep Learning", "LLM")
- A "GenAI Engineer" job should have semanticKeywords like: ["generative AI", "large language models", "LLM", "prompt engineering", "AI/ML", "deep learning", "NLP"]
- Include related/adjacent skills that a good candidate would likely have

Return ONLY valid JSON, no additional text.`;

    const response = await this.callQwen(prompt, true);
    return JSON.parse(response);
  }

  /**
   * LLM-based match evaluation — the LLM directly scores the candidate-job match.
   * This replaces the deterministic scoring with semantic understanding.
   * The LLM can understand that "GenAI" ≈ "LLM" ≈ "Generative AI" etc.
   */
  async evaluateMatch(
    candidateMatrix: any,
    jobMatrix: any,
    jobInfo: {
      title: string;
      description: string;
      department?: string;
      seniorityLevel?: string;
      minYearsExperience?: number;
      locationType?: string;
      country?: string;
    },
    candidateInfo: {
      name: string;
      headline?: string;
      country?: string;
      roles?: string[];
    }
  ): Promise<{
    score: number;
    breakdown: { skills: number; experience: number; domain: number; location: number };
    explanation: string;
    gaps: any[];
  }> {
    // Build a concise candidate summary from the matrix
    const candidateSkills = (candidateMatrix.skills || [])
      .map((s: any) => {
        const name = s.name || s;
        const level = s.level ? ` (${s.level})` : '';
        const years = s.yearsOfExperience ? ` ${s.yearsOfExperience}y` : '';
        return `${name}${level}${years}`;
      })
      .join(', ');

    const jobRequiredSkills = (jobMatrix.required_skills || [])
      .map((s: any) => {
        const skill = s.skill || s;
        const weight = s.weight ? ` [importance: ${s.weight}/100]` : '';
        return `${skill}${weight}`;
      })
      .join(', ');

    const jobPreferredSkills = (jobMatrix.preferred_skills || [])
      .map((s: any) => {
        const skill = s.skill || s;
        const weight = s.weight ? ` [importance: ${s.weight}/100]` : '';
        return `${skill}${weight}`;
      })
      .join(', ');

    // Determine seniority levels for gap calculation
    const seniorityLevels: Record<string, number> = {
      'internship': 0, 'intern': 0, 'student': 0, 'fresh graduate': 0,
      'junior': 1, 'entry': 1,
      'mid': 2, 'mid-level': 2, 'intermediate': 2,
      'senior': 3,
      'lead': 4, 'staff': 4, 'principal': 5, 'architect': 5,
    };

    // Infer candidate seniority from experience + roles
    const candidateYears = candidateMatrix.total_years_experience || 0;
    const candidateRoles = (candidateInfo.roles || candidateMatrix.roles || []).map((r: string) => r.toLowerCase());
    
    // Detect student/intern candidates from headline and roles
    const headlineLower = (candidateInfo.headline || '').toLowerCase();
    const studentKeywords = ['student', 'undergraduate', 'undergrad', 'fresh grad', 'fresh graduate', 'intern', 'trainee'];
    const hasStudentHeadline = studentKeywords.some(kw => headlineLower.includes(kw));
    const hasStudentRole = candidateRoles.some((r: string) => 
      ['student', 'intern', 'trainee', 'fresh graduate', 'undergraduate'].includes(r) ||
      r.includes('student') || r.includes('undergraduate')
    );
    
    // Flag as student/intern if:
    // 1. They have 0-1 years experience AND headline/roles suggest student, OR
    // 2. They have 0 years experience (regardless of headline)
    const isStudent = (candidateYears <= 1 && (hasStudentHeadline || hasStudentRole)) || candidateYears === 0;
    
    let candidateSeniorityLevel = 2; // default mid
    if (isStudent) candidateSeniorityLevel = 0;
    else if (candidateYears <= 2) candidateSeniorityLevel = 1;
    else if (candidateYears <= 5) candidateSeniorityLevel = 2;
    else if (candidateYears <= 8) candidateSeniorityLevel = 3;
    else candidateSeniorityLevel = 4;

    const jobSeniorityStr = (jobInfo.seniorityLevel || 'mid').toLowerCase();
    const jobSeniorityLevel = seniorityLevels[jobSeniorityStr] !== undefined ? seniorityLevels[jobSeniorityStr] : 2;
    const seniorityGap = jobSeniorityLevel - candidateSeniorityLevel; // positive = under-qualified, negative = overqualified
    const isInternshipJob = jobSeniorityStr === 'internship' || jobSeniorityStr === 'intern' || (jobInfo.minYearsExperience === 0 && jobInfo.title?.toLowerCase().includes('intern'));

    // Dynamic weights based on job seniority level
    let skillsWeight = 35;
    let experienceWeight = 30;
    let domainWeight = 15;
    let locationWeight = 20;
    
    if (isInternshipJob) {
      // For internships: skills matter most, experience barely matters
      skillsWeight = 50;
      experienceWeight = 10;
      domainWeight = 15;
      locationWeight = 25;
    } else if (jobSeniorityLevel <= 1) {
      // Junior: skills still most important
      skillsWeight = 40;
      experienceWeight = 20;
      domainWeight = 15;
      locationWeight = 25;
    } else if (jobSeniorityLevel >= 4) {
      // Lead/Principal: experience matters a lot
      skillsWeight = 30;
      experienceWeight = 35;
      domainWeight = 15;
      locationWeight = 20;
    }

    const prompt = `You are an expert technical recruiter. Evaluate how well this candidate matches this specific job.
Be fair and balanced — not too harsh, not too generous. Each job is different, so scores MUST vary per job.

=== CANDIDATE PROFILE ===
Name: ${candidateInfo.name}
Headline: ${candidateInfo.headline || 'Not specified'}
Country: ${candidateInfo.country || 'Unknown'}
Total Experience: ${candidateMatrix.total_years_experience || 0} years
Roles: ${JSON.stringify(candidateInfo.roles || candidateMatrix.roles || [])}
Domains: ${JSON.stringify(candidateMatrix.domains || [])}
Skills: ${candidateSkills}
Education: ${JSON.stringify(candidateMatrix.education || [])}
Location Preferences: ${JSON.stringify(candidateMatrix.location_signals || {})}

=== JOB REQUIREMENTS ===
Title: ${jobInfo.title}
Department: ${jobInfo.department || 'Not specified'}
Seniority Level: ${jobInfo.seniorityLevel || 'Not specified'}
Min Years Experience Required: ${jobInfo.minYearsExperience !== undefined ? jobInfo.minYearsExperience : 'Not specified'}
Location Type: ${jobInfo.locationType || 'Not specified'}
Job Country: ${jobInfo.country || 'Not specified'}
Required Skills: ${jobRequiredSkills}
Preferred Skills: ${jobPreferredSkills}
Job Description (excerpt): ${(jobInfo.description || '').substring(0, 2000)}

=== SENIORITY CONTEXT ===
Candidate Experience Level: ${candidateYears} years${isStudent ? ' (Student/Undergraduate)' : ''}
Job Seniority: ${jobSeniorityStr} (requires ${jobInfo.minYearsExperience || 0}+ years)
${seniorityGap > 0 ? `⚠ The candidate is ${seniorityGap} level(s) BELOW the job requirement (under-qualified).` : seniorityGap < 0 && isInternshipJob ? `⚠ The candidate is ${Math.abs(seniorityGap)} level(s) ABOVE the job requirement (overqualified). An experienced developer applying for an internship is a BAD fit.` : seniorityGap < 0 ? `✅ The candidate EXCEEDS the experience requirement by ${Math.abs(seniorityGap)} level(s). This is a POSITIVE — more experience is better for this role.` : 'Seniority levels are a good match.'}

=== SCORING INSTRUCTIONS ===
Score this candidate against THIS SPECIFIC JOB in 4 dimensions (each 0-100).
CRITICAL: The same candidate should score VERY DIFFERENTLY for different jobs. A student might score 75 for an internship but 30 for a senior role.
${isInternshipJob ? 'An experienced developer (3+ years) is a BAD fit for this internship — they should score LOW.' : 'For this role, more experience is ALWAYS better. Never penalize a candidate for having too much experience.'}

1. **skills** (0-100): How well do the candidate's skills match the job's required and preferred skills?
   - Use SEMANTIC matching: "GenAI" ≈ "Generative AI" ≈ "LLM", "React" implies JavaScript
   - Consider skill transferability between related technologies
   - Weight by importance: core required skills matter more than nice-to-haves
   - Count ALL forms of skill evidence: professional, freelance, consulting, real projects, open source
   - Score 85-100: Has most required skills with strong depth and evidence
   - Score 70-84: Has most required skills with moderate depth
   - Score 50-69: Has some required skills, missing some key ones
   - Score 30-49: Has few relevant skills, significant gaps
   - Score 0-29: Almost no relevant skills

2. **experience** (0-100): Does the candidate's experience level match what THIS JOB requires?
   - UNDER-QUALIFIED scoring (candidate has LESS experience than required):
     * Experience matches job requirement: 80-100
     * 1-2 years short but has relevant work: 55-75
     * 3-4 years short: 30-50
     * 5+ years short: 10-30
     * Student/0 years for internship: 80-95 (great fit!)
     * Student/0 years for mid-level: 25-40
     * Student/0 years for senior: 10-25
${isInternshipJob ? `   - ⚠️ OVERQUALIFIED — CRITICAL: This is an INTERNSHIP meant for students and fresh graduates.
     * An experienced developer is OVERQUALIFIED and a BAD fit for an internship.
     * 2 years experience → experience score: 30-40
     * 3+ years experience → experience score: 15-25
     * 5+ years experience → experience score: 5-15
     * The OVERALL score for an experienced developer on an internship should be LOW (below 30).` : `   - OVERQUALIFIED scoring (candidate has MORE experience than required):
     * For mid/senior/lead/principal jobs: MORE experience is ALWAYS a POSITIVE.
     * A candidate with 12 years applying for a mid-level (3+ years) role → experience score: 90-100 (exceeds requirements!)
     * A candidate with 8 years for a senior (5+ years) role → experience score: 95-100
     * NEVER penalize a candidate for having too much experience for non-internship jobs.
     * More experience = higher experience score, always.`}

3. **domain** (0-100): Does the candidate's domain/industry experience align?
   - Same domain = 80-100
   - Related domain = 55-75 (e.g., AI/ML ↔ Data Science, Web Dev ↔ SaaS)
   - Different but transferable = 35-55
   - Completely unrelated = 10-30

4. **location** (0-100): Does the location match?
   - Remote jobs = 100
   - Same country = 100
   - Willing to relocate = 70-80
   - Different country, onsite, not relocating = 20-30

=== OVERALL SCORE CALCULATION ===
Calculate the weighted average using these weights:
- skills: ${skillsWeight}% weight
- experience: ${experienceWeight}% weight
- domain: ${domainWeight}% weight
- location: ${locationWeight}% weight

Also provide:
- A 2-3 sentence explanation of the match quality
- A list of REAL gaps (only list gaps that genuinely exist — do NOT fabricate gaps)

Return a JSON object with this EXACT structure:
{
  "score": <calculated_weighted_average>,
  "breakdown": {
    "skills": <0-100>,
    "experience": <0-100>,
    "domain": <0-100>,
    "location": <0-100>
  },
  "explanation": "<2-3 sentences>",
  "gaps": [
    {"type": "experience|skill|domain|location", "description": "<specific gap>", "severity": "critical|major|minor"}
  ]
}

IMPORTANT RULES:
- Be FAIR and ACCURATE. Base scores on what the CV ACTUALLY shows.
- Freelance, consulting, contract work, and real project work count as experience.
- Use semantic skill matching (GenAI ≈ LLM ≈ Generative AI, Node.js ≈ Express backend).
- Only list gaps the candidate ACTUALLY has — do not assume or fabricate gaps.
- The overall score MUST be the correct weighted average of the 4 breakdown scores.
- CRITICAL: Different jobs MUST produce different scores for the same candidate. An intern CV should score high for internships but low for senior roles.
${isInternshipJob ? '- If the candidate is overqualified for this internship, list it as a gap with type "experience".' : '- NEVER list "overqualified" as a gap for non-internship jobs. More experience is always a positive.'}
- Gap severity: "critical" = dealbreaker missing, "major" = significant but addressable, "minor" = nice-to-have.
- Return ONLY valid JSON, no additional text or markdown.`;

    try {
      const responseJson = await this.callQwen(prompt, true);
      console.log(`[Qwen] Raw match evaluation response: ${responseJson.substring(0, 500)}`);
      
      let parsed: any;
      try {
        parsed = JSON.parse(responseJson);
      } catch (parseError: any) {
        console.warn(`[Qwen] Initial parse failed, trying to clean response: ${parseError.message}`);
        let cleanedResponse = responseJson.trim();
        if (cleanedResponse.startsWith('```json')) {
          cleanedResponse = cleanedResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
        } else if (cleanedResponse.startsWith('```')) {
          cleanedResponse = cleanedResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
        }
        parsed = JSON.parse(cleanedResponse);
      }
      
      console.log(`[Qwen] LLM Match evaluation result:`, {
        score: parsed.score,
        breakdown: parsed.breakdown,
        explanation: parsed.explanation?.substring(0, 100) + '...',
        gapsCount: parsed.gaps?.length || 0,
      });
      
      // Validate and clamp scores
      const clamp = (v: number) => Math.min(100, Math.max(0, Math.round(v || 0)));
      
      let finalScore = clamp(parsed.score);
      
      // === SERVER-SIDE MODERATE CAPS (safety net — catch cases where LLM scores too high) ===
      const minYearsRequired = jobInfo.minYearsExperience || 0;
      
      // Cap for UNDER-QUALIFIED candidates (seniority gap positive)
      if (seniorityGap >= 4) {
        finalScore = Math.min(finalScore, 40); // student → lead/principal
      } else if (seniorityGap >= 3) {
        finalScore = Math.min(finalScore, 50); // student → senior
      } else if (seniorityGap >= 2) {
        finalScore = Math.min(finalScore, 65); // student → mid, junior → senior
      }
      
      // Cap for extreme experience gaps (under-qualified)
      if (candidateYears === 0 && minYearsRequired >= 5) {
        finalScore = Math.min(finalScore, 45); // no experience for senior+ role
      } else if (candidateYears === 0 && minYearsRequired >= 3) {
        finalScore = Math.min(finalScore, 55); // no experience for mid role
      }
      
      // Cap for OVERQUALIFIED candidates
      if (isInternshipJob) {
        // Internship jobs are for students/fresh grads ONLY
        // Experienced developers should NOT appear in internship listings
        if (candidateYears >= 5) {
          finalScore = Math.min(finalScore, 15); // Senior/Lead dev → internship: hidden (below save threshold)
        } else if (candidateYears >= 3) {
          finalScore = Math.min(finalScore, 18); // Mid-level dev → internship: hidden (below save threshold)
        } else if (candidateYears >= 2) {
          finalScore = Math.min(finalScore, 28); // 2y experience → internship: barely visible
        }
      }
      // For non-internship jobs: overqualification is a POSITIVE, no caps applied
      
      if (finalScore !== clamp(parsed.score)) {
        console.log(`[Qwen] Score capped from ${clamp(parsed.score)} → ${finalScore} (seniority gap=${seniorityGap}, candidate=${candidateYears}y, job requires=${minYearsRequired}y)`);
      }
      
      return {
        score: finalScore,
        breakdown: {
          skills: clamp(parsed.breakdown?.skills),
          experience: clamp(parsed.breakdown?.experience),
          domain: clamp(parsed.breakdown?.domain),
          location: clamp(parsed.breakdown?.location),
        },
        explanation: parsed.explanation || 'No explanation available.',
        gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
      };
    } catch (error: any) {
      console.error('[Qwen] Failed to evaluate match via LLM:', error.message);
      // Return null to signal fallback to deterministic scoring
      throw error;
    }
  }

  async generateMatchExplanation(
    candidateProfile: any,
    jobRequirements: any,
    score: number
  ): Promise<{ explanation: string; gaps: any[] }> {
    const prompt = `Candidate Profile:
Skills: ${JSON.stringify(candidateProfile.skills)}
Experience: ${candidateProfile.totalYearsExperience} years
Roles: ${JSON.stringify(candidateProfile.roles || [])}
Domains: ${JSON.stringify(candidateProfile.domains)}
Location: ${JSON.stringify(candidateProfile.locationSignals)}

Job Requirements:
Required Skills: ${JSON.stringify(jobRequirements.requiredSkills)}
Preferred Skills: ${JSON.stringify(jobRequirements.preferredSkills)}
Min Experience: ${jobRequirements.minYearsExperience} years
Seniority Level: ${jobRequirements.seniorityLevel || 'not specified'}

Match Score: ${score}

Generate a natural language explanation (2-3 sentences) of why this candidate matches (or doesn't match) this job. Also identify any gaps (missing skills, insufficient experience, etc.).

Return a JSON object:
{
  "explanation": "The candidate demonstrates...",
  "gaps": [
    {"type": "skill", "description": "Missing experience with X", "severity": "minor"}
  ]
}

Return ONLY valid JSON, no additional text.`;

    try {
      const responseJson = await this.callQwen(prompt, true);
      
      let parsed: any;
      try {
        parsed = JSON.parse(responseJson);
      } catch (parseError: any) {
        let cleanedResponse = responseJson.trim();
        if (cleanedResponse.startsWith('```json')) {
          cleanedResponse = cleanedResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
        } else if (cleanedResponse.startsWith('```')) {
          cleanedResponse = cleanedResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
        }
        parsed = JSON.parse(cleanedResponse);
      }
      
      return {
        explanation: parsed.explanation || 'No explanation available.',
        gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
      };
    } catch (error: any) {
      console.error('[Qwen] Failed to generate match explanation:', error);
      return {
        explanation: 'Unable to generate explanation at this time.',
        gaps: [],
      };
    }
  }

  async extractJobInfoFromPosting(jobPostingText: string): Promise<{
    title: string;
    department?: string;
    company?: string;
    description: string;
    locationType: 'onsite' | 'hybrid' | 'remote';
    country: string;
    countryCode: string;
    city: string;
    mustHaveSkills: string[];
    niceToHaveSkills: string[];
    minYearsExperience: number;
    seniorityLevel: 'internship' | 'junior' | 'mid' | 'senior' | 'lead' | 'principal';
  }> {
    const prompt = `You are an expert at extracting structured information from job postings.

Extract the following information from this job posting:

${jobPostingText.substring(0, 8000)}

Extract and return a JSON object with this exact structure:
{
  "title": "Job Title",
  "department": "Department name (e.g., Engineering, Sales, Marketing)",
  "company": "Company name (the organization posting this job)",
  "description": "Full job description",
  "locationType": "onsite" | "hybrid" | "remote",
  "country": "Country name (e.g., United States, Malaysia)",
  "countryCode": "2-letter ISO code (e.g., US, MY, SG)",
  "city": "City name",
  "mustHaveSkills": ["skill1", "skill2", "skill3"],
  "niceToHaveSkills": ["skill1", "skill2"],
  "minYearsExperience": 3,
  "seniorityLevel": "internship" | "junior" | "mid" | "senior" | "lead" | "principal"
}

IMPORTANT:
- company: Extract the company/organization name posting this job (look for company name, organization name, or employer name in the posting)
- locationType: Determine from keywords like "remote", "hybrid", "on-site", "onsite", "work from home"
- countryCode: Use ISO 3166-1 alpha-2 codes (US, MY, SG, UK, etc.)
- mustHaveSkills: Extract technical skills, programming languages, frameworks, tools that are required
- niceToHaveSkills: Extract skills that are preferred but not required
- minYearsExperience: CRITICAL - Intelligently infer minimum years of experience based on:
  * Job title: "Developer" typically requires 2-3+ years, "Senior Developer" requires 5+ years, "Lead/Principal" requires 7+ years
  * Seniority keywords: "Junior" = 0-2 years, "Mid" = 2-4 years, "Senior" = 5+ years, "Lead" = 7+ years, "Principal" = 10+ years
  * Skill complexity: Advanced frameworks (React, Angular, Node.js) typically require 2+ years, multiple technologies suggest 3+ years
  * Job responsibilities: Team leadership, architecture decisions, mentoring = 5+ years; Independent project work = 2-3 years
  * Industry standards: Full-stack developers typically need 3+ years, specialized roles (DevOps, Data Engineer) need 3-5+ years
  * DO NOT default to 0 unless the job explicitly states "Intern", "Internship", "Entry-level", "Fresh graduate", or "No experience required"
  * If experience is not explicitly stated, infer from context: A "React.js Developer" role typically requires 2-3 years minimum
- seniorityLevel: Infer from title, requirements, and responsibilities
  * CRITICAL: If job title/description contains "Intern", "Internship", "Trainee" → seniorityLevel MUST be "internship" AND minYearsExperience = 0
  * If title contains "Senior", "Lead", "Principal", "Architect" → seniorityLevel should match AND minYearsExperience should be 5+ years
  * If title is just "Developer" or "Engineer" without qualifiers → typically "mid" level with 2-3 years experience
  * junior = 0-2 years, mid = 2-5 years, senior = 5+ years, lead = team lead (7+ years), principal = architect level (10+ years)
- If information is not found, use reasonable defaults based on industry standards (company can be null if not found)

Return ONLY valid JSON, no additional text or markdown formatting.`;

    try {
      const responseJson = await this.callQwen(prompt, true);
      console.log(`[Qwen] Raw job extraction response: ${responseJson}`);
      
      let parsed: any;
      try {
        parsed = JSON.parse(responseJson);
      } catch (parseError: any) {
        console.warn(`[Qwen] Initial parse failed, trying to clean response: ${parseError.message}`);
        let cleanedResponse = responseJson.trim();
        if (cleanedResponse.startsWith('```json')) {
          cleanedResponse = cleanedResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
        } else if (cleanedResponse.startsWith('```')) {
          cleanedResponse = cleanedResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
        }
        parsed = JSON.parse(cleanedResponse);
      }
      
      console.log(`[Qwen] Parsed job info:`, parsed);
      
      // Validate and set defaults
      return {
        title: parsed.title || 'Untitled Job',
        department: parsed.department || 'General',
        company: parsed.company || undefined,
        description: parsed.description || '',
        locationType: parsed.locationType || 'remote',
        country: parsed.country || 'United States',
        countryCode: parsed.countryCode || 'US',
        city: parsed.city || 'Unknown',
        mustHaveSkills: Array.isArray(parsed.mustHaveSkills) ? parsed.mustHaveSkills : [],
        niceToHaveSkills: Array.isArray(parsed.niceToHaveSkills) ? parsed.niceToHaveSkills : [],
        minYearsExperience: parsed.minYearsExperience !== undefined && parsed.minYearsExperience !== null 
          ? parsed.minYearsExperience 
          : (parsed.seniorityLevel === 'internship' ? 0 : 
             parsed.seniorityLevel === 'junior' ? 1 : 
             parsed.seniorityLevel === 'senior' || parsed.seniorityLevel === 'lead' || parsed.seniorityLevel === 'principal' ? 5 : 
             2), // Default to 2 years for mid-level if not specified
        seniorityLevel: parsed.seniorityLevel || 'mid',
      };
    } catch (error: any) {
      console.error('[Qwen] Failed to extract job info:', error);
      throw new Error(`Failed to extract job information: ${error.message}`);
    }
  }

  // ============================================================
  //  PHASE 6 — AI-POWERED FEATURES
  // ============================================================

  /**
   * 6.1 — CV Fixer / Improver
   * Analyzes a candidate's CV and returns actionable suggestions.
   */
  async reviewCV(
    cvText: string,
    targetRole?: string
  ): Promise<{
    score: number;
    sections: { section: string; issues: string[]; suggestions: string[] }[];
    rewrittenBullets: { original: string; improved: string }[];
    summary: string;
  }> {
    const roleCtx = targetRole ? `\nThe candidate is targeting the role: "${targetRole}".` : '';

    const prompt = `You are a senior career coach and CV expert. Analyze the following CV and provide detailed, actionable feedback.${roleCtx}

=== CV TEXT ===
${cvText.substring(0, 10000)}
=== END CV ===

Evaluate the CV for:
1. Weak action verbs ("worked on" → "engineered", "did" → "implemented")
2. Missing quantifiable achievements ("improved performance" → "improved by 40%")
3. Formatting issues (inconsistent dates, missing sections)
4. Missing keywords for the target role(s)
5. Grammar and clarity
6. Overall structure and readability

Return a JSON object:
{
  "score": <0-100 overall CV quality>,
  "sections": [
    {
      "section": "Content Quality",
      "issues": ["Uses weak action verbs in 3 bullet points"],
      "suggestions": ["Replace 'worked on' with 'engineered' or 'developed'"]
    }
  ],
  "rewrittenBullets": [
    {
      "original": "Worked on the backend system",
      "improved": "Engineered a scalable backend system serving 10K+ daily requests"
    }
  ],
  "summary": "2-3 sentence overall assessment",
  "revisedCvText": "Full CV text from above with every 'original' in rewrittenBullets replaced by its 'improved' version. Same structure and line breaks; use \\n for newlines in this JSON string."
}

You MUST include "revisedCvText": copy the entire CV TEXT from the input, then replace each original bullet with its improved version from rewrittenBullets. This allows the user to download the improved CV.
Provide 3-6 sections and 3-8 rewritten bullets. Return ONLY valid JSON.`;

    const { content, usage } = await this.callQwenWithUsage(prompt, true);
    const parsed = JSON.parse(content) as {
      score: number;
      sections: { section: string; issues: string[]; suggestions: string[] }[];
      rewrittenBullets: { original: string; improved: string }[];
      summary: string;
      _usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
    };
    if (usage) (parsed as any)._usage = usage;
    return parsed;
  }

  /**
   * 6.2 — CV Tailor for specific job
   * Suggests changes to emphasize skills/experience relevant to a particular job.
   */
  async tailorCV(
    cvText: string,
    jobTitle: string,
    jobDescription: string,
    jobSkills: string[]
  ): Promise<{
    tailoredSections: { section: string; changes: string[] }[];
    keyChanges: string[];
    matchImprovement: { before: number; after: number };
  }> {
    const prompt = `You are an expert career advisor. A candidate wants to tailor their CV for a specific job.

=== CANDIDATE'S CV ===
${cvText.substring(0, 8000)}

=== TARGET JOB ===
Title: ${jobTitle}
Description: ${jobDescription.substring(0, 3000)}
Key Skills: ${jobSkills.join(', ')}

Compare the CV with the job requirements and suggest specific changes:
1. Reorder skills to highlight relevant ones first
2. Suggest rewriting bullet points to match job keywords
3. Identify which experiences to emphasize or de-emphasize
4. Add missing keywords from the job description

Return JSON:
{
  "tailoredSections": [
    {
      "section": "Skills Section",
      "changes": ["Move Python and ML skills to the top", "Add 'data pipeline' keyword"]
    }
  ],
  "keyChanges": [
    "Highlight ML experience in the summary",
    "Add quantified metrics to data projects"
  ],
  "matchImprovement": { "before": 62, "after": 81 }
}

Return ONLY valid JSON.`;

    const { content, usage } = await this.callQwenWithUsage(prompt, true);
    const parsed = JSON.parse(content) as { tailoredSections: { section: string; changes: string[] }[]; keyChanges: string[]; matchImprovement: { before: number; after: number } };
    if (usage) (parsed as any)._usage = usage;
    return parsed;
  }

  /**
   * 6.2b — Tailor CV for job: same template, reorder + remove irrelevant. No fabrication.
   * Keeps the exact template (sections, headings, layout). Reorders content by job relevance and removes irrelevant items.
   */
  async tailorCVReordered(
    cvText: string,
    jobTitle: string,
    jobDescription: string,
    jobSkills: string[]
  ): Promise<{ tailoredCvText: string; keyChanges: string[] }> {
    const prompt = `You are a career advisor. Customize the candidate's CV for this specific job. You must preserve the candidate's real content exactly—no mixing, no fabrication.

=== CANDIDATE'S ORIGINAL CV (use only this text) ===
${cvText.substring(0, 12000)}

=== TARGET JOB ===
Title: ${jobTitle}
Description: ${jobDescription.substring(0, 3000)}
Key skills: ${jobSkills.join(', ')}

Rules (strict):
1. COPY text verbatim from the candidate's CV above. Do not rephrase, paraphrase, or "improve" wording. Do not add numbers, percentages, dates, or achievements that are not explicitly in the CV. Do not mix in content from any other source.
2. REORDER within each section so job-relevant content comes first (e.g. put matching skills first, relevant roles/projects first). Keep every word of each item you keep—only change order.
3. REMOVE entire bullets or entries that are not relevant to this job (e.g. unrelated roles, irrelevant hobbies). Omit them; do not replace with new text.
4. Keep the same structure: same section headers, same bullet style. Only reorder and delete—never add or invent.
5. If you are unsure whether something is in the CV, do not include it. Every skill, job, project, and date must appear exactly as in the candidate's CV.

Output the full tailored CV as one string. Use \\n for newlines in tailoredCvText. In keyChanges, list briefly what you did (e.g. "Moved Java and Spring to top of Skills", "Removed unrelated role", "Put Java project first").

Return ONLY valid JSON:
{
  "tailoredCvText": "<full tailored CV string, verbatim content from CV above, only reordered/trimmed, \\n for newlines>",
  "keyChanges": ["What you reordered", "What you removed", "etc."]
}`;

    const { content, usage } = await this.callQwenWithUsage(prompt, true);
    const parsed = JSON.parse(content) as { tailoredCvText: string; keyChanges: string[]; _usage?: { input_tokens: number; output_tokens: number; total_tokens: number } };
    if (usage) (parsed as any)._usage = usage;
    return parsed;
  }

  /**
   * Tailor resume for a job — returns a single JSON object matching the structured schema (preview + PDF).
   */
  async tailorResumeStructuredJson(
    resumeText: string,
    jobDescription: string,
    jobTitle: string,
    jobSkills: string[]
  ): Promise<{ content: string; usage?: { input_tokens: number; output_tokens: number; total_tokens: number } }> {
    const resumeBlock = resumeText.substring(0, 12000);
    const jobBlock = jobDescription.substring(0, 8000);
    const SYSTEM_PROMPT = `You are an expert resume tailor. Your job is to analyze a candidate's resume and a job description, then return a tailored version of the resume as a strictly valid JSON object.

CRITICAL RULES:
1. You MUST respond with ONLY a valid JSON object — no markdown, no code fences, no explanation, no preamble.
2. NEVER omit any key from the schema, even if the value is empty. Use "" for empty strings and [] for empty arrays.
3. NEVER mix content between sections. Each field must only contain data that belongs to it.
4. NEVER invent or hallucinate information. Only use what is in the original resume.
5. You MAY rephrase bullet points to better align with the job description, but must preserve the original meaning and facts.
6. Mark items as relevant or irrelevant — do NOT remove any experience or projects entirely.
7. Relevance is determined by how closely the item matches the skills, responsibilities, or requirements in the job description.
8. SKILLS: Include every professional/technical skill from the resume in "skills". Do NOT put human spoken or signed languages here (English, Urdu, Somali, Arabic, etc.)—those belong ONLY in "languages" (rule 13). Put job-relevant skills first; the app will highlight matches to the job posting.
9. EXPERIENCE "description" (required for every role that has any content under that job):
   - Source text ONLY from that job block on the resume (intro paragraph, role summary, or the bullets themselves).
   - If that experience is RELEVANT to the target job (isRelevant: true): copy the resume's narrative/summary for that role COMPLETELY — do not shorten it.
   - If that experience is NOT relevant (isRelevant: false): still include a description, but SUMMARIZE or minimize it to 1–3 tight factual sentences (keep what a recruiter needs to understand the role).
   - If the resume has NO prose paragraph but HAS bullets: write a short factual overview (2–4 sentences max) synthesized ONLY from those bullets — never leave "description" empty when bullets or any role text exist.
10. CERTIFICATIONS vs AWARDS (two sections only when the CV has both): (a) "certifications": ONLY vendor/course credentials (Microsoft Learn, Google Cloud, AWS cert, license, diploma course, etc.). NEVER list competition wins, hackathons, merit awards, or prizes here—those belong ONLY in "awardsAndAchievements". Each cert ONCE: if the same certificate appears twice in the resume (e.g. same title with/without issuer or date split differently), output a single merged object with the fullest name, issuer, and year—never duplicate the same certification. (b) "awardsAndAchievements": If the resume has ANY heading like Awards, Achievements, Honors, Competitions, or "Awards & Achievements", you MUST include every distinct award/honor from that section. Each object: name, issuer, year, isRelevant, plus "description" (1–3 short factual sentences synthesized ONLY from resume text tied to that award—e.g. sub-bullets or the line context; use "" if the title line alone is complete) and "skills" (same rule as project techStack: only tools/domains literally written on the resume next to or inside that award's text; else []). "issuer" is ONLY the host/organization/event name (e.g. university, company, competition body)—NEVER a comma-separated tool list, NEVER technologies. "year" is ONLY a date or calendar year—NEVER tools. Put every tool for that award ONLY in "skills" (or [] if the resume names none). Never concatenate tool names into one string without spaces. Use [] only if the resume truly has no awards/achievements section at all. Never omit the key. Never put the same fact in both arrays.
11. PROJECT techStack: Use [] unless a technology, framework, or tool is EXPLICITLY named in the candidate's resume in that project's title, description, or bullets. Never infer tech from the job posting, never guess, never copy from the global skills list unless that tech appears in that project's own text on the CV.
12. BULLETS (experience and projects): Each bullet must be a distinct fact. NEVER output two bullets that restate the same point in different wording (e.g. original line + AI-rewritten duplicate). Keep exactly one bullet per fact—the clearest version aligned to the job.
13. LANGUAGES: Put every human language the candidate lists (English, Urdu, Somali, Arabic, French, etc.) in the "languages" array as { "language": "...", "proficiency": "..." } with proficiency from the resume or "" if unknown. If the resume has a Languages section, merge all entries there. Never list those as technical skills in "skills".`;

    const userPrompt = `Here is the candidate's resume:
<resume>
${resumeBlock}
</resume>

Here is the job description:
<job_description>
${jobBlock}

Job title: ${jobTitle}
Key skills from posting: ${jobSkills.join(', ')}
</job_description>

Tailor the resume for this job and return ONLY a JSON object matching this exact schema:

{
  "name": "string",
  "email": "string",
  "phone": "string",
  "location": "string",
  "links": {
    "linkedin": "string",
    "github": "string",
    "portfolio": "string",
    "other": []
  },
  "summary": "string — rewrite this to target the job description specifically",
  "skills": ["EVERY skill from the candidate's resume as separate strings — do not omit any; order job-relevant skills first if helpful"],
  "experience": [
    {
      "title": "string",
      "company": "string",
      "duration": "string",
      "description": "string — if isRelevant true: full role narrative from resume; if false: shortened summary; if only bullets exist, synthesize from bullets; never \"\" when that job has bullets or any text",
      "isRelevant": true or false,
      "bullets": [
        {
          "text": "string — rewritten bullet point aligned to job description",
          "isRelevant": true or false
        }
      ]
    }
  ],
  "projects": [
    {
      "name": "string",
      "description": "string",
      "techStack": ["only technologies literally written in the resume for this project; else []"],
      "isRelevant": true or false,
      "bullets": [
        {
          "text": "string — rewritten bullet point aligned to job description",
          "isRelevant": true or false
        }
      ]
    }
  ],
  "education": [
    {
      "degree": "string",
      "institution": "string",
      "year": "string",
      "grade": "string"
    }
  ],
  "certifications": [
    {
      "name": "string — certification or license name exactly as on resume",
      "issuer": "string — issuing org or \"\"",
      "year": "string — year earned or expiry year or \"\"",
      "isRelevant": true or false
    }
  ],
  "awardsAndAchievements": [
    {
      "name": "string — award, competition, honor, or prize line as on resume",
      "issuer": "string — host/org/event name ONLY; never tools or comma-separated tech; \"\" if none",
      "year": "string — date or year ONLY; never tools; \"\" if none",
      "description": "string — brief factual context from the resume only (sub-bullets or surrounding text); \"\" if unnecessary",
      "skills": ["only tools/domains literally in the resume for this award; else []"],
      "isRelevant": true or false
    }
  ],
  "languages": [
    {
      "language": "string — e.g. English, Urdu, Somali (only human languages from the resume)",
      "proficiency": "string — e.g. Native, Fluent, Bilingual, or \"\""
    }
  ],
  "keyChanges": [
    "string — brief explanation of each major change made and why"
  ]
}

Remember: Return ONLY the JSON object. No other text.`;

    return this.callQwenWithMessages(SYSTEM_PROMPT, [{ role: 'user', content: userPrompt }], true);
  }

  /**
   * Extract structured resume from improved/tailored CV text for template-based rendering.
   * Returns: header (name, email, phone, linkedIn, portfolio), summary, skills, experience, education, projects, certifications.
   */
  async extractStructuredResume(cvText: string): Promise<{
    name: string;
    email: string;
    phone: string;
    linkedIn: string;
    portfolio: string;
    summary: string;
    skills: string[];
    experience: { role: string; company: string; dates?: string; bullets: string[] }[];
    education: { degree: string; institution: string; dates?: string }[];
    projects: { name: string; description?: string; bullets?: string[] }[];
    achievements: string[];
    certifications: string[];
  }> {
    const prompt = `You are a resume parser. Extract the following resume content into a structured JSON.

Rules: Use ONLY information that appears in the text below. Copy exact wording from the text. Do not invent, infer, or add any information. Do not add skills, jobs, dates, or achievements that are not explicitly written in the resume. If something is not in the text, use empty string or empty array. Do not mix content from different sections or fabricate details.

=== RESUME TEXT ===
${cvText.substring(0, 10000)}

Return ONLY valid JSON with this exact structure (use empty strings or empty arrays if not found):
{
  "name": "Full name as shown",
  "email": "email address or empty string",
  "phone": "phone or empty string",
  "linkedIn": "LinkedIn URL or empty string",
  "portfolio": "portfolio/website URL or empty string",
  "summary": "Professional summary / profile paragraph (one string, can be multi-line with \\n)",
  "skills": ["skill1", "skill2", ...],
  "experience": [
    { "role": "Job title", "company": "Company name", "dates": "e.g. 2020 - Present", "bullets": ["achievement one", "achievement two"] }
  ],
  "education": [
    { "degree": "Degree name", "institution": "School name", "dates": "e.g. 2018 - 2020" }
  ],
  "projects": [
    { "name": "Project name", "description": "optional short description", "bullets": ["optional bullet"] }
  ],
  "achievements": ["award or achievement 1", "award or achievement 2"],
  "certifications": ["cert1", "cert2"]
}

Extract "achievements" from sections like Awards, Achievements, Honours, Rewards, or any listed accolades (e.g. Dean's List, Employee of the Month, scholarships). Use empty array [] if none found.`;

    const { content, usage } = await this.callQwenWithUsage(prompt, true);
    const parsed = JSON.parse(content);
    const result = {
      ...parsed,
      achievements: Array.isArray(parsed.achievements) ? parsed.achievements : [],
    };
    if (usage) (result as any)._usage = usage;
    return result;
  }

  /**
   * 6.3 — Cover Letter Writer
   */
  async generateCoverLetter(
    cvText: string,
    jobTitle: string,
    jobDescription: string,
    companyName: string,
    tone: 'formal' | 'conversational' | 'enthusiastic' = 'formal'
  ): Promise<{ coverLetter: string; alternateVersions: string[] }> {
    const prompt = `You are an expert cover letter writer. Generate a tailored cover letter.

=== CANDIDATE'S CV ===
${cvText.substring(0, 6000)}

=== JOB DETAILS ===
Title: ${jobTitle}
Company: ${companyName}
Description: ${jobDescription.substring(0, 3000)}

Tone: ${tone}

Write a cover letter (300-500 words) that:
- Opens with why the candidate is interested in this specific company/role
- Maps their experience to the job requirements (2-3 key matches)
- Highlights 2-3 most relevant achievements with specifics
- Closes with enthusiasm and a call to action

Also generate 1 alternate shorter version (150-250 words).

Return JSON:
{
  "coverLetter": "<full cover letter text>",
  "alternateVersions": ["<shorter version>"]
}

Return ONLY valid JSON.`;

    const response = await this.callQwen(prompt, true);
    return JSON.parse(response);
  }

  /**
   * 6.4 — Job Posting Fixer / Optimizer
   */
  async reviewJobPosting(
    title: string,
    description: string,
    mustHaveSkills: string[],
    niceToHaveSkills: string[]
  ): Promise<{
    score: number;
    issues: { issue: string; severity: 'high' | 'medium' | 'low'; fix: string }[];
    suggestions: string[];
    rewrittenDescription: string;
    improvedTitle: string;
    inclusivityReport: string;
  }> {
    const prompt = `You are an expert talent acquisition consultant. Review this job posting for clarity, inclusivity, SEO, and candidate attraction.

Title: ${title}
Description: ${description.substring(0, 5000)}
Must-Have Skills: ${mustHaveSkills.join(', ')}
Nice-To-Have Skills: ${niceToHaveSkills.join(', ')}

Analyze for:
1. Clarity: vague requirements → specific ones
2. Inclusivity: biased language ("rockstar", "ninja", gendered terms)
3. SEO: missing keywords candidates search for
4. Length: too long/short, optimal structure
5. Realistic requirements: e.g., "10 years React" when React is 11 years old
6. Skill overload: too many must-haves discouraging good candidates
7. Missing info: no salary range, no remote/onsite clarity
8. Tone: too corporate/cold vs welcoming

Return JSON:
{
  "score": <0-100>,
  "issues": [
    { "issue": "Uses gendered language 'he/him'", "severity": "high", "fix": "Use 'they/them' or 'you'" }
  ],
  "suggestions": ["Add a salary range to attract 30% more applicants"],
  "rewrittenDescription": "<improved full description>",
  "improvedTitle": "<improved title>",
  "inclusivityReport": "2-3 sentence inclusivity assessment"
}

Return ONLY valid JSON.`;

    const response = await this.callQwen(prompt, true);
    return JSON.parse(response);
  }

  /**
   * 6.5 — Job Description Generator
   */
  async generateJobDescription(
    title: string,
    skills?: string[],
    seniorityLevel?: string,
    locationType?: string,
    industry?: string,
    companyDescription?: string
  ): Promise<{
    description: string;
    mustHaveSkills: string[];
    niceToHaveSkills: string[];
    suggestedSeniority: string;
    suggestedMinYears: number;
  }> {
    const prompt = `You are an expert HR professional. Generate a complete, compelling job description from the given inputs.

Title: ${title}
${skills?.length ? `Key Skills: ${skills.join(', ')}` : ''}
${seniorityLevel ? `Seniority Level: ${seniorityLevel}` : ''}
${locationType ? `Location Type: ${locationType}` : ''}
${industry ? `Industry: ${industry}` : ''}
${companyDescription ? `About the Company: ${companyDescription.substring(0, 500)}` : ''}

Generate a professional job posting including:
- Role summary (2-3 sentences)
- Key responsibilities (5-8 bullet points)
- Requirements (must-have skills, experience)
- Nice-to-have qualifications
- What we offer / benefits
- About the company section (generic if company info not provided)

Return JSON:
{
  "description": "<complete job description in markdown format>",
  "mustHaveSkills": ["Python", "Machine Learning"],
  "niceToHaveSkills": ["Docker", "Kubernetes"],
  "suggestedSeniority": "mid",
  "suggestedMinYears": 3
}

Return ONLY valid JSON.`;

    const response = await this.callQwen(prompt, true);
    return JSON.parse(response);
  }

  /**
   * 6.6 — Interview Question Generator
   */
  async generateInterviewQuestions(
    jobTitle: string,
    jobDescription: string,
    jobSkills: string[],
    candidateCvText?: string,
    questionTypes: string[] = ['technical', 'behavioral', 'situational'],
    difficulty: string = 'mixed'
  ): Promise<{
    questions: {
      question: string;
      type: string;
      difficulty: string;
      expectedAnswer: string;
      scoringCriteria: string;
      relatedSkill: string;
    }[];
  }> {
    const candidateContext = candidateCvText
      ? `\n=== CANDIDATE'S CV (for tailored questions) ===\n${candidateCvText.substring(0, 4000)}`
      : '';

    const prompt = `You are a senior technical interviewer. Generate tailored interview questions.

=== JOB ===
Title: ${jobTitle}
Description: ${jobDescription.substring(0, 3000)}
Key Skills: ${jobSkills.join(', ')}
${candidateContext}

Question Types to generate: ${questionTypes.join(', ')}
Difficulty: ${difficulty}

Generate 10-12 high-quality interview questions. For each:
- technical: based on required skills
- behavioral: STAR-format questions relevant to the role
- situational: role-specific scenarios
${candidateCvText ? '- candidate-specific: based on their CV gaps or interesting projects' : ''}
Include a scoring rubric for each.

Return JSON:
{
  "questions": [
    {
      "question": "Explain how you would design a real-time data pipeline...",
      "type": "technical",
      "difficulty": "senior",
      "expectedAnswer": "A good answer should cover...",
      "scoringCriteria": "Look for: architecture patterns, scalability, trade-offs",
      "relatedSkill": "Data Engineering"
    }
  ]
}

Return ONLY valid JSON.`;

    const response = await this.callQwen(prompt, true);
    return JSON.parse(response);
  }

  async generateBehavioralMcqAssessment(input: {
    candidateName?: string;
    candidateHeadline?: string;
    jobTitle: string;
    jobDescription: string;
    mustHaveSkills: string[];
    niceToHaveSkills: string[];
    questionCount?: number;
  }): Promise<{
    questions: {
      question: string;
      options: string[];
      correctOption: string;
      competencyTag: string;
      weight: number;
    }[];
  }> {
    const questionCount = Math.min(10, Math.max(1, input.questionCount || 10));
    const prompt = `You are an expert behavioral interviewer.
Generate exactly ${questionCount} multiple-choice behavioral questions for this candidate and role.

Role title: ${input.jobTitle}
Role description: ${(input.jobDescription || '').substring(0, 3000)}
Must-have skills: ${(input.mustHaveSkills || []).join(', ')}
Nice-to-have skills: ${(input.niceToHaveSkills || []).join(', ')}
Candidate name: ${input.candidateName || 'Candidate'}
Candidate headline: ${input.candidateHeadline || 'Not provided'}

Requirements:
- Each question must test behavioral decision-making relevant to this role.
- Each question must have exactly 4 options.
- "correctOption" must be the full option text that is best behaviorally.
- competencyTag must be one of: communication, collaboration, ownership, accountability, decision_making, growth_mindset, teamwork, inclusivity, initiative.
- weight must be an integer from 1 to 20.
- Keep language clear and practical.
- Return exactly ${questionCount} questions.

Return JSON only in this exact shape:
{
  "questions": [
    {
      "question": "string",
      "options": ["string", "string", "string", "string"],
      "correctOption": "string",
      "competencyTag": "string",
      "weight": 10
    }
  ]
}
`;

    const response = await this.callQwen(prompt, true);
    const parsed = JSON.parse(response);

    if (!Array.isArray(parsed?.questions)) {
      return { questions: [] };
    }

    return {
      questions: parsed.questions.slice(0, questionCount).map((q: any) => ({
        question: String(q?.question || '').trim(),
        options: Array.isArray(q?.options) ? q.options.slice(0, 4).map((o: any) => String(o)) : [],
        correctOption: String(q?.correctOption || ''),
        competencyTag: String(q?.competencyTag || 'behavior'),
        weight: Number.isFinite(q?.weight) ? Math.max(1, Math.min(20, Math.round(q.weight))) : 10,
      })),
    };
  }

  async evaluateInterviewAssessment(input: {
    jobTitle: string;
    jobDescription: string;
    candidateName: string;
    score: number;
    dimensionScores: Record<string, number>;
    answers: {
      question: string;
      options: string[];
      correctOption: string;
      selectedOption: string | null;
      isCorrect: boolean;
      competencyTag: string;
      weight: number;
    }[];
  }): Promise<{
    strengths: string[];
    concerns: string[];
    recommendation: string;
  }> {
    const prompt = `You are an interview assessor for behavioral MCQ assessments.

Job title: ${input.jobTitle}
Job description: ${(input.jobDescription || '').substring(0, 2000)}
Candidate: ${input.candidateName}
Overall score: ${input.score}/100
Dimension scores: ${JSON.stringify(input.dimensionScores)}

Assessment answers:
${JSON.stringify(input.answers).substring(0, 12000)}

Create a concise assessment report:
- strengths: 2-5 bullet-style strings
- concerns: 2-5 bullet-style strings
- recommendation: 1-2 sentences with hiring guidance for behavioral fit

Rules:
- Ground insights in the provided answers and scores.
- Do not invent background details.
- Keep language professional and concise.

Return JSON only:
{
  "strengths": ["..."],
  "concerns": ["..."],
  "recommendation": "..."
}
`;

    const response = await this.callQwen(prompt, true);
    const parsed = JSON.parse(response);
    return {
      strengths: Array.isArray(parsed?.strengths) ? parsed.strengths.map((x: any) => String(x)) : [],
      concerns: Array.isArray(parsed?.concerns) ? parsed.concerns.map((x: any) => String(x)) : [],
      recommendation: String(parsed?.recommendation || ''),
    };
  }

  /**
   * Voice interview: generate one natural, conversational question (or follow-up).
   * Uses phased flow: Greeting & small talk → Set context → Check readiness → Interview questions → Closing.
   */
  async generateVoiceInterviewQuestion(params: {
    jobTitle: string;
    jobDescription: string;
    jobSkills: string[];
    candidateContext?: string;
    candidateName?: string;
    previousQAndA: { question: string; answer: string }[];
    questionIndex: number;
    maxQuestions: number;
    durationMinutes?: number;
  }): Promise<{ question: string }> {
    const { jobTitle, jobDescription, jobSkills, candidateContext, candidateName, previousQAndA, questionIndex, maxQuestions, durationMinutes } = params;
    const firstName = candidateName?.trim() ? candidateName.trim().split(/\s+/)[0] : null;
    const candidateNamePlaceholder = firstName || 'there';
    const durationPlaceholder = durationMinutes != null ? String(durationMinutes) : '10';

    // Fixed script for guaranteed conversational flow (greeting → set context → check readiness → questions → closing)
    if (questionIndex === 0) {
      return {
        question: `Hi ${candidateNamePlaceholder}! Great to have you here today. I'm Aria, and I'll be conducting your interview. How are you doing? Hope you didn't have any trouble joining the call!`,
      };
    }
    if (questionIndex === 1) {
      return {
        question: `So today we'll be spending about ${durationPlaceholder} minutes together. I'll be asking you a mix of technical and behavioral questions related to the ${jobTitle} role. Feel free to take your time on each answer, and if any question is unclear just let me know!`,
      };
    }
    if (questionIndex === 2) {
      return {
        question: "Alright, I think that covers everything! Are you ready to get started, or do you have any questions before we begin?",
      };
    }
    if (questionIndex >= maxQuestions - 1 && maxQuestions > 3) {
      return {
        question: "That brings us to the end of the interview! You did great. We'll review everything and get back to you soon. Do you have any questions for me before we wrap up?",
      };
    }

    const systemPrompt = `You are a professional and friendly AI interviewer conducting a job interview. Your goal is to make the candidate feel comfortable before diving into the actual interview questions.

## Your Personality
- Warm, professional, and encouraging
- Conversational and natural — never robotic or stiff
- Patient and attentive
- Sound like a real human recruiter, not a checklist

---

## Interview Flow

### Phase 1: Greeting & Small Talk (Do this FIRST, always)
When the candidate joins, greet them warmly. Introduce yourself. Ask how they're doing or if they had any trouble joining. Keep it light and natural.

Example opening:
"Hi [Candidate Name]! Great to have you here today. I'm Aria, and I'll be conducting your interview. How are you doing? Hope you didn't have any trouble joining the call!"

Then engage in 1–2 exchanges of small talk based on their response. Be genuine, not scripted.

### Phase 2: Set Context
Briefly explain what this interview will look like:
- How long it will take
- What topics/areas will be covered (based on the JD)
- That they can ask for clarification on any question

Example:
"So today we'll be spending about [X] minutes together. I'll be asking you a mix of technical and behavioral questions related to the [Job Title] role. Feel free to take your time on each answer, and if any question is unclear just let me know!"

### Phase 3: Check Readiness
Before jumping into questions, explicitly ask if the candidate is ready.

Example:
"Alright, I think that covers everything! Are you ready to get started, or do you have any questions before we begin?"

Wait for confirmation. If they have questions, answer them naturally. Only proceed when they confirm they're ready.

### Phase 4: Interview Questions
Once the candidate confirms they're ready, transition naturally into the first question.

Example transition:
"Perfect! Let's dive in then. So, [Question 1]..."

Ask one question at a time. After each answer:
- Acknowledge their response briefly ("That's a great example", "Interesting approach", "Got it, thanks for sharing that")
- Then move to the next question naturally

### Phase 5: Closing
After all questions are done, close warmly:
"That brings us to the end of the interview! You did great. We'll review everything and get back to you soon. Do you have any questions for me before we wrap up?"

---

## Rules
- NEVER start with a question directly. Always greet first.
- NEVER rush the candidate.
- Keep acknowledgements short and varied — don't repeat "Great answer!" every time.
- Stay in character as a human interviewer at all times.
- Use the candidate's name occasionally to keep it personal.
- Mirror the candidate's energy — if they're nervous, be extra warm; if they're confident, match their pace.

---

## IMPORTANT — Phase gating
- Track which phase you are in from the conversation history above. Never skip phases.
- You are currently in Phase 4 (Interview questions). The candidate has already been greeted, context set, and asked if they are ready. Do NOT repeat greeting, set context, or "are you ready?" — generate only the next interview line (acknowledgement + next question, or closing when appropriate).
- Only move to interview questions AFTER the candidate has explicitly said they are ready (e.g. "yes", "ready", "let's go"). The conversation history shows what they said; use it.`;

    // Build full conversation history for the model (so it has memory of every turn)
    const conversationMessages: { role: 'user' | 'assistant'; content: string }[] = [];
    for (let i = 0; i < previousQAndA.length; i++) {
      conversationMessages.push({ role: 'assistant', content: previousQAndA[i].question });
      conversationMessages.push({
        role: 'user',
        content: (previousQAndA[i].answer || '(no response)').substring(0, 500),
      });
    }

    const phaseHint =
      questionIndex === 0
        ? `CRITICAL — This is the VERY FIRST thing the candidate hears. You MUST start with a warm greeting, NOT a question.

You MUST:
1. Greet the candidate by name: "Hi ${candidateNamePlaceholder}!" (use their first name).
2. Say you're glad they're here and introduce yourself: "I'm Aria, and I'll be conducting your interview today."
3. Ask how they are or if they had any trouble joining: "How are you doing? Hope you didn't have any trouble joining the call!"

Output a single greeting that does all of the above in 2–3 short sentences. Example: "Hi ${candidateNamePlaceholder}! Great to have you here today. I'm Aria, and I'll be conducting your interview. How are you doing? Hope you didn't have any trouble joining the call!" Do NOT ask an interview question yet.`
        : questionIndex === 1
          ? `Generate your NEXT line only. Phase 1 small talk or start of Phase 2. Candidate said: "${(previousQAndA[0]?.answer ?? '').substring(0, 300)}". Respond naturally (acknowledge, maybe one more small talk or begin setting context). One or two sentences.`
          : questionIndex === 2
            ? `Generate your NEXT line only. Phase 2: Set context. Tell them the interview will take about ${durationPlaceholder} minutes, you'll ask technical and behavioral questions for the ${jobTitle} role, and they can ask for clarification. Keep it brief and warm.`
            : questionIndex === 3
              ? `Generate your NEXT line only. Phase 3: Check readiness. Ask if they're ready to get started or if they have any questions before you begin. One sentence.`
              : questionIndex === 4
                ? `Generate your NEXT line only. Phase 4: Transition into first real question. Acknowledge their readiness, then ask your first interview question (based on the job and their resume). One question.`
                : questionIndex >= maxQuestions - 1
                  ? `Generate your NEXT line only. Phase 5: Closing. Thank them, say they did great, you'll review and get back to them, and ask if they have any questions before you wrap up. Warm and short.`
                  : `Generate your NEXT line only. Phase 4: Interview question. Conversation so far is above. Briefly acknowledge their last answer (varied, not "Great answer!" again), then ask the next interview question (technical or behavioral, relevant to the role and their experience). One question only.`;

    const systemWithContext = `${systemPrompt}

---

## Current context
- Job title: ${jobTitle}
- Job description (excerpt): ${(jobDescription || '').substring(0, 2000)}
- Key skills: ${(jobSkills || []).join(', ')}
- Candidate's first name: ${candidateNamePlaceholder}
- Candidate's resume (excerpt): ${candidateContext ? candidateContext.substring(0, 1000) : 'Not provided.'}`;

    const lastUserMessage = `Generate ONLY your next line as Aria (turn ${questionIndex + 1}). ${phaseHint}

Return ONLY valid JSON: { "question": "Your single interview line or question here." }`;

    conversationMessages.push({ role: 'user', content: lastUserMessage });

    const { content: responseContent } = await this.callQwenWithMessages(systemWithContext, conversationMessages, true);
    const parsed = JSON.parse(responseContent);
    let question = typeof parsed?.question === 'string' ? parsed.question.trim() : '';
    if (!question) {
      question = 'Tell me about a challenge you faced in a recent project and how you overcame it.';
    }
    return { question };
  }

  /**
   * Generate two reports: one for the candidate (improvement-focused), one for the recruiter (detailed assessment).
   */
  async generateVoiceInterviewOutcome(params: {
    jobTitle: string;
    questions: string[];
    answers: string[];
    expressionSummary?: string | null;
  }): Promise<{ candidateSummary: string; recruiterSummary: string; _usage?: { input_tokens: number; output_tokens: number; total_tokens: number } }> {
    const { jobTitle, questions, answers, expressionSummary } = params;

    const shouldSkipAnswerForSummary = (a: string): boolean => {
      const t = (a || '').trim();
      if (!t) return true;
      const lower = t.toLowerCase();
      if (lower === '(no answer provided)' || lower === '(no answer)') return true;
      if (/^\(silence\s*\d+\s*s\)$/i.test(t)) return true;
      return false;
    };

    const isConnectionCheckQuestion = (q: string): boolean => {
      const s = (q || '').trim().toLowerCase();
      if (!s) return false;
      return /still there|can you hear|just checking|are you there|no response|hear me/.test(s);
    };

    const filteredPairs: { q: string; a: string }[] = [];
    for (let i = 0; i < (questions || []).length; i++) {
      const q = questions[i] ?? '';
      const a = answers[i] ?? '';
      if (shouldSkipAnswerForSummary(a)) continue;
      if (isConnectionCheckQuestion(q)) continue;
      filteredPairs.push({ q, a });
    }

    const rawAnswers = filteredPairs.map((p) => (p.a || '').trim());
    const normalizedAnswers = rawAnswers.map((a) => a.toLowerCase());
    const placeholderPatterns = ['(no answer)', 'no answer provided', 'n/a', 'na', 'none', '—', '--'];
    const totalLength = rawAnswers.join(' ').length;
    const allPlaceholderOrEmpty = normalizedAnswers.every((a) => !a || placeholderPatterns.some((p) => a.includes(p)) || a.length < 3);
    const veryShortOrEmpty = totalLength < 25;

    const text = rawAnswers.join(' ');
    const commonWords = /\b(the|and|for|was|have|with|this|that|from|are|were|been|said|each|about|when|which|their|would|there|could|other|into|more|these|some|what|than|first|your|them|will|after|where|many|then|being|over|such|just|most|also|back|through|before|right|while|during|made|should|because|between|under|again|those|very|same|another|here|next|last|might|still|find|every|think|both|often|until|much|going|never|little|since|always|yes|no|ok|okay|good|well|really|actually|think|thought|know|work|experience|project|team|role|job|skills)\b/i;
    const realWordCount = (text.match(commonWords) || []).length;
    const looksLikeGibberish = totalLength >= 10 && realWordCount < 2;
    const sameCharRepeated = rawAnswers.some((a) => a.length >= 4 && new Set(a.replace(/\s/g, '').split('')).size <= 2);

    const fallbackRecruiter = `The candidate completed the voice interview but did not provide substantive answers (empty, minimal, or non-meaningful). Review the full Q&A transcript and follow up if needed.`;
    const fallbackCandidate = `Your answers in this interview were limited. Review the questions below and consider preparing more detailed responses for future interviews.`;

    if (filteredPairs.length === 0 || allPlaceholderOrEmpty || veryShortOrEmpty || looksLikeGibberish || sameCharRepeated) {
      return { candidateSummary: fallbackCandidate, recruiterSummary: fallbackRecruiter };
    }

    const qaList = filteredPairs
      .map((pair, i) => `Question ${i + 1}: ${pair.q}\nCandidate answer: "${pair.a.trim()}"`)
      .join('\n\n');
    const demeanorNote = expressionSummary ? `\nDemeanor/expression (from video): ${expressionSummary}\n` : '';

    const prompt = `You are evaluating a job interview. Generate TWO separate report texts based on the transcript below. Be evidence-based; only state what the answers clearly show.

Job role: ${jobTitle}

Interview Q&A (exact transcript):
${qaList.substring(0, 4500)}
${demeanorNote}

## 1) candidateSummary (for the candidate)
Write a short report FOR THE CANDIDATE. Address them directly using **you** and **your** throughout (never "the candidate" or third person). Tone: warm, personal, and encouraging—like a supportive mentor who believes in their growth. Be constructive, not harsh. Include:
- What you did well (only if clearly shown in your answers).
- What you could sharpen next time (e.g. vague moments, where a concrete example would help, technical depth).
- Practical suggestions you can use in your next interview (e.g. "When you're asked about X, try naming a specific story from your experience").
Do NOT include recruiter-only content (fit for role, hire/don't hire). Keep it to 1–2 short paragraphs.

## 2) recruiterSummary (for the recruiter)
Write a DETAILED report FOR RECRUITERS. Include:
- **Overall interview:** How the interview went; how the candidate answered (clear vs vague, engaged vs brief, technical depth).
- **Fit for role:** Strong fit / Potential fit / Weak fit / Not recommend — with one sentence why for ${jobTitle}.
- **Candidate strengths and flaws:** Bullet points with evidence from the transcript (e.g. "Strong: gave concrete example on Q2. Flaw: Q3 answer was vague.").
- **Per question (optional):** For each substantive question: brief quote of response + assessment (Strong/Acceptable/Weak/No answer).
- **Red flags (if any):** e.g. "No meaningful response to question N."
Be direct; do not soften weak answers.

Return ONLY valid JSON:
{
  "candidateSummary": "Your full candidate report text here.",
  "recruiterSummary": "Your full recruiter report text here."
}`;

    try {
      const { content: response, usage } = await this.callQwenWithUsage(prompt, true);
      const raw = (response || '').trim();
      let candidateSummary = '';
      let recruiterSummary = '';
      try {
        const parsed = JSON.parse(raw);
        candidateSummary = typeof parsed?.candidateSummary === 'string' ? parsed.candidateSummary.trim() : '';
        recruiterSummary = typeof parsed?.recruiterSummary === 'string' ? parsed.recruiterSummary.trim() : '';
      } catch {
        if (raw.length > 80) {
          candidateSummary = raw.substring(0, 2000).trim();
          recruiterSummary = raw.substring(0, 4000).trim();
        }
      }
      if (!candidateSummary) candidateSummary = fallbackCandidate;
      if (!recruiterSummary) recruiterSummary = fallbackRecruiter;
      return { candidateSummary, recruiterSummary, _usage: usage };
    } catch (err) {
      console.error('[Qwen] generateVoiceInterviewOutcome error:', err);
      return { candidateSummary: fallbackCandidate, recruiterSummary: fallbackRecruiter };
    }
  }

  // ============================================================
  //  PHASE 7 — AI INTERVIEW CONDUCTOR (State Machine)
  //  Your code controls phase transitions; LLM only speaks for the current phase.
  // ============================================================

  /**
   * Pre-generate a simple list of interview questions for the state-machine conductor.
   * Call once when creating the interview; pass the result into InterviewState.questions.
   * If preferredLanguage is set and not English, questions are generated in that language.
   */
  async generateConductorQuestions(params: {
    jobTitle: string;
    jobDescription: string;
    jobSkills: string[];
    candidateContext?: string;
    count?: number;
    preferredLanguage?: string;
  }): Promise<string[]> {
    const { jobTitle, jobDescription, jobSkills, candidateContext, count = 5, preferredLanguage } = params;
    const langCode = (preferredLanguage || 'en').split('-')[0];
    const languageName = QwenService.LANGUAGE_NAMES[langCode] || 'English';
    const languageRule =
      langCode !== 'en'
        ? `\nCRITICAL: Write every question entirely in ${languageName}. Use the correct script (e.g. Arabic script for Arabic). No English. Output only the questions, one per line.\n`
        : '';
    const skillsList = (jobSkills || []).filter(Boolean).join(', ') || '(none listed — derive from the job description only)';
    const prompt = `You are preparing interview questions for a job interview.${languageRule}

Job title: ${jobTitle}
Job description (ground truth for the role): ${(jobDescription || '').substring(0, 2000)}
Must-have / key skills to cover (name specific tools, methods, or domains from this list when relevant): ${skillsList}
Candidate resume (excerpt): ${(candidateContext || 'Not provided').substring(0, 1500)}

Generate exactly ${count} interview questions. You MUST follow ALL of these rules:
- **Every** question must be **technical**: it must probe knowledge, design, implementation, debugging, trade-offs, performance, reliability, security, data integrity, validation, operations, or tooling—not icebreakers, motivation, culture fit, or generic "tell me about a time" behavioral unless the scenario is explicitly a **technical** incident (e.g. outage, bug hunt) **in the stack or domain of this job description**.
- **Every** question MUST be **anchored to this role**: tie each question to something **explicit or clearly implied** in the **job description** (responsibilities, scope, deliverables, environment, constraints, metrics, compliance) **and/or** to a **specific skill, tool, method, or requirement** from the **key skills** line or JD requirements. The candidate should recognize it as about **this** role; avoid questions that would read the same for an unrelated job title.
- **No generic trivia** that does not reference this JD/skills context (e.g. do not ask abstract puzzles unrelated to the posting).
- **Difficulty**: challenging but fair; prefer trade-offs, failure modes, scaling/reliability, debugging under constraints, or how you would validate or measure a solution—avoid textbook-only definitions with no link to the role's work.
- **Optional**: at most **one** question may mention the **resume excerpt**, and only as a **technical** follow-on (e.g. how they applied a JD-relevant tool or pattern on a named project)—never a biography or strengths/weaknesses question.
- Vary themes (architecture vs implementation vs quality vs performance, etc.); do not repeat the same narrow topic.

One question per line. No numbering. No preamble — output only the questions, one per line.`;

    const { content, usage } = await this.callQwenWithUsage(prompt, false);
    const lines = (content || '')
      .split(/\n+/)
      .map((s) => s.replace(/^\d+[.)]\s*/, '').trim())
      .filter((s) => s.length > 10);
    const questions = lines.slice(0, count);
    return Object.assign(questions, { _usage: usage });
  }

  /**
   * Call this ONCE when the interview starts (before any user message).
   * Returns the opening greeting and initial state.
   */
  async startInterview(state: InterviewState): Promise<{ response: string; updatedState: InterviewState; usage?: { input_tokens: number; output_tokens: number; total_tokens: number } }> {
    const systemPrompt = this.buildPhasePrompt(state);
    const langCode = (state.preferredLanguage || 'en').split('-')[0];
    const languageName = QwenService.LANGUAGE_NAMES[langCode] || 'English';
    const openingPrompt = langCode !== 'en'
      ? `Start the interview now. Greet ${state.candidateName} warmly. Reply entirely in ${languageName} — every word must be in ${languageName}, no English.`
      : `Start the interview now. Greet ${state.candidateName} warmly.`;
    const respondInLanguage = langCode !== 'en' ? languageName : undefined;
    const { content: responseText, usage } = await this.callQwenWithHistory(
      systemPrompt,
      [{ role: 'user', content: openingPrompt }],
      respondInLanguage
    );
    return {
      response: responseText.trim(),
      updatedState: {
        ...state,
        conversationHistory: [
          { role: 'user', content: openingPrompt },
          { role: 'assistant', content: responseText.trim() },
        ],
      },
      usage,
    };
  }

  /**
   * Core method: given the current state + candidate's message,
   * returns the AI's next response + updated state. Call this on EVERY user message.
   */
  async conductInterview(
    state: InterviewState,
    userMessage: string
  ): Promise<{ response: string; updatedState: InterviewState; usage?: { input_tokens: number; output_tokens: number; total_tokens: number } }> {
    const history: { role: 'user' | 'assistant'; content: string }[] = [
      ...state.conversationHistory,
      { role: 'user', content: userMessage },
    ];

    const nextPhase = this.transitionPhase(state, userMessage);
    const systemPrompt = this.buildPhasePrompt({ ...state, phase: nextPhase });
    const langCode = (state.preferredLanguage || 'en').split('-')[0];
    const languageName = QwenService.LANGUAGE_NAMES[langCode] || 'English';
    const respondInLanguage = langCode !== 'en' ? languageName : undefined;
    const { content: responseText, usage } = await this.callQwenWithHistory(systemPrompt, history, respondInLanguage);

    const updatedHistory: { role: 'user' | 'assistant'; content: string }[] = [
      ...history,
      { role: 'assistant', content: responseText.trim() },
    ];

    const updatedQuestionIndex =
      nextPhase === 'interview' && state.phase === 'interview'
        ? state.questionIndex + 1
        : state.questionIndex;

    return {
      response: responseText.trim(),
      updatedState: {
        ...state,
        phase: nextPhase,
        questionIndex: updatedQuestionIndex,
        smallTalkTurns:
          nextPhase === 'small_talk' ? state.smallTalkTurns + 1 : state.smallTalkTurns,
        conversationHistory: updatedHistory,
      },
      usage,
    };
  }

  /**
   * Calls Qwen with system prompt + full conversation history. Returns plain text (no JSON) and usage for cost tracking.
   * When respondInLanguage is set (e.g. "Arabic"), appends a user message so the model's next reply is in that language.
   */
  private async callQwenWithHistory(
    systemPrompt: string,
    history: { role: 'user' | 'assistant'; content: string }[],
    respondInLanguage?: string
  ): Promise<{ content: string; usage?: { input_tokens: number; output_tokens: number; total_tokens: number } }> {
    const messages = [...history];
    if (respondInLanguage) {
      messages.push({
        role: 'user',
        content: `[Instruction: Your next reply must be written entirely in ${respondInLanguage}. Use only ${respondInLanguage} — no English or other languages. Write your response now.]`,
      });
    }
    const { content, usage } = await this.callQwenWithMessages(systemPrompt, messages, false);
    const text = typeof content === 'string' ? content.trim() : String(content).trim();
    return { content: text, usage };
  }

  /**
   * YOUR CODE decides phase transitions — NOT the LLM.
   */
  private transitionPhase(state: InterviewState, userMessage: string): InterviewPhase {
    const msg = userMessage.toLowerCase().trim();

    switch (state.phase) {
      case 'greeting':
        return 'small_talk';

      case 'small_talk':
        return state.smallTalkTurns >= 1 ? 'context_setting' : 'small_talk';

      case 'context_setting':
        return 'ready_check';

      case 'ready_check':
        return this.candidateIsReady(msg) ? 'interview' : 'ready_check';

      case 'interview':
        return state.questionIndex >= state.questions.length - 1 ? 'closing' : 'interview';

      case 'closing':
        return 'closing';

      default:
        return state.phase;
    }
  }

  private candidateIsReady(message: string): boolean {
    const readyPhrases = [
      'yes', 'yep', 'yeah', 'yup', 'sure', 'ready',
      "let's go", 'lets go', 'go ahead', 'okay', 'ok',
      'sounds good', 'absolutely', 'of course', 'definitely',
      "i'm ready", 'im ready', 'start', 'begin', 'proceed',
    ];
    return readyPhrases.some((phrase) => message.includes(phrase));
  }

  /**
   * Each phase gets its own focused prompt. LLM only does ONE thing per phase.
   */
  private static readonly LANGUAGE_NAMES: Record<string, string> = {
    en: 'English', es: 'Spanish', fr: 'French', de: 'German', hi: 'Hindi',
    pt: 'Portuguese', ar: 'Arabic', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
  };

  private buildPhasePrompt(state: InterviewState): string {
    const name = state.candidateName;
    const role = state.jobTitle;
    const interviewer = state.interviewerName || 'Aria';
    const currentQuestion = state.questions[state.questionIndex] || '';
    const questionNum = state.questionIndex + 1;
    const totalQuestions = Math.max(1, state.questions.length);
    const langCode = (state.preferredLanguage || 'en').split('-')[0];
    const languageName = QwenService.LANGUAGE_NAMES[langCode] || 'English';
    const isNonEnglish = langCode !== 'en';
    const languageInstruction = isNonEnglish
      ? `FIRST AND MOST IMPORTANT: You are conducting this interview in ${languageName} only. Every word you output must be in ${languageName}. Do NOT use English. Translate any English question text into ${languageName} when you ask it. Use the correct script (e.g. Arabic script for Arabic, not Latin letters).\n\n`
      : '';

    const basePersonality = `${languageInstruction}You are ${interviewer}, a professional interviewer at a company. Your tone is formal but warm: courteous, polished, and approachable.
Speak like a real recruiter on a video call — natural and clear, but keep language professional (avoid slang or overly casual phrases).
Never sound robotic, never use bullet points in speech, never list things formally.
The candidate's name is ${name}. Use their name occasionally, not every sentence.
Output ONLY what you say as the interviewer — no labels, no JSON, no "Assistant:". Just the spoken line, entirely in ${languageName}.`.trim();

    switch (state.phase) {
      case 'greeting':
        return `${basePersonality}

The candidate just joined the interview call. This is the very first thing you say.
Greet them warmly by name. Introduce yourself (your name is ${interviewer}).
Keep it professional but warm: ask how they're doing today or if they had any trouble joining — interview-appropriate only.
Do NOT ask about weekend plans, vacation, or personal life. Do NOT mention the interview questions yet.
Keep it to 2-3 natural sentences. Sound like you're happy they joined.`;

      case 'small_talk':
        return `${basePersonality}

You are in brief, professional small talk before the interview begins.
Respond naturally to what the candidate just said. Keep the tone warm and friendly but FORMAL and interview-appropriate.
Allowed: how their day is going, if they found the link okay, if they're ready to dive in, or a brief professional remark.
Do NOT ask about: weekend plans, vacation, hobbies, or any casual/personal topics. This is a job interview.
Max 2-3 sentences. Then move on — do NOT linger on small talk. Do NOT transition to the interview format yet.`;

      case 'context_setting':
        return `${basePersonality}

Now briefly explain how today's interview will go.
Tell them: it'll take about 20-30 minutes, you'll ask ${totalQuestions} questions
covering technical and behavioral topics for the ${role} role,
they can ask for clarification anytime, and there's no pressure — just a conversation.
Sound natural, like you're chatting — NOT reading from a script.
Keep it to 3-4 sentences max.`;

      case 'ready_check':
        return `${basePersonality}

You just explained the interview format.
Now ask ${name} if they're ready to begin, or if they have any questions first.
Keep it casual — one simple sentence. Wait for their go-ahead.
If they ask a question, answer it naturally and then ask again if they're ready.`;

      case 'interview':
        return `${basePersonality}

The interview is now underway. You are on question ${questionNum} of ${totalQuestions}.

${questionNum === 1
          ? `This is the first question. Transition naturally from "let's begin" into asking it.`
          : `The candidate just answered the previous question. Briefly acknowledge their answer in 1 sentence (vary your acknowledgements — don't always say "great answer"). Then naturally transition into the next question.`}

Ask ONLY this question now:
"${currentQuestion}"

Do not ask multiple questions at once. Do not explain why you're asking.
Sound conversational, not like reading from a list.`;

      case 'closing':
        return `${basePersonality}

All interview questions are done. Wrap up the interview warmly.
Thank ${name} for their time. Tell them the team will review and be in touch.
Ask if they have any questions for you before wrapping up.
Sound genuine and encouraging — leave them feeling good about the experience.
Keep it to 3-4 sentences.`;

      default:
        return basePersonality;
    }
  }

  /**
   * 6.7 — Candidate Summary / Pitch Generator
   */
  async generateCandidateSummary(
    candidateName: string,
    cvText: string,
    jobTitle: string,
    jobDescription: string
  ): Promise<{
    summary: string;
    strengths: string[];
    concerns: string[];
    fitReasoning: string;
  }> {
    const prompt = `You are a senior recruiter presenting a candidate to a hiring manager. Generate an executive summary.

=== CANDIDATE ===
Name: ${candidateName}
CV:
${cvText.substring(0, 6000)}

=== JOB ===
Title: ${jobTitle}
Description: ${jobDescription.substring(0, 3000)}

Generate:
1. A 3-4 sentence executive summary of the candidate
2. Top 3 key strengths for THIS role
3. Top 2 potential concerns (be honest but fair)
4. Why this candidate specifically fits this role (2-3 sentences)

Return JSON:
{
  "summary": "Jane is a seasoned backend engineer with 7 years of experience...",
  "strengths": ["Deep Python expertise with production ML systems", "Led team of 5"],
  "concerns": ["Limited frontend experience", "No direct industry exposure"],
  "fitReasoning": "Jane's strong backend and ML skills align directly with..."
}

Return ONLY valid JSON.`;

    const response = await this.callQwen(prompt, true);
    return JSON.parse(response);
  }

  /**
   * 6.8 — Skill Gap Analysis & Learning Recommendations
   */
  async analyzeSkillGaps(
    candidateSkills: any[],
    candidateExperience: number,
    targetRole?: string,
    targetJobDescriptions?: string[]
  ): Promise<{
    gaps: {
      skill: string;
      importance: 'critical' | 'high' | 'medium' | 'low';
      currentLevel: string;
      requiredLevel: string;
      learningTime: string;
      impactOnScore: number;
    }[];
    recommendations: string[];
    summary: string;
  }> {
    const currentSkills = candidateSkills
      .map((s: any) => `${s.name || s} (${s.level || 'unknown'})`)
      .join(', ');

    const jobContext = targetJobDescriptions?.length
      ? `\nTarget Job Descriptions:\n${targetJobDescriptions.map((d, i) => `Job ${i + 1}: ${d.substring(0, 1500)}`).join('\n')}`
      : '';

    const prompt = `You are a career development advisor. Analyze skill gaps and provide learning recommendations.

=== CANDIDATE ===
Current Skills: ${currentSkills}
Years of Experience: ${candidateExperience}
${targetRole ? `Target Role: ${targetRole}` : ''}
${jobContext}

Analyze:
1. Current skills vs. market demand for the target role(s)
2. Which missing skills would have the highest impact
3. Priority order (learn X before Y because…)
4. Time estimates

Return JSON:
{
  "gaps": [
    {
      "skill": "Docker",
      "importance": "high",
      "currentLevel": "none",
      "requiredLevel": "intermediate",
      "learningTime": "2-3 weeks",
      "impactOnScore": 12
    }
  ],
  "recommendations": [
    "Start with Docker basics — it's the highest-impact skill to learn next",
    "Consider an online course on Kubernetes after Docker"
  ],
  "summary": "You have a strong foundation in X but are missing key DevOps skills..."
}

Provide 5-10 skill gaps sorted by impact.
Return ONLY valid JSON.`;

    const response = await this.callQwen(prompt, true);
    return JSON.parse(response);
  }

  /**
   * 6.9 — Salary Estimator
   */
  async estimateSalary(
    role: string,
    skills: string[],
    yearsExperience: number,
    country: string,
    city?: string
  ): Promise<{
    min: number;
    median: number;
    max: number;
    currency: string;
    factors: { factor: string; impact: string }[];
    marketComparison: string;
  }> {
    const prompt = `You are a compensation analyst. Estimate the salary range for this role.

Role: ${role}
Skills: ${skills.join(', ')}
Years of Experience: ${yearsExperience}
Country: ${country}
${city ? `City: ${city}` : ''}

Based on general market knowledge, estimate:
- Salary range (min, median, max) in the local currency
- How each factor affects the range
- Comparison to market average

Return JSON:
{
  "min": 60000,
  "median": 80000,
  "max": 110000,
  "currency": "USD",
  "factors": [
    { "factor": "5 years Python experience", "impact": "+15% above entry level" },
    { "factor": "Remote position", "impact": "Salary may vary by location" }
  ],
  "marketComparison": "This range is slightly above the market median for this role..."
}

Return ONLY valid JSON.`;

    const response = await this.callQwen(prompt, true);
    return JSON.parse(response);
  }

  /**
   * 6.10 — AI Chat Assistant
   */
  async chatAssistant(
    message: string,
    conversationHistory: { role: 'user' | 'assistant'; content: string }[],
    context?: {
      userRole: string;
      userName: string;
      currentPage?: string;
    }
  ): Promise<{ response: string; suggestedActions?: string[] }> {
    const ctxStr = context
      ? `\nUser context: ${context.userName} is a ${context.userRole}. ${context.currentPage ? `Currently on: ${context.currentPage}` : ''}`
      : '';

    const historyStr = conversationHistory
      .slice(-10) // last 10 messages
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n');

    const prompt = `You are the CV Matcher AI Assistant — a helpful, concise assistant built into the CV Matcher hiring platform.${ctxStr}

Previous conversation:
${historyStr || '(none)'}

User: ${message}

Instructions:
- Be helpful, friendly, and concise (2-5 sentences per response unless more detail is needed)
- For candidates: help with profile improvement, job search, CV tips, interview prep
- For companies: help with job posting, candidate evaluation, hiring advice
- You can suggest platform actions the user might take
- If asked something outside the platform scope, politely redirect

Return JSON:
{
  "response": "Your helpful response here",
  "suggestedActions": ["Improve your CV", "Browse matching jobs"]
}

Return ONLY valid JSON.`;

    const response = await this.callQwen(prompt, true);
    return JSON.parse(response);
  }

  getModelVersion(): string {
    return this.model;
  }
}

export const qwenService = new QwenService();
