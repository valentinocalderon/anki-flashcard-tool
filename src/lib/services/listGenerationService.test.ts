import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { createClient, type Client } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { loadConfig } from '@/lib/config';
import { formatResultLine } from '@/lib/resultLine';
import type { WordInfo, WordResult } from '@/lib/types';
import { applyMigrations, createDb, type Db } from '@/server/db';
import { cards, conjugationPatterns, words } from '@/server/db/schema';
import { askForJson } from './aiLookup';
import { spanishSideItems } from './brainscapeSides';
import * as cardGenerator from './cardGenerator';
import * as cardStore from './cardStore';
import { dedupeItems, generateForWords } from './listGenerationService';
import * as lookupCache from './lookupCache';
import { createSpanishVoice } from './spanishVoice';
import * as wordListParser from './wordListParser';

vi.mock('@/env', () => ({ env: {
  OPENAI_API_KEY: 'test-key', ELEVENLABS_API_KEY: 'test-api-key', ELEVENLABS_VOICE_ID: 'test-voice-id',
} }));
vi.mock('./aiLookup', () => ({
  askForJson: vi.fn<typeof askForJson>().mockRejectedValue(new Error('Unexpected extraction request')),
  openaiLookup: vi.fn().mockRejectedValue(new Error('Unexpected live lookup')),
}));

const noun: WordInfo = {
  english: 'house', spanish: 'casa', gender: 'feminine', article: 'la', type: 'noun',
  example: 'La casa es grande. (The house is big.)', conjugations: null,
};
const goodbye: WordInfo = {
  english: 'goodbye', spanish: '¡Adiós!', gender: null, article: null, type: 'interjection',
  example: null, conjugations: null,
};
const storedGoodbye: typeof cards.$inferSelect = {
  id: 1, wordId: 1, deck: 'Spanish::Vocab', kind: 'basic', front: 'goodbye', back: '¡Adiós!',
  tags: '["auto-generated"]', forms: null, audioFile: null, audioMp3: null, audioSentAt: null, ankiNoteId: 987654, sentAt: 456, declinedAt: null, createdAt: 123,
};
const goodbyeAudio = {
  audioFile: 'card-c7a314202176837303762eca31fe8d778b52284e425256b3b46283325ec48935.mp3',
  audioMp3: Buffer.from([73, 68, 51]),
};
const houseAudio = {
  audioFile: 'card-39ea127757ece19e4f940e03a400b6cc3fae452580ca79223e0d6b75148a5477.mp3',
  audioMp3: Buffer.from([73, 68, 51]),
};
const regularVerb: WordInfo = {
  english: 'to speak', spanish: 'hablar', gender: null, article: null, type: 'verb',
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
const secondRegularVerb: WordInfo = {
  ...regularVerb, english: 'to dance', spanish: 'bailar',
  conjugations: {
    present: {
      yo: 'bailo', tú: 'bailas', 'él/ella': 'baila',
      nosotros: 'bailamos', vosotros: 'bailáis', ellos: 'bailan',
    },
    preterite: {
      yo: 'bailé', tú: 'bailaste', 'él/ella': 'bailó',
      nosotros: 'bailamos', vosotros: 'bailasteis', ellos: 'bailaron',
    },
  },
};
const irregularVerb: WordInfo = {
  ...regularVerb, english: 'to go', spanish: 'ir',
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

const packUrl = 'https://www.brainscape.com/packs/21648778';
const singleDeckUrl = 'https://www.brainscape.com/flashcards/test/packs/42';
const pack = readFileSync(new URL('./__fixtures__/brainscape/pack.html', import.meta.url), 'utf8');
const greetings = readFileSync(new URL('./__fixtures__/brainscape/deck-common-greetings.html', import.meta.url), 'utf8');
const nouns = readFileSync(new URL('./__fixtures__/brainscape/deck-nouns-articles.html', import.meta.url), 'utf8');
const packWords = [
  '¡Hola!', '¡Adiós! / ¡Chao!', '¡Buenos días!', '¡Buenas tardes!', '¡Buenas!',
  '¿Hablas inglés?', 'Hablo inglés.', 'No hablo español.', '¡Gracias! ¡De nada!',
  '¡Buenas noches!', '¿Habla inglés? Sí.', 'Hola, me llamo Sam.', '¿Cómo te llamas?',
  '¿Habla español? Un poco.', '¡Mucho gusto!', 'Igualmente. / Igual.',
  '¿Cómo te llamas? Me llamo Jenny. Mucho gusto. ¡Igual!',
  'una mujer', 'un hombre', 'la mujer', 'el hombre', 'un muchacho / un chico',
  'la muchacha / la chica', 'un niño', 'una niña', 'los niños', 'las niñas',
  'unos hombres', 'unas mujeres', 'un chico y una chica', 'los hombres y las mujeres',
  'una alumna / una estudiante', 'un profesor / un maestro', 'una profesora',
  'la casa', 'el dinero', 'los carros / los coches',
];
const packForms = [
  '¡Hola!', '¡Adiós!', '¡Chao!', '¡Buenos días!', '¡Buenas tardes!', '¡Buenas!',
  '¿Hablas inglés?', 'Hablo inglés.', 'No hablo español.', '¡Gracias! ¡De nada!',
  '¡Buenas noches!', '¿Habla inglés? Sí.', 'Hola, me llamo Sam.', '¿Cómo te llamas?',
  '¿Habla español? Un poco.', '¡Mucho gusto!', 'Igualmente.', 'Igual.',
  '¿Cómo te llamas? Me llamo Jenny. Mucho gusto. ¡Igual!',
  'una mujer', 'un hombre', 'la mujer', 'el hombre', 'un muchacho', 'un chico',
  'la muchacha', 'la chica', 'un niño', 'una niña', 'los niños', 'las niñas',
  'unos hombres', 'unas mujeres', 'un chico y una chica', 'los hombres y las mujeres',
  'una alumna', 'una estudiante', 'un profesor', 'un maestro', 'una profesora',
  'la casa', 'el dinero', 'los carros', 'los coches',
];
const fetchImpl = vi.fn<typeof fetch>();
// Compile the page in memory because the shared test configuration preserves JSX.
const pageScript = new Script(transpileModule(
  readFileSync(new URL('../../app/page.tsx', import.meta.url), 'utf8'),
  { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.React } },
).outputText);

function serveSides(sides: readonly string[]) {
  const html = "<a href='/flashcards/test/packs/42'>Deck</a>" + sides.map((side, index) =>
    `<div id='card-back-${index}' class='flashcard-contents answer-contents'>
      <div class='preview-html'><div class='scf-face'>${side}</div></div>
    </div>`,
  ).join('');
  fetchImpl.mockResolvedValueOnce(new Response(html));
}

function pageWithResults(results: WordResult[], capReached = false) {
  const useState = vi.fn<() => [string | null | WordResult[], (results: WordResult[]) => void]>()
    .mockReturnValue([null, vi.fn()])
    .mockReturnValueOnce(['', vi.fn()])
    .mockReturnValueOnce([null, vi.fn()])
    .mockReturnValueOnce([results, vi.fn()]);
  const exports: { default?: () => React.ReactNode } = {};
  const api = { anki: {
    pendingCount: { useQuery: () => ({ data: 0 }) },
    declinedCount: { useQuery: () => ({ data: 0 }) },
    sendPending: { useMutation: () => ({ isPending: false, reset: vi.fn() }) },
    retryDeclined: { useMutation: () => ({ isPending: false, reset: vi.fn() }) },
    generateFromList: {
      useMutation: () => ({ isPending: false, isSuccess: true, data: { capReached } }),
    },
  } };
  pageScript.runInNewContext({
    exports, React,
    require: (moduleName: string) => {
      if (moduleName === 'react') return { ...React, useState };
      if (moduleName === '@/lib/resultLine') return { formatResultLine };
      if (moduleName === '@/trpc/react') return { api };
      throw new Error(`Unexpected page import "${moduleName}".`);
    },
  });
  if (!exports.default) throw new Error('Expected a page component.');
  return exports.default();
}

function resultListKeys(page: React.ReactNode) {
  if (!React.isValidElement<{ children: React.ReactNode }>(page)) {
    throw new Error('Expected a page element.');
  }
  const list = React.Children.toArray(page.props.children)
    .find((child) => React.isValidElement(child) && child.type === 'ul');
  if (!React.isValidElement<{ children: React.ReactNode }>(list)) {
    throw new Error('Expected a result list.');
  }
  const keys: (string | null)[] = [];
  React.Children.forEach(list.props.children, (line) => {
    if (!React.isValidElement(line)) throw new Error('Expected a result line.');
    keys.push(line.key);
  });
  return keys;
}

let client: Client;
let db: Db;

beforeEach(async () => {
  fetchImpl.mockReset().mockImplementation(async (url, init) => {
    if (url === 'https://api.elevenlabs.io/v1/text-to-speech/test-voice-id?output_format=mp3_44100_128' && init?.method === 'POST') {
      return new Response(new Uint8Array([73, 68, 51]));
    }
    throw new Error('Unexpected pack fetch; provide a fixture response.');
  });
  vi.mocked(askForJson).mockClear();
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('Unexpected global fetch; tests must use lookup doubles.');
  }));
  client = createClient({ url: ':memory:' });
  db = createDb(client);
  await applyMigrations(db);
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  client.close();
  expect(askForJson).not.toHaveBeenCalled();
});

test('dedupes normalized forms within and across items while preserving alternative groups', () => {
  const items = [
    ' ¡Adiós! / ¡Chao! / ¡ADIÓS! ',
    '¡CHAO! / Hasta luego',
    'HASTA LUEGO',
    'ÁRBOL',
    'árbol',
    'Man: ¡Hola! Woman: ¡Buenas!',
    '¡HOLA! ¡BUENAS!',
  ].flatMap(spanishSideItems);

  expect(dedupeItems(items)).toEqual([
    { forms: [
      { spanish: '¡Adiós!', query: '¡adiós!' },
      { spanish: '¡Chao!', query: '¡chao!' },
    ] },
    { forms: [{ spanish: 'Hasta luego', query: 'hasta luego' }] },
    { forms: [{ spanish: 'ÁRBOL', query: 'árbol' }] },
    { forms: [{ spanish: '¡Hola! ¡Buenas!', query: '¡hola! ¡buenas!' }] },
  ]);
  expect(items[0]?.forms).toHaveLength(3);
  expect(items).toHaveLength(7);
});

