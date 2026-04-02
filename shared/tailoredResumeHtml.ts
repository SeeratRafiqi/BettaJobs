/**
 * Shared tailored-resume HTML for client preview and server Puppeteer PDF.
 * Self-contained styles (no external CSS) for reliable PDF rendering.
 */

export interface TailoredResumeBullet {
  text: string;
  isRelevant?: boolean;
}

export interface TailoredResumeExperience {
  title: string;
  company: string;
  duration: string;
  /** Role overview: what they did (from the CV only). Kept for recruiters; may be tightened, not removed. */
  description: string;
  isRelevant?: boolean;
  bullets: TailoredResumeBullet[];
}

export interface TailoredResumeProject {
  name: string;
  description: string;
  techStack: string[];
  isRelevant?: boolean;
  bullets: TailoredResumeBullet[];
}

export interface TailoredResumeEducation {
  degree: string;
  institution: string;
  year: string;
  grade: string;
}

export interface TailoredResumeCertification {
  name: string;
  issuer: string;
  year: string;
  isRelevant?: boolean;
  /** Short factual context (awards section); from CV only. */
  description?: string;
  /** Skill/domain chips under the award title (same visual style as project techStack). */
  skills?: string[];
}

export interface TailoredResumeLanguage {
  language: string;
  proficiency: string;
}

export interface TailoredStructuredResume {
  name: string;
  email: string;
  phone: string;
  location: string;
  links: {
    linkedin: string;
    github: string;
    portfolio: string;
    other: string[];
  };
  summary: string;
  /** Professional/technical skills (human languages live in `languages`, not here). Job-required terms are highlighted via job skills. */
  skills: string[];
  experience: TailoredResumeExperience[];
  projects: TailoredResumeProject[];
  education: TailoredResumeEducation[];
  /** Professional certifications, licenses, courses from the CV (empty if none). */
  certifications: TailoredResumeCertification[];
  /**
   * Awards, competitions, honors, hackathon wins, etc. — only populated when the CV has a distinct
   * awards/achievements-style section; otherwise []. Same item shape as certifications, plus optional
   * description and skills chips for project-style layout in preview/PDF.
   */
  awardsAndAchievements: TailoredResumeCertification[];
  languages: TailoredResumeLanguage[];
  keyChanges: string[];
}

function coerceBullet(b: unknown): TailoredResumeBullet {
  if (typeof b === 'string') return { text: b, isRelevant: true };
  if (b && typeof b === 'object' && 'text' in (b as object)) {
    const o = b as { text?: unknown; isRelevant?: unknown };
    return { text: String(o.text ?? ''), isRelevant: o.isRelevant !== false };
  }
  return { text: '', isRelevant: true };
}

/** Merge legacy { relevant, other } or flat array into one deduped list (preserves order). */
function normalizeSkillsFromParsed(sk: unknown): string[] {
  const ordered: string[] = [];
  if (Array.isArray(sk)) {
    for (const x of sk) ordered.push(String(x));
  } else if (sk && typeof sk === 'object' && !Array.isArray(sk)) {
    const so = sk as Record<string, unknown>;
    const rel = Array.isArray(so.relevant) ? so.relevant.map((x) => String(x)) : [];
    const other = Array.isArray(so.other) ? so.other.map((x) => String(x)) : [];
    ordered.push(...rel, ...other);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of ordered) {
    const t = s.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** If the model left description empty, build a short overview from bullet text (facts only, same source). */
function descriptionFromBullets(bullets: TailoredResumeBullet[], maxLen = 720): string {
  const parts = bullets.map((b) => b.text.trim()).filter(Boolean);
  if (!parts.length) return '';
  let text = parts.join(' ');
  if (text.length > maxLen) text = text.slice(0, maxLen - 1).trim() + '…';
  return text;
}

function normalizeForOverlap(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordOverlapFraction(description: string, bulletText: string): number {
  const wordsDesc = new Set(normalizeForOverlap(description).split(' ').filter((w) => w.length > 2));
  if (wordsDesc.size === 0) return 0;
  const wordsBullet = normalizeForOverlap(bulletText).split(' ').filter((w) => w.length > 2);
  if (wordsBullet.length === 0) return 0;
  let hit = 0;
  for (const w of wordsBullet) {
    if (wordsDesc.has(w)) hit++;
  }
  return hit / wordsBullet.length;
}

function stripBulletPrefix(t: string): string {
  return t.replace(/^\s*[•\-\*⋅▪○]\s*/, '').trim();
}

/** True when the bullet repeats what the paragraph already says (avoid double-reading in preview). */
function isBulletRedundantWithDescription(description: string, bulletText: string): boolean {
  const d = normalizeForOverlap(description);
  const b = normalizeForOverlap(stripBulletPrefix(bulletText));
  if (b.length < 10) return false;
  if (d.includes(b)) return true;
  if (b.includes(d) && d.length > 28) return true;
  if (wordOverlapFraction(description, bulletText) >= 0.68) return true;
  if (wordOverlapFraction(bulletText, description) >= 0.68) return true;
  return false;
}

/** All bullets together only repeat the role paragraph (common LLM pattern) — drop the list. */
function bulletsCollectivelyDuplicateDescription(description: string, bullets: TailoredResumeBullet[]): boolean {
  const parts = bullets.map((b) => stripBulletPrefix(b.text).trim()).filter(Boolean);
  if (!parts.length) return false;
  const joined = normalizeForOverlap(parts.join(' '));
  const d = normalizeForOverlap(description);
  if (joined.length < 18 || d.length < 18) return false;
  if (d === joined) return true;
  if (d.includes(joined) && joined.length >= d.length * 0.5) return true;
  if (joined.includes(d) && d.length >= 40) return true;
  const joinedRaw = parts.join(' ');
  return wordOverlapFraction(description, joinedRaw) >= 0.88 || wordOverlapFraction(joinedRaw, description) >= 0.88;
}

/**
 * Final bullet list for display/storage: never show the same copy twice (dark paragraph + faded duplicate bullets).
 */
export function finalizeExperienceBulletsForDisplay(
  description: string,
  bullets: TailoredResumeBullet[]
): TailoredResumeBullet[] {
  const desc = description.trim();
  const clean = bullets.filter((b) => (b.text || '').trim());
  if (!desc || !clean.length) return clean;

  if (bulletsCollectivelyDuplicateDescription(desc, clean)) {
    return [];
  }

  let kept = clean.filter((b) => !isBulletRedundantWithDescription(desc, b.text));

  if (kept.length === 0 && clean.length > 0 && desc.length < 90) {
    kept = clean;
  }

  return kept;
}

/** Keep tech chips only if that string appears in the project's own CV text (name + description + bullets). */
function filterProjectTechStack(techStack: string[], projectText: string): string[] {
  const rawBlob = projectText;
  const blob = normalizeForOverlap(rawBlob);
  return techStack
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => {
      const tn = normalizeForOverlap(t);
      if (tn.length < 2) return false;
      if (blob.includes(tn)) return true;
      return rawBlob.toLowerCase().includes(t.toLowerCase());
    });
}

/** Comma-separated tool list (e.g. Figma, Flutter, HTML) — not an org/date line. */
function lineLooksLikeTechStackCommaList(line: string): boolean {
  const parts = line.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 4) return false;
  return parts.every((p) => p.length > 0 && p.length < 25);
}

function looksLikeDateOrPeriod(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 52) return false;
  if (/\b(19|20)\d{2}\b/.test(t)) return true;
  if (
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/i.test(
      t
    )
  )
    return true;
  if (/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(t)) return true;
  return false;
}

