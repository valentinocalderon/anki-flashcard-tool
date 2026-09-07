import { expect, test } from 'vitest';
import { formatResultLine } from './resultLine';

test.each([
  { vocabCards: 1, conjugationCards: 1, expected: '1 vocab card plus 1 conjugation card' },
  { vocabCards: 2, conjugationCards: 2, expected: '2 vocab cards plus 2 conjugation cards' },
  { vocabCards: 1, conjugationCards: 0, expected: '1 vocab card' },
  { vocabCards: 2, conjugationCards: 0, expected: '2 vocab cards' },
  { vocabCards: 0, conjugationCards: 1, expected: '1 conjugation card' },
  { vocabCards: 0, conjugationCards: 2, expected: '2 conjugation cards' },
  { vocabCards: 0, conjugationCards: 0, expected: '' },
])('formats added counts with singular, plural, and zero parts omitted: %j', (result) => {
  expect(formatResultLine({ word: 'casa', status: 'added', ...result })).toBe(result.expected);
});

test('formats an existing word as already stored', () => {
  expect(formatResultLine({
    word: 'casa', status: 'exists', vocabCards: 0, conjugationCards: 0,
  })).toBe('already stored');
});

test('names a skipped word and why it was skipped', () => {
  expect(formatResultLine({
    word: 'casa', status: 'skipped', vocabCards: 0, conjugationCards: 0,
  })).toBe('skipped: already stored');
});

test('formats an error using its message', () => {
  expect(formatResultLine({
    word: 'casa', status: 'error', vocabCards: 0, conjugationCards: 0,
    message: 'Lookup unavailable; retry later',
  })).toBe('Lookup unavailable; retry later');
});
