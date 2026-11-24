import { createHash } from 'node:crypto';
import { Document, Packer, Paragraph, Tab, TextRun } from 'docx';
import type { Ground as AssessmentGround } from '../assessment/commands.js';

export const layouts = ['formal', 'brief'] as const;
export const formats = ['txt', 'docx'] as const;
export type Layout = typeof layouts[number];
export type Format = typeof formats[number];

export interface Selection {
  questionId: string;
  questionVersion: number;
  decisionId: string;
}

export interface Ground extends Selection {
  kind: AssessmentGround['kind'];
  scopeId: string;
  recipient: string;
  subject: string;
  action: string;
  sources: readonly { label: string; address: AssessmentGround['citations'][number] }[];
  /** Assessment-owned facts and versioned provenance preserved in history. */
  basis: AssessmentGround;
  /** Full text assembled from the confirmed assessment. */
  wording: string;
  alternativeWording: string;
}

export interface LetterItem extends Ground {
  id: string;
  /** Null uses the exact wording supplied by the confirmed assessment. */
  editedWording: string | null;
  wordingApproval?: WordingApproval;
}

export interface TextRange {
  start: number;
  end: number;
}

export interface WordingReview {
  wordingSha256: string;
  scope: TextRange;
  subject: TextRange;
  action: TextRange;
  citations: Array<{ observationId: string; reference: TextRange; value?: TextRange }>;
}

export interface WordingApproval extends WordingReview {
  actorId: string;
  confirmedAt: string;
  basisSha256: string;
}

export const contentTypes: Record<Format, string> = {
  txt: 'text/plain; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function externalLine(value: string) {
  return value.toWellFormed().replace(/[\u0000-\u001f\ufffe\uffff]/gu, ' ').replace(/ +/gu, ' ').trim();
}

export function renderText(
  recipient: string, layout: Layout, items: readonly LetterItem[], includeStage = true,
): string {
  const contents = items.map((item, index) => `${index + 1}. ${item.editedWording ?? item.wording}`);
  const title = layout === 'formal' ? 'Запрос исходных данных' : 'Запрос';
  const stage = includeStage ? externalLine(items[0]?.basis?.scope?.stage ?? '') : '';
  const stageLine = stage ? [`Стадия ${stage}`] : [];
  return [title, `Кому: ${recipient}`, ...stageLine, ...contents].join('\n\n');
}

export async function renderDocument(format: Format, text: string): Promise<Buffer> {
  if (format === 'txt') return Buffer.from(text, 'utf8');

  const children = text.split('\n').map((line) => {
    const runs = line.split('\t').map((part, index) => new TextRun({
      children: index === 0 ? [part] : [new Tab(), part],
    }));
    return new Paragraph({ children: runs });
  });
  const document = new Document({
    styles: { default: { document: { run: { font: 'Arial', size: 22 } } } },
    sections: [{ children }],
  });
  return Packer.toBuffer(document);
}
