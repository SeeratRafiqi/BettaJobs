export interface FaqEntry {
  question: string;
  answer: string;
  keywords: string[];
}

export const FAQ_LIST: FaqEntry[] = [
  {
    question: 'How do I upload my CV?',
    answer:
      'Go to your candidate dashboard and use the CV upload area. Upload a PDF or supported document, then wait for the system to parse it and build your candidate profile.',
    keywords: ['upload', 'cv', 'resume', 'pdf', 'document'],
  },
  {
    question: 'How does job matching work?',
    answer:
      'The platform compares your CV skills, experience, and role preferences with job requirements. Matches are ranked by relevance so you can focus on the strongest opportunities first.',
    keywords: ['matching', 'match', 'score', 'rank', 'jobs'],
  },
  {
    question: 'Can I tailor my resume for a job?',
    answer:
      'Yes. Open a job that interests you and use the tailoring tools to generate a role-specific resume draft based on your existing CV and the job requirements.',
    keywords: ['tailor', 'tailored', 'resume', 'job', 'customize'],
  },
  {
    question: 'Can I generate a cover letter?',
    answer:
      'Yes. For supported jobs, you can generate a cover letter draft that uses your profile and the job description. Review and edit it before submitting.',
    keywords: ['cover', 'letter', 'generate', 'application'],
  },
  {
    question: 'How do I apply for a job?',
    answer:
      'Open the job details page, review the requirements, choose the CV or tailored resume you want to submit, add any requested information, and submit your application.',
    keywords: ['apply', 'application', 'submit', 'job'],
  },
  {
    question: 'Where can I see my applications?',
    answer:
      'Your dashboard shows submitted applications, current statuses, matches, and interview-related updates when they are available.',
    keywords: ['applications', 'status', 'dashboard', 'submitted'],
  },
  {
    question: 'What should I do if CV parsing looks wrong?',
    answer:
      'Check that your CV text is selectable and clearly formatted. If something still looks wrong, upload a cleaner version or update your profile fields manually.',
    keywords: ['parsing', 'wrong', 'error', 'profile', 'fields'],
  },
  {
    question: 'How do voice interviews work?',
    answer:
      'If a company assigns a voice interview, you will see it in your dashboard. Complete it before the deadline and make sure your microphone is working before you start.',
    keywords: ['voice', 'interview', 'microphone', 'deadline'],
  },
];

export function getFaqSuggestions(limit = 6): string[] {
  return FAQ_LIST.slice(0, limit).map((entry) => entry.question);
}

export function getFaqAnswer(query: string): FaqEntry | undefined {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return undefined;

  const exactMatch = FAQ_LIST.find(
    (entry) => entry.question.toLowerCase() === normalizedQuery,
  );
  if (exactMatch) return exactMatch;

  return FAQ_LIST.find((entry) =>
    entry.keywords.some((keyword) => normalizedQuery.includes(keyword)),
  );
}
