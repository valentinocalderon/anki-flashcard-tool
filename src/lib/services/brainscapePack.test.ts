import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { deckLinks, fetchPack, fetchPackEvents, fetchPackSet, fetchPackSetEvents, isPackSetUrl, isPackUrl, packSetLinks, spanishSides } from './brainscapePack';

const packId = '21648778';
const packUrl = `https://www.brainscape.com/packs/${packId}`;
const packSetUrl = 'https://www.brainscape.com/p/5M6OW-LH-D10NR';
const pack = readFileSync(new URL('./__fixtures__/brainscape/pack.html', import.meta.url), 'utf8');
const packSet = readFileSync(new URL('./__fixtures__/brainscape/packset.html', import.meta.url), 'utf8');
const greetings = readFileSync(new URL('./__fixtures__/brainscape/deck-common-greetings.html', import.meta.url), 'utf8');
const nouns = readFileSync(new URL('./__fixtures__/brainscape/deck-nouns-articles.html', import.meta.url), 'utf8');
const links = [
  '/flashcards/011-common-greetings-14150191/packs/21648778',
  '/flashcards/012-nouns-articles-14150195/packs/21648778',
  '/flashcards/013-adjectives-14150196/packs/21648778',
  '/flashcards/021-basic-conversation-14150198/packs/21648778',
  '/flashcards/022-pronouns-origins-14150199/packs/21648778',
  '/flashcards/023-family-friends-14150203/packs/21648778',
  '/flashcards/031-numbers-money-14150204/packs/21648778',
  '/flashcards/032-days-14150207/packs/21648778',
  '/flashcards/033-time-14150209/packs/21648778',
  '/flashcards/034-food-drinks-14150212/packs/21648778',
  '/flashcards/035-getting-around-14150217/packs/21648778',
  '/flashcards/041-pronunciation-gotchas-14150221/packs/21648778',
];
const setLinks = [
  '/flashcards/38-vocabulary-level-2-part-1-level-2-bas-15113057/packs/21882519',
  '/flashcards/39-verbs-level-2-part-1-level-2-basic-15113060/packs/21882519',
  '/flashcards/40-the-numbers-level-2-basic-15113061/packs/21882519',
  '/flashcards/42-the-time-level-2-basic-15113064/packs/21882519',
  '/flashcards/44-possessives-1-level-2-basic-15113066/packs/21882519',
  '/flashcards/46-expressing-possession-with-de-level-2-15113068/packs/21882519',
  '/flashcards/48-to-have-to-have-to-level-2-basic-15113070/packs/21882519',
  '/flashcards/50-can-can-t-level-2-basic-15113073/packs/21882519',
  '/flashcards/52-vocabulary-level-2-part-2-level-2-bas-15113074/packs/21882519',
  '/flashcards/53-verbs-level-2-part-2-level-2-basic-15113078/packs/21882519',
  '/flashcards/54-demonstratives-level-2-basic-15113079/packs/21882519',
  '/flashcards/56-to-want-to-prefer-to-need-level-2-bas-15113081/packs/21882519',
  '/flashcards/58-i-like-i-love-i-m-interested-in-level-15113082/packs/21882519',
  '/flashcards/60-vocabulary-level-2-basic-part-3-level-15113083/packs/21882519',
  '/flashcards/61-be-going-to-level-2-basic-15113084/packs/21882519',
  '/flashcards/63-window-words-2-level-2-basic-15113086/packs/21882519',
];

const greetingSides = [
  '¡Hola!',
  '¡Adiós! / ¡Chao!',
  '¡Buenos días!',
  '¡Buenas tardes!',
  '¡Buenas!',
  '¿Hablas inglés?',
  'Hablo inglés.',
  'No hablo español.',
  'Man: ¡Gracias! Woman: ¡De nada!',
  '¡Buenas noches!',
  'Woman: ¿Habla inglés? Man: Sí.',
  'Hola, me llamo Sam.',
  '¿Cómo te llamas?',
  'Man: ¿Habla español? Woman: Un poco.',
  '¡Mucho gusto!',
  'Igualmente. / Igual.',
  'Hombre: ¿Cómo te llamas? Mujer: Me llamo Jenny. Mucho gusto. Hombre: ¡Igual!',
];
const nounSides = [
  'una mujer',
  'un hombre',
  'la mujer',
  'el hombre',
  'un muchacho / un chico',
  'la muchacha / la chica',
  'un niño',
  'una niña',
  'los niños',
  'las niñas',
  'unos hombres',
  'unas mujeres',
  'un chico y una chica',
  'los hombres y las mujeres',
  'una alumna / una estudiante',
  'un profesor / un maestro',
  'una profesora',
  'la casa',
  'el dinero',
  'los carros / los coches',
];

function answerHtml(face: string) {
  return `<div id='card-back-123' class='answer-contents extra flashcard-contents'>
    <div class='preview-html'><div class='scf-face'>${face}</div></div>
  </div>`;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('Unexpected global fetch; tests must use saved fixtures.');
  }));
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const eventSources = [
  { name: 'fetchPackEvents', stream: fetchPackEvents, url: packUrl, html: pack, expectedLinks: links },
  { name: 'fetchPackSetEvents', stream: fetchPackSetEvents, url: packSetUrl, html: packSet, expectedLinks: setLinks },
];