/** Long single token run-on of tools (e.g. FigmaFlutterHTML…) — hide from subheader, do not trust for chips. */
function looksLikeRunOnToolSmear(s: string): boolean {
  const t = s.trim();
  if (t.length < 18) return false;
  if (/[\s,;:|/]/.test(t)) return false;
  return /^[A-Za-z0-9+#.]+$/.test(t);
}

function splitIssuerDateCombined(issuer: string): { left: string; right: string } | null {
  const m = issuer.match(/^(.+?)\s*[—–-]\s*(.+)$/);
  if (!m) return null;
  return { left: m[1].trim(), right: m[2].trim() };
}

function dedupeStringsCi(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of items) {
    const t = x.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * Remove tool lists from issuer/year subheader; comma tokens from a mistaken issuer line become chip candidates.
 * Raw issuer/year are still used in the CV blob for filterProjectTechStack so only resume-backed tools pass.
 */
function awardDisplayMetaAndCandidateSkills(a: TailoredResumeCertification): {
  displayIssuer: string;
  displayYear: string;
  extraSkillTokens: string[];
} {
  let displayIssuer = (a.issuer || '').trim();
  let displayYear = (a.year || '').trim();
  const extra: string[] = [];

  if (looksLikeRunOnToolSmear(displayIssuer)) {
    displayIssuer = '';
  }

  const dashSplit = splitIssuerDateCombined(displayIssuer);
  if (dashSplit) {
    const leftTech = lineLooksLikeTechStackCommaList(dashSplit.left);
    const rightDate = looksLikeDateOrPeriod(dashSplit.right);
    if (leftTech && rightDate) {
      for (const p of dashSplit.left.split(',')) {
        const t = p.trim();
        if (t) extra.push(t);
      }
      displayIssuer = '';
      displayYear = displayYear.trim() || dashSplit.right;
    }
  }

  if (lineLooksLikeTechStackCommaList(displayIssuer)) {
    for (const p of displayIssuer.split(',')) {
      const t = p.trim();
      if (t) extra.push(t);
    }
    displayIssuer = '';
  }

  if (lineLooksLikeTechStackCommaList(displayYear)) {
    for (const p of displayYear.split(',')) {
      const t = p.trim();
      if (t) extra.push(t);
    }
    displayYear = '';
  }

  return { displayIssuer, displayYear, extraSkillTokens: extra };
}

function filteredAwardSkillsForDisplay(
  a: TailoredResumeCertification,
  /** Full description text for substring checks (may include run-on junk we hide in UI). */
  descriptionForBlob: string
): { displayIssuer: string; displayYear: string; skills: string[] } {
  const name = (a.name || '').trim();
  const rawIssuer = (a.issuer || '').trim();
  const rawYear = (a.year || '').trim();
  const { displayIssuer, displayYear, extraSkillTokens } = awardDisplayMetaAndCandidateSkills(a);

  const blobFull = [name, rawIssuer, rawYear, descriptionForBlob].filter(Boolean).join('\n');
  const rawList = dedupeStringsCi([
    ...(a.skills ?? []).map((s) => String(s).trim()).filter(Boolean),
    ...extraSkillTokens,
  ]);
  const skills = filterProjectTechStack(rawList, blobFull);
  return { displayIssuer, displayYear, skills };
}

function awardDescriptionForDisplay(desc: string): string {
  const t = desc.trim();
  if (!t) return '';
  if (looksLikeRunOnToolSmear(t)) return '';
  return t;
}

function bulletsMutuallyRedundant(a: string, b: string): boolean {
  const na = normalizeForOverlap(stripBulletPrefix(a));
  const nb = normalizeForOverlap(stripBulletPrefix(b));
  if (na.length < 14 || nb.length < 14) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const o1 = wordOverlapFraction(a, b);
  const o2 = wordOverlapFraction(b, a);
  return o1 >= 0.84 || o2 >= 0.84 || (o1 >= 0.7 && o2 >= 0.7);
}

/** Drop near-duplicate bullets (e.g. original vs AI rephrase of the same point). */
export function dedupeSimilarBullets(bullets: TailoredResumeBullet[]): TailoredResumeBullet[] {
  const out: TailoredResumeBullet[] = [];
  for (const b of bullets) {
    const t = b.text.trim();
    if (!t) continue;
    let mergeIdx = -1;
    for (let i = 0; i < out.length; i++) {
      if (bulletsMutuallyRedundant(out[i].text, t)) {
        mergeIdx = i;
        break;
      }
    }
    if (mergeIdx === -1) {
      out.push(b);
      continue;
    }
    const existing = out[mergeIdx];
    const preferNew =
      (b.isRelevant !== false && existing.isRelevant === false) ||
      (t.length > existing.text.length + 12 && b.isRelevant !== false);
    if (preferNew) {
      out[mergeIdx] = b;
    }
  }
  return out;
}

/**
 * One clear role narrative: replace weak or overlong-irrelevant descriptions with a tight version from bullets;
 * drop bullets that largely duplicate the final paragraph.
 */
function refineExperienceDescriptionAndBullets(
  description: string,
  bullets: TailoredResumeBullet[],
  isRelevant: boolean
): { description: string; bullets: TailoredResumeBullet[] } {
  let desc = description.trim();
  const syntheticFull = descriptionFromBullets(bullets, isRelevant ? 2000 : 520);
  const syntheticTight = descriptionFromBullets(bullets, isRelevant ? 950 : 380);

  if (!desc && bullets.length > 0) {
    desc = syntheticFull;
  }

  const looksWeak =
    desc.length > 0 &&
    desc.length < 58 &&
    /\b(responsible for|various|general|duties included|assisted with|helped with|worked on multiple)\b/i.test(desc) &&
    bullets.length > 0;

  const tooLongIrrelevant = !isRelevant && desc.length > 500;

  if (looksWeak) {
    desc = syntheticTight || desc;
  } else if (tooLongIrrelevant) {
    desc = syntheticTight || descriptionFromBullets(bullets, 320);
  }

  if (!desc.trim() && bullets.length > 0) {
    desc = syntheticFull;
  }

  const kept = dedupeSimilarBullets(finalizeExperienceBulletsForDisplay(desc, bullets));

  return { description: desc.trim(), bullets: kept };
}

function mergeCertificationSources(parsed: Record<string, unknown>): unknown[] {
  const keys = [
    'certifications',
    'certification',
    'credential',
    'licenses',
    'credentials',
    'professionalCertifications',
  ] as const;
  const out: unknown[] = [];
  for (const k of keys) {
    const v = parsed[k];
    if (Array.isArray(v)) out.push(...v);
  }
  return out;
}

function coerceStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const t = String(x).trim();
    if (t) out.push(t);
  }
  return out;
}

