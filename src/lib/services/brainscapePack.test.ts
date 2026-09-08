import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { deckLinks, fetchPack, isPackUrl, spanishSides } from './brainscapePack';

const packId = '21648778';
const packUrl = `https://www.brainscape.com/packs/${packId}`;
const pack = readFileSync(new URL('./__fixtures__/brainscape/pack.html', import.meta.url), 'utf8');
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