test.each(eventSources)('$name yields the saved links first and each deck as its body lands in page order', async ({ stream, url, html, expectedLinks }) => {
  let finishPageBody: (html: string) => void = () => { throw new Error('Page body was not requested'); };
  let finishDeckBody: (html: string) => void = () => { throw new Error('Deck body was not requested'); };
  const pageResponse = new Response();
  const deckResponse = new Response();
  vi.spyOn(pageResponse, 'text').mockImplementation(() => new Promise<string>((resolve) => { finishPageBody = resolve; }));
  vi.spyOn(deckResponse, 'text').mockImplementation(() => new Promise<string>((resolve) => { finishDeckBody = resolve; }));
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(pageResponse)
    .mockResolvedValueOnce(deckResponse);
  for (let index = 1; index < expectedLinks.length; index += 1) fetchImpl.mockResolvedValueOnce(new Response(nouns));

  const events = stream(url, fetchImpl);
  const first = events.next();
  await vi.advanceTimersByTimeAsync(5000);
  expect(fetchImpl).toHaveBeenCalledOnce();
  finishPageBody(html);
  expect(await first).toEqual({ done: false, value: { links: expectedLinks } });
  expect(fetchImpl).toHaveBeenCalledOnce();
  for (const [index, link] of expectedLinks.entries()) {
    const next = events.next();
    let landed = false;
    void next.then(() => { landed = true; }, () => { landed = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchImpl).toHaveBeenCalledTimes(index + 1);
    expect(landed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(index + 2);
    if (index === 0) {
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(landed).toBe(false);
      finishDeckBody(greetings);
    }
    expect(await next).toEqual({ done: false, value: { link, sides: index === 0 ? greetingSides : nounSides } });
    expect(fetchImpl).toHaveBeenLastCalledWith(`https://www.brainscape.com${link}`, expect.any(Object));
  }
  expect(await events.next()).toEqual({ done: true, value: undefined });
  for (const [, options] of fetchImpl.mock.calls) {
    expect(new Headers(options?.headers).get('User-Agent')).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    );
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  }
  expect(timeout).toHaveBeenCalledTimes(expectedLinks.length + 1);
  for (const call of timeout.mock.calls) expect(call).toEqual([15000]);
  expect(vi.getTimerCount()).toBe(0);
});

test('fetchPackEvents reuses the initial deck body and yields its sides before any delay or second fetch', async () => {
  const url = 'https://www.brainscape.com/flashcards/011-common-greetings-14150191/packs/21648778';
  const response = new Response(greetings);
  const readBody = vi.spyOn(response, 'text');
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
  for (let index = 1; index < links.length; index += 1) fetchImpl.mockResolvedValueOnce(new Response(nouns));

  const events = fetchPackEvents(url, fetchImpl);
  expect(await events.next()).toEqual({ done: false, value: { links } });
  expect(await events.next()).toEqual({ done: false, value: { link: links[0], sides: greetingSides } });
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(readBody).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  for (const [index, link] of links.slice(1).entries()) {
    const next = events.next();
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchImpl).toHaveBeenCalledTimes(index + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await next).toEqual({ done: false, value: { link, sides: nounSides } });
    expect(fetchImpl).toHaveBeenCalledTimes(index + 2);
    expect(fetchImpl).toHaveBeenLastCalledWith(`https://www.brainscape.com${link}`, expect.any(Object));
  }
  expect(await events.next()).toEqual({ done: true, value: undefined });
  expect(readBody).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(eventSources)('$name preserves discovery failures without yielding a links event', async ({ stream, url }) => {
  const requestError = new Error('connect ETIMEDOUT');
  const bodyError = new Error('Response body stream terminated');
  const brokenBody = new Response();
  vi.spyOn(brokenBody, 'text').mockRejectedValueOnce(bodyError);
  const failures = [
    { response: new Response('Request denied', { status: 403, statusText: 'Forbidden' }), error: new Error(`Brainscape request for ${url} returned HTTP 403 Forbidden; check the response and retry.`) },
    { response: undefined, error: requestError },
    { response: brokenBody, error: bodyError },
    {
      response: new Response('<html>No preview available</html>'),
      error: new Error(url === packUrl
        ? 'Brainscape page https://www.brainscape.com/packs/21648778 contained 0 deck links for pack 21648778; check the page HTML.'
        : 'Brainscape page has no canonical link href; check the page HTML.'),
    },
  ];
  for (const { response, error } of failures) {
    const fetchImpl = vi.fn<typeof fetch>();
    if (response) fetchImpl.mockResolvedValueOnce(response);
    else fetchImpl.mockRejectedValueOnce(error);
    const events = stream(url, fetchImpl);

    await expect(events.next()).rejects.toThrow(error);
    expect(await events.next()).toEqual({ done: true, value: undefined });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  }
});

test('fetchPackEvents preserves the missing pack id error before fetching', async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const events = fetchPackEvents('https://www.brainscape.com/learn/spanish', fetchImpl);

  await expect(events.next()).rejects.toThrow(new Error(
    'Brainscape URL https://www.brainscape.com/learn/spanish has no /packs/DIGITS path; use a public pack URL.',
  ));
  expect(fetchImpl).not.toHaveBeenCalled();
});

test.each(eventSources)('$name keeps the landed deck event and throws the observed error from the next deck', async ({ stream, url, html, expectedLinks }) => {
  const deckUrl = `https://www.brainscape.com${expectedLinks[1]}`;
  const requestError = new Error('connect ETIMEDOUT');
  const bodyError = new Error('Response body stream terminated');
  const brokenBody = new Response();
  vi.spyOn(brokenBody, 'text').mockRejectedValueOnce(bodyError);
  const failures = [
    { response: new Response('Request denied', { status: 403, statusText: 'Forbidden' }), error: new Error(`Brainscape request for ${deckUrl} returned HTTP 403 Forbidden; check the response and retry.`) },
    { response: undefined, error: requestError },
    { response: brokenBody, error: bodyError },
    { response: new Response('<html>No preview available</html>'), error: new Error(`Brainscape deck ${deckUrl} contained 0 Spanish sides; check the page HTML.`) },
    { response: new Response(answerHtml('<p> </p>')), error: new Error('Card card-back-123 has no Spanish text; check the Brainscape HTML.') },
  ];
  for (const { response, error } of failures) {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(html))
      .mockResolvedValueOnce(new Response(greetings));
    if (response) fetchImpl.mockResolvedValueOnce(response);
    else fetchImpl.mockRejectedValueOnce(error);
    const events = stream(url, fetchImpl);
    expect(await events.next()).toEqual({ done: false, value: { links: expectedLinks } });
    const firstDeck = events.next();
    await vi.advanceTimersByTimeAsync(1000);
    const landed = await firstDeck;
    expect(landed).toEqual({ done: false, value: { link: expectedLinks[0], sides: greetingSides } });

    const next = events.next();
    const assertion = expect(next).rejects.toThrow(error);
    await vi.runAllTimersAsync();
    await assertion;
    if (error === requestError || error === bodyError) await expect(next).rejects.toBe(error);
    expect(await events.next()).toEqual({ done: true, value: undefined });
    expect(landed).toEqual({ done: false, value: { link: expectedLinks[0], sides: greetingSides } });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  }
});