test.each([
  'https://www.brainscape.com/packs/21648778',
  'https://www.brainscape.com/packs/21648778/',
])('runs a lone pack URL through the saved decks with one result per deduped item: %s', async (url) => {
  vi.useFakeTimers();
  fetchImpl.mockResolvedValueOnce(new Response(pack)).mockResolvedValueOnce(new Response(greetings));
  for (let deck = 0; deck < 11; deck += 1) fetchImpl.mockResolvedValueOnce(new Response(nouns));
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockImplementation(async (word) => ({
    ...noun, spanish: word, english: word, article: null, example: null,
  }));
  const generate = vi.spyOn(cardGenerator, 'generateCards');
  const parseList = vi.spyOn(wordListParser, 'resolveWordList');

  const run = generateForWords(db, ` \n${url}\t `, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl));
  await vi.runAllTimersAsync();

  expect((await run).results).toEqual(packWords.map((word) => ({ word, status: 'added', vocabCards: 1, conjugationCards: 0 })));
  expect(lookup.mock.calls.flat()).toEqual(packForms);
  expect(fetchImpl).toHaveBeenCalledTimes(50);
  expect(fetchImpl).toHaveBeenNthCalledWith(1, url, expect.any(Object));
  expect(parseList).not.toHaveBeenCalled();
  expect(generate).toHaveBeenCalledTimes(37);
  expect(await db.select().from(cards)).toHaveLength(37);
  expect((await db.select().from(cards).orderBy(cards.id))[1]).toMatchObject({
    wordId: 2, kind: 'basic', front: '¡Adiós! / ¡Chao!', back: '¡Adiós! / ¡Chao!',
  });
  expect(vi.getTimerCount()).toBe(0);
});

test('reports the observed HTTP failure for a trailing-slash pack URL before lookup or writes', async () => {
  fetchImpl.mockResolvedValueOnce(new Response('Request denied', { status: 403, statusText: 'Forbidden' }));
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue(noun);
  const parseList = vi.spyOn(wordListParser, 'resolveWordList');

  await expect(generateForWords(db, 'https://www.brainscape.com/packs/21648778/', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl)))
    .rejects.toThrow('Brainscape request for https://www.brainscape.com/packs/21648778/ returned HTTP 403 Forbidden; check the response and retry.');

  expect(fetchImpl).toHaveBeenCalledExactlyOnceWith('https://www.brainscape.com/packs/21648778/', expect.any(Object));
  expect(parseList).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
  expect(await db.select().from(words)).toEqual([]);
  expect(await db.select().from(cards)).toEqual([]);
});

