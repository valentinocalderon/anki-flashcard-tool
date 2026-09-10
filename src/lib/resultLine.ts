import type { WordResult } from '@/lib/types';

export function formatResultLine(result: WordResult): string {
  if (result.status === 'error') return result.message;
  if (result.status === 'skipped') return 'skipped: already stored';
  if (result.status === 'duplicate') return 'skipped: duplicate in this run';

  const parts: string[] = [];
  if (result.vocabCards > 0) {
    parts.push(`${result.vocabCards} vocab card${result.vocabCards === 1 ? '' : 's'}`);
  }
  if (result.conjugationCards > 0) {
    parts.push(`${result.conjugationCards} conjugation card${result.conjugationCards === 1 ? '' : 's'}`);
  }
  let line = parts.join(' plus ');
  if (result.status === 'exists') line = 'already stored';
  if (result.status === 'updated') {
    const warning = 'updated: stored card changed; check Anki if this card was already sent';
    line = parts.length === 0 ? warning : `${line} added; ${warning}`;
  }
  return [line, result.message].filter(Boolean).join('; ');
}