test.each(eventSources)('$name preserves the fifteen second request and body timeouts at discovery and after a landed deck', async ({ stream, url, html, expectedLinks }) => {
  const timeoutReason = new DOMException('The operation timed out', 'TimeoutError');
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(timeoutReason), delay);
    return controller.signal;
  });
  for (const page of ['discovery', 'deck']) {
    for (const failure of ['request', 'body']) {
      const cause = failure === 'request' ? timeoutReason : new DOMException('The operation was aborted', 'AbortError');
      const fetchImpl = vi.fn<typeof fetch>();
      if (page === 'deck') {
        fetchImpl.mockResolvedValueOnce(new Response(html));
        fetchImpl.mockResolvedValueOnce(new Response(greetings));
      }
      fetchImpl.mockImplementationOnce((_url, options) => {
        const signal = options?.signal;
        if (!signal) return Promise.reject(new Error('Request has no abort signal'));
        const stalled = new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(cause), { once: true });
        });
        if (failure === 'request') return stalled;
        const response = new Response();
        vi.spyOn(response, 'text').mockReturnValueOnce(stalled);
        return Promise.resolve(response);
      });
      const events = stream(url, fetchImpl);
      if (page === 'deck') {
        expect(await events.next()).toEqual({ done: false, value: { links: expectedLinks } });
        const firstDeck = events.next();
        await vi.advanceTimersByTimeAsync(1000);
        expect(await firstDeck).toEqual({ done: false, value: { link: expectedLinks[0], sides: greetingSides } });
      }
      const next = events.next();
      let settled = false;
      void next.then(() => { settled = true; }, () => { settled = true; });
      await vi.advanceTimersByTimeAsync(page === 'discovery' ? 0 : 1000);
      expect(timeout).toHaveBeenLastCalledWith(15000);
      await vi.advanceTimersByTimeAsync(14999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const failedUrl = page === 'discovery' ? url : `https://www.brainscape.com${expectedLinks[1]}`;
      await expect(next).rejects.toThrow(new Error(`Brainscape request for ${failedUrl} did not answer in time`));
      await expect(next).rejects.toHaveProperty('cause', cause);
      expect(await events.next()).toEqual({ done: true, value: undefined });
      expect(fetchImpl).toHaveBeenCalledTimes(page === 'discovery' ? 1 : 3);
      expect(vi.getTimerCount()).toBe(0);
    }
  }
});

test('distinguishes pack-set URLs from pack URLs and word lists', () => {
  const cases = [
    { text: 'https://www.brainscape.com/p/5M6OW-LH-D10NR', packSet: true, pack: false },
    { text: 'https://www.brainscape.com/packs/21648778', packSet: false, pack: true },
    { text: 'hola\nadiós', packSet: false, pack: false },
    { text: 'https://example.com/p/5M6OW-LH-D10NR', packSet: false, pack: false },
    { text: '/p/5M6OW-LH-D10NR', packSet: false, pack: false },
  ];

  for (const { text, packSet, pack } of cases) {
    expect(isPackSetUrl(text), text).toBe(packSet);
    expect(isPackUrl(text), text).toBe(pack);
  }
});

test('recognizes one whole Brainscape pack-set URL with the allowed origin and path', () => {
  for (const text of [
    ' \n\thttps://brainscape.com/p/5M6OW-LH-D10NR\t ',
    'http://BRAINSCAPE.com/p/abc123/',
    'https://learn.brainscape.com/p/abc-123?source=share#cards',
  ]) {
    expect(isPackSetUrl(text), text).toBe(true);
    expect(isPackUrl(text), text).toBe(false);
  }
});

test('rejects contents without one valid Brainscape pack-set URL', () => {
  for (const text of [
    '', 'casa', 'not a URL', 'https://[',
    'https://www.brainscape.com/p/abc\ncasa',
    'https://www.brainscape.com/p/abc https://www.brainscape.com/p/def',
    'https://www.brainscape.com/p/ab\nc',
    'https://www.brainscape.com/p/abc?source=two words',
    'ftp://www.brainscape.com/p/abc',
    'https://notbrainscape.com/p/abc',
    'https://brainscape.com.example.com/p/abc',
    'https://brainscape.com@other.example/p/abc',
    'https://www.brainscape.com/learn/spanish',
    'https://www.brainscape.com/nested/p/abc',
    'https://www.brainscape.com/P/abc',
    'https://www.brainscape.com/p/abc//',
    'https://www.brainscape.com/p/abc/decks',
    'https://www.brainscape.com/p/abc_def',
    'https://www.brainscape.com/p/abc.def',
    'https://www.brainscape.com/p/',
    'https://www.brainscape.com/p/ábc',
    'https://www.brainscape.com/p/４２',
    '/packs/21648778',
  ]) {
    expect(isPackSetUrl(text), text).toBe(false);
    expect(isPackUrl(text), text).toBe(false);
  }
});