test('reports one malformed-side error and still generates the following deduped sides', async () => {
  serveSides(['¡Hola! /', 'Casa / CASA', 'Man: Casa', 'árbol']);
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
    .mockResolvedValueOnce(noun).mockResolvedValueOnce({ ...noun, english: 'tree', spanish: 'árbol' });

  expect((await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    {
      word: '¡Hola! /', status: 'error', vocabCards: 0, conjugationCards: 0,
      message: 'Spanish side "¡Hola! /" has an empty form at position 2; check the Brainscape text.',
    },
    { word: 'Casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
    { word: 'árbol', status: 'added', vocabCards: 1, conjugationCards: 0 },
  ]);
  expect(lookup.mock.calls).toEqual([['Casa'], ['árbol']]);
  expect(await db.select().from(cards)).toHaveLength(3);
});

test('renders two identical malformed sides as two visible result lines with distinct keys', async () => {
  serveSides(['¡Hola! /', '¡Hola! /']);
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>();

  const results = (await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results;
  expect(results).toEqual([
    {
      word: '¡Hola! /', status: 'error', vocabCards: 0, conjugationCards: 0,
      message: 'Spanish side "¡Hola! /" has an empty form at position 2; check the Brainscape text.',
    },
    {
      word: '¡Hola! /', status: 'error', vocabCards: 0, conjugationCards: 0,
      message: 'Spanish side "¡Hola! /" has an empty form at position 2; check the Brainscape text.',
    },
  ]);
  const page = pageWithResults(results);
  const html = renderToStaticMarkup(page);
  expect(html.match(/<li\b[^>]*>.*?<\/li>/g)).toEqual([
    '<li class="bg-gray-100 p-3 rounded"><span aria-hidden="true" class="text-xs mr-2">!</span><strong>¡Hola! /</strong>: Spanish side &quot;¡Hola! /&quot; has an empty form at position 2; check the Brainscape text.</li>',
    '<li class="bg-gray-100 p-3 rounded"><span aria-hidden="true" class="text-xs mr-2">!</span><strong>¡Hola! /</strong>: Spanish side &quot;¡Hola! /&quot; has an empty form at position 2; check the Brainscape text.</li>',
  ]);
  expect(resultListKeys(page)).toEqual(['0', '1']);
  expect(lookup).not.toHaveBeenCalled();
  expect(await db.select().from(words)).toEqual([]);
  expect(await db.select().from(cards)).toEqual([]);
});

test.each([
  { carded: 'casa', id: 1, firstWordId: 1, remaining: 'hogar', front: 'house', audioFile: 'card-39ea127757ece19e4f940e03a400b6cc3fae452580ca79223e0d6b75148a5477.mp3' },
  { carded: 'hogar', id: 2, firstWordId: 3, remaining: 'casa', front: 'home', audioFile: 'card-c52337b70b85005dc91a7f708dad36fc9786e97eaa16da99e29e581ce7734cb1.mp3' },
])('enriches the card owned by $carded even when the folded English differs', async ({ carded, id, firstWordId, remaining, front, audioFile }) => {
  const house = { ...noun, example: null };
  const home = { ...house, english: 'home', spanish: 'hogar', article: 'el', gender: 'masculine' };
  await db.insert(words).values({
    id, query: carded, info: JSON.stringify(carded === 'casa' ? house : home), lookedUpAt: 123,
  });
  await db.insert(cards).values({
    ...storedGoodbye, id: 41, wordId: id, front, back: 'stored answer', tags: '["original"]',
  });
  serveSides(['casa / hogar']);
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
    .mockResolvedValueOnce(remaining === 'casa' ? house : home);
  const cached = vi.spyOn(lookupCache, 'cachedLookup');
  const generate = vi.spyOn(cardGenerator, 'generateCards');
  const store = vi.spyOn(cardStore, 'storeCards');

  const results = (await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results;
  expect(results).toEqual([
    { word: 'casa / hogar', status: 'updated', vocabCards: 0, conjugationCards: 0 },
  ]);
  expect(renderToStaticMarkup(pageWithResults(results)).match(/<li\b[^>]*>.*?<\/li>/g)).toEqual([
    '<li class="bg-gray-100 p-3 rounded"><span aria-hidden="true" class="text-xs mr-2">↻</span><strong>casa / hogar</strong>: updated: stored card changed; check Anki if this card was already sent</li>',
  ]);
  expect(lookup).toHaveBeenCalledExactlyOnceWith(remaining);
  expect(cached.mock.calls).toEqual([[db, 'casa', lookup], [db, 'hogar', lookup]]);
  expect(generate).toHaveBeenCalledExactlyOnceWith({ forms: [
    { spanish: 'casa', query: 'casa', info: house },
    { spanish: 'hogar', query: 'hogar', info: home },
  ] });
  expect(store).toHaveBeenCalledExactlyOnceWith(db, firstWordId, [{
    deck: 'Spanish::Vocab', kind: 'basic', front: 'house / home', back: 'casa / hogar',
    audioFile, audioMp3: Buffer.from([73, 68, 51]),
    tags: ['auto-generated'], forms: [
      { spanish: 'casa', query: 'casa' }, { spanish: 'hogar', query: 'hogar' },
    ],
  }], [], 41);
  expect(await db.select().from(cards)).toEqual([{
    ...storedGoodbye, audioFile, audioMp3: Buffer.from([73, 68, 51]),
    id: 41, wordId: id, front, back: 'casa / hogar', tags: '["original"]',
    forms: [{ spanish: 'casa', query: 'casa' }, { spanish: 'hogar', query: 'hogar' }],
  }]);
  cached.mockClear();
  generate.mockClear();
  store.mockClear();
  serveSides(['casa / hogar']);
  expect((await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: 'casa / hogar', status: 'skipped', vocabCards: 0, conjugationCards: 0 },
  ]);
  expect((await generateForWords(db, 'CASA\nHOGAR', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: 'CASA', status: 'skipped', vocabCards: 0, conjugationCards: 0 },
    { word: 'HOGAR', status: 'skipped', vocabCards: 0, conjugationCards: 0 },
  ]);
  expect(cached).not.toHaveBeenCalled();
  expect(generate).not.toHaveBeenCalled();
  expect(store).not.toHaveBeenCalled();
  expect(lookup).toHaveBeenCalledExactlyOnceWith(remaining);
});

test.each(['word query', 'recorded form'])(
  'refuses a partly carded fold owned by distinct basic cards through %s before lookup or writes',
  async (ownership) => {
    const storedWords = [
      { id: 1, query: '¡adiós!', info: JSON.stringify(goodbye), lookedUpAt: 123 },
      { id: 2, query: ownership === 'word query' ? '¡chao!' : 'hasta pronto',
        info: JSON.stringify({ ...goodbye, spanish: '¡Chao!', english: 'bye' }), lookedUpAt: 123 },
    ];
    const storedCards = [
      storedGoodbye,
      { ...storedGoodbye, id: 2, wordId: 2, front: 'bye', back: '¡Chao!', ankiNoteId: 987655,
        forms: ownership === 'word query' ? null : [{ spanish: '¡Chao!', query: ' ¡CHAO!\t' }] },
    ];
    await db.insert(words).values(storedWords);
    await db.insert(cards).values(storedCards);
    serveSides(['Hasta luego / ¡Adiós! / ¡Chao!']);
    const cached = vi.spyOn(lookupCache, 'cachedLookup');
    const store = vi.spyOn(cardStore, 'storeCards');
    const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
      .mockResolvedValue({ ...goodbye, spanish: 'Hasta luego', english: 'see you later' });

    const results = (await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results;

    expect(results).toEqual([
      {
        word: 'Hasta luego / ¡Adiós! / ¡Chao!', status: 'error', vocabCards: 0, conjugationCards: 0,
        message: 'Cannot fold "Hasta luego / ¡Adiós! / ¡Chao!": its forms are already owned by 2 different basic cards; card the forms one at a time.',
      },
    ]);
    expect(cached).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect(await db.select().from(words).orderBy(words.id)).toEqual(storedWords);
    expect(await db.select().from(cards).orderBy(cards.id)).toEqual(storedCards);
    expect(await db.select().from(conjugationPatterns)).toEqual([]);
    expect(renderToStaticMarkup(pageWithResults(results)).match(/<li\b[^>]*>.*?<\/li>/g)).toEqual([
      '<li class="bg-gray-100 p-3 rounded"><span aria-hidden="true" class="text-xs mr-2">!</span><strong>Hasta luego / ¡Adiós! / ¡Chao!</strong>: Cannot fold &quot;Hasta luego / ¡Adiós! / ¡Chao!&quot;: its forms are already owned by 2 different basic cards; card the forms one at a time.</li>',
    ]);
  },
);

test('skips an all-forms-carded fold even when different basic cards own its forms', async () => {
  const storedWords = [
    { id: 1, query: '¡adiós!', info: 'unreadable cache', lookedUpAt: 123 },
    { id: 2, query: '¡chao!', info: 'unreadable cache', lookedUpAt: 123 },
  ];
  const storedCards = [
    storedGoodbye,
    { ...storedGoodbye, id: 2, wordId: 2, front: 'bye', back: '¡Chao!', ankiNoteId: 987655 },
  ];
  await db.insert(words).values(storedWords);
  await db.insert(cards).values(storedCards);
  serveSides(['¡Adiós! / ¡Chao!']);
  const cached = vi.spyOn(lookupCache, 'cachedLookup');
  const store = vi.spyOn(cardStore, 'storeCards');
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>();

  expect((await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: '¡Adiós! / ¡Chao!', status: 'skipped', vocabCards: 0, conjugationCards: 0 },
  ]);
  expect(cached).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
  expect(store).not.toHaveBeenCalled();
  expect(await db.select().from(words).orderBy(words.id)).toEqual(storedWords);
  expect(await db.select().from(cards).orderBy(cards.id)).toEqual(storedCards);
});

test.each(['success', 'throw', 'payload'])(
  'keeps single-card enrichment behavior when two forms share an owner and lookup returns %s',
  async (outcome) => {
    const storedWords = [
      { id: 1, query: '¡adiós!', info: JSON.stringify(goodbye), lookedUpAt: 123 },
      { id: 2, query: '¡chao!',
        info: JSON.stringify({ ...goodbye, spanish: '¡Chao!', english: 'bye' }), lookedUpAt: 123 },
    ];
    const owner = { ...storedGoodbye, back: '¡Adiós! / ¡Chao!', forms: [
      { spanish: '¡Adiós!', query: '¡adiós!' }, { spanish: '¡Chao!', query: '¡chao!' },
    ] };
    await db.insert(words).values(storedWords);
    await db.insert(cards).values(owner);
    serveSides(['¡Adiós! / ¡Chao! / Hasta luego']);
    const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
      .mockResolvedValue({ ...goodbye, spanish: 'Hasta luego', english: 'see you later' });
    if (outcome === 'throw') lookup.mockRejectedValueOnce(new Error('Lookup timed out after 1000 ms'));
    if (outcome === 'payload') lookup.mockResolvedValueOnce({ ...goodbye, error: 'Lookup returned HTTP 503' });

    const results = (await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results;

    expect(lookup).toHaveBeenCalledExactlyOnceWith('Hasta luego');
    if (outcome === 'success') {
      expect(results).toEqual([
        { word: '¡Adiós! / ¡Chao! / Hasta luego', status: 'updated', vocabCards: 0, conjugationCards: 0 },
      ]);
      expect(await db.select().from(cards)).toEqual([{
        ...owner, ...goodbyeAudio, back: '¡Adiós! / ¡Chao! / Hasta luego', forms: [
          { spanish: '¡Adiós!', query: '¡adiós!' }, { spanish: '¡Chao!', query: '¡chao!' },
          { spanish: 'Hasta luego', query: 'hasta luego' },
        ],
      }]);
    } else {
      expect(results).toEqual([
        {
          word: '¡Adiós! / ¡Chao! / Hasta luego', status: 'error', vocabCards: 0, conjugationCards: 0,
          message: outcome === 'throw' ? 'Lookup timed out after 1000 ms' : 'Lookup returned HTTP 503',
        },
      ]);
      expect(await db.select().from(words).orderBy(words.id)).toEqual(storedWords);
      expect(await db.select().from(cards)).toEqual([owner]);
    }
    expect(await db.select().from(conjugationPatterns)).toEqual([]);
  },
);

test('enriches a carded goodbye in place with its pack alternative, preserving the Anki note', async () => {
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue(goodbye);
  expect((await generateForWords(db, '¡adiós!', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: '¡adiós!', status: 'added', vocabCards: 1, conjugationCards: 0 },
  ]);
  await db.update(cards).set({ ankiNoteId: 987654, sentAt: 456, createdAt: 123 }).where(eq(cards.id, 1));
  expect(await db.select().from(cards)).toEqual([{ ...storedGoodbye, ...goodbyeAudio }]);
  serveSides(['¡Adiós! / ¡Chao!']);
  const store = vi.spyOn(cardStore, 'storeCards');

  const results = (await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results;
  expect(results).toEqual([
    { word: '¡Adiós! / ¡Chao!', status: 'updated', vocabCards: 0, conjugationCards: 0 },
  ]);
  expect(await store.mock.results[0]?.value).toEqual({ vocabCards: 0, conjugationCards: 0, updatedCards: 1 });
  expect(await db.select().from(cards)).toEqual([{
    ...storedGoodbye, ...goodbyeAudio, back: '¡Adiós! / ¡Chao!',
    forms: [{ spanish: '¡Adiós!', query: '¡adiós!' }, { spanish: '¡Chao!', query: '¡chao!' }],
  }]);
  expect(lookup.mock.calls).toEqual([['¡adiós!'], ['¡Chao!']]);
  expect(renderToStaticMarkup(pageWithResults(results)))
    .toContain('<span aria-hidden="true" class="text-xs mr-2">↻</span>');
});

test('preserves a sent synonym card when a partly carded pack item collides with its front', async () => {
  const car: WordInfo = {
    english: 'the car', spanish: 'coche', gender: 'masculine', article: 'el', type: 'noun',
    example: null, conjugations: null,
  };
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
    .mockResolvedValueOnce(car)
    .mockResolvedValueOnce({ ...car, spanish: 'carro', example: 'El carro es rojo. (The car is red.)' })
    .mockResolvedValueOnce({ ...car, spanish: 'auto' });
  expect((await generateForWords(db, 'el coche\nel carro', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: 'el coche', status: 'added', vocabCards: 1, conjugationCards: 0 },
    { word: 'el carro', status: 'added', vocabCards: 1, conjugationCards: 0 },
  ]);
  await db.update(cards).set({ ankiNoteId: 987654, sentAt: 456, createdAt: 123 }).where(eq(cards.id, 1));
  const storedBeforePack = await db.select().from(cards).orderBy(cards.id);
  expect(storedBeforePack).toEqual([
    { ...storedGoodbye, front: 'the car', back: 'el coche',
      audioFile: 'card-ad7e94db0801963c57cdc59d4cd2d05f6189feeb92eb56baad2a00f124544e31.mp3',
      audioMp3: Buffer.from([73, 68, 51]),
    },
    expect.objectContaining({ wordId: 2, kind: 'example', front: 'El ____ es rojo.' }),
  ]);
  serveSides(['el carro / el auto']);
  const store = vi.spyOn(cardStore, 'storeCards');

  expect((await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: 'el carro / el auto', status: 'exists', vocabCards: 0, conjugationCards: 0 },
  ]);
  expect(await store.mock.results[0]?.value).toEqual({ vocabCards: 0, conjugationCards: 0, updatedCards: 0 });
  expect(await db.select().from(cards).orderBy(cards.id)).toEqual(storedBeforePack);
  expect(lookup.mock.calls).toEqual([['el coche'], ['el carro'], ['el auto']]);
});

test('enriches the owning card when an unrelated card already has the folded front', async () => {
  await db.insert(words).values([
    { id: 1, query: 'casa', info: JSON.stringify({ ...noun, example: null }), lookedUpAt: 123 },
    { id: 2, query: 'vivienda', info: '{}', lookedUpAt: 123 },
  ]);
  const owner = { ...storedGoodbye, front: 'house', back: 'la casa' };
  const unrelated = { ...storedGoodbye, id: 2, wordId: 2, front: 'house / home', back: 'la vivienda' };
  await db.insert(cards).values([owner, unrelated]);
  serveSides(['casa / hogar']);
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
    .mockResolvedValue({ ...noun, english: 'home', spanish: 'hogar', example: null });

  expect((await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: 'casa / hogar', status: 'updated', vocabCards: 0, conjugationCards: 0 },
  ]);
  expect(await db.select().from(cards).orderBy(cards.id)).toEqual([
    { ...owner, ...houseAudio, back: 'casa / hogar', forms: [
      { spanish: 'casa', query: 'casa' }, { spanish: 'hogar', query: 'hogar' },
    ] },
    unrelated,
  ]);
});

test('resolves a later fold through a recorded secondary form and retains earlier alternatives', async () => {
  serveSides(['¡Adiós! / ¡Chao!']);
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
    .mockResolvedValueOnce(goodbye)
    .mockResolvedValueOnce({ ...goodbye, english: 'bye', spanish: '¡Chao!' })
    .mockResolvedValueOnce({ ...goodbye, english: 'see you later', spanish: 'Hasta luego' });
  expect((await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: '¡Adiós! / ¡Chao!', status: 'added', vocabCards: 1, conjugationCards: 0 },
  ]);
  serveSides(['¡Chao! / Hasta luego']);
  expect((await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: '¡Chao! / Hasta luego', status: 'updated', vocabCards: 0, conjugationCards: 0 },
  ]);
  expect(await db.select().from(cards)).toEqual([expect.objectContaining({
    id: 1, wordId: 1, front: 'goodbye / bye', back: '¡Chao! / Hasta luego / ¡Adiós!',
    forms: [
      { spanish: '¡Chao!', query: '¡chao!' },
      { spanish: 'Hasta luego', query: 'hasta luego' },
      { spanish: '¡Adiós!', query: '¡adiós!' },
    ],
  })]);
  expect((await generateForWords(db, '¡ADIÓS!\n¡CHAO!\nHasta luego', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: '¡ADIÓS!', status: 'skipped', vocabCards: 0, conjugationCards: 0 },
    { word: '¡CHAO!', status: 'skipped', vocabCards: 0, conjugationCards: 0 },
    { word: 'Hasta luego', status: 'skipped', vocabCards: 0, conjugationCards: 0 },
  ]);
  expect(lookup.mock.calls).toEqual([['¡Adiós!'], ['¡Chao!'], ['Hasta luego']]);
});

test('skips normalized recorded forms before reading an unusable cache', async () => {
  await db.insert(words).values({ id: 1, query: 'casa', info: 'unreadable cache', lookedUpAt: 123 });
  await db.insert(cards).values({ ...storedGoodbye, front: 'house', back: 'casa / hogar', forms: [
    { spanish: 'casa', query: 'casa' }, { spanish: 'hogar', query: ' HOGAR\t' },
  ] });
  const cached = vi.spyOn(lookupCache, 'cachedLookup');
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>();

  expect((await generateForWords(db, 'hogar', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: 'hogar', status: 'skipped', vocabCards: 0, conjugationCards: 0 },
  ]);
  expect(cached).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
  expect(await db.select({ query: words.query }).from(words)).toEqual([{ query: 'casa' }]);
});

