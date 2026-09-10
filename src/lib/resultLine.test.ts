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

test('says the stored card changed and asks to check Anki if it was already sent', () => {
  expect(formatResultLine({
    word: '¡Adiós! / ¡Chao!', status: 'updated', vocabCards: 0, conjugationCards: 0,
  })).toBe('updated: stored card changed; check Anki if this card was already sent');
});

test.each([
  { vocabCards: 0, conjugationCards: 2, expected: '2 conjugation cards added; updated: stored card changed; check Anki if this card was already sent' },
  { vocabCards: 1, conjugationCards: 0, expected: '1 vocab card added; updated: stored card changed; check Anki if this card was already sent' },
  { vocabCards: 1, conjugationCards: 1, expected: '1 vocab card plus 1 conjugation card added; updated: stored card changed; check Anki if this card was already sent' },
])('keeps inserted counts and the conditional Anki warning together: %j', ({ vocabCards, conjugationCards, expected }) => {
  expect(formatResultLine({
    word: 'hablar / platicar', status: 'updated', vocabCards, conjugationCards,
  })).toBe(expected);
});

test('names a skipped word and why it was skipped', () => {
  expect(formatResultLine({
    word: 'casa', status: 'skipped', vocabCards: 0, conjugationCards: 0,
  })).toBe('skipped: already stored');
});

test('distinguishes a duplicate in this run from an already stored item', () => {
  expect(formatResultLine({
    word: 'casa', status: 'duplicate', vocabCards: 0, conjugationCards: 0,
  })).toBe('skipped: duplicate in this run');
});

test('formats an error using its message', () => {
  expect(formatResultLine({
    word: 'casa', status: 'error', vocabCards: 0, conjugationCards: 0,
    message: 'Lookup unavailable; retry later',
  })).toBe('Lookup unavailable; retry later');
});

test.each([
  { status: 'added' as const, vocabCards: 2, expected: '2 vocab cards; 0 conjugation cards: Spanish side does not match a single infinitive with the classified ending -ar.' },
  { status: 'added' as const, vocabCards: 0, expected: '0 conjugation cards: Spanish side does not match a single infinitive with the classified ending -ar.' },
  { status: 'updated' as const, vocabCards: 1, expected: '1 vocab card added; updated: stored card changed; check Anki if this card was already sent; 0 conjugation cards: Spanish side does not match a single infinitive with the classified ending -ar.' },
  { status: 'updated' as const, vocabCards: 0, expected: 'updated: stored card changed; check Anki if this card was already sent; 0 conjugation cards: Spanish side does not match a single infinitive with the classified ending -ar.' },
  { status: 'exists' as const, vocabCards: 0, expected: 'already stored; 0 conjugation cards: Spanish side does not match a single infinitive with the classified ending -ar.' },
])('renders a gated result with its stored outcome: $status, $vocabCards vocab cards', ({ status, vocabCards, expected }) => {
  expect(formatResultLine({
    word: 'Nos gusta', status, vocabCards, conjugationCards: 0,
    message: '0 conjugation cards: Spanish side does not match a single infinitive with the classified ending -ar.',
  })).toBe(expected);
});