test.each([
  'https://www.brainscape.com/packs/21648778',
  'https://www.brainscape.com/packs/42/',
  ' \n\thttps://brainscape.com/packs/42\t ',
  'http://BRAINSCAPE.com/packs/42',
  'https://learn.brainscape.com/flashcards/greetings/packs/42?source=share#cards',
])('recognizes one whole Brainscape pack URL: %s', (text) => {
  expect(isPackUrl(text)).toBe(true);
});

test.each([
  '', 'casa', 'not a URL',
  'https://www.brainscape.com/packs/42\ncasa',
  'https://www.brainscape.com/packs/42 https://www.brainscape.com/packs/43',
  'https://www.brainscape.com/pa\ncks/42',
  'https://www.brainscape.com/packs/42?source=two words',
  'ftp://www.brainscape.com/packs/42',
  'https://notbrainscape.com/packs/42',
  'https://brainscape.com.example.com/packs/42',
  'https://brainscape.com@other.example/packs/42',
  'https://www.brainscape.com/learn/spanish',
  'https://www.brainscape.com/packs/42//',
  'https://www.brainscape.com/packs/42/decks',
  'https://www.brainscape.com/packs/42abc',
  'https://www.brainscape.com/packs/',
  'https://www.brainscape.com/packs/４２',
  '/packs/42',
])('keeps other textarea contents in word-list mode: %s', (text) => {
  expect(isPackUrl(text)).toBe(false);
});

test.each([
  { name: 'pack', html: pack },
  { name: 'greetings deck', html: greetings },
  { name: 'nouns deck', html: nouns },
])('extracts the twelve deck hrefs in page order from the $name fixture', ({ html }) => {
  expect(deckLinks(html, packId)).toHaveLength(12);
  expect(deckLinks(html, packId)).toEqual(links);
});

test('dedupes hrefs, matches the whole pack id, and ignores non-href text', () => {
  const html = `<a href='/flashcards/z/packs/42'>z</a>
    <a href="/flashcards/a/packs/42">a</a>
    <a href='/flashcards/z/packs/42'>z again</a>
    <a href='/flashcards/other/packs/420'>other pack</a>
    <a href='/flashcards/query/packs/42?x=1'>query</a>
    <a data-href='/flashcards/data/packs/42'>data</a>
    <div>/flashcards/text/packs/42</div>`;

  expect(deckLinks(html, '42')).toEqual(['/flashcards/z/packs/42', '/flashcards/a/packs/42']);
  expect(deckLinks(html, '4.')).toEqual([]);
  expect(deckLinks('', packId)).toEqual([]);
  expect(deckLinks(pack, '999')).toEqual([]);
});

test('extracts exactly sixteen pack-set links in page order from the saved fixture', () => {
  expect(packSetLinks(packSet)).toEqual([
    '/flashcards/38-vocabulary-level-2-part-1-level-2-bas-15113057/packs/21882519',
    '/flashcards/39-verbs-level-2-part-1-level-2-basic-15113060/packs/21882519',
    '/flashcards/40-the-numbers-level-2-basic-15113061/packs/21882519',
    '/flashcards/42-the-time-level-2-basic-15113064/packs/21882519',
    '/flashcards/44-possessives-1-level-2-basic-15113066/packs/21882519',
    '/flashcards/46-expressing-possession-with-de-level-2-15113068/packs/21882519',
    '/flashcards/48-to-have-to-have-to-level-2-basic-15113070/packs/21882519',
    '/flashcards/50-can-can-t-level-2-basic-15113073/packs/21882519',
    '/flashcards/52-vocabulary-level-2-part-2-level-2-bas-15113074/packs/21882519',
    '/flashcards/53-verbs-level-2-part-2-level-2-basic-15113078/packs/21882519',
    '/flashcards/54-demonstratives-level-2-basic-15113079/packs/21882519',
    '/flashcards/56-to-want-to-prefer-to-need-level-2-bas-15113081/packs/21882519',
    '/flashcards/58-i-like-i-love-i-m-interested-in-level-15113082/packs/21882519',
    '/flashcards/60-vocabulary-level-2-basic-part-3-level-15113083/packs/21882519',
    '/flashcards/61-be-going-to-level-2-basic-15113084/packs/21882519',
    '/flashcards/63-window-words-2-level-2-basic-15113086/packs/21882519',
  ]);
});

test.each(['https://www.brainscape.com/packs/42', '/packs/level-2-42'])(
  'keeps pack-set deck order, deduplication and pack filtering for canonical %s', (href) => {
    const html = `<link rel='alternate' href='/packs/420'>
      <link href="${href}" rel="canonical">
      <a href='/flashcards/other/packs/420'>other pack</a>
      <a href='/flashcards/z/packs/42'>z</a>
      <a href='/flashcards/a/packs/42'>a</a>
      <a href='/flashcards/z/packs/42'>z again</a>
      <a href='/flashcards/query/packs/42?x=1'>query</a>
      <a data-href='/flashcards/data/packs/42'>data</a>
      <div>/flashcards/text/packs/42</div>`;

    expect(packSetLinks(html)).toEqual(['/flashcards/z/packs/42', '/flashcards/a/packs/42']);
  },
);

test.each([
  "<link rel='alternate' href='/packs/42'><a rel='canonical' href='/packs/42'>pack</a>",
  "<link rel='canonical'>",
])('reports a missing pack-set canonical link href without guessing from deck links: %s', (html) => {
  expect(() => packSetLinks(html + "<a href='/flashcards/z/packs/42'>z</a>"))
    .toThrow(new Error('Brainscape page has no canonical link href; check the page HTML.'));
});

test('reports an invalid pack-set canonical href', () => {
  expect(() => packSetLinks('<link rel="canonical" href="https://[">'))
    .toThrow(new Error('Brainscape canonical href https://[ is not a valid URL; check the page HTML.'));
});