test.each(['throw', 'payload'])('retains a committed enrichment when the next lookup fails by %s', async (failure) => {
  await db.insert(words).values({ id: 1, query: '¡adiós!', info: JSON.stringify(goodbye), lookedUpAt: 123 });
  await db.insert(cards).values(storedGoodbye);
  serveSides(['¡Adiós! / ¡Chao!', 'casa / hogar']);
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
    .mockResolvedValueOnce({ ...goodbye, spanish: '¡Chao!', english: 'bye' })
    .mockResolvedValueOnce(noun);
  if (failure === 'throw') lookup.mockRejectedValueOnce(new Error('Lookup timed out after 1000 ms'));
  else lookup.mockResolvedValueOnce({ ...noun, error: 'Lookup returned HTTP 503' });

  expect((await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: '¡Adiós! / ¡Chao!', status: 'updated', vocabCards: 0, conjugationCards: 0 },
    { word: 'casa / hogar', status: 'error', vocabCards: 0, conjugationCards: 0,
      message: failure === 'throw' ? 'Lookup timed out after 1000 ms' : 'Lookup returned HTTP 503' },
  ]);
  expect(await db.select().from(cards)).toEqual([{
    ...storedGoodbye, ...goodbyeAudio, back: '¡Adiós! / ¡Chao!', forms: [
      { spanish: '¡Adiós!', query: '¡adiós!' }, { spanish: '¡Chao!', query: '¡chao!' },
    ],
  }]);
  expect(await db.select({ query: words.query }).from(words).orderBy(words.id)).toEqual([
    { query: '¡adiós!' }, { query: '¡chao!' }, { query: 'casa' },
  ]);
});

test('reports a missing second form cache row without enriching and continues the pack', async () => {
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
    .mockResolvedValueOnce(goodbye).mockResolvedValueOnce(goodbye).mockResolvedValueOnce(noun);
  await generateForWords(db, '¡adiós!', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl));
  await db.update(cards).set({ ankiNoteId: 987654, sentAt: 456, createdAt: 123 }).where(eq(cards.id, 1));
  await client.execute(`
    CREATE TRIGGER omit_second_form BEFORE INSERT ON words
    WHEN NEW.query = '¡chao!'
    BEGIN SELECT RAISE(IGNORE); END
  `);
  serveSides(['¡Adiós! / ¡Chao!', 'casa']);

  expect((await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    {
      word: '¡Adiós! / ¡Chao!', status: 'error', vocabCards: 0, conjugationCards: 0,
      message: 'Cached word "¡Chao!" is missing; check lookup cache persistence and retry.',
    },
    { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
  ]);
  expect(await db.select().from(cards).where(eq(cards.id, 1))).toEqual([{ ...storedGoodbye, ...goodbyeAudio }]);
  expect((await db.select().from(cards).orderBy(cards.id)).map(({ front }) => front)).toEqual([
    'goodbye', 'house', 'La ____ es grande.',
  ]);
  expect((await db.select().from(words).orderBy(words.id)).map(({ query }) => query)).toEqual(['¡adiós!', 'casa']);
});

test('records missing forms even when the basic back matches and leaves conjugation backs untouched', async () => {
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue(irregularVerb);
  expect((await generateForWords(db, 'ir', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: 'ir', status: 'added', vocabCards: 1, conjugationCards: 2 },
  ]);
  await db.update(cards).set({ back: 'ir / marchar' }).where(eq(cards.front, 'to go'));
  await db.update(cards).set({ back: 'stored present answer' })
    .where(eq(cards.front, 'Conjugate ir in present (irregular)'));
  serveSides(['ir / marchar']);

  expect((await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: 'ir / marchar', status: 'updated', vocabCards: 0, conjugationCards: 0 },
  ]);
  expect((await db.select().from(cards).orderBy(cards.id)).map(({ front, back }) => ({ front, back }))).toEqual([
    { front: 'to go', back: 'ir / marchar' },
    { front: 'Conjugate ir in present (irregular)', back: 'stored present answer' },
    {
      front: 'Conjugate ir in preterite (irregular)',
      back: 'yo: fui<br>tú: fuiste<br>él/ella: fue<br>nosotros: fuimos<br>vosotros: fuisteis<br>ellos: fueron',
    },
  ]);
  expect(await db.select({ forms: cards.forms }).from(cards).where(eq(cards.front, 'to go'))).toEqual([{
    forms: [{ spanish: 'ir', query: 'ir' }, { spanish: 'marchar', query: 'marchar' }],
  }]);
  expect(lookup.mock.calls).toEqual([['ir'], ['marchar']]);
});

test('skips the same pack item twice before lookup, generation or storage', async () => {
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue(goodbye);
  serveSides(['¡Adiós! / ¡Chao!']);
  expect((await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: '¡Adiós! / ¡Chao!', status: 'added', vocabCards: 1, conjugationCards: 0 },
  ]);
  await db.update(cards).set({ ankiNoteId: 987654, sentAt: 456, createdAt: 123 }).where(eq(cards.id, 1));
  await client.execute(`
    CREATE TRIGGER reject_card_update BEFORE UPDATE ON cards
    BEGIN SELECT RAISE(ABORT, 'unexpected card update'); END
  `);
  serveSides(['¡Adiós! / ¡Chao!']);
  const store = vi.spyOn(cardStore, 'storeCards');

  expect((await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: '¡Adiós! / ¡Chao!', status: 'skipped', vocabCards: 0, conjugationCards: 0 },
  ]);
  expect(store).not.toHaveBeenCalled();
  expect(await db.select().from(cards)).toEqual([{
    ...storedGoodbye, ...goodbyeAudio, back: '¡Adiós! / ¡Chao!',
    forms: [{ spanish: '¡Adiós!', query: '¡adiós!' }, { spanish: '¡Chao!', query: '¡chao!' }],
  }]);
  expect(lookup.mock.calls).toEqual([['¡Adiós!'], ['¡Chao!']]);
});

test.each(['¡adiós!', '¡CHAO!'])('skips standalone %s after its richer pack item without changing the stored card', async (word) => {
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue(goodbye);
  serveSides(['¡Adiós! / ¡Chao!']);
  expect((await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: '¡Adiós! / ¡Chao!', status: 'added', vocabCards: 1, conjugationCards: 0 },
  ]);
  await db.update(cards).set({ ankiNoteId: 987654, sentAt: 456, createdAt: 123 }).where(eq(cards.id, 1));
  const store = vi.spyOn(cardStore, 'storeCards');

  const cached = vi.spyOn(lookupCache, 'cachedLookup');
  const generate = vi.spyOn(cardGenerator, 'generateCards');
  expect((await generateForWords(db, word, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word, status: 'skipped', vocabCards: 0, conjugationCards: 0 },
  ]);
  expect(store).not.toHaveBeenCalled();
  expect(cached).not.toHaveBeenCalled();
  expect(generate).not.toHaveBeenCalled();
  expect(await db.select().from(cards)).toEqual([{
    ...storedGoodbye, ...goodbyeAudio, back: '¡Adiós! / ¡Chao!',
    forms: [{ spanish: '¡Adiós!', query: '¡adiós!' }, { spanish: '¡Chao!', query: '¡chao!' }],
  }]);
  expect(lookup.mock.calls).toEqual([['¡Adiós!'], ['¡Chao!']]);
});

test('asks to check Anki if already sent and shows inserted counts when an item also enriches a card', async () => {
  await db.insert(words).values({ query: 'hablar', info: JSON.stringify(regularVerb), lookedUpAt: 123 });
  await db.insert(cards).values({
    wordId: 1, deck: 'Spanish::Vocab', kind: 'basic', front: 'to speak', back: 'hablar',
    tags: '[]', ankiNoteId: 987654, sentAt: 456, createdAt: 123,
  });
  serveSides(['hablar / platicar']);
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue({ ...regularVerb, spanish: 'platicar' });
  const store = vi.spyOn(cardStore, 'storeCards');

  const results = (await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results;
  expect(results).toEqual([
    { word: 'hablar / platicar', status: 'updated', vocabCards: 0, conjugationCards: 2 },
  ]);
  expect(await store.mock.results[0]?.value).toEqual({ vocabCards: 0, conjugationCards: 2, updatedCards: 1 });
  expect((await db.select().from(cards).orderBy(cards.id)).map(({ back }) => back)).toEqual([
    'hablar / platicar',
    'yo: hablo<br>tú: hablas<br>él/ella: habla<br>nosotros: hablamos<br>vosotros: habláis<br>ellos: hablan',
    'yo: hablé<br>tú: hablaste<br>él/ella: habló<br>nosotros: hablamos<br>vosotros: hablasteis<br>ellos: hablaron',
  ]);
  expect(renderToStaticMarkup(pageWithResults(results)).match(/<li\b[^>]*>.*?<\/li>/g)).toEqual([
    '<li class="bg-gray-100 p-3 rounded"><span aria-hidden="true" class="text-xs mr-2">↻</span><strong>hablar / platicar</strong>: 2 conjugation cards added; updated: stored card changed; check Anki if this card was already sent</li>',
  ]);
});

test('reports a rejected enrichment, preserves the stored note and cache, and processes the next item', async () => {
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValueOnce(goodbye);
  await generateForWords(db, '¡adiós!', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl));
  await db.update(cards).set({ ankiNoteId: 987654, sentAt: 456, createdAt: 123 }).where(eq(cards.id, 1));
  await client.execute(`
    CREATE TRIGGER reject_card_update BEFORE UPDATE ON cards
    BEGIN SELECT RAISE(ABORT, 'card update rejected'); END
  `);
  serveSides(['¡Adiós! / ¡Chao!', 'casa']);
  lookup.mockResolvedValueOnce(goodbye).mockResolvedValueOnce(noun);

  const results = (await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results;

  expect(results).toEqual([
    expect.objectContaining({ word: '¡Adiós! / ¡Chao!', status: 'error', vocabCards: 0, conjugationCards: 0 }),
    { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
  ]);
  expect(results[0]?.message).toContain('update "cards" set "back" = ?, "forms" = ?, "audio_file" = ?, "audio_mp3" = ?, "audio_sent_at" = ? where "cards"."id" = ?');
  expect(await db.select().from(cards).where(eq(cards.id, 1))).toEqual([{ ...storedGoodbye, ...goodbyeAudio }]);
  expect((await db.select().from(cards).orderBy(cards.id)).map(({ front }) => front)).toEqual([
    'goodbye', 'house', 'La ____ es grande.',
  ]);
  expect((await db.select().from(words).orderBy(words.id)).map(({ query }) => query)).toEqual([
    '¡adiós!', '¡chao!', 'casa',
  ]);
});

test('skips a group only when every normalized form has a card', async () => {
  await db.insert(words).values([
    { id: 1, query: ' CaSa\t', info: 'unreadable cached info', lookedUpAt: 123 },
    { id: 2, query: 'HOGAR', info: 'unreadable cached info', lookedUpAt: 123 },
  ]);
  await db.insert(cards).values([
    { wordId: 1, deck: 'Vocab', kind: 'basic', front: 'house', back: 'casa', tags: '[]', createdAt: 123 },
    { wordId: 2, deck: 'Vocab', kind: 'basic', front: 'home', back: 'hogar', tags: '[]', createdAt: 123 },
  ]);
  serveSides(['CASA / Hogar']);
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>();
  const cached = vi.spyOn(lookupCache, 'cachedLookup');
  const generate = vi.spyOn(cardGenerator, 'generateCards');

  expect((await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: 'CASA / Hogar', status: 'skipped', vocabCards: 0, conjugationCards: 0 },
  ]);
  expect(cached).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
  expect(generate).not.toHaveBeenCalled();
  expect(await db.select().from(cards)).toHaveLength(2);
});

test('takes conjugations and pattern claims only from the first form before the next item', async () => {
  serveSides(['hablar / ir', 'bailar']);
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
    .mockResolvedValueOnce(regularVerb).mockResolvedValueOnce(irregularVerb).mockResolvedValueOnce(secondRegularVerb);
  const conjugations = vi.spyOn(cardGenerator, 'conjugationCards');

  expect((await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: 'hablar / ir', status: 'added', vocabCards: 1, conjugationCards: 2 },
    { word: 'bailar', status: 'added', vocabCards: 1, conjugationCards: 0 },
  ]);
  expect(conjugations.mock.calls).toEqual([
    [regularVerb, new Set()], [secondRegularVerb, new Set(['ar-regular-present', 'ar-regular-preterite'])],
  ]);
  expect((await db.select().from(cards).orderBy(cards.id)).map(({ wordId, front }) => ({ wordId, front }))).toEqual([
    { wordId: 1, front: 'to speak / to go' },
    { wordId: 1, front: 'Conjugate hablar in present (regular -ar)' },
    { wordId: 1, front: 'Conjugate hablar in preterite (regular -ar)' },
    { wordId: 3, front: 'to dance' },
  ]);
  expect((await db.select().from(conjugationPatterns)).map(({ cardId }) => cardId)).toEqual([2, 3]);
});

