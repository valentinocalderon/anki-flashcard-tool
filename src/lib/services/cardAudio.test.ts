import { expect, test } from 'vitest';
import type { WordInfo } from '@/lib/types';
import type { cards } from '@/server/db/schema';
import { cardAudio } from './cardAudio';
import { conjugationCards, generateCards } from './cardGenerator';

const basic: typeof cards.$inferSelect = {
  id: 41, wordId: 1, deck: 'Spanish::Vocab', kind: 'basic', front: 'house',
  back: '  la <b>casa</b> &amp; el hogar\n', tags: '["vocab"]', forms: null,
  audioFile: null, audioMp3: null, audioSentAt: null, ankiNoteId: null, sentAt: null, declinedAt: null, createdAt: 123,
};
const example: typeof cards.$inferSelect = {
  ...basic, id: 42, kind: 'example', front: 'La ____ es grande.',
  back: 'casa (house) (The <em>house</em> is big &amp; bright.)  ',
};
const conjugation: typeof cards.$inferSelect = {
  ...basic, id: 43, deck: 'Spanish::Conjugation', kind: 'conjugation',
  front: 'Conjugate hablar in present (regular -ar)',
  back: 'yo: hablo<br>tú: hablas<br>él/ella: habla<br>nosotros: hablamos<br>vosotros: habláis<br>ellos: hablan',
};

test.each([
  {
    card: basic,
    expected: {
      text: '  la <b>casa</b> &amp; el hogar\n',
      audioFile: 'card-39ea127757ece19e4f940e03a400b6cc3fae452580ca79223e0d6b75148a5477.mp3',
    },
  },
  {
    card: example,
    expected: {
      text: 'casa (house) (The <em>house</em> is big &amp; bright.)  ',
      audioFile: 'card-4c344c79b718a77c9b2bf1afebdd12740e1959784d43c22a867bbcb85d9e74bb.mp3',
    },
  },
  {
    card: conjugation,
    expected: {
      text: 'yo: hablo tú: hablas él/ella: habla nosotros: hablamos vosotros: habláis ellos: hablan',
      audioFile: 'card-c601592f902a214434a7a704ad2f32fbbe719057a47ea3c26506cc66eb97ccf1.mp3',
    },
  },
])('prepares a stored $card.kind card for speech and media', ({ card, expected }) => {
  expect(cardAudio(card)).toEqual(expected);
});

const word: WordInfo = {
  english: 'house', spanish: 'casa', gender: 'feminine', article: 'la', type: 'noun',
  example: 'La casa es grande. (The house is big.)', conjugations: null,
};

test('preserves literal speech for generated basic and example cards', () => {
  expect(generateCards(word).map((card) => cardAudio(card).text)).toEqual([
    'la casa', 'casa (house) (The house is big.)',
  ]);
  expect(generateCards({
    ...word, spanish: '¡adiós!', english: 'goodbye', article: null,
    example: '¡Adiós!, amigo.',
  }).map((card) => cardAudio(card).text)).toEqual([
    '¡adiós!', '¡adiós! (goodbye)',
  ]);
  expect(generateCards({
    ...word, spanish: 'tener', english: 'to have', article: null, type: 'verb',
    example: 'Tengo un pingüino. (I have a penguin.)', exampleWord: 'Tengo',
  }).map((card) => cardAudio(card).text)).toEqual([
    'tener', 'Tengo (tener, to have) (I have a penguin.)',
  ]);
  expect(generateCards({
    ...word, spanish: 'oír', english: 'to hear', article: null, type: 'verb',
    example: 'Oigo música.', exampleWord: 'Oigo',
  }).map((card) => cardAudio(card).text)).toEqual([
    'oír', 'Oigo (oír, to hear)',
  ]);
});

test('preserves literal speech for generated single and multiple forms', () => {
  expect(generateCards({ forms: [
    { spanish: 'la casa', query: 'casa', info: word },
  ] }).map((card) => cardAudio(card).text)).toEqual([
    'la casa', 'casa (house) (The house is big.)',
  ]);
  expect(generateCards({ forms: [
    { spanish: '¡adiós!', query: 'adiós', info: { ...word, english: 'goodbye' } },
    { spanish: '¡chao!', query: 'chao', info: { ...word, english: 'bye' } },
  ] }).map((card) => cardAudio(card).text)).toEqual(['¡adiós! / ¡chao!']);
});

test('preserves literal speech for both generated conjugation tenses and pronoun order', () => {
  const generated = conjugationCards({
    ...word, spanish: 'hablar', english: 'to speak', article: null, type: 'verb',
    conjugationClass: { ending: 'ar', present: 'regular', preterite: 'regular' },
    conjugations: {
      present: {
        yo: 'hablo', tú: 'hablas', 'él/ella': 'habla', nosotros: 'hablamos',
        vosotros: 'habláis', ellos: 'hablan',
      },
      preterite: {
        yo: 'hablé', tú: 'hablaste', 'él/ella': 'habló', nosotros: 'hablamos',
        vosotros: 'hablasteis', ellos: 'hablaron',
      },
    },
  }, new Set());
  expect(generated.cards.map((card) => cardAudio(card).text)).toEqual([
    'yo: hablo tú: hablas él/ella: habla nosotros: hablamos vosotros: habláis ellos: hablan',
    'yo: hablé tú: hablaste él/ella: habló nosotros: hablamos vosotros: hablasteis ellos: hablaron',
  ]);
});