test.each(['/learn/spanish', '/flashcards/lesson/packs/42', '/packs/lesson42'])(
  'reports a pack-set canonical path without a pack id: %s', (href) => {
    expect(() => packSetLinks(`<link rel='canonical' href='${href}'>`))
      .toThrow(new Error(`Brainscape canonical URL ${href} has no /packs/SLUG-DIGITS or /packs/DIGITS path; check the page HTML.`));
  },
);

test('reports zero pack-set deck links for the canonical pack even when another pack has links', () => {
  const html = `<link rel='canonical' href='https://www.brainscape.com/packs/42'>
    <a href='/flashcards/other/packs/420'>other pack</a>`;

  expect(() => packSetLinks(html))
    .toThrow(new Error('Brainscape page https://www.brainscape.com/packs/42 contained 0 deck links for pack 42; check the page HTML.'));
});

test('extracts every answer without footnotes from the common greetings fixture in page order', () => {
  expect(spanishSides(greetings)).toEqual(greetingSides);
});

test('extracts every answer from the nouns and articles fixture, without footnotes, CSS or question text', () => {
  const sides = spanishSides(nouns);

  expect(sides).toEqual(nounSides);
  for (const side of sides) {
    expect(side.length).toBeGreaterThan(0);
    expect(side).not.toMatch(/[<>]/);
    expect(side).not.toMatch(/&(?:#\w+|[a-z]+);/i);
    expect(side).not.toContain('Translate to Spanish:');
    expect(side).not.toContain('Study These Flashcards');
  }
});

test('drops whole footnote divs by class token, including nested contents, before filtering paragraphs', () => {
  const face = `<div><p>antes</p><div class='extra scf-footnote more'>
    <p class='scf-prompt'>Translate this:</p><div><p>English explanation</p></div>More English
    </div><p>entre</p></div><div class="scf-footnote"><p>Translation</p></div>
    <p class='scf-prompt'>Translate this too:</p><p>después</p>
    <div class='scf-footnote-extra'><p>otra vez</p></div>`;

  expect(spanishSides(answerHtml(face))).toEqual(['antes entre después otra vez']);
});

test.each([
  "<p class='scf-prompt'>Translate this:</p><div class='scf-footnote'><p>English explanation</p></div>",
  '<p> \n\t&nbsp;&#32;&#xA0; </p>',
])('reports the card id when the extracted Spanish side is blank: %s', (face) => {
  expect(() => spanishSides(answerHtml(face)))
    .toThrow(new Error('Card card-back-123 has no Spanish text; check the Brainscape HTML.'));
});

test('separates paragraphs and line breaks without splitting inline words', () => {
  expect(spanishSides(answerHtml('<p>ho<strong>la</strong><br>mundo</p><div><p>otra</p><p>vez</p></div>')))
    .toEqual(['hola mundo otra vez']);
});

test.each(['figure', 'figcaption', 'table', 'tr', 'td', 'th', 'section'])(
  'separates text on both sides of %s tags', (tag) => {
    expect(spanishSides(answerHtml(`antes<${tag} class='extra'>dentro</${tag}>después`)))
      .toEqual(['antes dentro después']);
  },
);

test('reports an unknown named entity and tells the reader how to add it', () => {
  expect(() => spanishSides(answerHtml('<p>Temperatura: 20&deg;C</p>')))
    .toThrow(new Error('Unknown HTML entity "&deg;"; add deg to namedEntities.'));
});

test('drops prompt paragraphs, decodes entities once, and preserves duplicate cards in page order', () => {
  const answer = answerHtml(`<p class='extra scf-prompt'>Translate <b>this</b>:</p>
    <p> &iexcl;Hola!&nbsp;&iquest;Qu&eacute;? &#161;S&#xED;! &ntilde; &uuml;
    &quot;uno&quot; &apos;dos&#39; &amp; &ldquo;tres&rdquo;&hellip; &ndash; &mdash;
    &lt;texto&gt; &amp;lt; </p>`);

  expect(spanishSides(answer + answer)).toEqual([
    '¡Hola! ¿Qué? ¡Sí! ñ ü "uno" \'dos\' & “tres”… – — <texto> &lt;',
    '¡Hola! ¿Qué? ¡Sí! ñ ü "uno" \'dos\' & “tres”… – — <texto> &lt;',
  ]);
});

test('ignores stylesheet text, question sides, and divs without the required id and classes', () => {
  const html = `<style>.flashcard-contents.answer-contents { color: red; }</style>
    <div class='flashcard-contents question-contents'><div class='preview-html'><div class='scf-face'>English</div></div></div>
    <div class='flashcard-contents answer-contents'><div class='preview-html'><div class='scf-face'>No id</div></div></div>
    <div id='card-back-1' class='answer-contents'><div class='preview-html'><div class='scf-face'>Missing class</div></div></div>
    <div id='card-back-x' class='flashcard-contents answer-contents'>Bad id</div>`;

  expect(spanishSides(html + answerHtml('<p>¡Hola!</p>'))).toEqual(['¡Hola!']);
  expect(spanishSides(pack)).toEqual([]);
  expect(spanishSides('')).toEqual([]);
});

test.each([
  { html: "<div id='card-back-123' class='flashcard-contents answer-contents'></div>", message: 'Card card-back-123 has no preview-html div' },
  { html: "<div id='card-back-123' class='flashcard-contents answer-contents'><div class='preview-html'></div></div>", message: 'Card card-back-123 has no scf-face div' },
  { html: "<div id='card-back-123' class='flashcard-contents answer-contents'><div>", message: 'Unclosed div' },
])('reports missing card markup: $message', ({ html, message }) => {
  expect(() => spanishSides(html)).toThrow(message);
});

test('fetches the saved pack and each deck sequentially, with a Chrome user agent and a full second after each body', async () => {
  let finishBody: (html: string) => void = () => { throw new Error('Response body was not requested'); };
  const firstResponse = new Response();
  vi.spyOn(firstResponse, 'text').mockImplementation(() => new Promise<string>((resolve) => { finishBody = resolve; }));
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(firstResponse);
  for (const [index] of links.entries()) {
    fetchImpl.mockResolvedValueOnce(new Response(index === 0 ? greetings : nouns));
  }

  const result = fetchPack(packUrl, fetchImpl);
  await vi.advanceTimersByTimeAsync(5000);
  expect(fetchImpl).toHaveBeenCalledOnce();
  finishBody(pack);
  await vi.advanceTimersByTimeAsync(0);
  for (const [index] of links.entries()) {
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchImpl).toHaveBeenCalledTimes(index + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(index + 2);
  }

  expect(await result).toEqual(links.flatMap((_, index) => index === 0 ? greetingSides : nounSides));
  expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([packUrl, ...links.map((link) => new URL(link, packUrl).href)]);
  for (const [, options] of fetchImpl.mock.calls) {
    const agent = new Headers(options?.headers).get('User-Agent');
    expect(agent).toMatch(/Mozilla\/5\.0 .*AppleWebKit\/537\.36 .*Chrome\/\d+.*Safari\/537\.36/);
    expect(agent).not.toContain('Mobile');
  }
  expect(vi.getTimerCount()).toBe(0);
});

test('reuses the initial deck HTML when the supplied pack URL is a deck URL', async () => {
  const url = new URL(links[0]!, packUrl).href;
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(greetings));
  for (let index = 1; index < links.length; index += 1) fetchImpl.mockResolvedValueOnce(new Response(nouns));

  const result = fetchPack(url, fetchImpl);
  await vi.runAllTimersAsync();

  expect(await result).toEqual(links.flatMap((_, index) => index === 0 ? greetingSides : nounSides));
  expect(fetchImpl.mock.calls.map(([requested]) => requested)).toEqual(links.map((link) => new URL(link, packUrl).href));
});

test.each(['not a URL', 'https://www.brainscape.com/learn/spanish'])(
  'rejects a URL without a usable pack id before fetching: %s', async (url) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(fetchPack(url, fetchImpl)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  },
);

test.each(['pack', 'deck'])(
  'reports the observed HTTP status from a failed %s request and stops', async (page) => {
    const fetchImpl = vi.fn<typeof fetch>();
    if (page === 'deck') fetchImpl.mockResolvedValueOnce(new Response(pack));
    fetchImpl.mockResolvedValueOnce(new Response('Request denied', { status: 403, statusText: 'Forbidden' }));
    const url = page === 'pack' ? packUrl : new URL(links[0]!, packUrl).href;

    const assertion = expect(fetchPack(packUrl, fetchImpl)).rejects.toThrow(`Brainscape request for ${url} returned HTTP 403 Forbidden`);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchImpl).toHaveBeenCalledTimes(page === 'pack' ? 1 : 2);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test.each([
  { page: 'pack', failure: 'request' }, { page: 'deck', failure: 'request' },
  { page: 'pack', failure: 'body' }, { page: 'deck', failure: 'body' },
])('times out a stalled $page $failure after fifteen seconds and names its URL', async ({ page, failure }) => {
  const timeoutReason = new DOMException('The operation timed out', 'TimeoutError');
  const cause = failure === 'request' ? timeoutReason : new DOMException('The operation was aborted', 'AbortError');
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(timeoutReason), delay);
    return controller.signal;
  });
  const fetchImpl = vi.fn<typeof fetch>();
  if (page === 'deck') fetchImpl.mockResolvedValueOnce(new Response(pack));
  fetchImpl.mockImplementationOnce((_url, options) => {
    const signal = options?.signal;
    if (!signal) return Promise.reject(new Error('Request has no abort signal'));
    const stalled = new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(cause), { once: true });
    });
    if (failure === 'request') return stalled;
    const response = new Response();
    vi.spyOn(response, 'text').mockReturnValueOnce(stalled);
    return Promise.resolve(response);
  });
  const url = page === 'pack' ? packUrl : new URL(links[0]!, packUrl).href;
  const result = fetchPack(packUrl, fetchImpl);
  let settled = false;
  void result.then(() => { settled = true; }, () => { settled = true; });

  await vi.advanceTimersByTimeAsync(page === 'pack' ? 0 : 1000);
  expect(timeout).toHaveBeenLastCalledWith(15000);
  const signal = fetchImpl.mock.calls.at(-1)?.[1]?.signal;
  expect(signal).toBeInstanceOf(AbortSignal);
  await vi.advanceTimersByTimeAsync(14999);
  expect(signal?.aborted).toBe(false);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);

  expect(signal?.aborted).toBe(true);
  await expect(result).rejects.toThrow(new Error(`Brainscape request for ${url} did not answer in time`));
  await expect(result).rejects.toHaveProperty('cause', cause);
  expect(fetchImpl).toHaveBeenCalledTimes(page === 'pack' ? 1 : 2);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([
  { page: 'pack', failure: 'request' }, { page: 'deck', failure: 'request' },
  { page: 'pack', failure: 'body' }, { page: 'deck', failure: 'body' },
])('preserves a $page $failure error and stops without returning partial results', async ({ page, failure }) => {
  const error = new Error(failure === 'request' ? 'connect ETIMEDOUT' : 'Response body stream terminated');
  const fetchImpl = vi.fn<typeof fetch>();
  if (page === 'deck') {
    fetchImpl.mockResolvedValueOnce(new Response(pack));
    fetchImpl.mockResolvedValueOnce(new Response(greetings));
  }
  if (failure === 'request') fetchImpl.mockRejectedValueOnce(error);
  else {
    const response = new Response();
    vi.spyOn(response, 'text').mockRejectedValueOnce(error);
    fetchImpl.mockResolvedValueOnce(response);
  }

  const assertion = expect(fetchPack(packUrl, fetchImpl)).rejects.toBe(error);
  await vi.runAllTimersAsync();
  await assertion;
  expect(fetchImpl).toHaveBeenCalledTimes(page === 'pack' ? 1 : 3);
  expect(vi.getTimerCount()).toBe(0);
});

