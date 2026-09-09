const namedEntities: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  iexcl: '¡', iquest: '¿', copy: '©', reg: '®', ordm: 'º', ordf: 'ª',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Ntilde: 'Ñ', ntilde: 'ñ', Uuml: 'Ü', uuml: 'ü',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', hellip: '…', ndash: '–', mdash: '—', bull: '•',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#(?:x[\da-f]+|\d+)|[a-z][a-z\d]+);/gi, (entity: string, name: string) => {
    if (name.startsWith('#')) {
      const hex = name[1]?.toLowerCase() === 'x';
      return String.fromCodePoint(Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    const decoded = namedEntities[name];
    if (decoded === undefined) {
      throw new Error(`Unknown HTML entity "${entity}"; add ${name} to namedEntities.`);
    }
    return decoded;
  });
}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag)?.[2];
}

function hasClass(tag: string, name: string): boolean {
  return attribute(tag, 'class')?.split(/\s+/).includes(name) ?? false;
}

function divContents(html: string, start: number): string {
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 1;
  for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
    depth += tag[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(start, tag.index);
  }
  throw new Error(`Unclosed div at offset ${start}; check the Brainscape HTML.`);
}

function classContents(html: string, className: string): string | undefined {
  for (const tag of html.matchAll(/<div\b[^>]*>/gi)) {
    if (hasClass(tag[0], className)) return divContents(html, tag.index + tag[0].length);
  }
  return undefined;
}

