import { expect, test, vi } from 'vitest';
import { configSchema, loadConfig } from '@/lib/config';
import { CardSchema, WordInfoSchema, type WordInfo } from '@/lib/types';
import { openaiLookup } from './aiLookup';
import { conjugationCards, generateCards } from './cardGenerator';

const { createCompletion } = vi.hoisted(() => ({
  createCompletion: vi.fn<(request: {
    model: string;
    messages: { role: string; content: string }[];
    temperature: number;
  }) => Promise<{ choices: { message: { content: string | null } }[] }>>(),
}));

vi.mock('@/env', () => ({ env: { OPENAI_API_KEY: 'test-key' } }));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createCompletion } };
  },
}));

const noun: WordInfo = {
  english: 'house',
  spanish: 'casa',
  gender: 'feminine',
  article: 'la',
  type: 'noun',
  example: 'La casa es grande. (The house is big.)',
  conjugations: null,
  conjugationClass: null,
};

const regularVerb: WordInfo = {
  english: 'to speak',
  spanish: 'hablar',
  gender: null,
  article: null,
  type: 'verb',
  example: null,
  conjugations: {
    present: {
      yo: 'hablo', tú: 'hablas', 'él/ella': 'habla',
      nosotros: 'hablamos', vosotros: 'habláis', ellos: 'hablan',
    },
    preterite: {
      yo: 'hablé', tú: 'hablaste', 'él/ella': 'habló',
      nosotros: 'hablamos', vosotros: 'hablasteis', ellos: 'hablaron',
    },
  },
  conjugationClass: { ending: 'ar', present: 'regular', preterite: 'regular' },
};

const stemChangingVerb: WordInfo = {
  ...regularVerb,
  english: 'to want',
  spanish: 'querer',
  conjugations: {
    present: {
      yo: 'quiero', tú: 'quieres', 'él/ella': 'quiere',
      nosotros: 'queremos', vosotros: 'queréis', ellos: 'quieren',
    },
  },
  conjugationClass: { ending: 'er', present: 'e-ie', preterite: 'irregular' },
};

const irregularVerb: WordInfo = {
  ...regularVerb,
  english: 'to go',
  spanish: 'ir',
  conjugations: {
    present: {
      yo: 'voy', tú: 'vas', 'él/ella': 'va',
      nosotros: 'vamos', vosotros: 'vais', ellos: 'van',
    },
    preterite: {
      yo: 'fui', tú: 'fuiste', 'él/ella': 'fue',
      nosotros: 'fuimos', vosotros: 'fuisteis', ellos: 'fueron',
    },
  },
  conjugationClass: { ending: 'ir', present: 'irregular', preterite: 'irregular' },
};

test('a noun produces only a basic card and its blanked example in the vocab deck', () => {
  expect(generateCards(noun)).toEqual([
    {
      deck: 'Spanish::Vocab', kind: 'basic', front: 'house', back: 'la casa',
      tags: ['auto-generated'],
    },
    {
      deck: 'Spanish::Vocab', kind: 'example', front: 'La ____ es grande.',
      back: 'casa (house) (The house is big.)', tags: ['auto-generated'],
    },
  ]);
  expect(conjugationCards(noun, new Set())).toEqual({ cards: [], claims: [] });
});

test.each([null, 'El hogar es grande.', 'La casita es grande.'])(
  'omits an example card when the example is absent or does not contain the word: %s',
  (example) => {
    expect(generateCards({ ...noun, example })).toEqual([
      {
        deck: 'Spanish::Vocab', kind: 'basic', front: 'house', back: 'la casa',
        tags: ['auto-generated'],
      },
    ]);
  },
);

test('blanks every case-insensitive match and supports an example without a translation', () => {
  expect(generateCards({ ...noun, example: 'Casa y casa.' })[1]).toEqual({
    deck: 'Spanish::Vocab', kind: 'example', front: '____ y ____.',
    back: 'casa (house)', tags: ['auto-generated'],
  });
});