test.each(['pack', 'deck'])(
  'reports zero parsed items on an empty %s page instead of returning success', async (page) => {
    const fetchImpl = vi.fn<typeof fetch>();
    if (page === 'deck') fetchImpl.mockResolvedValueOnce(new Response(pack));
    fetchImpl.mockResolvedValueOnce(new Response('<html><body>No preview available</body></html>'));
    const message = page === 'pack'
      ? `Brainscape page ${packUrl} contained 0 deck links for pack ${packId}`
      : `Brainscape deck ${new URL(links[0]!, packUrl).href} contained 0 Spanish sides`;

    const assertion = expect(fetchPack(packUrl, fetchImpl)).rejects.toThrow(message);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchImpl).toHaveBeenCalledTimes(page === 'pack' ? 1 : 2);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test('rejects a blank Spanish side after a valid deck instead of returning partial results', async () => {
  const blank = answerHtml("<p class='scf-prompt'>Translate this:</p><div class='scf-footnote'><p>English explanation</p></div>");
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(pack))
    .mockResolvedValueOnce(new Response(greetings))
    .mockResolvedValueOnce(new Response(blank))
    .mockRejectedValue(new Error('Unexpected later deck fetch'));

  const assertion = expect(fetchPack(packUrl, fetchImpl)).rejects
    .toThrow(new Error('Card card-back-123 has no Spanish text; check the Brainscape HTML.'));
  await Promise.all([assertion, vi.runAllTimersAsync()]);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});

