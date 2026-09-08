import type { WordResult } from '@/lib/types';

export function formatResultLine(result: WordResult): string {
  if (result.status === 'error') return result.message;
  if (result.status === 'exists') return 'already stored';
  if (result.status === 'skipped') return 'skipped: already stored';

  const parts: string[] = [];
  if (result.vocabCards > 0) {
    parts.push(`${result.vocabCards} vocab card${result.vocabCards === 1 ? '' : 's'}`);
  }
  if (result.conjugationCards > 0) {
    parts.push(`${result.conjugationCards} conjugation card${result.conjugationCards === 1 ? '' : 's'}`);
  }
  const added = parts.join(' plus ');
  if (result.status !== 'updated') return added;

  const warning = 'updated: stored card changed; check Anki if this card was already sent';
  if (parts.length === 0) return warning;
  return `${added} added; ${warning}`;
}