test('a verb example blanks the conjugated form supplied as exampleWord', () => {
  expect(generateCards({
    ...noun, english: 'to have', spanish: 'tener', gender: null, article: null, type: 'verb',
    example: 'Tengo un perro. (I have a dog.)', exampleWord: 'Tengo',
  })[1]).toEqual({
    deck: 'Spanish::Vocab', kind: 'example', front: '____ un perro.',
    back: 'tener (to have) (I have a dog.)', tags: ['auto-generated'],
  });
});

test('a word present only in the English half yields no example card', () => {
  expect(generateCards({
    ...noun, example: 'El hogar es grande. (The casa is big.)',
  }).map((card) => card.kind)).toEqual(['basic']);
});

test('an accented noun gets its example card with case-insensitive Unicode matching', () => {
  expect(generateCards({
    ...noun, english: 'tree', spanish: 'árbol', gender: 'masculine', article: 'el',
    example: 'El ÁRBOL es alto. (The tree is tall.)',
  })).toEqual([
    {
      deck: 'Spanish::Vocab', kind: 'basic', front: 'tree', back: 'el árbol',
      tags: ['auto-generated'],
    },
    {
      deck: 'Spanish::Vocab', kind: 'example', front: 'El ____ es alto.',
      back: 'árbol (tree) (The tree is tall.)', tags: ['auto-generated'],
    },
  ]);
});

test.each(['a+b', 'a.b', '[', 'c++', '\\'])(
  'matches regex metacharacters literally in an example: %s',
  (spanish) => {
    expect(generateCards({
      ...noun, spanish, example: `Uso ${spanish} aquí. (I use it here.)`,
    })[1]).toEqual({
      deck: 'Spanish::Vocab', kind: 'example', front: 'Uso ____ aquí.',
      back: `${spanish} (house) (I use it here.)`, tags: ['auto-generated'],
    });
  },
);

test.each([
  { spanish: 'a.b', example: 'Uso axb aquí.' },
  { spanish: 'rbol', example: 'El árbol es alto.' },
  { spanish: 'caf', example: 'El café está caliente.' },
])('does not blank a wildcard match or part of a Unicode word: %j', (word) => {
  expect(generateCards({ ...noun, ...word }).map((card) => card.kind)).toEqual(['basic']);
});

test('the first regular -ar verb claims one conjugation card per configured tense', () => {
  const cardedKeys = new Set<string>();
  expect(generateCards(regularVerb)).toEqual([
    {
      deck: 'Spanish::Vocab', kind: 'basic', front: 'to speak', back: 'hablar',
      tags: ['auto-generated'],
    },
  ]);
  expect(conjugationCards(regularVerb, cardedKeys)).toEqual({
    cards: [
      {
        deck: 'Spanish::Conjugation', kind: 'conjugation',
        front: 'Conjugate hablar in present (regular -ar)',
        back: 'yo: hablo<br>tú: hablas<br>él/ella: habla<br>nosotros: hablamos<br>vosotros: habláis<br>ellos: hablan',
        tags: ['auto-generated'],
      },
      {
        deck: 'Spanish::Conjugation', kind: 'conjugation',
        front: 'Conjugate hablar in preterite (regular -ar)',
        back: 'yo: hablé<br>tú: hablaste<br>él/ella: habló<br>nosotros: hablamos<br>vosotros: hablasteis<br>ellos: hablaron',
        tags: ['auto-generated'],
      },
    ],
    claims: [
      { front: 'Conjugate hablar in present (regular -ar)', key: 'ar-regular-present' },
      { front: 'Conjugate hablar in preterite (regular -ar)', key: 'ar-regular-preterite' },
    ],
  });
  expect([...cardedKeys]).toEqual([]);
});

test('an e-ie verb claims its stem-changing pattern and skips a tense without forms', () => {
  expect(conjugationCards(stemChangingVerb, new Set())).toEqual({
    cards: [
      {
        deck: 'Spanish::Conjugation', kind: 'conjugation',
        front: 'Conjugate querer in present (e-ie -er)',
        back: 'yo: quiero<br>tú: quieres<br>él/ella: quiere<br>nosotros: queremos<br>vosotros: queréis<br>ellos: quieren',
        tags: ['auto-generated'],
      },
    ],
    claims: [{ front: 'Conjugate querer in present (e-ie -er)', key: 'er-e-ie-present' }],
  });
});