function mergeAwardsAndAchievementsSources(parsed: Record<string, unknown>): unknown[] {
  const keys = [
    'awardsAndAchievements',
    'awards',
    'award',
    'achievements',
    'honors',
    'honours',
    'accomplishments',
    'recognitions',
  ] as const;
  const out: unknown[] = [];
  for (const k of keys) {
    const v = parsed[k];
    if (Array.isArray(v)) out.push(...v);
  }
  return out;
}

function normalizeCertificationEntry(
  raw: unknown,
  fallbackTitle = 'Certification'
): TailoredResumeCertification | null {
  if (typeof raw === 'string') {
    const t = raw.trim();
    return t ? { name: t, issuer: '', year: '', isRelevant: true } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const name = String(
    c.name ??
      c.title ??
      c.award ??
      c.achievement ??
      c.cert ??
      c.credential ??
      c.certificationName ??
      c.certName ??
      ''
  ).trim();
  const issuer = String(
    c.issuer ??
      c.organization ??
      c.authority ??
      c.provider ??
      c.institution ??
      c.awardingBody ??
      c.issuedBy ??
      ''
  ).trim();
  const year = String(c.year ?? c.date ?? c.issued ?? c.expiry ?? c.expires ?? '').trim();
  const isRelevant = c.isRelevant !== false;
  const description = String(
    c.description ?? c.summary ?? c.details ?? c.detail ?? c.context ?? ''
  ).trim();
  const skills = coerceStringList(c.skills ?? c.relatedSkills ?? c.techStack ?? c.tags);
  if (!name && !issuer && !year) return null;
  const row: TailoredResumeCertification = {
    name: name || issuer || fallbackTitle,
    issuer,
    year,
    isRelevant,
  };
  if (description) row.description = description;
  if (skills.length) row.skills = skills;
  return row;
}

function normalizeAchievementEntry(raw: unknown): TailoredResumeCertification | null {
  return normalizeCertificationEntry(raw, 'Award / achievement');
}

function normalizeCertificationsList(parsed: Record<string, unknown>): TailoredResumeCertification[] {
  const merged = mergeCertificationSources(parsed);
  const seen = new Set<string>();
  const out: TailoredResumeCertification[] = [];
  for (const item of merged) {
    const n = normalizeCertificationEntry(item);
    if (!n) continue;
    const key = `${n.name.toLowerCase()}|${n.year}|${n.issuer.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

function normalizeAwardsAndAchievementsList(parsed: Record<string, unknown>): TailoredResumeCertification[] {
  const merged = mergeAwardsAndAchievementsSources(parsed);
  const seen = new Set<string>();
  const out: TailoredResumeCertification[] = [];
  for (const item of merged) {
    const n = normalizeAchievementEntry(item);
    if (!n) continue;
    const key = `${n.name.toLowerCase()}|${n.year}|${n.issuer.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

function normalizeCertBlob(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function certificationBlob(c: TailoredResumeCertification): string {
  return normalizeCertBlob([c.name, c.issuer, c.year].filter(Boolean).join(' '));
}

function certRichness(c: TailoredResumeCertification): number {
  let score = [c.name, c.issuer, c.year].filter(Boolean).join(' ').length;
  if (c.issuer?.trim()) score += 40;
  if (c.year?.trim()) score += 20;
  const desc = c.description?.trim();
  if (desc) score += Math.min(160, desc.length);
  score += (c.skills?.length ?? 0) * 18;
  return score;
}

function significantWordsFromCertBlob(blob: string): Set<string> {
  return new Set(
    blob
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 2)
  );
}

/** True if the smaller word set is at least 75% contained in the larger (rephrased duplicate). */
function certLikeWordOverlapDuplicate(a: TailoredResumeCertification, b: TailoredResumeCertification): boolean {
  const setA = significantWordsFromCertBlob(certificationBlob(a));
  const setB = significantWordsFromCertBlob(certificationBlob(b));
  const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  if (smaller.size < 4) return false;
  let inter = 0;
  smaller.forEach((w) => {
    if (larger.has(w)) inter++;
  });
  return inter / smaller.size >= 0.75;
}

/**
 * Collapse near-duplicate rows (same cert/award split differently across name/issuer/year or punctuation).
 */
export function dedupeCertLikeRows(rows: TailoredResumeCertification[]): TailoredResumeCertification[] {
  if (rows.length <= 1) return rows;
  const out: TailoredResumeCertification[] = [];
  for (const cand of rows) {
    const cBlob = certificationBlob(cand);
    if (cBlob.length < 8) {
      out.push(cand);
      continue;
    }
    let dupIdx = -1;
    for (let i = 0; i < out.length; i++) {
      const oBlob = certificationBlob(out[i]);
      if (oBlob.length < 8) continue;
      if (oBlob === cBlob) {
        dupIdx = i;
        break;
      }
      if (oBlob.length >= 28 && cBlob.length >= 28 && (oBlob.includes(cBlob) || cBlob.includes(oBlob))) {
        dupIdx = i;
        break;
      }
      if (certLikeWordOverlapDuplicate(out[i], cand)) {
        dupIdx = i;
        break;
      }
    }
    if (dupIdx === -1) {
      out.push(cand);
      continue;
    }
    if (certRichness(cand) > certRichness(out[dupIdx])) {
      out[dupIdx] = cand;
    }
  }
  return out;
}

/** Spoken / signed human languages only (not programming languages). */
const HUMAN_LANGUAGE_NAMES = new Set([
  'english', 'spanish', 'french', 'german', 'italian', 'portuguese', 'dutch', 'flemish',
  'russian', 'ukrainian', 'polish', 'czech', 'slovak', 'hungarian', 'romanian', 'bulgarian',
  'greek', 'serbian', 'croatian', 'bosnian', 'albanian', 'macedonian', 'slovenian',
  'swedish', 'norwegian', 'danish', 'finnish', 'icelandic', 'estonian', 'latvian', 'lithuanian',
  'irish', 'welsh', 'basque', 'catalan', 'galician',
  'chinese', 'mandarin', 'cantonese', 'japanese', 'korean', 'vietnamese',
  'thai', 'lao', 'khmer', 'burmese', 'indonesian', 'malay', 'tagalog', 'filipino',
  'hindi', 'urdu', 'bengali', 'punjabi', 'gujarati', 'marathi', 'telugu', 'tamil',
  'malayalam', 'kannada', 'nepali', 'sinhala', 'pashto', 'dari', 'balochi',
  'arabic', 'hebrew', 'persian', 'farsi', 'turkish', 'kurdish', 'azerbaijani', 'armenian',
  'georgian', 'kazakh', 'uzbek', 'kyrgyz', 'tajik', 'turkmen', 'mongolian',
  'swahili', 'somali', 'amharic', 'oromo', 'tigrinya', 'zulu', 'xhosa', 'afrikaans',
  'yoruba', 'igbo', 'hausa', 'shona', 'malagasy', 'lingala', 'kinyarwanda', 'kirundi',
  'american sign language', 'british sign language', 'sign language',
]);

function titleCaseLanguageWords(name: string): string {
  return name.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Parse a single skills-array entry if it names a human language (+ optional level). */
function skillLooksLikeLanguage(skill: string): TailoredResumeLanguage | null {
  const t = skill.trim();
  if (t.length < 3 || t.length > 72) return null;

  const withLevel = /^\s*([^–—\-]+?)\s*[–—\-]\s*(.+)$/.exec(t);
  if (withLevel) {
    const a = withLevel[1].trim();
    const b = withLevel[2].trim();
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    if (HUMAN_LANGUAGE_NAMES.has(la)) {
      return { language: titleCaseLanguageWords(a), proficiency: b };
    }
    if (HUMAN_LANGUAGE_NAMES.has(lb)) {
      return { language: titleCaseLanguageWords(b), proficiency: a };
    }
  }

  const paren = /^(.+?)\s*\(([^)]+)\)\s*$/.exec(t);
  if (paren) {
    const a = paren[1].trim();
    const inner = paren[2].trim();
    if (HUMAN_LANGUAGE_NAMES.has(a.toLowerCase())) {
      return { language: titleCaseLanguageWords(a), proficiency: inner };
    }
  }

  const fluentLead =
    /^(native|bilingual|fluent|professional working|professional|conversational|basic|elementary|intermediate|advanced)\s+(?:in\s+)?(.+)$/i.exec(
      t
    );
  if (fluentLead) {
    const langPart = fluentLead[2].trim();
    const ll = langPart.toLowerCase();
    if (HUMAN_LANGUAGE_NAMES.has(ll)) {
      return { language: titleCaseLanguageWords(langPart), proficiency: fluentLead[1] };
    }
  }

  const lower = t.toLowerCase();
  if (HUMAN_LANGUAGE_NAMES.has(lower)) {
    return { language: titleCaseLanguageWords(t), proficiency: '' };
  }

  return null;
}

function partitionLanguagesFromSkills(skills: string[]): { skillsOut: string[]; languagesOut: TailoredResumeLanguage[] } {
  const skillsOut: string[] = [];
  const languagesOut: TailoredResumeLanguage[] = [];
  for (const s of skills) {
    const row = skillLooksLikeLanguage(s);
    if (row) {
      languagesOut.push(row);
    } else {
      skillsOut.push(s);
    }
  }
  return { skillsOut, languagesOut };
}

function mergeLanguageRows(
  fromJson: TailoredResumeLanguage[],
  fromSkills: TailoredResumeLanguage[]
): TailoredResumeLanguage[] {
  const byLang = new Map<string, TailoredResumeLanguage>();
  for (const row of fromJson) {
    const k = row.language.trim().toLowerCase();
    if (!k) continue;
    byLang.set(k, { language: row.language.trim(), proficiency: (row.proficiency || '').trim() });
  }
  for (const row of fromSkills) {
    const k = row.language.trim().toLowerCase();
    if (!k) continue;
    const existing = byLang.get(k);
    const pNew = (row.proficiency || '').trim();
    if (!existing) {
      byLang.set(k, { language: titleCaseLanguageWords(row.language.trim()), proficiency: pNew });
      continue;
    }
    const pOld = (existing.proficiency || '').trim();
    if (pNew.length > pOld.length) {
      byLang.set(k, { language: existing.language, proficiency: pNew });
    }
  }
  return Array.from(byLang.values());
}

function normalizeLanguageEntry(raw: unknown): TailoredResumeLanguage | null {
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return null;
    const fromSkill = skillLooksLikeLanguage(t);
    if (fromSkill) return fromSkill;
    return { language: titleCaseLanguageWords(t), proficiency: '' };
  }
  if (!raw || typeof raw !== 'object') return null;
  const l = raw as Record<string, unknown>;
  const language = String(l.language ?? l.name ?? '').trim();
  if (!language) return null;
  return {
    language: titleCaseLanguageWords(language),
    proficiency: String(l.proficiency ?? l.level ?? '').trim(),
  };
}

/** Normalize a parsed JSON object into TailoredStructuredResume (defaults for missing nested fields). */
export function normalizeParsedTailoredResume(parsed: Record<string, unknown>): TailoredStructuredResume {
  const linksRaw =
    parsed.links && typeof parsed.links === 'object' && !Array.isArray(parsed.links)
      ? (parsed.links as Record<string, unknown>)
      : {};
  const otherLinks = Array.isArray(linksRaw.other) ? linksRaw.other.map((x) => String(x)) : [];

  let skillsList = normalizeSkillsFromParsed(parsed.skills);

  const experience: TailoredResumeExperience[] = Array.isArray(parsed.experience)
    ? (parsed.experience as unknown[]).map((raw) => {
        const exp = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
        const isRelevant = exp.isRelevant !== false;
        const bulletsRaw = exp.bullets;
        const bullets = Array.isArray(bulletsRaw)
          ? bulletsRaw.map(coerceBullet).filter((b) => b.text.trim().length > 0)
          : [];
        const rawDescription = String(
          exp.description ??
            exp.summary ??
            exp.overview ??
            exp.roleDescription ??
            exp.roleSummary ??
            exp.highlights ??
            ''
        ).trim();
        const { description, bullets: refinedBullets } = refineExperienceDescriptionAndBullets(
          rawDescription,
          bullets,
          isRelevant
        );
        return {
          title: String(exp.title ?? exp.role ?? ''),
          company: String(exp.company ?? ''),
          duration: String(exp.duration ?? exp.dates ?? ''),
          description,
          isRelevant,
          bullets: refinedBullets,
        };
      })
    : [];

  const projects: TailoredResumeProject[] = Array.isArray(parsed.projects)
    ? (parsed.projects as unknown[]).map((raw) => {
        const proj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
        const techRaw = proj.techStack;
        const rawTech = Array.isArray(techRaw) ? techRaw.map((x) => String(x)) : [];
        const bulletsRaw = proj.bullets;
        const bulletsCoerced = Array.isArray(bulletsRaw)
          ? bulletsRaw.map(coerceBullet).filter((b) => b.text.trim().length > 0)
          : [];
        const name = String(proj.name ?? '');
        const description = String(proj.description ?? '');
        const projectBlob = [name, description, ...bulletsCoerced.map((b) => b.text)].join('\n');
        const techStack = filterProjectTechStack(rawTech, projectBlob);
        const bullets = dedupeSimilarBullets(
          finalizeExperienceBulletsForDisplay(description.trim(), bulletsCoerced)
        );
        return {
          name,
          description,
          techStack,
          isRelevant: proj.isRelevant !== false,
          bullets,
        };
      })
    : [];

  const education: TailoredResumeEducation[] = Array.isArray(parsed.education)
    ? (parsed.education as unknown[]).map((raw) => {
        const e = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
        return {
          degree: String(e.degree ?? ''),
          institution: String(e.institution ?? ''),
          year: String(e.year ?? e.dates ?? ''),
          grade: String(e.grade ?? ''),
        };
      })
    : [];

  const certifications = normalizeCertificationsList(parsed);
  const awardsAndAchievements = normalizeAwardsAndAchievementsList(parsed);

  const languagesFromJson: TailoredResumeLanguage[] = Array.isArray(parsed.languages)
    ? (parsed.languages as unknown[])
        .map((raw) => normalizeLanguageEntry(raw))
        .filter((x): x is TailoredResumeLanguage => x != null)
    : [];

  const { skillsOut, languagesOut: languagesFromSkills } = partitionLanguagesFromSkills(skillsList);
  skillsList = skillsOut;
  const languages = mergeLanguageRows(languagesFromJson, languagesFromSkills);

  const keyChanges = Array.isArray(parsed.keyChanges) ? parsed.keyChanges.map((x) => String(x)) : [];

  return {
    name: String(parsed.name ?? ''),
    email: String(parsed.email ?? ''),
    phone: String(parsed.phone ?? ''),
    location: String(parsed.location ?? ''),
    links: {
      linkedin: String(linksRaw.linkedin ?? linksRaw.linkedIn ?? ''),
      github: String(linksRaw.github ?? ''),
      portfolio: String(linksRaw.portfolio ?? ''),
      other: otherLinks,
    },
    summary: String(parsed.summary ?? ''),
    skills: skillsList,
    experience,
    projects,
    education,
    certifications: dedupeCertLikeRows(certifications),
    awardsAndAchievements: dedupeCertLikeRows(awardsAndAchievements),
    languages,
    keyChanges,
  };
}

/**
 * Normalize stored or API JSON (including legacy { skills: { relevant, other } }) for preview / PDF / HTML.
 */
export function coerceTailoredStructuredForTemplate(raw: unknown): TailoredStructuredResume | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.name !== 'string' || typeof rec.email !== 'string' || !('skills' in rec)) return null;
  const arrayKeys = [
    'experience',
    'projects',
    'education',
    'certifications',
    'awardsAndAchievements',
    'languages',
    'keyChanges',
  ] as const;
  const base: Record<string, unknown> = { ...rec };
  for (const key of arrayKeys) {
    if (!Array.isArray(base[key])) base[key] = [];
  }
  return normalizeParsedTailoredResume(base as Record<string, unknown>);
}

export function isTailoredStructuredResume(o: unknown): o is TailoredStructuredResume {
  return coerceTailoredStructuredForTemplate(o) !== null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const HIGHLIGHT_STYLE = 'background:#fef3c7;padding:0 2px;border-radius:1px;';

function applyHighlights(escaped: string, terms: string[]): string {
  if (!terms?.length) return escaped;
  const seen = new Set<string>();
  let out = escaped;
  const sorted = [...terms]
    .filter(Boolean)
    .map((t) => t.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const term of sorted) {
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    const re = new RegExp(escapeRegex(term), 'gi');
    out = out.replace(re, (match) => `<mark style="${HIGHLIGHT_STYLE}">${match}</mark>`);
  }
  return out;
}

function hl(raw: string, terms: string[]): string {
  return applyHighlights(escapeHtml(raw), terms);
}

function linkHref(url: string): string {
  const t = url.trim();
  if (!t) return '';
  return t.startsWith('http') ? t : `https://${t}`;
}

function buildContactParts(data: TailoredStructuredResume, terms: string[]): string {
  const parts: string[] = [];
  if (data.email?.trim()) parts.push(hl(data.email.trim(), terms));
  if (data.phone?.trim()) parts.push(hl(data.phone.trim(), terms));
  if (data.location?.trim()) parts.push(hl(data.location.trim(), terms));
  const L = data.links;
  if (L?.linkedin?.trim()) {
    const u = linkHref(L.linkedin.trim());
    parts.push(`<a href="${escapeHtml(u)}" style="color:#222;">${hl(L.linkedin.trim(), terms)}</a>`);
  }
  if (L?.github?.trim()) {
    const u = linkHref(L.github.trim());
    parts.push(`<a href="${escapeHtml(u)}" style="color:#222;">${hl(L.github.trim(), terms)}</a>`);
  }
  if (L?.portfolio?.trim()) {
    const u = linkHref(L.portfolio.trim());
    parts.push(`<a href="${escapeHtml(u)}" style="color:#222;">${hl(L.portfolio.trim(), terms)}</a>`);
  }
  for (const o of L?.other ?? []) {
    const s = String(o).trim();
    if (!s) continue;
    const u = linkHref(s);
    parts.push(`<a href="${escapeHtml(u)}" style="color:#222;">${hl(s, terms)}</a>`);
  }
  return parts.join(' &nbsp;|&nbsp; ');
}

const SECTION_TITLE =
  'font-size:11pt;font-weight:bold;text-transform:uppercase;letter-spacing:0.05em;margin:1.1em 0 0.5em 0;padding-bottom:5px;border-bottom:2px solid #1a4568;color:#222;width:100%;max-width:100%;box-sizing:border-box;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;';

/** Full-width justified body copy (summary, role blurbs, project text). */
const BODY_PROSE =
  'width:100%;max-width:100%;box-sizing:border-box;line-height:1.55;margin:0.4em 0 0 0;color:#222;text-align:justify;text-justify:inter-word;overflow-wrap:anywhere;word-wrap:break-word;';

const UL_BLOCK =
  'margin:0.4em 0 0 0;padding:0 0 0 1.15em;line-height:1.55;list-style-position:outside;width:100%;max-width:100%;box-sizing:border-box;';

const ITEM_RELEVANT =
  'width:100%;max-width:100%;box-sizing:border-box;margin:0.5em 0;padding:0 0 0 11px;border-left:3px solid #1a4568;clear:both;';
const ITEM_DIM =
  'width:100%;max-width:100%;box-sizing:border-box;margin:0.5em 0;padding:0 0 0 14px;border-left:3px solid transparent;clear:both;';

const PAGE_ROOT =
  'width:100%;max-width:100%;box-sizing:border-box;margin:0;padding:0;font-size:11pt;line-height:1.5;color:#222;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;background:#fff;overflow-wrap:anywhere;word-wrap:break-word;';

/** Awards block: project-style title, optional issuer/year line (never tool lists), skill chips, short description. */
function buildResumeAwardsSectionHtml(items: TailoredResumeCertification[], terms: string[]): string {
  if (!items.length) return '';
  const rows = items
    .map((a) => {
      const itemStyle = a.isRelevant !== false ? ITEM_RELEVANT : ITEM_DIM;
      const name = (a.name || 'Award').trim();
      const descRaw = (a.description || '').trim();
      const descPlain = awardDescriptionForDisplay(descRaw);
      const { displayIssuer, displayYear, skills } = filteredAwardSkillsForDisplay(a, descRaw);
      const metaLine = [displayIssuer, displayYear].filter(Boolean).join(' — ');
      const metaHtml = metaLine
        ? `<p style="margin:0.15em 0 0 0;font-size:9.5pt;color:#444;line-height:1.35;width:100%;overflow-wrap:anywhere;">${hl(metaLine, terms)}</p>`
        : '';
      const techHtml = skills.length
        ? `<p style="margin:0.25em 0 0 0;font-size:9.5pt;line-height:1.4;">${skills
            .map(
              (t) =>
                `<span style="display:inline-block;background:#f1f5f9;color:#222;padding:2px 6px;border-radius:3px;margin:2px 4px 2px 0;font-size:9pt;">${hl(t, terms)}</span>`
            )
            .join('')}</p>`
        : '';
      const descHtml = descPlain
        ? `<p style="${BODY_PROSE}margin-top:0.3em;">${hl(descPlain, terms)}</p>`
        : '';
      return `<div style="${itemStyle}"><p style="margin:0 0 0.1em 0;font-weight:700;line-height:1.35;width:100%;overflow-wrap:anywhere;">${hl(name, terms)}</p>${metaHtml}${techHtml}${descHtml}</div>`;
    })
    .join('');
  return `<section style="margin-bottom:0.9em;width:100%;max-width:100%;box-sizing:border-box;">
    <h2 style="${SECTION_TITLE}">${escapeHtml('Awards and Achievements')}</h2>
    <div style="width:100%;max-width:100%;">${rows}</div>
  </section>`;
}

function buildResumeCertLikeSectionHtml(
  items: TailoredResumeCertification[],
  heading: string,
  terms: string[]
): string {
  if (!items.length) return '';
  const ul = `<ul style="${UL_BLOCK}margin-top:0;">${items
    .map((c) => {
      const line = [c.name, c.issuer, c.year].filter((x) => String(x || '').trim()).join(' — ');
      if (!line) return '';
      return `<li style="margin-bottom:0.25em;text-align:justify;overflow-wrap:anywhere;">${hl(line, terms)}</li>`;
    })
    .filter(Boolean)
    .join('')}</ul>`;
  return `<section style="margin-bottom:0.9em;width:100%;max-width:100%;box-sizing:border-box;">
    <h2 style="${SECTION_TITLE}">${escapeHtml(heading)}</h2>
    <div>${ul}</div>
  </section>`;
}

export interface BuildResumeHtmlOptions {
  highlightTerms?: string[];
}

/** Inner resume markup (one root div) — for React dangerouslySetInnerHTML preview. */
export function buildResumePreviewFragment(
  data: TailoredStructuredResume,
  options?: BuildResumeHtmlOptions
): string {
  const terms = options?.highlightTerms ?? [];
  const name = (data.name || 'Your Name').trim();
  const contact = buildContactParts(data, terms);

  const blocks: string[] = [];

  blocks.push(`<header style="margin-bottom:0.85em;width:100%;max-width:100%;box-sizing:border-box;">
    <h1 style="font-size:21pt;font-weight:700;margin:0 0 0.2em 0;color:#222;width:100%;line-height:1.2;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;">${escapeHtml(name)}</h1>
    ${contact ? `<p style="font-size:10pt;color:#222;margin:0;font-style:italic;line-height:1.5;width:100%;max-width:100%;overflow-wrap:anywhere;word-wrap:break-word;">${contact}</p>` : ''}
  </header>`);

  const summary = (data.summary || '').trim();
  if (summary) {
    blocks.push(`<section style="margin-bottom:0.9em;width:100%;max-width:100%;box-sizing:border-box;">
    <h2 style="${SECTION_TITLE}">Professional Summary</h2>
    <div style="white-space:pre-wrap;${BODY_PROSE}margin-top:0.25em;text-align:justify;">${hl(summary, terms)}</div>
  </section>`);
  }

  const allSkills = (data.skills ?? []).map((s) => s.trim()).filter(Boolean);
  if (allSkills.length > 0) {
    const skillsInner = `<p style="margin:0;line-height:1.65;width:100%;max-width:100%;overflow-wrap:anywhere;word-wrap:break-word;text-align:left;">${allSkills
      .map(
        (s) =>
          `<span style="display:inline-block;background:#f1f5f9;color:#222;padding:3px 8px;border-radius:4px;font-size:9.5pt;margin:2px 6px 2px 0;">${hl(s, terms)}</span>`
      )
      .join('')}</p>${
      terms.length > 0
        ? `<p style="margin:0.35em 0 0 0;font-size:8.5pt;color:#222;">Skills that match this job posting are highlighted.</p>`
        : ''
    }`;
    blocks.push(`<section style="margin-bottom:0.9em;width:100%;max-width:100%;box-sizing:border-box;">
    <h2 style="${SECTION_TITLE}">Skills</h2>
    <div style="width:100%;max-width:100%;">${skillsInner}</div>
  </section>`);
  }

  const exps = data.experience ?? [];
  if (exps.length > 0) {
    const rows = exps
      .map((exp) => {
        const titleLine = [exp.title, exp.company].filter(Boolean).join(' — ');
        const dur = exp.duration?.trim() ? ` &nbsp;|&nbsp; ${hl(exp.duration.trim(), terms)}` : '';
        const itemStyle = exp.isRelevant !== false ? ITEM_RELEVANT : ITEM_DIM;
        const desc = (exp.description || '').trim();
        const descHtml = desc
          ? `<div style="${BODY_PROSE}margin-top:0.3em;">${hl(desc, terms)}</div>`
          : '';
        const bullets = dedupeSimilarBullets(finalizeExperienceBulletsForDisplay(desc, exp.bullets ?? []));
        const ul =
          bullets.length > 0
            ? `<ul style="${UL_BLOCK}">${bullets
                .map((b) => {
                  const liStyle = '';
                  return `<li style="${liStyle}margin-bottom:0.28em;text-align:justify;text-justify:inter-word;overflow-wrap:anywhere;">${hl(b.text.trim(), terms)}</li>`;
                })
                .join('')}</ul>`
            : '';
        return `<div style="${itemStyle}"><p style="margin:0 0 0.1em 0;font-weight:700;line-height:1.35;width:100%;max-width:100%;overflow-wrap:anywhere;">${hl(titleLine, terms)}${dur}</p>${descHtml}${ul}</div>`;
      })
      .join('');
    blocks.push(`<section style="margin-bottom:0.9em;width:100%;max-width:100%;box-sizing:border-box;">
    <h2 style="${SECTION_TITLE}">Work Experience</h2>
    <div style="width:100%;max-width:100%;">${rows}</div>
  </section>`);
  }

  const projs = data.projects ?? [];
  if (projs.length > 0) {
    const rows = projs
      .map((proj) => {
        const itemStyle = proj.isRelevant !== false ? ITEM_RELEVANT : ITEM_DIM;
        const descPlain = (proj.description || '').trim();
        const bulletsForProj = dedupeSimilarBullets(
          finalizeExperienceBulletsForDisplay(descPlain, proj.bullets ?? [])
        );
        const projectBlob = [proj.name, descPlain, ...bulletsForProj.map((b) => b.text)].join('\n');
        const tech = filterProjectTechStack(
          (proj.techStack ?? []).map((t) => t.trim()).filter(Boolean),
          projectBlob
        );
        const techHtml = tech.length
          ? `<p style="margin:0.25em 0 0 0;font-size:9.5pt;line-height:1.4;">${tech.map((t) => `<span style="display:inline-block;background:#f1f5f9;color:#222;padding:2px 6px;border-radius:3px;margin:2px 4px 2px 0;font-size:9pt;">${hl(t, terms)}</span>`).join('')}</p>`
          : '';
        const desc = descPlain
          ? `<p style="${BODY_PROSE}margin-top:0.3em;">${hl(descPlain, terms)}</p>`
          : '';
        const bullets = bulletsForProj.filter((b) => (b.text || '').trim());
        const ul =
          bullets.length > 0
            ? `<ul style="${UL_BLOCK}">${bullets
                .map((b) => {
                  const liStyle = '';
                  return `<li style="${liStyle}margin-bottom:0.28em;text-align:justify;overflow-wrap:anywhere;">${hl(b.text.trim(), terms)}</li>`;
                })
                .join('')}</ul>`
            : '';
        return `<div style="${itemStyle}"><p style="margin:0 0 0.1em 0;font-weight:700;line-height:1.35;width:100%;overflow-wrap:anywhere;">${hl((proj.name || 'Project').trim(), terms)}</p>${techHtml}${desc}${ul}</div>`;
      })
      .join('');
    blocks.push(`<section style="margin-bottom:0.9em;width:100%;max-width:100%;box-sizing:border-box;">
    <h2 style="${SECTION_TITLE}">Projects</h2>
    <div style="width:100%;max-width:100%;">${rows}</div>
  </section>`);
  }

  const edu = data.education ?? [];
  if (edu.length > 0) {
    const ul = `<ul style="${UL_BLOCK}margin-top:0;">${edu
      .map((e) => {
        const line = [e.degree, e.institution, e.year, e.grade].filter((x) => String(x || '').trim()).join(' | ');
        return line ? `<li style="margin-bottom:0.25em;text-align:justify;overflow-wrap:anywhere;">${hl(line, terms)}</li>` : '';
      })
      .filter(Boolean)
      .join('')}</ul>`;
    blocks.push(`<section style="margin-bottom:0.9em;width:100%;max-width:100%;box-sizing:border-box;">
    <h2 style="${SECTION_TITLE}">Education</h2>
    <div>${ul}</div>
  </section>`);
  }

  const awards = data.awardsAndAchievements ?? [];
  const awardsHtml = buildResumeAwardsSectionHtml(awards, terms);
  if (awardsHtml) blocks.push(awardsHtml);

  const certs = data.certifications ?? [];
  const certsHtml = buildResumeCertLikeSectionHtml(certs, 'Certifications', terms);
  if (certsHtml) blocks.push(certsHtml);

  const langs = data.languages ?? [];
  if (langs.length > 0) {
    const ul = `<ul style="${UL_BLOCK}margin-top:0;">${langs
      .map((l) => {
        const line = [l.language, l.proficiency].filter((x) => String(x || '').trim()).join(' — ');
        return line ? `<li style="margin-bottom:0.25em;">${hl(line, terms)}</li>` : '';
      })
      .filter(Boolean)
      .join('')}</ul>`;
    blocks.push(`<section style="margin-bottom:0.85em;">
    <h2 style="${SECTION_TITLE}">Languages</h2>
    <div>${ul}</div>
  </section>`);
  }

  return `<div class="resume-page" style="${PAGE_ROOT}">${blocks.join('')}</div>`;
}

const DOCUMENT_STYLES = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: 100%; max-width: 100%; }
  body {
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.5;
    color: #222;
    background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .resume-page { width: 100% !important; max-width: 100% !important; margin: 0 !important; padding: 10mm 12mm !important; }
`;

/** Full HTML document for Puppeteer PDF (inline CSS only). */
export function buildResumeHTMLTemplate(
  data: TailoredStructuredResume,
  options?: BuildResumeHtmlOptions
): string {
  const inner = buildResumePreviewFragment(data, options);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Resume</title>
  <style>${DOCUMENT_STYLES}</style>
</head>
<body>${inner}</body>
</html>`;
}

/** Plain-text version for storage / apply flows when JSON tailoring succeeds. */
export function tailoredStructuredResumeToPlainText(data: TailoredStructuredResume): string {
  const lines: string[] = [];
  lines.push(data.name || '');
  if (data.email?.trim()) lines.push(data.email.trim());
  if (data.phone?.trim()) lines.push(data.phone.trim());
  if (data.location?.trim()) lines.push(data.location.trim());
  const L = data.links;
  if (L?.linkedin?.trim()) lines.push(`LinkedIn: ${L.linkedin.trim()}`);
  if (L?.github?.trim()) lines.push(`GitHub: ${L.github.trim()}`);
  if (L?.portfolio?.trim()) lines.push(`Portfolio: ${L.portfolio.trim()}`);
  for (const o of L?.other ?? []) {
    const s = String(o).trim();
    if (s) lines.push(s);
  }
  if (data.summary?.trim()) {
    lines.push('');
    lines.push('PROFESSIONAL SUMMARY');
    lines.push(data.summary.trim());
  }
  const skillLines = (data.skills ?? []).map((s) => String(s).trim()).filter(Boolean);
  if (skillLines.length) {
    lines.push('');
    lines.push('SKILLS');
    lines.push(skillLines.join(', '));
  }
  if ((data.experience ?? []).length) {
    lines.push('');
    lines.push('EXPERIENCE');
    for (const exp of data.experience) {
      lines.push('');
      lines.push([exp.title, exp.company].filter(Boolean).join(' — '));
      if (exp.duration?.trim()) lines.push(exp.duration.trim());
      if (exp.description?.trim()) lines.push(exp.description.trim());
      for (const b of exp.bullets ?? []) {
        if (b.text?.trim()) lines.push(`• ${b.text.trim()}`);
      }
    }
  }
  if ((data.projects ?? []).length) {
    lines.push('');
    lines.push('PROJECTS');
    for (const p of data.projects) {
      lines.push('');
      lines.push(p.name || '');
      if (p.description?.trim()) lines.push(p.description.trim());
      const ts = (p.techStack ?? []).filter(Boolean);
      if (ts.length) lines.push(`Tech: ${ts.join(', ')}`);
      for (const b of p.bullets ?? []) {
        if (b.text?.trim()) lines.push(`• ${b.text.trim()}`);
      }
    }
  }
  if ((data.education ?? []).length) {
    lines.push('');
    lines.push('EDUCATION');
    for (const e of data.education) {
      const line = [e.degree, e.institution, e.year, e.grade].filter((x) => String(x || '').trim()).join(' | ');
      if (line) lines.push(line);
    }
  }
  const pushCertLines = (label: string, list: TailoredResumeCertification[]) => {
    if (!list.length) return;
    lines.push('');
    lines.push(label);
    for (const c of list) {
      const line = [c.name, c.issuer, c.year].filter((x) => String(x || '').trim()).join(' — ');
      if (line) lines.push(line);
    }
  };
  {
    const awards = data.awardsAndAchievements ?? [];
    if (awards.length) {
      lines.push('');
      lines.push('AWARDS AND ACHIEVEMENTS');
      for (const a of awards) {
        lines.push('');
        const descRaw = (a.description || '').trim();
        const descPlain = awardDescriptionForDisplay(descRaw);
        const { displayIssuer, displayYear, skills } = filteredAwardSkillsForDisplay(a, descRaw);
        const head = [a.name, displayIssuer, displayYear].filter((x) => String(x || '').trim()).join(' — ');
        if (head) lines.push(head);
        if (descPlain) lines.push(descPlain);
        if (skills.length) lines.push(`Skills: ${skills.join(', ')}`);
      }
    }
  }
  pushCertLines('CERTIFICATIONS', data.certifications ?? []);
  if ((data.languages ?? []).length) {
    lines.push('');
    lines.push('LANGUAGES');
    for (const l of data.languages) {
      const line = [l.language, l.proficiency].filter((x) => String(x || '').trim()).join(' — ');
      if (line) lines.push(line);
    }
  }
  return lines.join('\n').trim();
}
