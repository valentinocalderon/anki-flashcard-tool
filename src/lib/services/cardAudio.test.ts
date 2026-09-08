import { expect, test } from 'vitest';
import type { cards } from '@/server/db/schema';
import { cardAudio } from './cardAudio';

const basic: typeof cards.$inferSelect = {
  id: 41, wordId: 1, deck: 'Spanish::Vocab', kind: 'basic', front: 'house',
  back: '  la <b>casa</b> &amp; el hogar\n', tags: '["vocab"]', forms: null,
  audioFile: null, audioMp3: null, ankiNoteId: null, sentAt: null, declinedAt: null, createdAt: 123,
};
const example: typeof cards.$inferSelect = {
  ...basic, id: 42, kind: 'example', front: 'La ____ es grande.',
  back: 'casa (house) (The <em>house</em> is big &amp; bright.)  ',
};
const conjugation: typeof cards.$inferSelect = {
  ...basic, id: 43, deck: 'Spanish::Conjugation', kind: 'conjugation',
  front: 'Conjugate hablar in present (regular -ar)',
  back: 'yo: hablo<br>t&uacute;: hablas<br>&eacute;l/ella: habla<br>nosotros: hablamos<br>vosotros: habl&aacute;is<br>ellos: hablan',
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

test('strips nested and custom tags, quoted attributes and comments without splitting a form', () => {
  expect(cardAudio({
    ...conjugation,
    back: '<div><b>yo</b>: ha<strong title="1 > 0">bl</strong>o</div><!-- no speech > here --><p><voice-word>tú</voice-word>: hablas</p><BR /><span>él/ella</span>: habla',
  }).text).toBe('yo: hablo tú: hablas él/ella: habla');
});

test('decodes named, decimal, hexadecimal and multi-codepoint HTML entities', () => {
  expect(cardAudio({
    ...conjugation,
    back: 't&uacute;:&nbsp;habl&#225;s<br>&eacute;l: habl&#xF3;<br>&iexcl;yo &amp; ella! &quot;s&iacute;&quot; &apos;no&apos; &lt;3 &gt;2 &euro; &aelig; &NotEqualTilde; &#x1F600;',
  }).text).toBe('tú: hablás él: habló ¡yo & ella! "sí" \'no\' <3 >2 € æ ≂̸ 😀');
});

test('decodes legacy references without semicolons and leaves literal ampersands intact', () => {
  expect(cardAudio({
    ...conjugation, back: 't&uacute: habl&#225s &AMP ella &#Xf3 &notit; &desconocida; &amp;lt; R&D',
  }).text).toBe('tú: hablás & ella ó ¬it; &desconocida; &lt; R&D');
});

test('uses HTML replacements for invalid and legacy numeric character references', () => {
  expect(cardAudio({
    ...conjugation, back: 'yo: &#0; &#xD800; &#1114112; &#128; &#x91;sí&#x92;',
  }).text).toBe('yo: � � � € ‘sí’');
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
