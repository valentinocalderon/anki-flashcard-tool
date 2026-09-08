import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { configSchema, loadConfig } from '@/lib/config';
import * as config from '@/lib/config';
import { CardSchema, WordInfoSchema, type WordInfo } from '@/lib/types';
import { openaiLookup } from './aiLookup';
import { spanishSideItems } from './brainscapeSides';
import { conjugationCards, generateCards } from './cardGenerator';
import { dedupeItems } from './listGenerationService';

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

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('Unexpected global fetch; tests must use lookup doubles.');
  }));
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

const farewell: WordInfo = {
  ...noun, english: 'goodbye', spanish: 'adiós', gender: null, article: null, type: 'phrase',
  example: 'Adiós, amigo. (Goodbye, friend.)',
};
const farewellInfos: Record<string, WordInfo> = {
  '¡adiós!': farewell,
  '¡chao!': { ...farewell, english: 'bye', spanish: 'chao' },
  'hasta luego': { ...farewell, english: 'see you later', spanish: 'hasta luego' },
};

function lookedUpItems(sides: string[], infos: Readonly<Record<string, WordInfo>>) {
  return dedupeItems(sides.flatMap(spanishSideItems)).map((item) => ({
    forms: item.forms.map((form) => {
      const info = infos[form.query];
      if (!info) throw new Error(`Missing lookup fixture for "${form.query}"`);
      return { ...form, info };
    }),
  }));
}

test.each([
  {
    side: 'un muchacho / un chico',
    english: 'a boy',
    forms: [
      { spanish: 'un muchacho', query: 'un muchacho' },
      { spanish: 'un chico', query: 'un chico' },
    ],
  },
  {
    side: 'la muchacha / la chica',
    english: 'the girl',
    forms: [
      { spanish: 'la muchacha', query: 'la muchacha' },
      { spanish: 'la chica', query: 'la chica' },
    ],
  },
  {
    side: 'los carros / los coches',
    english: 'the cars',
    forms: [
      { spanish: 'los carros', query: 'los carros' },
      { spanish: 'los coches', query: 'los coches' },
    ],
  },
])('folds identical English once while retaining both Spanish forms: $side', ({ side, english, forms }) => {
  const item = {
    forms: forms.map((form) => ({
      ...form,
      info: { ...noun, english, spanish: form.spanish, article: null, example: null },
    })),
  };

  expect(generateCards(item)).toEqual([{
    deck: 'Spanish::Vocab', kind: 'basic', front: english,
    back: side, tags: ['auto-generated'], forms,
  }]);
});

test('folds two distinct English meanings in order with individually addressable Spanish forms', () => {
  const items = lookedUpItems(['¡Adiós! / ¡Chao!'], farewellInfos);

  expect(items.flatMap(generateCards)).toEqual([{
    deck: 'Spanish::Vocab', kind: 'basic', front: 'goodbye / bye',
    back: '¡Adiós! / ¡Chao!', tags: ['auto-generated'],
    forms: [
      { spanish: '¡Adiós!', query: '¡adiós!' },
      { spanish: '¡Chao!', query: '¡chao!' },
    ],
  }]);
});

test('folds three forms with a repeated English meaning in first-occurrence order', () => {
  const items = lookedUpItems(['¡Adiós! / Hasta luego / ¡Chao!'], {
    ...farewellInfos,
    '¡chao!': { ...farewell, spanish: 'chao' },
  });

  expect(items.flatMap(generateCards)).toEqual([{
    deck: 'Spanish::Vocab', kind: 'basic', front: 'goodbye / see you later',
    back: '¡Adiós! / Hasta luego / ¡Chao!', tags: ['auto-generated'],
    forms: [
      { spanish: '¡Adiós!', query: '¡adiós!' },
      { spanish: 'Hasta luego', query: 'hasta luego' },
      { spanish: '¡Chao!', query: '¡chao!' },
    ],
  }]);
});

test('folds three looked-up forms in their original order without per-form example cards', () => {
  const items = lookedUpItems(['Hasta luego / ¡Adiós! / ¡Chao!'], farewellInfos);
  const cards = items.flatMap(generateCards);

  expect(cards).toEqual([{
    deck: 'Spanish::Vocab', kind: 'basic', front: 'see you later / goodbye / bye',
    back: 'Hasta luego / ¡Adiós! / ¡Chao!', tags: ['auto-generated'],
    forms: [
      { spanish: 'Hasta luego', query: 'hasta luego' },
      { spanish: '¡Adiós!', query: '¡adiós!' },
      { spanish: '¡Chao!', query: '¡chao!' },
    ],
  }]);
  expect(cards[0]?.forms?.[1]).toEqual({ spanish: '¡Adiós!', query: '¡adiós!' });
});

test('folds the forms retained by the existing case-insensitive pack dedupe', () => {
  const items = lookedUpItems(['¡Chao! / ¡Adiós! / ¡CHAO!', '¡ADIÓS!'], farewellInfos);

  expect(items.flatMap(generateCards)).toEqual([{
    deck: 'Spanish::Vocab', kind: 'basic', front: 'bye / goodbye',
    back: '¡Chao! / ¡Adiós!', tags: ['auto-generated'],
    forms: [
      { spanish: '¡Chao!', query: '¡chao!' },
      { spanish: '¡Adiós!', query: '¡adiós!' },
    ],
  }]);
});