function htmlText(html: string): string {
  const text = html
    .replace(/<\/?(?:p|div|br|li|ul|ol|blockquote|h[1-6]|figure|figcaption|table|tr|td|th|section)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

type DeckLink = { href: string; title: string | null };

export function deckLinks(html: string, packId: string): DeckLink[] {
  const links = new Map<string, DeckLink>();
  for (const tag of html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi)) {
    const opening = tag[0].slice(0, tag[0].indexOf('>') + 1);
    const href = attribute(opening, 'href');
    if (href && /^\/flashcards\/[^/\s?#]+\/packs\/\d+$/.test(href) && href.endsWith(`/packs/${packId}`) && !links.has(href)) {
      const title = classContents(tag[0], 'deck-item-title');
      links.set(href, { href, title: title === undefined ? null : htmlText(title) });
    }
  }
  return [...links.values()];
}

export function packSetLinks(html: string): DeckLink[] {
  const canonical = [...html.matchAll(/<link\b[^>]*>/gi)]
    .find((tag) => attribute(tag[0], 'rel') === 'canonical');
  const href = canonical && attribute(canonical[0], 'href');
  if (!href) {
    throw new Error('Brainscape page has no canonical link href; check the page HTML.');
  }
  if (!URL.canParse(href, 'https://www.brainscape.com')) {
    throw new Error(`Brainscape canonical href ${href} is not a valid URL; check the page HTML.`);
  }
  const path = new URL(href, 'https://www.brainscape.com').pathname;
  const packId = /^\/packs\/(?:[^/\s]+-)?(\d+)$/.exec(path)?.[1];
  if (!packId) {
    throw new Error(`Brainscape canonical URL ${href} has no /packs/SLUG-DIGITS or /packs/DIGITS path; check the page HTML.`);
  }
  const links = deckLinks(html, packId);
  if (links.length === 0) {
    throw new Error(`Brainscape page ${href} contained ${links.length} deck links for deck set ${packId}; check the page HTML.`);
  }
  return links;
}

export function spanishSides(html: string): string[] {
  const sides: string[] = [];
  // Anchor on the card id: answer-contents also occurs in the inline stylesheet.
  for (const tag of html.matchAll(/<div\b[^>]*\sid\s*=\s*["']card-back-\d+["'][^>]*>/gi)) {
    if (!hasClass(tag[0], 'flashcard-contents') || !hasClass(tag[0], 'answer-contents')) continue;
    const card = divContents(html, tag.index + tag[0].length);
    const preview = classContents(card, 'preview-html');
    if (preview === undefined) {
      throw new Error(`Card ${attribute(tag[0], 'id')} has no preview-html div; check the Brainscape HTML.`);
    }
    let face = classContents(preview, 'scf-face');
    if (face === undefined) {
      throw new Error(`Card ${attribute(tag[0], 'id')} has no scf-face div; check the Brainscape HTML.`);
    }
    const divs = /<div\b[^>]*>/gi;
    for (let div = divs.exec(face); div; div = divs.exec(face)) {
      if (!hasClass(div[0], 'scf-footnote')) continue;
      const start = div.index + div[0].length;
      const end: number = start + divContents(face, start).length;
      face = face.slice(0, div.index) + face.slice(face.indexOf('>', end) + 1);
      divs.lastIndex = div.index;
    }
    const text = face
      .replace(/<p\b[^>]*>[\s\S]*?<\/p\s*>/gi, (paragraph) => {
        const opening = paragraph.slice(0, paragraph.indexOf('>') + 1);
        return hasClass(opening, 'scf-prompt') ? '' : paragraph;
      });
    const side = htmlText(text);
    if (side.length === 0) {
      throw new Error(`Card ${attribute(tag[0], 'id')} has no Spanish text; check the Brainscape HTML.`);
    }
    sides.push(side);
  }
  return sides;
}

const packPath = /^\/(?:(flashcards\/[^/\s?#]+\/packs\/)|packs\/(?:[^/\s?#]+-)?)(\d+)\/?$/;

export function isPackUrl(text: string): boolean {
  const value = text.trim();
  if (/\s/.test(value) || !URL.canParse(value)) return false;

  const url = new URL(value);
  return (url.protocol === 'http:' || url.protocol === 'https:')
    && (url.hostname === 'brainscape.com' || url.hostname.endsWith('.brainscape.com'))
    && packPath.test(url.pathname);
}

export function isPackSetUrl(text: string): boolean {
  const value = text.trim();
  if (/\s/.test(value) || !URL.canParse(value)) return false;

  const url = new URL(value);
  return (url.protocol === 'http:' || url.protocol === 'https:')
    && (url.hostname === 'brainscape.com' || url.hostname.endsWith('.brainscape.com'))
    && /^\/p\/[a-zA-Z\d-]+\/?$/.test(url.pathname);
}

async function readPage(pageUrl: string, fetchImpl: typeof fetch): Promise<string> {
  const signal = AbortSignal.timeout(15000);
  try {
    const response = await fetchImpl(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      signal,
    });
    if (!response.ok) {
      throw new Error(`Brainscape request for ${pageUrl} returned HTTP ${response.status} ${response.statusText}; check the response and retry.`);
    }
    return await response.text();
  } catch (cause) {
    if (signal.aborted) {
      throw new Error(`Brainscape request for ${pageUrl} did not answer in time`, { cause });
    }
    throw cause;
  }
}

type DeckEvent = { link: string; title: string | null; sides: string[] };
export type PackEvent = { links: string[] } | DeckEvent;

async function* fetchDecks(links: DeckLink[], pageUrl: URL, fetchImpl: typeof fetch, firstHtml?: string): AsyncGenerator<DeckEvent, void> {
  for (const { href: link, title } of links) {
    const deckUrl = new URL(link, pageUrl).href;
    let deckHtml = firstHtml;
    if (link !== pageUrl.pathname.replace(/\/$/, '') || deckHtml === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      deckHtml = await readPage(deckUrl, fetchImpl);
    }
    const deckSides = spanishSides(deckHtml);
    if (deckSides.length === 0) {
      throw new Error(`Brainscape deck ${deckUrl} contained ${deckSides.length} Spanish sides; check the page HTML.`);
    }
    yield { link, title, sides: deckSides };
  }
}

export async function* fetchPackEvents(url: string, fetchImpl: typeof fetch): AsyncGenerator<PackEvent, void> {
  const packUrl = new URL(url);
  const pathMatch = packPath.exec(packUrl.pathname);
  const packId = pathMatch?.[2];
  if (!packId) {
    throw new Error(`Brainscape URL ${url} has no deck or deck set path; use a public Brainscape deck or deck set URL.`);
  }
  const html = await readPage(packUrl.href, fetchImpl);
  const isDeck = Boolean(pathMatch?.[1]);
  const links = deckLinks(html, packId)
    .filter(({ href }) => !isDeck || href === packUrl.pathname.replace(/\/$/, ''));
  if (links.length === 0) {
    const target = isDeck ? `matching ${packUrl.pathname}` : `for deck set ${packId}`;
    throw new Error(`Brainscape page ${packUrl.href} contained ${links.length} deck links ${target}; check the page HTML.`);
  }
  yield { links: links.map(({ href }) => href) };
  yield* fetchDecks(links, packUrl, fetchImpl, html);
}

export async function* fetchPackSetEvents(url: string, fetchImpl: typeof fetch): AsyncGenerator<PackEvent, void> {
  const packSetUrl = new URL(url);
  const html = await readPage(packSetUrl.href, fetchImpl);
  const links = packSetLinks(html);
  yield { links: links.map(({ href }) => href) };
  yield* fetchDecks(links, packSetUrl, fetchImpl);
}

export async function fetchPack(url: string, fetchImpl: typeof fetch): Promise<string[]> {
  const sides: string[] = [];
  for await (const event of fetchPackEvents(url, fetchImpl)) {
    if ('sides' in event) sides.push(...event.sides);
  }
  return sides;
}

export async function fetchPackSet(url: string, fetchImpl: typeof fetch): Promise<string[]> {
  const sides: string[] = [];
  for await (const event of fetchPackSetEvents(url, fetchImpl)) {
    if ('sides' in event) sides.push(...event.sides);
  }
  return sides;
}