test('irregular tenses always produce cards without claiming a pattern', () => {
  const cardedKeys = new Set(['ir-irregular-present', 'ir-irregular-preterite']);
  expect(conjugationCards(irregularVerb, cardedKeys)).toEqual({
    cards: [
      {
        deck: 'Spanish::Conjugation', kind: 'conjugation',
        front: 'Conjugate ir in present (irregular)',
        back: 'yo: voy<br>tú: vas<br>él/ella: va<br>nosotros: vamos<br>vosotros: vais<br>ellos: van',
        tags: ['auto-generated'],
      },
      {
        deck: 'Spanish::Conjugation', kind: 'conjugation',
        front: 'Conjugate ir in preterite (irregular)',
        back: 'yo: fui<br>tú: fuiste<br>él/ella: fue<br>nosotros: fuimos<br>vosotros: fuisteis<br>ellos: fueron',
        tags: ['auto-generated'],
      },
    ],
    claims: [],
  });
});

test('a repeat pattern yields no conjugation cards and leaves the supplied keys untouched', () => {
  const cardedKeys: ReadonlySet<string> = new Set(['ar-regular-present', 'ar-regular-preterite']);
  expect(conjugationCards(regularVerb, cardedKeys)).toEqual({ cards: [], claims: [] });
  expect([...cardedKeys]).toEqual(['ar-regular-present', 'ar-regular-preterite']);
});

test('deduplicates each tense independently', () => {
  const result = conjugationCards(regularVerb, new Set(['ar-regular-present']));
  expect(result.claims).toEqual([
    { front: 'Conjugate hablar in preterite (regular -ar)', key: 'ar-regular-preterite' },
  ]);
  expect(result.cards.map((card) => card.front)).toEqual([
    'Conjugate hablar in preterite (regular -ar)',
  ]);
});

test.each([undefined, null])('skips conjugations when classification is %s', (conjugationClass) => {
  expect(conjugationCards({ ...regularVerb, conjugationClass }, new Set())).toEqual({
    cards: [], claims: [],
  });
});

test.each(['Verb', 'verbo', 'noun'])(
  'uses classification and forms as the verb signal regardless of the type string: %s',
  (type) => {
    expect(conjugationCards({ ...regularVerb, type }, new Set())).toEqual(
      conjugationCards(regularVerb, new Set()),
    );
  },
);

test('skips conjugations when classification exists without conjugations', () => {
  expect(conjugationCards({ ...regularVerb, conjugations: null }, new Set())).toEqual({
    cards: [], claims: [],
  });
});

test('config declares the three card kinds, two tenses, and both decks', () => {
  const config = loadConfig();
  expect(config.cardTypes).toEqual({ basic: true, example: true, conjugation: true });
  expect(config.tenses).toEqual(['present', 'preterite']);
  expect(config.decks).toEqual({ vocab: 'Spanish::Vocab', conjugation: 'Spanish::Conjugation' });
  expect(config.modelName).toBe('Basic');
  expect(config).not.toHaveProperty('deckName');
  expect(configSchema.parse(config)).toEqual(config);
  expect(configSchema.safeParse({ ...config, tenses: ['future'] }).success).toBe(false);
  expect(configSchema.safeParse({ ...config, decks: { vocab: 'Spanish::Vocab' } }).success).toBe(false);
});

test('config schema strips the retired deckName field', () => {
  expect(configSchema.parse({ ...loadConfig(), deckName: 'Legacy deck' })).not.toHaveProperty('deckName');
});