test('fetchPackSet reads the saved set and all sixteen decks in order with a Chrome user agent and a full second after each body', async () => {
  const expectedUrls = [
    packSetUrl,
    'https://www.brainscape.com/flashcards/38-vocabulary-level-2-part-1-level-2-bas-15113057/packs/21882519',
    'https://www.brainscape.com/flashcards/39-verbs-level-2-part-1-level-2-basic-15113060/packs/21882519',
    'https://www.brainscape.com/flashcards/40-the-numbers-level-2-basic-15113061/packs/21882519',
    'https://www.brainscape.com/flashcards/42-the-time-level-2-basic-15113064/packs/21882519',
    'https://www.brainscape.com/flashcards/44-possessives-1-level-2-basic-15113066/packs/21882519',
    'https://www.brainscape.com/flashcards/46-expressing-possession-with-de-level-2-15113068/packs/21882519',
    'https://www.brainscape.com/flashcards/48-to-have-to-have-to-level-2-basic-15113070/packs/21882519',
    'https://www.brainscape.com/flashcards/50-can-can-t-level-2-basic-15113073/packs/21882519',
    'https://www.brainscape.com/flashcards/52-vocabulary-level-2-part-2-level-2-bas-15113074/packs/21882519',
    'https://www.brainscape.com/flashcards/53-verbs-level-2-part-2-level-2-basic-15113078/packs/21882519',
    'https://www.brainscape.com/flashcards/54-demonstratives-level-2-basic-15113079/packs/21882519',
    'https://www.brainscape.com/flashcards/56-to-want-to-prefer-to-need-level-2-bas-15113081/packs/21882519',
    'https://www.brainscape.com/flashcards/58-i-like-i-love-i-m-interested-in-level-15113082/packs/21882519',
    'https://www.brainscape.com/flashcards/60-vocabulary-level-2-basic-part-3-level-15113083/packs/21882519',
    'https://www.brainscape.com/flashcards/61-be-going-to-level-2-basic-15113084/packs/21882519',
    'https://www.brainscape.com/flashcards/63-window-words-2-level-2-basic-15113086/packs/21882519',
  ];
  let finishSetBody: (html: string) => void = () => { throw new Error('Pack-set body was not requested'); };
  let finishDeckBody: (html: string) => void = () => { throw new Error('Deck body was not requested'); };
  const setResponse = new Response();
  const deckResponse = new Response();
  vi.spyOn(setResponse, 'text').mockImplementation(() => new Promise<string>((resolve) => { finishSetBody = resolve; }));
  vi.spyOn(deckResponse, 'text').mockImplementation(() => new Promise<string>((resolve) => { finishDeckBody = resolve; }));
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(setResponse)
    .mockResolvedValueOnce(deckResponse);
  for (let index = 1; index < 16; index += 1) fetchImpl.mockResolvedValueOnce(new Response(nouns));

  const result = fetchPackSet(packSetUrl, fetchImpl);
  await vi.advanceTimersByTimeAsync(5000);
  expect(fetchImpl).toHaveBeenCalledOnce();
  finishSetBody(packSet);
  await vi.advanceTimersByTimeAsync(0);
  for (let index = 0; index < 16; index += 1) {
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchImpl).toHaveBeenCalledTimes(index + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(index + 2);
    if (index === 0) {
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      finishDeckBody(greetings);
      await vi.advanceTimersByTimeAsync(0);
    }
  }

  expect(await result).toEqual([
    ...greetingSides, ...nounSides, ...nounSides, ...nounSides,
    ...nounSides, ...nounSides, ...nounSides, ...nounSides,
    ...nounSides, ...nounSides, ...nounSides, ...nounSides,
    ...nounSides, ...nounSides, ...nounSides, ...nounSides,
  ]);
  expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(expectedUrls);
  for (const [, options] of fetchImpl.mock.calls) {
    expect(new Headers(options?.headers).get('User-Agent')).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    );
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  }
  expect(vi.getTimerCount()).toBe(0);
});

