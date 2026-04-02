/**
 * Tailored resume HTML preview — same markup as server Puppeteer PDF (see @shared/tailoredResumeHtml).
 */
import type { TailoredStructuredResume } from '@shared/tailoredResumeHtml';
import {
  buildResumeHTMLTemplate,
  buildResumePreviewFragment,
  type BuildResumeHtmlOptions,
} from '@shared/tailoredResumeHtml';

export type PopulateResumeOptions = BuildResumeHtmlOptions;

export { buildResumeHTMLTemplate };

/** Replace placeholders in the template with structured resume data. */
export function populateResumeTemplate(data: TailoredStructuredResume, options?: PopulateResumeOptions): string {
  return buildResumePreviewFragment(data, options);
}