test.each([
  { failedForm: 'first', message: 'First form unsupported' },
  { failedForm: 'second', message: 'Second form unsupported' },
  { failedForm: 'second', message: '' },
])('reports the whole item when its $failedForm lookup returns error "$message"', async ({ failedForm, message }) => {
  serveSides(['casa / hogar', 'árbol']);
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
    .mockResolvedValueOnce(failedForm === 'first' ? { ...noun, error: message } : noun)
    .mockResolvedValueOnce(failedForm === 'second' ? { ...noun, error: message } : noun)
    .mockResolvedValueOnce({ ...noun, english: 'tree', spanish: 'árbol', example: null });
  const generate = vi.spyOn(cardGenerator, 'generateCards');

  expect((await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: 'casa / hogar', status: 'error', vocabCards: 0, conjugationCards: 0, message },
    { word: 'árbol', status: 'added', vocabCards: 1, conjugationCards: 0 },
  ]);
  expect(lookup.mock.calls).toEqual([['casa'], ['hogar'], ['árbol']]);
  expect(generate).toHaveBeenCalledOnce();
  expect(await db.select().from(cards)).toEqual([expect.objectContaining({ front: 'tree' })]);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
});

test.each([new Error('Lookup response timed out'), 'Lookup response timed out'])(
  'preserves a thrown form lookup error and its completed cache writes: %s', async (error) => {
    serveSides(['casa / hogar', 'árbol']);
    const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
      .mockResolvedValueOnce(noun).mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ ...noun, english: 'tree', spanish: 'árbol', example: null });

    expect((await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
      {
        word: 'casa / hogar', status: 'error', vocabCards: 0, conjugationCards: 0,
        message: 'Lookup response timed out',
      },
      { word: 'árbol', status: 'added', vocabCards: 1, conjugationCards: 0 },
    ]);
    expect((await db.select().from(words).orderBy(words.id)).map(({ query }) => query)).toEqual(['casa', 'árbol']);
    expect(await db.select().from(cards)).toEqual([expect.objectContaining({ wordId: 2, front: 'tree' })]);
  },
);

