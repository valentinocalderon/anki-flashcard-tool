import type { WordResult } from '@/lib/types';

export function formatResultLine(result: WordResult): string {
  if (result.status === 'error') return result.message;
  if (result.status === 'exists') return 'already stored';

  const parts: string[] = [];
  if (result.vocabCards > 0) {
    parts.push(`${result.vocabCards} vocab card${result.vocabCards === 1 ? '' : 's'}`);
  }
  if (result.conjugationCards > 0) {
    parts.push(`${result.conjugationCards} conjugation card${result.conjugationCards === 1 ? '' : 's'}`);
  }
  return parts.join(' plus ');
}