test.each(['pack-set', 'deck'])(
  'fetchPackSet reports the observed HTTP status from a failed %s request and stops', async (page) => {
    const fetchImpl = vi.fn<typeof fetch>();
    if (page === 'deck') fetchImpl.mockResolvedValueOnce(new Response(packSet));
    fetchImpl.mockResolvedValueOnce(new Response('Request denied', { status: 403, statusText: 'Forbidden' }));
    const url = page === 'pack-set' ? packSetUrl
      : 'https://www.brainscape.com/flashcards/38-vocabulary-level-2-part-1-level-2-bas-15113057/packs/21882519';

    const assertion = expect(fetchPackSet(packSetUrl, fetchImpl)).rejects.toThrow(
      new Error(`Brainscape request for ${url} returned HTTP 403 Forbidden; check the response and retry.`),
    );
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchImpl).toHaveBeenCalledTimes(page === 'pack-set' ? 1 : 2);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test.each([
  { page: 'pack-set', failure: 'request' }, { page: 'deck', failure: 'request' },
  { page: 'pack-set', failure: 'body' }, { page: 'deck', failure: 'body' },
])('fetchPackSet times out a stalled $page $failure after fifteen seconds and names its URL', async ({ page, failure }) => {
  const timeoutReason = new DOMException('The operation timed out', 'TimeoutError');
  const cause = failure === 'request' ? timeoutReason : new DOMException('The operation was aborted', 'AbortError');
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(timeoutReason), delay);
    return controller.signal;
  });
  const fetchImpl = vi.fn<typeof fetch>();
  if (page === 'deck') fetchImpl.mockResolvedValueOnce(new Response(packSet));
  fetchImpl.mockImplementationOnce((_url, options) => {
    const signal = options?.signal;
    if (!signal) return Promise.reject(new Error('Request has no abort signal'));
    const stalled = new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(cause), { once: true });
    });
    if (failure === 'request') return stalled;
    const response = new Response();
    vi.spyOn(response, 'text').mockReturnValueOnce(stalled);
    return Promise.resolve(response);
  });
  const url = page === 'pack-set' ? packSetUrl
    : 'https://www.brainscape.com/flashcards/38-vocabulary-level-2-part-1-level-2-bas-15113057/packs/21882519';
  const result = fetchPackSet(packSetUrl, fetchImpl);
  let settled = false;
  void result.then(() => { settled = true; }, () => { settled = true; });

  await vi.advanceTimersByTimeAsync(page === 'pack-set' ? 0 : 1000);
  expect(timeout).toHaveBeenLastCalledWith(15000);
  const signal = fetchImpl.mock.calls.at(-1)?.[1]?.signal;
  expect(signal).toBeInstanceOf(AbortSignal);
  await vi.advanceTimersByTimeAsync(14999);
  expect(signal?.aborted).toBe(false);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);

  expect(signal?.aborted).toBe(true);
  await expect(result).rejects.toThrow(new Error(`Brainscape request for ${url} did not answer in time`));
  await expect(result).rejects.toHaveProperty('cause', cause);
  expect(fetchImpl).toHaveBeenCalledTimes(page === 'pack-set' ? 1 : 2);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([
  { page: 'pack-set', failure: 'request' }, { page: 'deck', failure: 'request' },
  { page: 'pack-set', failure: 'body' }, { page: 'deck', failure: 'body' },
])('fetchPackSet preserves a $page $failure error and stops without returning partial results', async ({ page, failure }) => {
  const error = new Error(failure === 'request' ? 'connect ETIMEDOUT' : 'Response body stream terminated');
  const fetchImpl = vi.fn<typeof fetch>();
  if (page === 'deck') {
    fetchImpl.mockResolvedValueOnce(new Response(packSet));
    fetchImpl.mockResolvedValueOnce(new Response(greetings));
  }
  if (failure === 'request') fetchImpl.mockRejectedValueOnce(error);
  else {
    const response = new Response();
    vi.spyOn(response, 'text').mockRejectedValueOnce(error);
    fetchImpl.mockResolvedValueOnce(response);
  }

  const assertion = expect(fetchPackSet(packSetUrl, fetchImpl)).rejects.toBe(error);
  await vi.runAllTimersAsync();
  await assertion;
  expect(fetchImpl).toHaveBeenCalledTimes(page === 'pack-set' ? 1 : 3);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([
  { html: '<html>No preview available</html>', message: 'Brainscape page has no canonical link href; check the page HTML.' },
  { html: '<link rel="canonical" href="https://[">', message: 'Brainscape canonical href https://[ is not a valid URL; check the page HTML.' },
  { html: '<link rel="canonical" href="/learn/spanish">', message: 'Brainscape canonical URL /learn/spanish has no /packs/SLUG-DIGITS or /packs/DIGITS path; check the page HTML.' },
  { html: '<link rel="canonical" href="/packs/21882519">', message: 'Brainscape page /packs/21882519 contained 0 deck links for pack 21882519; check the page HTML.' },
])('fetchPackSet reports unusable pack-set HTML and stops: $message', async ({ html, message }) => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(html));

  await expect(fetchPackSet(packSetUrl, fetchImpl)).rejects.toThrow(new Error(message));
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test.each([
  {
    html: '<html><body>No preview available</body></html>',
    message: 'Brainscape deck https://www.brainscape.com/flashcards/39-verbs-level-2-part-1-level-2-basic-15113060/packs/21882519 contained 0 Spanish sides; check the page HTML.',
  },
  {
    html: answerHtml("<p class='scf-prompt'>Translate this:</p><div class='scf-footnote'><p>English explanation</p></div>"),
    message: 'Card card-back-123 has no Spanish text; check the Brainscape HTML.',
  },
])('fetchPackSet rejects a deck without Spanish text after a valid deck: $message', async ({ html, message }) => {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(packSet))
    .mockResolvedValueOnce(new Response(greetings))
    .mockResolvedValueOnce(new Response(html))
    .mockRejectedValue(new Error('Unexpected later deck fetch'));

  const assertion = expect(fetchPackSet(packSetUrl, fetchImpl)).rejects.toThrow(new Error(message));
  await vi.runAllTimersAsync();
  await assertion;
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});