test('the word schema retains valid classification and accepts legacy and non-verb records', () => {
  expect(WordInfoSchema.parse(regularVerb)).toEqual(regularVerb);
  expect(WordInfoSchema.parse(noun)).toEqual(noun);
  const { conjugationClass, ...legacyVerb } = regularVerb;
  expect(conjugationClass).toBeDefined();
  expect(WordInfoSchema.parse(legacyVerb)).toEqual(legacyVerb);
});

test.each(['Tengo', null])('the word schema retains exampleWord: %j', (exampleWord) => {
  const word = { ...regularVerb, exampleWord };
  expect(WordInfoSchema.parse(word)).toEqual(word);
});

test('the word schema keeps only present and preterite conjugations', () => {
  expect(WordInfoSchema.parse({
    ...regularVerb,
    conjugations: {
      ...regularVerb.conjugations,
      imperfect: { yo: 'hablaba' },
      future: { yo: 'hablaré' },
    },
  }).conjugations).toEqual(regularVerb.conjugations);
});

test.each([
  { ending: 're', present: 'regular', preterite: 'regular' },
  { ending: 'ar', present: 'unknown', preterite: 'regular' },
  { ending: 'ar', present: 'regular', preterite: 'unknown' },
  { ending: 'ar', present: 'regular' },
])('the word schema rejects invalid classification: %j', (conjugationClass) => {
  expect(WordInfoSchema.safeParse({ ...regularVerb, conjugationClass }).success).toBe(false);
});

test('the card schema requires a deck, a supported kind, and tags', () => {
  const card = {
    deck: 'Spanish::Vocab', kind: 'basic', front: 'house', back: 'la casa', tags: [],
  };
  expect(CardSchema.parse(card)).toEqual(card);
  expect(CardSchema.safeParse({ front: 'house', back: 'la casa' }).success).toBe(false);
  expect(CardSchema.safeParse({ ...card, tags: undefined }).success).toBe(false);
  expect(CardSchema.safeParse({ ...card, kind: 'gender' }).success).toBe(false);
});

test('lookup requests six forms for two tenses and classification for verbs or null for non-verbs', async () => {
  createCompletion.mockResolvedValueOnce({
    choices: [{ message: { content: JSON.stringify(regularVerb) } }],
  });
  const result = await openaiLookup('hablar');
  const prompt = createCompletion.mock.calls[0]?.[0].messages[0]?.content;
  expect(prompt).toContain('exampleWord: the exact form of the word as it appears in the Spanish example sentence');
  expect(prompt).toContain('Tengo when the word is tener');
  expect(prompt).toContain('null when there is no example');
  expect(prompt).toContain('only present and preterite');
  expect(prompt).not.toMatch(/imperfect|future/);
  for (const pronoun of ['yo', 'tú', 'él/ella', 'nosotros', 'vosotros', 'ellos']) {
    expect(prompt).toContain(`"${pronoun}"`);
  }
  expect(prompt).toContain('conjugationClass');
  for (const value of ['ar', 'er', 'ir', 'regular', 'e-ie', 'o-ue', 'e-i', 'u-ue', 'irregular']) {
    expect(prompt).toContain(`"${value}"`);
  }
  expect(prompt).toContain('For non-verbs, return null');
  expect(result).toEqual(regularVerb);
});

test.each(['{', '', null])(
  'lookup reports malformed or missing JSON separately from an invalid word shape: %j',
  async (content) => {
    createCompletion.mockResolvedValueOnce({ choices: [{ message: { content } }] });
    await expect(openaiLookup('hablar')).rejects.toThrow(new Error('AI response was not valid JSON'));
  },
);

test('lookup reports shape failures with the zod issues', async () => {
  const invalidWord = { ...regularVerb, spanish: 123, conjugationClass: { ending: 're' } };
  const validation = WordInfoSchema.safeParse(invalidWord);
  if (validation.success) throw new Error('Expected the invalid word fixture to fail validation');
  createCompletion.mockResolvedValueOnce({
    choices: [{ message: { content: JSON.stringify(invalidWord) } }],
  });
  await expect(openaiLookup('hablar')).rejects.toThrow(
    `AI response did not match the expected shape: ${JSON.stringify(validation.error.issues)}`,
  );
});