test('preserves Unicode bytes and the existing conjugation whitespace normalization', () => {
  expect(cardAudio({
    ...conjugation, back: ' \tyo: oigo\n<br>tú:\u00a0oyes<br>él/ella: oyó<br>nosotros: oímos<br>vosotros: oi\u0301s<br>ellos: oyen  ',
  }).text).toBe('yo: oigo tú: oyes él/ella: oyó nosotros: oímos vosotros: oi\u0301s ellos: oyen');
  expect(cardAudio({
    ...conjugation, back: '¡ÁÉÍÓÚÜÑ áéíóúüñ! ¿sí? "sí" \'no\' & ella — … 😀',
  }).text).toBe('¡ÁÉÍÓÚÜÑ áéíóúüñ! ¿sí? "sí" \'no\' & ella — … 😀');
  expect(cardAudio({ ...conjugation, back: '' }).text).toBe('');
});

test('rejects entity references with their observed spelling and a named error', () => {
  expect(() => cardAudio({ ...conjugation, back: 'yo: &desconocida;' })).toThrowError(
    expect.objectContaining({
      name: 'CardAudioError',
      message: 'Unsupported card audio HTML entity "&desconocida;"; check cardGenerator output (expected plain text with <br> separators only).',
    }),
  );
  for (const entity of [
    '&desconocida;', '&deg;', '&uacute;', '&amp;', '&nbsp;', '&NotEqualTilde;',
    '&#225;', '&#xF3;', '&#Xf3;', '&#0;', '&#xD800;', '&#1114112;', '&#128;',
    '&uacute', '&AMP', '&notit;', '&#225', '&#Xf3',
  ]) {
    const prepare = () => cardAudio({ ...conjugation, back: `yo: ${entity}` });
    expect(prepare).toThrowError(expect.objectContaining({ name: 'CardAudioError' }));
    expect(prepare).toThrowError(entity);
  }
});

test('rejects every tag spelling except the generated <br> and reports the observed markup', () => {
  expect(() => cardAudio({ ...conjugation, back: 'yo: <strong title="1 > 0">hablo</strong>' })).toThrowError(
    expect.objectContaining({
      name: 'CardAudioError',
      message: 'Unsupported card audio HTML tag "<strong title="1 > 0">"; check cardGenerator output (expected plain text with <br> separators only).',
    }),
  );
  for (const tag of [
    '<div>', '<b>', '</b>', '<voice-word>', '<strong title="1 > 0">',
    '<!-- no speech > here -->', '<BR>', '<br/>', '<br />', '<br class="break">', '</br>',
  ]) {
    const prepare = () => cardAudio({ ...conjugation, back: `yo: hablo${tag}tú: hablas` });
    expect(prepare).toThrowError(expect.objectContaining({ name: 'CardAudioError' }));
    expect(prepare).toThrowError(tag);
  }
});

test('keeps the same filename when a stored card is enriched or re-sent', () => {
  const resent: typeof cards.$inferSelect = {
    ...basic, id: 100, wordId: 2, back: 'la casa / el hogar', tags: '["updated"]',
    forms: [{ spanish: 'la casa', query: 'la casa' }, { spanish: 'el hogar', query: 'el hogar' }],
    audioFile: 'cached.mp3', audioMp3: Buffer.from([73, 68, 51]),
    ankiNoteId: 123456, sentAt: 789, declinedAt: 456, createdAt: 999,
  };
  expect(cardAudio(resent).audioFile).toBe('card-39ea127757ece19e4f940e03a400b6cc3fae452580ca79223e0d6b75148a5477.mp3');
});

test.each([
  { deck: 'Another deck', front: 'house', expected: 'card-5917e052a9a07ae3ae436d187989d1b3363729390afbfdce08ff0b70b0bbc05a.mp3' },
  { deck: 'Spanish::Vocab', front: 'home', expected: 'card-c52337b70b85005dc91a7f708dad36fc9786e97eaa16da99e29e581ce7734cb1.mp3' },
  { deck: '../Español::"voz"', front: '¿él / ella? <hablar> \\ : * |', expected: 'card-7ec3802d54da902ef0941cd036797aad6d6a1ad935ff231dca707675efe39a79.mp3' },
])('names each deck/front identity safely: $deck / $front', ({ deck, front, expected }) => {
  expect(cardAudio({ ...basic, deck, front }).audioFile).toBe(expected);
});