test.each(['http', 'request', 'body'])(
  'propagates a pack %s failure without extraction, lookup or writes', async (failure) => {
    const response = new Response('Denied', { status: 403, statusText: 'Forbidden' });
    let message = 'Brainscape request for https://www.brainscape.com/packs/21648778 returned HTTP 403 Forbidden; check the response and retry.';
    if (failure === 'request') {
      message = 'connect ETIMEDOUT';
      fetchImpl.mockRejectedValueOnce(new Error(message));
    } else if (failure === 'body') {
      message = 'Response body stream terminated';
      const bodyResponse = new Response();
      vi.spyOn(bodyResponse, 'text').mockRejectedValueOnce(new Error(message));
      fetchImpl.mockResolvedValueOnce(bodyResponse);
    } else {
      fetchImpl.mockResolvedValueOnce(response);
    }
    const lookup = vi.fn<(word: string) => Promise<WordInfo>>();

    await expect(generateForWords(db, packUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).rejects.toThrow(message);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(lookup).not.toHaveBeenCalled();
    expect(await db.select().from(words)).toEqual([]);
    expect(await db.select().from(cards)).toEqual([]);
  },
);

test.each([
  { text: 'https://www.brainscape.com/packs/42\ncasa', expected: ['https://www.brainscape.com/packs/42', 'casa'] },
  { text: 'https://notbrainscape.com/packs/42', expected: ['https://notbrainscape.com/packs/42'] },
  { text: 'Casa; ¡Adiós!/¡Chao!; CASA', expected: ['Casa', '¡Adiós!/¡Chao!'] },
])('preserves the ordinary word-list path for $text', async ({ text, expected }) => {
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue(noun);
  const parseList = vi.spyOn(wordListParser, 'resolveWordList');
  const generate = vi.spyOn(cardGenerator, 'generateCards');

  const results = (await generateForWords(db, text, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results;

  expect(results.map(({ word }) => word)).toEqual(expected);
  expect(lookup.mock.calls.flat()).toEqual(expected);
  expect(parseList).toHaveBeenCalledExactlyOnceWith(text, expect.any(Function));
  expect(fetchImpl.mock.calls.filter(([, init]) => init?.method !== 'POST')).toEqual([]);
  for (const call of generate.mock.calls) expect(call).toEqual([noun]);
});

test('dedupes incoming words before lookup even when the first occurrence fails', async () => {
  vi.spyOn(wordListParser, 'resolveWordList').mockResolvedValue([
    'ÁRBOL', ' árbol\t', 'Casa', 'CASA',
  ]);
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
    .mockRejectedValueOnce(new Error('Lookup timed out after 1000 ms'))
    .mockResolvedValue(noun);

  expect((await generateForWords(db, 'pack items', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    {
      word: 'ÁRBOL', status: 'error', vocabCards: 0, conjugationCards: 0,
      message: 'Lookup timed out after 1000 ms',
    },
    { word: 'Casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
  ]);
  expect(lookup.mock.calls).toEqual([['ÁRBOL'], ['Casa']]);
  expect(await db.select().from(words)).toEqual([expect.objectContaining({ query: 'casa' })]);
  expect(await db.select().from(cards)).toHaveLength(2);
});

test('reports a rejected stored-word read without lookup or writes', async () => {
  vi.spyOn(client, 'execute').mockRejectedValueOnce(new Error('Database read timed out after 1000 ms'));
  const cached = vi.spyOn(lookupCache, 'cachedLookup');
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue(noun);

  const results = (await generateForWords(db, 'casa', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results;

  expect(results).toEqual([
    expect.objectContaining({
      word: 'casa', status: 'error', vocabCards: 0, conjugationCards: 0,
    }),
  ]);
  expect(results[0]?.message).toBe(
    'Failed query: select "words"."query", "cards"."id", "cards"."kind", "cards"."forms" from "words" inner join "cards" on "cards"."word_id" = "words"."id" order by "cards"."id"\nparams: ',
  );
  expect(cached).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
  expect(await db.select().from(words)).toEqual([]);
  expect(await db.select().from(cards)).toEqual([]);
});

test.each([
  'Casa, hablar, CASA, por favor',
  'Casa; hablar; CASA; por favor',
  ' - Casa, 2) hablar; • CASA\n* por favor',
])('generates each cleaned delimiter item in order without extraction: %s', async (text) => {
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue(noun);

  const results = (await generateForWords(db, text, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results;

  expect(results.map((result) => result.word)).toEqual(['Casa', 'hablar', 'por favor']);
  expect(lookup.mock.calls).toEqual([['Casa'], ['hablar'], ['por favor']]);
});

test('an empty list produces no results or lookups', async () => {
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>();

  expect((await generateForWords(db, ' \n\t ', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([]);
  expect(lookup).not.toHaveBeenCalled();
  expect(await db.select().from(words)).toEqual([]);
});

test('adds a noun and its example once, then reports skipped using the normalized query', async () => {
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue(noun);
  const first: WordResult[] = (await generateForWords(db, ' Casa \nCASA\n', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results;

  expect(first).toEqual([{ word: 'Casa', status: 'added', vocabCards: 2, conjugationCards: 0 }]);
  expect((await generateForWords(db, 'casa', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: 'casa', status: 'skipped', vocabCards: 0, conjugationCards: 0 },
  ]);
  expect(lookup).toHaveBeenCalledExactlyOnceWith('Casa');
  const storedWords = await db.select().from(words);
  expect(storedWords).toEqual([expect.objectContaining({ query: 'casa' })]);
  const storedCards = await db.select().from(cards).orderBy(cards.id);
  expect(storedCards).toHaveLength(2);
  expect(storedCards[0]).toMatchObject({
    wordId: storedWords[0]?.id, kind: 'basic', front: 'house', back: 'la casa',
  });
  expect(storedCards[1]).toMatchObject({
    wordId: storedWords[0]?.id, kind: 'example', front: 'La ____ es grande.',
  });
});

test('reports exists when a cached word with no cards generates a stored front in the same deck', async () => {
  const cachedInfo: WordInfo = { ...noun, example: null };
  const storedWords = [
    {
      id: 1, query: 'hogar', lookedUpAt: 123,
      info: JSON.stringify({ ...cachedInfo, spanish: 'hogar', gender: 'masculine', article: 'el' }),
    },
    { id: 2, query: 'casa', info: JSON.stringify(cachedInfo), lookedUpAt: 123 },
  ];
  const storedCard: typeof cards.$inferSelect = {
    id: 1, wordId: 1, deck: 'Spanish::Vocab', kind: 'basic', front: 'house', back: 'el hogar',
    tags: '["auto-generated"]', forms: null, audioFile: null, audioMp3: null, audioSentAt: null, ankiNoteId: null, sentAt: null, declinedAt: null, createdAt: 123,
  };
  await db.insert(words).values(storedWords);
  await db.insert(cards).values(storedCard);
  expect(await db.select().from(words).orderBy(words.id)).toEqual(storedWords);
  expect(await db.select().from(cards)).toEqual([storedCard]);
  const cached = vi.spyOn(lookupCache, 'cachedLookup');
  const generate = vi.spyOn(cardGenerator, 'generateCards');
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>();

  expect((await generateForWords(db, 'casa', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: 'casa', status: 'exists', vocabCards: 0, conjugationCards: 0 },
  ]);
  expect(cached).toHaveBeenCalledExactlyOnceWith(db, 'casa', lookup);
  expect(generate).toHaveBeenCalledExactlyOnceWith(cachedInfo);
  expect(generate).toHaveReturnedWith([
    {
      deck: 'Spanish::Vocab', kind: 'basic', front: 'house', back: 'la casa',
      tags: ['auto-generated'],
    },
  ]);
  expect(lookup).not.toHaveBeenCalled();
  expect(await db.select().from(words).orderBy(words.id)).toEqual(storedWords);
  expect(await db.select().from(cards)).toEqual([{ ...storedCard, ...houseAudio }]);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
});

test('finishes storing the first regular verb before looking up the next verb of that pattern', async () => {
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>();
  lookup.mockImplementationOnce(async (word) => {
    expect(word).toBe('hablar');
    expect(await db.select().from(cards)).toHaveLength(0);
    return regularVerb;
  });
  lookup.mockImplementationOnce(async (word) => {
    expect(word).toBe('bailar');
    expect(await db.select().from(cards)).toHaveLength(3);
    expect(await db.select().from(conjugationPatterns)).toHaveLength(2);
    return secondRegularVerb;
  });

  expect((await generateForWords(db, 'hablar\nbailar', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: 'hablar', status: 'added', vocabCards: 1, conjugationCards: 2 },
    { word: 'bailar', status: 'added', vocabCards: 1, conjugationCards: 0 },
  ]);
  expect(lookup.mock.calls).toEqual([['hablar'], ['bailar']]);
  expect(await db.select().from(cards)).toHaveLength(4);
  expect(await db.select().from(conjugationPatterns)).toHaveLength(2);
  expect((await generateForWords(db, 'hablar\nbailar', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: 'hablar', status: 'skipped', vocabCards: 0, conjugationCards: 0 },
    { word: 'bailar', status: 'skipped', vocabCards: 0, conjugationCards: 0 },
  ]);
  expect(lookup).toHaveBeenCalledTimes(2);
});

test('adds both irregular tenses without pattern claims and reports skipped on repeat', async () => {
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue(irregularVerb);

  expect((await generateForWords(db, 'ir', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: 'ir', status: 'added', vocabCards: 1, conjugationCards: 2 },
  ]);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
  expect((await db.select().from(cards).orderBy(cards.id)).map((card) => card.front)).toEqual([
    'to go', 'Conjugate ir in present (irregular)', 'Conjugate ir in preterite (irregular)',
  ]);
  expect((await generateForWords(db, 'IR', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: 'IR', status: 'skipped', vocabCards: 0, conjugationCards: 0 },
  ]);
  expect(lookup).toHaveBeenCalledTimes(1);
});

test.each([
  { query: 'casa', word: 'CASA' },
  { query: 'CaSa', word: 'casa' },
  { query: 'ÁRBOL', word: 'árbol' },
  { query: '  ÁrBoL\t', word: 'Árbol' },
])('skips a query with one card before cache access or generation: $query', async ({ query, word }) => {
  const storedWord = { id: 1, query, info: 'unreadable cached info', lookedUpAt: 123 };
  const storedCard: typeof cards.$inferInsert = {
    wordId: 1, deck: 'Vocab', kind: 'basic', front: 'stored front', back: word,
    tags: '[]', createdAt: 123,
  };
  await db.insert(words).values(storedWord);
  await db.insert(cards).values(storedCard);
  const cached = vi.spyOn(lookupCache, 'cachedLookup');
  const generate = vi.spyOn(cardGenerator, 'generateCards');
  const conjugations = vi.spyOn(cardGenerator, 'conjugationCards');
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>();

  expect((await generateForWords(db, word, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word, status: 'skipped', vocabCards: 0, conjugationCards: 0 },
  ]);
  expect(cached).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
  expect(generate).not.toHaveBeenCalled();
  expect(conjugations).not.toHaveBeenCalled();
  expect(await db.select().from(words)).toEqual([storedWord]);
  expect(await db.select().from(cards)).toEqual([expect.objectContaining(storedCard)]);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
});

test('reports a stored-word read error before cache access and continues with the following word', async () => {
  vi.spyOn(db, 'select').mockImplementationOnce(() => {
    throw new Error('Stored-word query failed; retry later.');
  });
  const cached = vi.spyOn(lookupCache, 'cachedLookup');
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue(noun);

  expect((await generateForWords(db, 'broken\ncasa', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    {
      word: 'broken', status: 'error', vocabCards: 0, conjugationCards: 0,
      message: 'Stored-word query failed; retry later.',
    },
    { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
  ]);
  expect(cached).toHaveBeenCalledExactlyOnceWith(db, 'casa', lookup);
  expect(lookup).toHaveBeenCalledExactlyOnceWith('casa');
  expect(await db.select().from(words)).toEqual([expect.objectContaining({ query: 'casa' })]);
  expect(await db.select().from(cards)).toHaveLength(2);
});

test('reports an error payload without storing it and continues with the following word', async () => {
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
    .mockResolvedValueOnce({ ...noun, spanish: 'unsupported', error: 'Word not supported' })
    .mockResolvedValueOnce(noun);

  expect((await generateForWords(db, 'unsupported\ncasa', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: 'unsupported', status: 'error', vocabCards: 0, conjugationCards: 0, message: 'Word not supported' },
    { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
  ]);
  expect(lookup.mock.calls).toEqual([['unsupported'], ['casa']]);
  expect(await db.select().from(words)).toEqual([expect.objectContaining({ query: 'casa' })]);
  expect(await db.select().from(cards)).toHaveLength(2);
});

test('cards and pattern rows are not written when storage fails, and the following word is processed', async () => {
  await client.execute(`
    CREATE TRIGGER reject_preterite_card BEFORE INSERT ON cards
    WHEN NEW.front = 'Conjugate hablar in preterite (regular -ar)'
    BEGIN SELECT RAISE(ABORT, 'card insert rejected'); END
  `);
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
    .mockResolvedValueOnce(regularVerb)
    .mockResolvedValueOnce(noun);

  const results = (await generateForWords(db, 'hablar\ncasa', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results;
  expect(results).toEqual([
    expect.objectContaining({
      word: 'hablar', status: 'error', vocabCards: 0, conjugationCards: 0,
    }),
    { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
  ]);
  expect(results[0]?.message).toContain('insert into "cards"');
  expect(lookup.mock.calls).toEqual([['hablar'], ['casa']]);
  expect((await db.select().from(cards).orderBy(cards.id)).map((card) => card.front)).toEqual([
    'house', 'La ____ es grande.',
  ]);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
});

test('retries a word with no cards after a failed card insert and reports added from the cache', async () => {
  await client.execute(`
    CREATE TRIGGER reject_preterite_card BEFORE INSERT ON cards
    WHEN NEW.front = 'Conjugate hablar in preterite (regular -ar)'
    BEGIN SELECT RAISE(ABORT, 'card insert rejected'); END
  `);
  const cached = vi.spyOn(lookupCache, 'cachedLookup');
  const generate = vi.spyOn(cardGenerator, 'generateCards');
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue(regularVerb);

  const failed = (await generateForWords(db, 'hablar', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results;

  expect(failed).toEqual([
    expect.objectContaining({
      word: 'hablar', status: 'error', vocabCards: 0, conjugationCards: 0,
    }),
  ]);
  expect(failed[0]?.message).toContain('insert into "cards"');
  expect(await db.select().from(words)).toEqual([expect.objectContaining({ id: 1, query: 'hablar' })]);
  expect(await db.select().from(cards)).toEqual([]);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
  await client.execute('DROP TRIGGER reject_preterite_card');
  cached.mockClear();
  generate.mockClear();

  expect((await generateForWords(db, 'HABLAR', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    { word: 'HABLAR', status: 'added', vocabCards: 1, conjugationCards: 2 },
  ]);
  expect(cached).toHaveBeenCalledExactlyOnceWith(db, 'HABLAR', lookup);
  expect(generate).toHaveBeenCalledExactlyOnceWith(regularVerb);
  expect(lookup).toHaveBeenCalledExactlyOnceWith('hablar');
  expect(await db.select().from(words)).toEqual([expect.objectContaining({ id: 1, query: 'hablar' })]);
  expect((await db.select().from(cards).orderBy(cards.id)).map((card) => ({
    wordId: card.wordId, kind: card.kind, front: card.front,
  }))).toEqual([
    { wordId: 1, kind: 'basic', front: 'to speak' },
    { wordId: 1, kind: 'conjugation', front: 'Conjugate hablar in present (regular -ar)' },
    { wordId: 1, kind: 'conjugation', front: 'Conjugate hablar in preterite (regular -ar)' },
  ]);
  expect((await db.select().from(conjugationPatterns).orderBy(conjugationPatterns.id)).map((row) => ({
    ending: row.ending, pattern: row.pattern, tense: row.tense,
  }))).toEqual([
    { ending: 'ar', pattern: 'regular', tense: 'present' },
    { ending: 'ar', pattern: 'regular', tense: 'preterite' },
  ]);
});

test('reports a generation error and continues with the following word', async () => {
  vi.spyOn(cardGenerator, 'generateCards').mockImplementationOnce(() => {
    throw new Error('Card generation failed; check word data and retry.');
  });
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
    .mockResolvedValueOnce(regularVerb)
    .mockResolvedValueOnce(noun);

  expect((await generateForWords(db, 'hablar\ncasa', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    {
      word: 'hablar', status: 'error', vocabCards: 0, conjugationCards: 0,
      message: 'Card generation failed; check word data and retry.',
    },
    { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
  ]);
  expect(lookup.mock.calls).toEqual([['hablar'], ['casa']]);
  expect(await db.select().from(cards)).toHaveLength(2);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
});

test('reports a missing cached word row and continues with the following word', async () => {
  await client.execute(`
    CREATE TRIGGER remove_missing_word AFTER INSERT ON words
    WHEN NEW.query = 'missing'
    BEGIN DELETE FROM words WHERE id = NEW.id; END
  `);
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue(noun);

  expect((await generateForWords(db, 'missing\ncasa', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
    {
      word: 'missing', status: 'error', vocabCards: 0, conjugationCards: 0,
      message: 'Cached word "missing" is missing; check lookup cache persistence and retry.',
    },
    { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
  ]);
  expect(lookup.mock.calls).toEqual([['missing'], ['casa']]);
  expect(await db.select().from(words)).toEqual([expect.objectContaining({ query: 'casa' })]);
  expect(await db.select().from(cards)).toHaveLength(2);
});

test.each([new Error('Lookup unavailable; retry later'), 'Lookup unavailable; retry later'])(
  'reports a thrown lookup error and still generates the following word: %s',
  async (error) => {
    const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(noun);

    expect((await generateForWords(db, 'broken\ncasa', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).results).toEqual([
      {
        word: 'broken', status: 'error', vocabCards: 0, conjugationCards: 0,
        message: 'Lookup unavailable; retry later',
      },
      { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
    ]);
    expect(lookup.mock.calls).toEqual([['broken'], ['casa']]);
    expect(await db.select().from(words)).toEqual([expect.objectContaining({ query: 'casa' })]);
    expect(await db.select().from(cards)).toHaveLength(2);
  },
);

test('voice wiring voices every stored kind under the cap with the injected fetch', async () => {
  fetchImpl.mockImplementation(async () => new Response(new Uint8Array([73, 68, 51, 0, 255])));
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
    .mockResolvedValueOnce(noun).mockResolvedValueOnce(regularVerb);

  const report = await generateForWords(db, 'casa\nhablar', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl));

  expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.body])).toEqual([
    ['https://api.elevenlabs.io/v1/text-to-speech/test-voice-id?output_format=mp3_44100_128', '{"text":"la casa","model_id":"eleven_multilingual_v2"}'],
    ['https://api.elevenlabs.io/v1/text-to-speech/test-voice-id?output_format=mp3_44100_128', '{"text":"casa (house) (The house is big.)","model_id":"eleven_multilingual_v2"}'],
    ['https://api.elevenlabs.io/v1/text-to-speech/test-voice-id?output_format=mp3_44100_128', '{"text":"hablar","model_id":"eleven_multilingual_v2"}'],
    ['https://api.elevenlabs.io/v1/text-to-speech/test-voice-id?output_format=mp3_44100_128', '{"text":"yo: hablo tú: hablas él/ella: habla nosotros: hablamos vosotros: habláis ellos: hablan","model_id":"eleven_multilingual_v2"}'],
    ['https://api.elevenlabs.io/v1/text-to-speech/test-voice-id?output_format=mp3_44100_128', '{"text":"yo: hablé tú: hablaste él/ella: habló nosotros: hablamos vosotros: hablasteis ellos: hablaron","model_id":"eleven_multilingual_v2"}'],
  ]);
  expect(await db.select({ kind: cards.kind, audioFile: cards.audioFile, audioMp3: cards.audioMp3 })
    .from(cards).orderBy(cards.id)).toEqual([
    { kind: 'basic', audioFile: 'card-39ea127757ece19e4f940e03a400b6cc3fae452580ca79223e0d6b75148a5477.mp3', audioMp3: Buffer.from([73, 68, 51, 0, 255]) },
    { kind: 'example', audioFile: 'card-4c344c79b718a77c9b2bf1afebdd12740e1959784d43c22a867bbcb85d9e74bb.mp3', audioMp3: Buffer.from([73, 68, 51, 0, 255]) },
    { kind: 'basic', audioFile: 'card-bd30c9f95c035f042fba0778ae19ef44688eb1fb9eacd55f5f1fc8228aedd332.mp3', audioMp3: Buffer.from([73, 68, 51, 0, 255]) },
    { kind: 'conjugation', audioFile: 'card-c601592f902a214434a7a704ad2f32fbbe719057a47ea3c26506cc66eb97ccf1.mp3', audioMp3: Buffer.from([73, 68, 51, 0, 255]) },
    { kind: 'conjugation', audioFile: 'card-51dcfe18e8147d6a083aad1ba0fb3f05d9bc1a49db7f8a17ec948de22660f344.mp3', audioMp3: Buffer.from([73, 68, 51, 0, 255]) },
  ]);
  expect(report).toEqual({ capReached: false, results: [
    { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
    { word: 'hablar', status: 'added', vocabCards: 1, conjugationCards: 2 },
  ] });
});

test('voice wiring shares the 30000 character cap across items and resets it for the next call', async () => {
  fetchImpl.mockImplementation(async () => new Response(new Uint8Array([73, 68, 51])));
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
    .mockResolvedValueOnce({ ...goodbye, spanish: 'a'.repeat(15000), english: 'house' })
    .mockResolvedValueOnce({ ...goodbye, spanish: 'b'.repeat(15000), english: 'home' })
    .mockResolvedValueOnce(goodbye)
    .mockResolvedValueOnce({ ...goodbye, spanish: 'sí', english: 'yes' })
    .mockResolvedValueOnce({ ...goodbye, spanish: 'árbol', english: 'tree' });

  const report = await generateForWords(db, 'casa\nhogar\nadiós\nsí', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl));

  expect(fetchImpl.mock.calls.map(([, init]) => {
    if (typeof init?.body !== 'string') throw new Error('Expected a voice JSON request body.');
    return /"text":"([^"]*)"/.exec(init.body)?.[1]?.length;
  })).toEqual([15000, 15000]);
  expect((await db.select().from(cards).orderBy(cards.id)).map(({ front, audioFile, audioMp3 }) => ({
    front, voiced: audioMp3 !== null, named: audioFile !== null,
  }))).toEqual([
    { front: 'house', voiced: true, named: true },
    { front: 'home', voiced: true, named: true },
    { front: 'goodbye', voiced: false, named: false },
    { front: 'yes', voiced: false, named: false },
  ]);
  expect(report).toEqual({ capReached: true, results: [
    { word: 'casa', status: 'added', vocabCards: 1, conjugationCards: 0 },
    { word: 'hogar', status: 'added', vocabCards: 1, conjugationCards: 0 },
    { word: 'adiós', status: 'added', vocabCards: 1, conjugationCards: 0 },
    { word: 'sí', status: 'added', vocabCards: 1, conjugationCards: 0 },
  ] });
  expect(await generateForWords(db, 'árbol', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl))).toEqual({ capReached: false, results: [
    { word: 'árbol', status: 'added', vocabCards: 1, conjugationCards: 0 },
  ] });
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});

test.each(['collision', 'fold', 'skipped'])('voice wiring reuses cached audio when Back is unchanged on a %s', async (path) => {
  await db.insert(words).values({ id: 1, query: '¡adiós!', info: JSON.stringify(goodbye), lookedUpAt: 123 });
  const cached = {
    ...storedGoodbye, back: path === 'fold' ? '¡Adiós! / ¡Chao!' : '¡Adiós!',
    audioFile: 'cached.mp3', audioMp3: Buffer.from([9, 8, 7]),
  };
  await db.insert(cards).values(cached);
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue(goodbye);
  if (path === 'fold') serveSides(['¡Adiós! / ¡Chao!']);

  const report = await generateForWords(db,
    path === 'fold' ? singleDeckUrl : path === 'collision' ? '¡Chao!' : '¡ADIÓS!', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl));

  expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([]);
  expect(report).toEqual({ capReached: false, results: [
    { word: path === 'fold' ? '¡Adiós! / ¡Chao!' : path === 'collision' ? '¡Chao!' : '¡ADIÓS!',
      status: path === 'fold' ? 'updated' : path === 'collision' ? 'exists' : 'skipped', vocabCards: 0, conjugationCards: 0 },
  ] });
  expect(await db.select({ audioFile: cards.audioFile, audioMp3: cards.audioMp3, ankiNoteId: cards.ankiNoteId })
    .from(cards)).toEqual([{ audioFile: 'cached.mp3', audioMp3: Buffer.from([9, 8, 7]), ankiNoteId: 987654 }]);
});

test.each([
  { state: 'pending', ankiNoteId: null, sentAt: null },
  { state: 'sent', ankiNoteId: 987654, sentAt: 456 },
])('voice wiring replaces cached audio when a fold changes a $state card Back', async ({ ankiNoteId, sentAt }) => {
  await db.insert(words).values({ id: 1, query: '¡adiós!', info: JSON.stringify(goodbye), lookedUpAt: 123 });
  await db.insert(cards).values({
    ...storedGoodbye, ...goodbyeAudio, id: 41, ankiNoteId, sentAt, audioMp3: Buffer.from([9, 8, 7]),
  });
  serveSides(['¡Adiós! / ¡Chao!']);
  fetchImpl.mockResolvedValueOnce(new Response(new Uint8Array([73, 68, 51, 0, 255])));
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
    .mockResolvedValue({ ...goodbye, spanish: '¡Chao!', english: 'bye' });

  const report = await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl));

  expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url, init]) => [url, init?.body]))
    .toEqual([
      ['https://api.elevenlabs.io/v1/text-to-speech/test-voice-id?output_format=mp3_44100_128',
        '{"text":"¡Adiós! / ¡Chao!","model_id":"eleven_multilingual_v2"}'],
    ]);
  expect(await db.select().from(cards)).toEqual([{
    id: 41, wordId: 1, deck: 'Spanish::Vocab', kind: 'basic', front: 'goodbye', back: '¡Adiós! / ¡Chao!',
    tags: '["auto-generated"]', forms: [
      { spanish: '¡Adiós!', query: '¡adiós!' }, { spanish: '¡Chao!', query: '¡chao!' },
    ],
    audioFile: 'card-c7a314202176837303762eca31fe8d778b52284e425256b3b46283325ec48935.mp3',
    audioMp3: Buffer.from([73, 68, 51, 0, 255]), audioSentAt: null, ankiNoteId, sentAt, declinedAt: null, createdAt: 123,
  }]);
  expect(report).toEqual({ capReached: false, results: [
    { word: '¡Adiós! / ¡Chao!', status: 'updated', vocabCards: 0, conjugationCards: 0 },
  ] });
});

test.each([
  { failure: 'request', message: 'Voice request timed out after 1000 ms' },
  { failure: 'http', message: 'ElevenLabs request returned HTTP 429: Too many requests; check the response before retrying.' },
  { failure: 'body', message: 'MP3 response stream interrupted' },
  { failure: 'error body', message: 'ElevenLabs request returned HTTP 503; reading its body failed: Error response stream interrupted; inspect the response before retrying.' },
])('voice wiring preserves the pending card when fold replacement has a $failure failure', async ({ failure, message }) => {
  await db.insert(words).values({ id: 1, query: '¡adiós!', info: JSON.stringify(goodbye), lookedUpAt: 123 });
  await db.insert(cards).values({
    ...storedGoodbye, ...goodbyeAudio, id: 41, ankiNoteId: null, sentAt: null, audioMp3: Buffer.from([9, 8, 7]),
  });
  serveSides(['sí', '¡Adiós! / ¡Chao!', 'casa']);
  fetchImpl.mockResolvedValueOnce(new Response(new Uint8Array([1])));
  if (failure === 'request') fetchImpl.mockRejectedValueOnce(new Error('Voice request timed out after 1000 ms'));
  if (failure === 'http') fetchImpl.mockResolvedValueOnce(new Response('Too many requests', { status: 429 }));
  if (failure === 'body') {
    const response = new Response();
    vi.spyOn(response, 'arrayBuffer').mockRejectedValueOnce(new Error('MP3 response stream interrupted'));
    fetchImpl.mockResolvedValueOnce(response);
  }
  if (failure === 'error body') {
    const response = new Response('', { status: 503 });
    vi.spyOn(response, 'text').mockRejectedValueOnce(new Error('Error response stream interrupted'));
    fetchImpl.mockResolvedValueOnce(response);
  }
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
    .mockResolvedValueOnce({ ...goodbye, spanish: 'sí', english: 'yes' })
    .mockResolvedValueOnce({ ...goodbye, spanish: '¡Chao!', english: 'bye' })
    .mockResolvedValueOnce({ ...noun, example: null });

  const report = await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl));

  expect(report).toEqual({ capReached: false, results: [
    { word: 'sí', status: 'added', vocabCards: 1, conjugationCards: 0 },
    { word: '¡Adiós! / ¡Chao!', status: 'error', vocabCards: 0, conjugationCards: 0, message },
    { word: 'casa', status: 'added', vocabCards: 1, conjugationCards: 0 },
  ] });
  expect(await db.select().from(cards).where(eq(cards.id, 41))).toEqual([{
    id: 41, wordId: 1, deck: 'Spanish::Vocab', kind: 'basic', front: 'goodbye', back: '¡Adiós!',
    tags: '["auto-generated"]', forms: null,
    audioFile: 'card-c7a314202176837303762eca31fe8d778b52284e425256b3b46283325ec48935.mp3',
    audioMp3: Buffer.from([9, 8, 7]), audioSentAt: null, ankiNoteId: null, sentAt: null, declinedAt: null, createdAt: 123,
  }]);
  expect(await db.select({ back: cards.back, audioMp3: cards.audioMp3, sentAt: cards.sentAt })
    .from(cards).orderBy(cards.id)).toEqual([
    { back: '¡Adiós!', audioMp3: Buffer.from([9, 8, 7]), sentAt: null },
    { back: 'sí', audioMp3: Buffer.from([1]), sentAt: null },
    { back: 'la casa', audioMp3: Buffer.from([73, 68, 51]), sentAt: null },
  ]);
  expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => init?.body))
    .toEqual([
      '{"text":"sí","model_id":"eleven_multilingual_v2"}',
      '{"text":"¡Adiós! / ¡Chao!","model_id":"eleven_multilingual_v2"}',
      '{"text":"la casa","model_id":"eleven_multilingual_v2"}',
    ]);
});

test('voice wiring uses the stored Back and identity when an uncached front collides', async () => {
  await db.insert(words).values({ id: 1, query: 'hogar', info: '{}', lookedUpAt: 123 });
  await db.insert(cards).values({ ...storedGoodbye, front: 'house', back: 'el hogar' });
  fetchImpl.mockImplementation(async () => new Response(new Uint8Array([73, 68, 51])));
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue({ ...noun, example: null });

  const report = await generateForWords(db, 'casa', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl));

  expect(fetchImpl.mock.calls.map(([, init]) => init?.body)).toEqual([
    '{"text":"el hogar","model_id":"eleven_multilingual_v2"}',
  ]);
  expect(await db.select().from(cards)).toEqual([{
    ...storedGoodbye, front: 'house', back: 'el hogar',
    audioFile: 'card-39ea127757ece19e4f940e03a400b6cc3fae452580ca79223e0d6b75148a5477.mp3',
    audioMp3: Buffer.from([73, 68, 51]),
  }]);
  expect(report).toEqual({ capReached: false, results: [
    { word: 'casa', status: 'exists', vocabCards: 0, conjugationCards: 0 },
  ] });
});

test('voice wiring voices the retained alternatives and original identity of an uncached fold', async () => {
  await db.insert(words).values({ id: 1, query: '¡adiós!', info: JSON.stringify(goodbye), lookedUpAt: 123 });
  await db.insert(cards).values({ ...storedGoodbye, back: '¡Adiós! / ¡Chao!', forms: [
    { spanish: '¡Adiós!', query: '¡adiós!' }, { spanish: '¡Chao!', query: '¡chao!' },
  ] });
  serveSides(['¡Chao! / Hasta luego']);
  fetchImpl.mockImplementation(async () => new Response(new Uint8Array([73, 68, 51])));
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue(goodbye);

  const report = await generateForWords(db, singleDeckUrl, lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl));

  expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => init?.body))
    .toEqual(['{"text":"¡Chao! / Hasta luego / ¡Adiós!","model_id":"eleven_multilingual_v2"}']);
  expect(await db.select({ back: cards.back, audioFile: cards.audioFile, audioMp3: cards.audioMp3 }).from(cards))
    .toEqual([{
      back: '¡Chao! / Hasta luego / ¡Adiós!',
      audioFile: 'card-c7a314202176837303762eca31fe8d778b52284e425256b3b46283325ec48935.mp3',
      audioMp3: Buffer.from([73, 68, 51]),
    }]);
  expect(report).toEqual({ capReached: false, results: [
    { word: '¡Chao! / Hasta luego', status: 'updated', vocabCards: 0, conjugationCards: 0 },
  ] });
});

test('voice wiring keeps a CardAudioError card stored and reported and voices following cards', async () => {
  fetchImpl.mockImplementation(async () => new Response(new Uint8Array([73, 68, 51])));
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>().mockResolvedValue({
    ...regularVerb, conjugations: { present: { yo: '<b>hablo</b>' }, preterite: { yo: 'hablé' } },
  });

  const report = await generateForWords(db, 'hablar', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl));

  expect(fetchImpl.mock.calls.map(([, init]) => init?.body)).toEqual([
    '{"text":"hablar","model_id":"eleven_multilingual_v2"}',
    '{"text":"yo: hablé","model_id":"eleven_multilingual_v2"}',
  ]);
  expect(await db.select({ back: cards.back, audioMp3: cards.audioMp3 }).from(cards).orderBy(cards.id)).toEqual([
    { back: 'hablar', audioMp3: Buffer.from([73, 68, 51]) },
    { back: 'yo: <b>hablo</b>', audioMp3: null },
    { back: 'yo: hablé', audioMp3: Buffer.from([73, 68, 51]) },
  ]);
  expect(report).toEqual({ capReached: false, results: [
    { word: 'hablar', status: 'added', vocabCards: 1, conjugationCards: 2 },
  ] });
  expect(await db.select({ cardId: conjugationPatterns.cardId }).from(conjugationPatterns).orderBy(conjugationPatterns.id))
    .toEqual([{ cardId: 2 }, { cardId: 3 }]);
});

test.each([
  { failure: 'request', message: 'Voice request timed out after 1000 ms' },
  { failure: 'http', message: 'ElevenLabs request returned HTTP 429: Too many requests; check the response before retrying.' },
  { failure: 'body', message: 'MP3 response stream interrupted' },
  { failure: 'error body', message: 'ElevenLabs request returned HTTP 503; reading its body failed: Error response stream interrupted; inspect the response before retrying.' },
])('voice wiring reports a $failure failure, preserves committed cards and continues', async ({ failure, message }) => {
  fetchImpl.mockImplementation(async () => new Response(new Uint8Array([73, 68, 51])))
    .mockResolvedValueOnce(new Response(new Uint8Array([1])))
    .mockResolvedValueOnce(new Response(new Uint8Array([2])))
    .mockResolvedValueOnce(new Response(new Uint8Array([3])));
  if (failure === 'request') fetchImpl.mockRejectedValueOnce(new Error('Voice request timed out after 1000 ms'));
  if (failure === 'http') fetchImpl.mockResolvedValueOnce(new Response('Too many requests', { status: 429 }));
  if (failure === 'body') {
    const response = new Response();
    vi.spyOn(response, 'arrayBuffer').mockRejectedValueOnce(new Error('MP3 response stream interrupted'));
    fetchImpl.mockResolvedValueOnce(response);
  }
  if (failure === 'error body') {
    const response = new Response('', { status: 503 });
    vi.spyOn(response, 'text').mockRejectedValueOnce(new Error('Error response stream interrupted'));
    fetchImpl.mockResolvedValueOnce(response);
  }
  const lookup = vi.fn<(word: string) => Promise<WordInfo>>()
    .mockResolvedValueOnce(noun).mockResolvedValueOnce(regularVerb).mockResolvedValueOnce(goodbye);

  const report = await generateForWords(db, 'casa\nhablar\nadiós', lookup, fetchImpl, createSpanishVoice(loadConfig().audio, fetchImpl));

  expect(report).toEqual({ capReached: false, results: [
    { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
    { word: 'hablar', status: 'error', vocabCards: 0, conjugationCards: 0, message },
    { word: 'adiós', status: 'added', vocabCards: 1, conjugationCards: 0 },
  ] });
  expect(await db.select({ front: cards.front, audioMp3: cards.audioMp3 }).from(cards).orderBy(cards.id)).toEqual([
    { front: 'house', audioMp3: Buffer.from([1]) },
    { front: 'La ____ es grande.', audioMp3: Buffer.from([2]) },
    { front: 'goodbye', audioMp3: Buffer.from([73, 68, 51]) },
  ]);
  expect(await db.select().from(conjugationPatterns)).toEqual([]);
  expect(fetchImpl).toHaveBeenCalledTimes(5);
});

test.each([false, true])('voice wiring shows a single page notice only when capReached is %s', (capReached) => {
  const html = renderToStaticMarkup(pageWithResults([
    { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
  ], capReached));

  expect(html.includes('Audio cap reached for this run.')).toBe(capReached);
  expect(html.match(/<li\b[^>]*>.*?<\/li>/g)).toEqual([
    '<li class="bg-gray-100 p-3 rounded"><span aria-hidden="true" class="text-xs mr-2">✓</span><strong>casa</strong>: 2 vocab cards</li>',
  ]);
});

test.each([false, true])('voice wiring passes capReached %s through a successful router send', async (capReached) => {
  vi.resetModules();
  vi.doMock('@/server/db', () => ({ getDb: async () => db }));
  vi.doMock('@/lib/services/listGenerationService', () => ({
    generateForWords: vi.fn<typeof generateForWords>().mockImplementation(async (...args) => {
      if (capReached) await args[4].synthesize('a'.repeat(30001));
      return { capReached, results: [
        { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
      ] };
    }),
  }));
  vi.doMock('@/lib/services/ankiSender', () => ({
    sendPending: vi.fn().mockResolvedValue({ status: 'sent', sent: 2, rejected: 0, pending: 0, syncedAt: 123 }),
  }));
  try {
    const { ankiRouter } = await import('@/server/api/routers/lookupRouter');
    const caller = ankiRouter.createCaller({ headers: new Headers() });

    expect(await caller.generateFromList({ text: 'casa' })).toEqual({ capReached, results: [
      { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
    ], send: { status: 'sent', sent: 2, rejected: 0, pending: 0, syncedAt: 123 },
    backfill: { status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null } });
  } finally {
    vi.doUnmock('@/server/db');
    vi.doUnmock('@/lib/services/listGenerationService');
    vi.doUnmock('@/lib/services/ankiSender');
    vi.resetModules();
  }
});