test.each(['Casa', 'Casa / CASA'])(
  'a single retained form keeps the exact basic and example card shape: %s',
  (side) => {
    const items = lookedUpItems([side], { casa: noun });

    expect(items.flatMap(generateCards)).toEqual([
      {
        deck: 'Spanish::Vocab', kind: 'basic', front: 'house', back: 'la casa',
        tags: ['auto-generated'],
      },
      {
        deck: 'Spanish::Vocab', kind: 'example', front: 'La ____ es grande.',
        back: 'casa (house)<br>(The house is big.)', tags: ['auto-generated'],
      },
    ]);
  },
);

test('does not emit a folded basic card when basic cards are disabled', () => {
  const settings = loadConfig();
  vi.spyOn(config, 'loadConfig').mockReturnValue({
    ...settings, cardTypes: { ...settings.cardTypes, basic: false },
  });

  expect(lookedUpItems(['¡Adiós! / ¡Chao!'], farewellInfos).flatMap(generateCards)).toEqual([]);
});

test('reports an item with no looked-up forms instead of generating an empty card', () => {
  expect(() => generateCards({ forms: [] })).toThrow(
    'Cannot generate cards for an item with 0 forms; supply at least one looked-up form.',
  );
});

test.each(['¡Chao!', '¡Chao! / ¡Adiós!', '¡Adiós! / ¡Chao!'])(
  'reports a form lookup error without generating a partial card: %s',
  (side) => {
    const items = lookedUpItems([side], {
      ...farewellInfos,
      '¡chao!': { ...farewell, error: 'Lookup timed out after 1000 ms' },
    });

    expect(() => items.flatMap(generateCards)).toThrow(
      'Cannot generate cards for "¡Chao!": lookup returned error "Lookup timed out after 1000 ms".',
    );
  },
);

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
      back: 'casa (house)<br>(The house is big.)', tags: ['auto-generated'],
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

test('an example form matching spanish ignoring case uses spanish and its translation', () => {
  expect(generateCards({ ...noun, exampleWord: 'CASA' })[1]).toEqual({
    deck: 'Spanish::Vocab', kind: 'example', front: 'La ____ es grande.',
    back: 'casa (house)<br>(The house is big.)', tags: ['auto-generated'],
  });
});

test.each([
  { translation: ' (I have a dog.)', back: 'Tengo (tener, to have)<br>(I have a dog.)' },
  { translation: '', back: 'Tengo (tener, to have)' },
])(
  'a verb example blanks the conjugated form supplied as exampleWord with translation $translation',
  ({ translation, back }) => {
    expect(generateCards({
      ...noun, english: 'to have', spanish: 'tener', gender: null, article: null, type: 'verb',
      example: `Tengo un perro.${translation}`, exampleWord: 'Tengo',
    })[1]).toEqual({
      deck: 'Spanish::Vocab', kind: 'example', front: '____ un perro.',
      back, tags: ['auto-generated'],
    });
  },
);

test('a padded exampleWord is trimmed for blanking and the example back', () => {
  expect(generateCards({
    ...noun, english: 'to have', spanish: 'tener', gender: null, article: null, type: 'verb',
    example: 'Tengo un perro. (I have a dog.)', exampleWord: '  Tengo  ',
  })[1]).toEqual({
    deck: 'Spanish::Vocab', kind: 'example', front: '____ un perro.',
    back: 'Tengo (tener, to have)<br>(I have a dog.)', tags: ['auto-generated'],
  });
});

test('an empty exampleWord falls back to spanish for blanking and the example back', () => {
  expect(generateCards({ ...noun, exampleWord: '' })[1]).toEqual({
    deck: 'Spanish::Vocab', kind: 'example', front: 'La ____ es grande.',
    back: 'casa (house)<br>(The house is big.)', tags: ['auto-generated'],
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
      back: 'árbol (tree)<br>(The tree is tall.)', tags: ['auto-generated'],
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
      back: `${spanish} (house)<br>(I use it here.)`, tags: ['auto-generated'],
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
  expect(config).not.toHaveProperty('deckName');
  expect(configSchema.parse(config)).toEqual(config);
  expect(configSchema.safeParse({ ...config, tenses: ['future'] }).success).toBe(false);
  expect(configSchema.safeParse({ ...config, decks: { vocab: 'Spanish::Vocab' } }).success).toBe(false);
});

test.each(['deckName', 'modelName'])('config schema strips the retired %s field', (field) => {
  expect(configSchema.parse({ ...loadConfig(), [field]: 'Legacy value' })).not.toHaveProperty(field);
});

test('config declares the AnkiConnect URL and both required note types', () => {
  const config = loadConfig();
  expect(config).toHaveProperty('anki', {
    url: 'http://127.0.0.1:8765',
    noteTypes: { reversed: 'Basic (and reversed card)', basic: 'Basic' },
  });
  expect(configSchema.parse(config)).toEqual(config);
});

test.each([
  undefined,
  { url: 8765, noteTypes: { reversed: 'Basic (and reversed card)', basic: 'Basic' } },
  { url: 'http://127.0.0.1:8765', noteTypes: { basic: 'Basic' } },
  { url: 'http://127.0.0.1:8765', noteTypes: { reversed: 'Basic (and reversed card)' } },
])('config requires an Anki URL string and both note type names: %j', (anki) => {
  expect(configSchema.safeParse({ ...loadConfig(), anki }).success).toBe(false);
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
