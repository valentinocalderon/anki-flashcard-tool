import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { MutationObserver, QueryClient, type MutationObserverOptions } from '@tanstack/react-query';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { formatResultLine } from '@/lib/resultLine';
import type { WordResult } from '@/lib/types';
import type { SendReport } from './ankiSender';
import type { AudioBackfillReport } from './audioBackfill';
import type { GenerationAudioReport, GenerationEvent } from './listGenerationService';

type RunReport = {
  results: WordResult[]; capReached: boolean; audio: GenerationAudioReport; send: SendReport; backfill: AudioBackfillReport;
};
type RunEvent = GenerationEvent | RunReport;

async function* reportEvents(report: RunReport): AsyncIterable<RunEvent> {
  yield report;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

// Use the existing in-memory page compilation pattern with real mutation observers.
// React state and rendering are driven explicitly; this is not a useMutation mount.
const pageScript = new Script(transpileModule(
  readFileSync(new URL('../../app/page.tsx', import.meta.url), 'utf8'),
  { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.React } },
).outputText);

function pageMutation<TData, TVariables = void>(
  client: QueryClient, mutationFn: (variables: TVariables) => Promise<TData>,
) {
  const observer = new MutationObserver<TData, Error, TVariables>(client, { mutationFn });
  let run: Promise<TData> | undefined;
  return {
    useMutation: (options: MutationObserverOptions<TData, Error, TVariables>) => {
      observer.setOptions({ ...options, mutationFn });
      return {
        ...observer.getCurrentResult(),
        mutate: (variables: TVariables) => {
          run = observer.mutate(variables);
          // Like useMutation's void mutate, handle rejection; tests await the original promise.
          void run.catch(() => undefined);
        },
      };
    },
    get run() {
      if (!run) throw new Error('Expected a submitted mutation.');
      return run;
    },
  };
}

function pageRun(pending = 1, declined = 1, awaitingAudio = 0) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: Infinity } } });
  const send = vi.fn<() => Promise<{ send: SendReport; backfill: AudioBackfillReport; capReached: boolean }>>()
    .mockRejectedValue(new Error('Unexpected send request.'));
  const retry = vi.fn<() => Promise<{ send: SendReport; backfill: AudioBackfillReport; capReached: boolean }>>()
    .mockRejectedValue(new Error('Unexpected retry request.'));
  const generate = vi.fn<(input: { text: string }) => Promise<AsyncIterable<RunEvent>>>()
    .mockRejectedValue(new Error('Unexpected generation request.'));
  const backfill = vi.fn<() => Promise<{ backfill: AudioBackfillReport; capReached: boolean }>>()
    .mockRejectedValue(new Error('Unexpected audio request.'));
  const voicing = pageMutation(client, backfill);
  const sending = pageMutation(client, send);
  const retrying = pageMutation(client, retry);
  const generation = pageMutation(client, generate);
  const storedCounts = { pending, declined, awaitingAudio };
  const query = (key: keyof typeof storedCounts) => {
    const state: { data: number | undefined; error: Error | null } = { data: storedCounts[key], error: null };
    const refetch = vi.fn(async () => { state.data = storedCounts[key]; });
    return { state, refetch, useQuery: () => ({ ...state, refetch }) };
  };
  const queries = { pending: query('pending'), declined: query('declined'), awaitingAudio: query('awaitingAudio') };
  const api = { anki: {
    pendingCount: queries.pending, declinedCount: queries.declined, awaitingAudioCount: queries.awaitingAudio,
    sendPending: sending, retryDeclined: retrying, generateFromList: generation, backfillAudio: voicing,
  } };
  type PageState = string | SendReport | AudioBackfillReport | WordResult[] | null
    | { audio: GenerationAudioReport; capReached: boolean }
    | { total: number; finished: number; decks: { href: string; title: string | null }[] };
  const state: PageState[] = ['casa'];
  let stateIndex = 0;
  const useState = (initial: PageState) => {
    const index = stateIndex++;
    if (index === state.length) state.push(initial);
    return [state[index], (value: PageState | ((previous: PageState | undefined) => PageState)) => {
      state[index] = typeof value === 'function' ? value(state[index]) : value;
    }];
  };
  const exports: { default?: () => React.ReactNode } = {};
  pageScript.runInNewContext({
    exports, React,
    require: (moduleName: string) => {
      if (moduleName === 'react') return { ...React, useState };
      if (moduleName === '@/lib/resultLine') return { formatResultLine };
      if (moduleName === '@/trpc/react') return { api };
      throw new Error(`Unexpected page import "${moduleName}".`);
    },
  });
  const render = () => {
    stateIndex = 0;
    if (!exports.default) throw new Error('Expected a page component.');
    return exports.default();
  };
  const children = () => {
    const page = render();
    if (!React.isValidElement<{ children: React.ReactNode }>(page)) throw new Error('Expected a page element.');
    return React.Children.toArray(page.props.children);
  };
  return {
    send, retry, generate, backfill, sending, retrying, generation, voicing, storedCounts, queries,
    children,
    html: () => renderToStaticMarkup(render()),
    submit: () => {
      const form = children().find((child) => React.isValidElement(child) && child.type === 'form');
      if (!React.isValidElement<{ onSubmit: (event: { preventDefault: () => void }) => void }>(form)) {
        throw new Error('Expected the generation form.');
      }
      form.props.onSubmit({ preventDefault: vi.fn() });
    },
    sendFromFooter: (action: 'onSend' | 'onRetry' | 'onVoice') => {
      const footer = children().find((child) =>
        React.isValidElement(child) && typeof child.type === 'function',
      );
      if (!React.isValidElement<{ onSend: () => void; onRetry: () => void; onVoice: () => void }>(footer)) {
        throw new Error('Expected the send footer.');
      }
      footer.props[action]();
    },
  };
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('Unexpected network request.'))));
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

test.each(['onSend', 'onRetry'] as const)(
  'a new generation clears a previous %s failure and displays its fresh report', async (action) => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('Unexpected network request.'));
    vi.stubGlobal('fetch', fetchImpl);
    const page = pageRun();
    page.send.mockRejectedValue(new Error('AnkiConnect returned invalid media data.'));
    page.retry.mockRejectedValue(new Error('AnkiConnect returned invalid media data.'));
    page.sendFromFooter(action);
    await expect(action === 'onSend' ? page.sending.run : page.retrying.run)
      .rejects.toThrow('AnkiConnect returned invalid media data.');
    expect(page.html()).toContain('<p role="alert" class="text-red-600">AnkiConnect returned invalid media data.</p>');

    let finish: (() => void) | undefined;
    page.generate.mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve(reportEvents({ audio: { unspeakable: 0, message: null }, results: [
        { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
      ], capReached: true, send: {
        status: 'sent', sent: 2, rejected: 0, pending: 0, syncedAt: 123, message: null,
      }, backfill: { status: 'nothing', sent: 0, rejected: 0, awaitingAudio: 0, unspeakable: 0, failureStage: null, message: null } }));
    }));
    page.submit();
    await vi.waitFor(() => expect(page.generate).toHaveBeenCalledTimes(1));
    expect(page.html()).not.toContain('role="alert"');
    expect(page.html()).toContain('disabled=""');
    if (!finish) throw new Error('Expected generation to start.');
    finish();
    await page.generation.run;

    expect(page.html()).not.toContain('role="alert"');
    expect(page.html()).toContain('Synced to AnkiWeb at ');
    expect(page.html()).toContain('<strong>casa</strong>: 2 vocab cards');
    expect(page.html()).toContain('Audio cap reached for this run.');
    expect(page.html()).not.toContain('disabled=""');
    expect(fetchImpl).not.toHaveBeenCalled();
  },
);

test('a new generation clears the previous send report even when the pack request fails', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('Unexpected network request.'));
  vi.stubGlobal('fetch', fetchImpl);
  const page = pageRun();
  page.generate.mockResolvedValueOnce(reportEvents({ audio: { unspeakable: 0, message: null }, results: [
    { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
  ], capReached: false, send: {
    status: 'sent', sent: 2, rejected: 0, pending: 0, syncedAt: 123, message: null,
  }, backfill: { status: 'sent', sent: 1, rejected: 0, awaitingAudio: 0, unspeakable: 0, failureStage: null, message: null } }));
  page.submit();
  await page.generation.run;
  expect(page.html()).not.toContain('Synced to AnkiWeb at ');
  expect(page.html()).toContain('Sync Anki desktop with AnkiWeb, then sync Anki on your phone to get this audio.');
  expect(page.html()).toContain('<strong>casa</strong>: 2 vocab cards');
  expect(page.html()).toContain('<p>1 card already in Anki gained audio.</p>');

  let fail: (() => void) | undefined;
  page.generate.mockImplementationOnce(() => new Promise((_resolve, reject) => {
    fail = () => reject(new Error('Brainscape pack request failed: HTTP 503.'));
  }));
  page.submit();
  await vi.waitFor(() => expect(page.generate).toHaveBeenCalledTimes(2));
  expect(page.html()).not.toContain('Synced to AnkiWeb at ');
  expect(page.html()).not.toContain('<strong>casa</strong>');
  expect(page.html()).not.toContain('already in Anki gained audio');
  expect(page.html()).not.toContain('Sync Anki desktop with AnkiWeb');
  if (!fail) throw new Error('Expected generation to start.');
  fail();
  await expect(page.generation.run).rejects.toThrow('Brainscape pack request failed: HTTP 503.');

  expect(page.html()).not.toContain('Synced to AnkiWeb at ');
  expect(page.html()).toContain('<p role="alert" class="text-red-600">Brainscape pack request failed: HTTP 503.</p>');
  expect(fetchImpl).not.toHaveBeenCalled();
});

const backfillOutcomes: { name: string; report: AudioBackfillReport; line: string | null; alert: string | null }[] = [
  {
    name: 'one card', line: '<p>1 card already in Anki gained audio.</p>', alert: null,
    report: { status: 'sent', sent: 1, rejected: 0, awaitingAudio: 0, unspeakable: 0, failureStage: null, message: null },
  },
  {
    name: 'multiple cards', line: '<p>2 cards already in Anki gained audio.</p>', alert: null,
    report: { status: 'sent', sent: 2, rejected: 0, awaitingAudio: 0, unspeakable: 0, failureStage: null, message: null },
  },
  {
    name: 'partial failure', line: '<p>1 card already in Anki gained audio.</p>',
    alert: '<p role="alert" class="text-red-600">Audio backfill failed: note was not found: 102</p>',
    report: { status: 'failed', sent: 1, rejected: 0, awaitingAudio: 2, unspeakable: 0, failureStage: null, message: 'note was not found: 102' },
  },
  {
    name: 'partial voice failure', line: '<p>1 card already in Anki gained audio.</p>',
    alert: '<p role="alert" class="text-red-600">Audio backfill failed: ElevenLabs request returned HTTP 429: quota exceeded; check the response before retrying.</p>',
    report: { status: 'failed', sent: 1, rejected: 0, awaitingAudio: 1, unspeakable: 0, failureStage: null,
      message: 'ElevenLabs request returned HTTP 429: quota exceeded; check the response before retrying.' },
  },
  {
    name: 'partial Anki timeout', line: '<p>1 card already in Anki gained audio.</p>',
    alert: '<p role="alert" class="text-red-600">Audio backfill failed: AnkiConnect request timed out: The operation timed out</p>',
    report: { status: 'anki_closed', sent: 1, rejected: 0, awaitingAudio: 1, unspeakable: 0, failureStage: null,
      message: 'AnkiConnect request timed out: The operation timed out' },
  },
  {
    name: 'voice failure', line: null,
    alert: '<p role="alert" class="text-red-600">Audio backfill failed: ElevenLabs request returned HTTP 429: quota exceeded; check the response before retrying.</p>',
    report: { status: 'failed', sent: 0, rejected: 0, awaitingAudio: 1, unspeakable: 0, failureStage: null,
      message: 'ElevenLabs request returned HTTP 429: quota exceeded; check the response before retrying.' },
  },
  {
    name: 'unreachable Anki', line: null,
    alert: '<p role="alert" class="text-red-600">Audio backfill failed: AnkiConnect request timed out: The operation timed out</p>',
    report: { status: 'anki_closed', sent: 0, rejected: 0, awaitingAudio: 1, unspeakable: 0, failureStage: null,
      message: 'AnkiConnect request timed out: The operation timed out' },
  },
  {
    name: 'nothing sent', line: null, alert: null,
    report: { status: 'nothing', sent: 0, rejected: 0, awaitingAudio: 1, unspeakable: 0, failureStage: null, message: null },
  },
];

test.each(backfillOutcomes.flatMap((outcome) => ['generation', 'sending', 'retrying'].map((mutation) => ({ ...outcome, mutation }))))(
  '$mutation displays backfill $name even when there are no pending or declined cards', async ({ mutation, report, line, alert }) => {
    const page = pageRun(0, 0, report.awaitingAudio);
    const send: SendReport = { status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null };
    if (mutation === 'generation') {
      page.generate.mockResolvedValueOnce(reportEvents({ audio: { unspeakable: 0, message: null }, results: [
        { word: 'casa', status: 'skipped', vocabCards: 0, conjugationCards: 0 },
      ], capReached: false, send, backfill: report }));
      page.submit();
      await page.generation.run;
      expect(page.html().match(/<li\b[^>]*>.*?<\/li>/g)).toEqual([
        '<li class="bg-gray-100 p-3 rounded"><span aria-hidden="true" class="text-xs mr-2">–</span><strong>casa</strong>: skipped: already stored</li>',
      ]);
    } else if (mutation === 'sending') {
      page.send.mockResolvedValueOnce({ capReached: false, send, backfill: report });
      page.sendFromFooter('onSend');
      await page.sending.run;
    } else {
      page.retry.mockResolvedValueOnce({ capReached: false, send, backfill: report });
      page.sendFromFooter('onRetry');
      await page.retrying.run;
    }
    const html = page.html();
    if (line) {
      expect(html).toContain(line);
      expect(html).toContain('<p>Sync Anki desktop with AnkiWeb, then sync Anki on your phone to get this audio.</p>');
    } else {
      expect(html).not.toContain('already in Anki gained audio');
      expect(html).not.toContain('Sync Anki desktop with AnkiWeb');
    }
    if (alert) expect(html).toContain(alert);
    else expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('Synced to AnkiWeb at ');
    expect(html).not.toContain('AnkiWeb sync failed');
    if (report.awaitingAudio > 0) expect(html).toContain('waiting for audio.');
    else expect(html).not.toContain('<button type="button"');
  },
);

const sendBeforeBackfill: { name: string; send: SendReport; expected: string[] }[] = [
  {
    name: 'an earlier successful sync',
    send: { status: 'sent', sent: 1, rejected: 1, pending: 0, syncedAt: 123, message: null },
    expected: ['Sent to Anki.', 'Anki declined 1 card.', '1 card already in Anki gained audio.',
      'Sync Anki desktop with AnkiWeb, then sync Anki on your phone to get this audio.'],
  },
  {
    name: 'no pending cards and no sync',
    send: { status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null },
    expected: ['1 card already in Anki gained audio.',
      'Sync Anki desktop with AnkiWeb, then sync Anki on your phone to get this audio.'],
  },
  {
    name: 'an earlier sync timeout',
    send: { status: 'sent', sent: 1, rejected: 0, pending: 0, syncedAt: null,
      message: 'AnkiConnect request timed out: The operation timed out' },
    expected: ['Sent to Anki. AnkiWeb sync failed: AnkiConnect request timed out: The operation timed out',
      '1 card already in Anki gained audio.',
      'Sync Anki desktop with AnkiWeb, then sync Anki on your phone to get this audio.'],
  },
];

test.each(sendBeforeBackfill.flatMap((outcome) => ['generation', 'sending', 'retrying'].map((mutation) => ({ ...outcome, mutation }))))(
  '$mutation requires a desktop sync for backfilled audio after $name', async ({ mutation, send, expected }) => {
    const page = pageRun(0, 0);
    const backfill: AudioBackfillReport = { status: 'sent', sent: 1, rejected: 0, awaitingAudio: 0, unspeakable: 0, failureStage: null, message: null };
    if (mutation === 'generation') {
      page.generate.mockResolvedValueOnce(reportEvents({ audio: { unspeakable: 0, message: null }, results: [
        { word: 'casa', status: 'skipped', vocabCards: 0, conjugationCards: 0 },
      ], capReached: false, send, backfill }));
      page.submit();
      await page.generation.run;
    } else if (mutation === 'sending') {
      page.send.mockResolvedValueOnce({ capReached: false, send, backfill });
      page.sendFromFooter('onSend');
      await page.sending.run;
    } else {
      page.retry.mockResolvedValueOnce({ capReached: false, send, backfill });
      page.sendFromFooter('onRetry');
      await page.retrying.run;
    }
    const paragraphs = [...page.html().matchAll(/<p\b[^>]*>(.*?)<\/p>/g)].map((match) => match[1]);
    expect(paragraphs).toEqual(expected);
  },
);

test.each(['generation', 'onSend', 'onRetry'] as const)(
  '%s clears an earlier partial backfill report before its new request fails', async (action) => {
    const page = pageRun();
    page.generate.mockResolvedValueOnce(reportEvents({ audio: { unspeakable: 0, message: null }, results: [], capReached: false,
      send: { status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null },
      backfill: { status: 'failed', sent: 1, rejected: 0, awaitingAudio: 1, unspeakable: 0, failureStage: null, message: 'old backfill failure' },
    }));
    page.submit();
    await page.generation.run;
    expect(page.html()).toContain('<p>1 card already in Anki gained audio.</p>');
    expect(page.html()).toContain('<p role="alert" class="text-red-600">Audio backfill failed: old backfill failure</p>');

    const reject = () => Promise.reject(new Error('new request failure'));
    page.generate.mockImplementationOnce(reject);
    page.send.mockImplementationOnce(reject);
    page.retry.mockImplementationOnce(reject);
    if (action === 'generation') page.submit();
    else page.sendFromFooter(action);
    await expect(action === 'generation' ? page.generation.run : action === 'onSend' ? page.sending.run : page.retrying.run)
      .rejects.toThrow('new request failure');
    expect(page.html()).not.toContain('already in Anki gained audio');
    expect(page.html()).not.toContain('Sync Anki desktop with AnkiWeb');
    expect(page.html()).not.toContain('old backfill failure');
    expect(page.html()).toContain('<p role="alert" class="text-red-600">new request failure</p>');
  },
);

test('pending send displays both reports and retry with no backfill clears the previous audio outcome', async () => {
  const page = pageRun();
  page.send.mockResolvedValueOnce({ capReached: false,
    send: { status: 'sent', sent: 1, rejected: 0, pending: 0, syncedAt: 123, message: null },
    backfill: { status: 'sent', sent: 2, rejected: 0, awaitingAudio: 0, unspeakable: 0, failureStage: null, message: null },
  });
  page.sendFromFooter('onSend');
  await page.sending.run;
  expect(page.html()).not.toContain('Synced to AnkiWeb at ');
  expect(page.html()).toContain('Sync Anki desktop with AnkiWeb, then sync Anki on your phone to get this audio.');
  expect(page.html()).toContain('<p>2 cards already in Anki gained audio.</p>');

  page.retry.mockResolvedValueOnce({ capReached: false,
    send: { status: 'sent', sent: 1, rejected: 0, pending: 0, syncedAt: 456, message: null },
    backfill: { status: 'nothing', sent: 0, rejected: 0, awaitingAudio: 0, unspeakable: 0, failureStage: null, message: null },
  });
  page.sendFromFooter('onRetry');
  await page.retrying.run;
  expect(page.html()).toContain('Synced to AnkiWeb at ');
  expect(page.html()).not.toContain('already in Anki gained audio');
  expect(page.html()).not.toContain('Sync Anki desktop with AnkiWeb');
});

const noSend: SendReport = { status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null };
const noBackfill: AudioBackfillReport = {
  status: 'nothing', sent: 0, rejected: 0, awaitingAudio: 0, unspeakable: 0, message: null, failureStage: null,
};

function resultGroups(html: string) {
  return [...html.matchAll(/<section\b[^>]*>(.*?)<\/section>/g)].map((match) => {
    const section = match[1];
    if (section === undefined) throw new Error('Expected a result section.');
    return {
      heading: /<h2\b[^>]*>(.*?)<\/h2>/.exec(section)?.[1],
      words: [...section.matchAll(/<strong>(.*?)<\/strong>/g)].map((word) => word[1]),
      tally: /<p\b[^>]*>(.*?)<\/p>/.exec(section)?.[1],
    };
  });
}

test('results without link progress keep the original direct flat list, including sourced results', async () => {
  const page = pageRun(0, 0);
  const streamed = deferred<void>();
  const finish = deferred<void>();
  const results: WordResult[] = [
    { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0, source: 'deck-z' },
    { word: 'hogar', status: 'error', vocabCards: 0, conjugationCards: 0, source: 'deck-a', message: 'Lookup returned HTTP 429.' },
    { word: 'suelto', status: 'skipped', vocabCards: 0, conjugationCards: 0 },
  ];
  page.generate.mockResolvedValueOnce((async function* (): AsyncIterable<RunEvent> {
    for (const result of results) yield { result };
    streamed.resolve();
    await finish.promise;
    yield { results, audio: { unspeakable: 0, message: null }, capReached: false, send: noSend, backfill: noBackfill };
  })());
  const expected = '<ul aria-live="polite" class="text-sm space-y-2">'
    + '<li class="bg-gray-100 p-3 rounded"><span aria-hidden="true" class="text-xs mr-2">✓</span><strong>casa</strong>: 2 vocab cards</li>'
    + '<li class="bg-gray-100 p-3 rounded"><span aria-hidden="true" class="text-xs mr-2">!</span><strong>hogar</strong>: Lookup returned HTTP 429.</li>'
    + '<li class="bg-gray-100 p-3 rounded"><span aria-hidden="true" class="text-xs mr-2">–</span><strong>suelto</strong>: skipped: already stored</li></ul>';
  page.submit();
  await streamed.promise;
  expect(page.html().match(/<ul\b[^>]*>.*?<\/ul>/g)).toEqual([expected]);
  expect(page.html()).not.toMatch(/<h2\b|\d+ added, \d+ skipped|Deck links finished:/);
  finish.resolve();
  await page.generation.run;
  expect(page.children().map((child) => React.isValidElement(child) ? typeof child.type === 'string' ? child.type : 'component' : null))
    .toEqual(['h1', 'form', 'ul', 'component']);
  const list = page.children().find((child) => React.isValidElement(child) && child.type === 'ul');
  if (!React.isValidElement<{ children: React.ReactNode }>(list)) throw new Error('Expected the direct flat result list.');
  const keys: (string | null)[] = [];
  React.Children.forEach(list.props.children, (line) => {
    if (!React.isValidElement(line)) throw new Error('Expected a result line.');
    keys.push(line.key);
  });
  expect(keys).toEqual(['0', '1', '2']);
  expect(renderToStaticMarkup(list)).toBe(expected);
  expect(page.html()).not.toMatch(/<h2\b|\d+ added, \d+ skipped|Deck links finished:/);
});

test('deck groups show every discovery heading before any deck is fetched', async () => {
  const page = pageRun(0, 0);
  const discovered = deferred<void>();
  const finish = deferred<void>();
  page.generate.mockResolvedValueOnce((async function* (): AsyncIterable<RunEvent> {
    yield { links: ['deck-z', 'deck-a'] };
    discovered.resolve();
    await finish.promise;
  })());
  page.submit();
  await discovered.promise;
  expect(resultGroups(page.html())).toEqual([
    { heading: 'Pack 1', words: [], tally: undefined },
    { heading: 'Pack 2', words: [], tally: undefined },
  ]);
  expect(page.html().match(/<section\b[^>]*><h2\b[^>]*>Pack [12]<\/h2><\/section>/g)).toHaveLength(2);
  expect(page.html()).toContain('Deck links finished: 0 of 2');
  finish.resolve();
  await page.generation.run;
});

test('deck groups keep discovery order and place streamed and final results by their own source', async () => {
  const page = pageRun(0, 0);
  const streamed = deferred<void>();
  const finish = deferred<void>();
  const results: [WordResult, WordResult, WordResult] = [
    { word: 'viajar', status: 'added', vocabCards: 2, conjugationCards: 3, source: 'deck-a' },
    { word: 'suelto', status: 'skipped', vocabCards: 0, conjugationCards: 0 },
    { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0, source: 'deck-z' },
  ];
  page.generate.mockResolvedValueOnce((async function* (): AsyncIterable<RunEvent> {
    yield { links: ['deck-z', 'deck-a'] };
    yield { link: 'deck-a', title: 'Travel' };
    yield { link: 'deck-z', title: 'Common Greetings' };
    for (const result of results) yield { result };
    streamed.resolve();
    await finish.promise;
    yield { results, audio: { unspeakable: 0, message: null }, capReached: false, send: noSend, backfill: noBackfill };
  })());
  const expected = [
    { heading: 'Pack 1 — Common Greetings', words: ['casa'], tally: '1 added, 0 skipped' },
    { heading: 'Pack 2 — Travel', words: ['viajar'], tally: '1 added, 0 skipped' },
  ];
  page.submit();
  await streamed.promise;
  expect(resultGroups(page.html())).toEqual(expected);
  expect(page.html()).toContain('Deck links finished: 2 of 2');
  const flat = page.html().replace(/<section\b[^>]*>.*?<\/section>/g, '');
  expect(flat.match(/<li\b[^>]*>.*?<\/li>/g)).toEqual([
    '<li class="bg-gray-100 p-3 rounded"><span aria-hidden="true" class="text-xs mr-2">–</span><strong>suelto</strong>: skipped: already stored</li>',
  ]);
  expect(page.children().filter((child) => React.isValidElement(child) && child.type === 'ul').map((list) => renderToStaticMarkup(list)))
    .toEqual(['<ul aria-live="polite" class="text-sm space-y-2"><li class="bg-gray-100 p-3 rounded"><span aria-hidden="true" class="text-xs mr-2">–</span><strong>suelto</strong>: skipped: already stored</li></ul>']);
  expect(page.html()).toMatch(/<h2\b[^>]*>Pack 1 — Common Greetings<\/h2><ul\b[^>]*><li\b[^>]*>.*?<strong>casa<\/strong>.*?<\/li><\/ul><p\b[^>]*>1 added, 0 skipped<\/p>/);
  finish.resolve();
  await page.generation.run;
  expect(resultGroups(page.html())).toEqual(expected);
  expect(page.html().match(/<li\b/g)).toHaveLength(3);
});

test('deck groups use bare Pack 2 when its link title is null', async () => {
  const page = pageRun(0, 0);
  page.generate.mockResolvedValueOnce((async function* (): AsyncIterable<RunEvent> {
    yield { links: ['deck-z', 'deck-a'] };
    yield { link: 'deck-z', title: 'Common Greetings' };
    yield { link: 'deck-a', title: null };
    yield { result: { word: 'viajar', status: 'skipped', vocabCards: 0, conjugationCards: 0, source: 'deck-a' } };
  })());
  page.submit();
  await page.generation.run;
  expect(resultGroups(page.html())).toEqual([
    { heading: 'Pack 1 — Common Greetings', words: [], tally: undefined },
    { heading: 'Pack 2', words: ['viajar'], tally: '0 added, 1 skipped' },
  ]);
});

test('deck groups tally every status as items while results stream, including duplicate and error', async () => {
  const page = pageRun(0, 0);
  const steps: { result: WordResult; tally: string }[] = [
    { result: { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 }, tally: '1 added, 0 skipped' },
    { result: { word: 'hablar', status: 'updated', vocabCards: 0, conjugationCards: 4 }, tally: '2 added, 0 skipped' },
    { result: { word: 'calle', status: 'exists', vocabCards: 0, conjugationCards: 0 }, tally: '2 added, 1 skipped' },
    { result: { word: 'sol', status: 'skipped', vocabCards: 0, conjugationCards: 0 }, tally: '2 added, 2 skipped' },
    { result: { word: 'casa', status: 'duplicate', vocabCards: 0, conjugationCards: 0 }, tally: '2 added, 3 skipped' },
    { result: { word: 'hogar', status: 'error', vocabCards: 0, conjugationCards: 0, message: 'Lookup returned HTTP 429.' },
      tally: '2 added, 3 skipped, 1 failed' },
  ];
  const checkpoints = steps.map((step) => ({ ...step, consumed: deferred<void>(), next: deferred<void>() }));
  const results = steps.map(({ result }) => ({ ...result, source: 'deck-z' }));
  page.generate.mockResolvedValueOnce((async function* (): AsyncIterable<RunEvent> {
    yield { links: ['deck-z'] };
    yield { link: 'deck-z', title: 'Common Greetings' };
    for (const step of checkpoints) {
      yield { result: { ...step.result, source: 'deck-z' } };
      step.consumed.resolve();
      await step.next.promise;
    }
    yield { results, audio: { unspeakable: 0, message: null }, capReached: false, send: noSend, backfill: noBackfill };
  })());
  page.submit();
  for (const step of checkpoints) {
    await step.consumed.promise;
    expect(resultGroups(page.html()).map(({ tally }) => tally)).toEqual([step.tally]);
    step.next.resolve();
  }
  await page.generation.run;
  expect(resultGroups(page.html())).toEqual([
    { heading: 'Pack 1 — Common Greetings', words: ['casa', 'hablar', 'calle', 'sol', 'casa', 'hogar'],
      tally: '2 added, 3 skipped, 1 failed' },
  ]);
  expect(page.html().match(/<li\b/g)).toHaveLength(6);
  expect(page.html()).toContain('<strong>casa</strong>: skipped: duplicate in this run');
  expect(page.html()).toContain('<span aria-hidden="true" class="text-xs mr-2">!</span><strong>hogar</strong>: Lookup returned HTTP 429.');
});

test('word-list results keep their exact flat markup with no heading or tally during and after streaming', async () => {
  const page = pageRun(0, 0);
  const streamed = deferred<void>();
  const finish = deferred<void>();
  const results: WordResult[] = [
    { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
    { word: 'hogar', status: 'error', vocabCards: 0, conjugationCards: 0, message: 'Lookup returned HTTP 429.' },
  ];
  page.generate.mockResolvedValueOnce((async function* (): AsyncIterable<RunEvent> {
    for (const result of results) yield { result };
    streamed.resolve();
    await finish.promise;
    yield { results, audio: { unspeakable: 0, message: null }, capReached: false, send: noSend, backfill: noBackfill };
  })());
  const expected = '<ul aria-live="polite" class="text-sm space-y-2">'
    + '<li class="bg-gray-100 p-3 rounded"><span aria-hidden="true" class="text-xs mr-2">✓</span><strong>casa</strong>: 2 vocab cards</li>'
    + '<li class="bg-gray-100 p-3 rounded"><span aria-hidden="true" class="text-xs mr-2">!</span><strong>hogar</strong>: Lookup returned HTTP 429.</li></ul>';
  page.submit();
  await streamed.promise;
  expect(page.html().match(/<ul\b[^>]*>.*?<\/ul>/g)).toEqual([expected]);
  expect(page.html()).not.toMatch(/<h2\b|\d+ added, \d+ skipped|Deck links finished:/);
  finish.resolve();
  await page.generation.run;
  expect(page.html().match(/<ul\b[^>]*>.*?<\/ul>/g)).toEqual([expected]);
  expect(page.html()).not.toMatch(/<h2\b|\d+ added, \d+ skipped|Deck links finished:/);
});

test.each(['word list', 'failed request'] as const)('deck groups clear before a new %s', async (nextRun) => {
  const page = pageRun(0, 0);
  page.generate.mockResolvedValueOnce((async function* (): AsyncIterable<RunEvent> {
    yield { links: ['deck-z'] };
    yield { link: 'deck-z', title: 'Common Greetings' };
    yield { result: { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0, source: 'deck-z' } };
  })());
  page.submit();
  await page.generation.run;
  expect(resultGroups(page.html())).toEqual([
    { heading: 'Pack 1 — Common Greetings', words: ['casa'], tally: '1 added, 0 skipped' },
  ]);
  const started = deferred<void>();
  const finish = deferred<void>();
  page.generate.mockImplementationOnce(async () => {
    started.resolve();
    await finish.promise;
    if (nextRun === 'failed request') throw new Error('Brainscape pack request failed: HTTP 503.');
    return reportEvents({ results: [{ word: 'sol', status: 'added', vocabCards: 1, conjugationCards: 0 }],
      audio: { unspeakable: 0, message: null }, capReached: false, send: noSend, backfill: noBackfill });
  });
  page.submit();
  await started.promise;
  expect(resultGroups(page.html())).toEqual([]);
  expect(page.html()).not.toMatch(/<h2\b|\d+ added, \d+ skipped|<strong>casa<\/strong>|Deck links finished:/);
  finish.resolve();
  if (nextRun === 'failed request') {
    await expect(page.generation.run).rejects.toThrow('Brainscape pack request failed: HTTP 503.');
    expect(page.html()).toContain('<p role="alert" class="text-red-600">Brainscape pack request failed: HTTP 503.</p>');
  } else {
    await page.generation.run;
    expect(page.html()).toContain('<strong>sol</strong>: 1 vocab card');
  }
  expect(resultGroups(page.html())).toEqual([]);
  expect(page.html()).not.toMatch(/<h2\b|\d+ added, \d+ skipped/);
});

test.each(['deck fetch', 'after result'] as const)('deck groups preserve observed progress after a failure during %s', async (stage) => {
  const page = pageRun(0, 0);
  const message = stage === 'deck fetch' ? 'Brainscape deck request failed: HTTP 503.' : 'AnkiConnect request timed out: The operation timed out';
  page.generate.mockResolvedValueOnce((async function* (): AsyncIterable<RunEvent> {
    yield { links: ['deck-z', 'deck-a'] };
    yield { link: 'deck-z', title: 'Common Greetings' };
    if (stage === 'after result') {
      yield { link: 'deck-a', title: null };
      yield { result: { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0, source: 'deck-z' } };
    }
    page.storedCounts.pending = 3;
    page.storedCounts.declined = 2;
    page.storedCounts.awaitingAudio = 1;
    throw new Error(message);
  })());
  page.submit();
  await expect(page.generation.run).rejects.toThrow(message);
  expect(resultGroups(page.html())).toEqual([
    { heading: 'Pack 1 — Common Greetings', words: stage === 'after result' ? ['casa'] : [],
      tally: stage === 'after result' ? '1 added, 0 skipped' : undefined },
    { heading: 'Pack 2', words: [], tally: undefined },
  ]);
  expect(page.html()).toContain(`<p role="alert" class="text-red-600">${message}</p>`);
  expect(page.html()).not.toContain('Anki is not running');
  expect(page.html()).not.toContain('role="status"');
  expect(page.html()).toContain('Send 3 pending cards');
  expect(page.html()).toContain('Retry 2 declined cards');
  expect(page.html()).toContain('Voice 1 card waiting for audio');
  expect(page.queries.pending.refetch).toHaveBeenCalledOnce();
  expect(page.queries.declined.refetch).toHaveBeenCalledOnce();
  expect(page.queries.awaitingAudio.refetch).toHaveBeenCalledOnce();
});

test.each([true, false])('the page streams progress and stays pending until completion (pack: %s)', async (pack) => {
  const page = pageRun();
  const first = deferred<void>();
  const second = deferred<void>();
  const summary = deferred<void>();
  const summaryConsumed = deferred<void>();
  const report = deferred<void>();
  const finish = deferred<void>();
  const results: [WordResult, WordResult] = [
    { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
    { word: 'hogar', status: 'error', vocabCards: 0, conjugationCards: 0, message: 'Lookup returned HTTP 429.' },
  ];
  const links = ['deck-1', 'deck-2', 'deck-3', 'deck-4', 'deck-5', 'deck-6', 'deck-7', 'deck-8',
    'deck-9', 'deck-10', 'deck-11', 'deck-12', 'deck-13', 'deck-14', 'deck-15', 'deck-16'];
  page.generate.mockResolvedValueOnce((async function* (): AsyncIterable<RunEvent> {
    await first.promise;
    if (pack) {
      yield { links };
      yield { link: 'deck-1', title: 'Common Greetings' };
    }
    yield { result: results[0] };
    await second.promise;
    if (pack) yield { link: 'deck-2', title: null };
    yield { result: results[1] };
    await summary.promise;
    yield { results, capReached: true, audio: { unspeakable: 1, message: 'Cannot speak this card.' } };
    summaryConsumed.resolve();
    await report.promise;
    yield { results, capReached: true, audio: { unspeakable: 1, message: 'Cannot speak this card.' },
      send: { status: 'sent', sent: 2, rejected: 0, pending: 0, syncedAt: 123, message: null }, backfill: noBackfill };
    await finish.promise;
  })());

  expect(page.html()).not.toContain('role="status"');
  page.submit();
  expect(page.html()).toContain('role="status"');
  expect(page.html()).toContain('Generating');
  expect(page.html()).not.toContain('Deck links finished:');
  first.resolve();
  await vi.waitFor(() => expect(page.html()).toContain('<strong>casa</strong>: 2 vocab cards'));
  expect(page.html()).not.toContain('<strong>hogar</strong>');
  if (pack) expect(page.html()).toContain('Deck links finished: 1 of 16');
  else expect(page.html()).not.toContain('Deck links finished:');
  second.resolve();
  await vi.waitFor(() => expect(page.html()).toContain('<strong>hogar</strong>'));
  expect(page.html()).toContain('Lookup returned HTTP 429.');
  expect(page.html().match(/<li\b/g)).toHaveLength(2);
  if (pack) expect(page.html()).toContain('Deck links finished: 2 of 16');
  else expect(page.html()).not.toContain('Deck links finished:');
  expect(page.html()).toContain('role="status"');
  expect(page.html().match(/<button[^>]*disabled=""/g)).toHaveLength(3);
  page.submit();
  expect(page.generate).toHaveBeenCalledOnce();
  summary.resolve();
  await summaryConsumed.promise;
  expect(page.html()).not.toContain('Synced to AnkiWeb');
  expect(page.html()).not.toContain('Audio cap reached');
  report.resolve();
  await vi.waitFor(() => expect(page.html()).toContain('Synced to AnkiWeb'));
  expect(page.html()).toContain('Audio cap reached for this run.');
  expect(page.html()).toContain('During generation, 1 card could not be spoken.');
  expect(page.html()).toContain('role="status"');
  expect(page.queries.pending.refetch).not.toHaveBeenCalled();
  page.storedCounts.pending = 0;
  page.storedCounts.declined = 0;
  finish.resolve();
  await page.generation.run;
  expect(page.html()).not.toContain('role="status"');
  expect(page.html()).not.toContain('Deck links finished:');
  expect(page.html()).not.toContain('disabled=""');
  expect(page.html().match(/<li\b/g)).toHaveLength(2);
  expect(page.queries.pending.refetch).toHaveBeenCalledOnce();
  expect(page.queries.declined.refetch).toHaveBeenCalledOnce();
  expect(page.queries.awaitingAudio.refetch).toHaveBeenCalledOnce();

  const next = deferred<AsyncIterable<RunEvent>>();
  page.generate.mockReturnValueOnce(next.promise);
  page.submit();
  await vi.waitFor(() => expect(page.generate).toHaveBeenCalledTimes(2));
  expect(page.html()).toContain('role="status"');
  expect(page.html()).not.toContain('Deck links finished:');
  expect(page.html()).not.toContain('<strong>casa</strong>');
  next.resolve(reportEvents({ results: [], audio: { unspeakable: 0, message: null },
    capReached: false, send: noSend, backfill: noBackfill }));
  await page.generation.run;
  expect(page.html()).toContain('No words found in the text.');
});

test.each(['request', 'stream'] as const)('a rejected %s shows the observed error and refreshes stored counts', async (failure) => {
  const page = pageRun(0, 0, 0);
  const stop = deferred<void>();
  const error = new Error('Brainscape pack request failed: HTTP 503.');
  if (failure === 'request') page.generate.mockImplementationOnce(async () => { await stop.promise; throw error; });
  else page.generate.mockResolvedValueOnce((async function* (): AsyncIterable<RunEvent> {
    yield { result: { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 } };
    await stop.promise;
    throw error;
  })());
  page.submit();
  expect(page.html()).toContain('role="status"');
  if (failure === 'stream') await vi.waitFor(() => expect(page.html()).toContain('<strong>casa</strong>'));
  page.storedCounts.pending = 3;
  page.storedCounts.declined = 2;
  page.storedCounts.awaitingAudio = 1;
  stop.resolve();
  await expect(page.generation.run).rejects.toThrow('Brainscape pack request failed: HTTP 503.');
  expect(page.html()).toContain('<p role="alert" class="text-red-600">Brainscape pack request failed: HTTP 503.</p>');
  expect(page.html()).not.toContain('role="status"');
  expect(page.html()).not.toContain('disabled=""');
  expect(page.html()).not.toContain('Synced to AnkiWeb');
  if (failure === 'stream') expect(page.html()).toContain('<strong>casa</strong>: 2 vocab cards');
  expect(page.html()).toContain('Send 3 pending cards');
  expect(page.html()).toContain('Retry 2 declined cards');
  expect(page.html()).toContain('Voice 1 card waiting for audio');
  expect(page.queries.pending.refetch).toHaveBeenCalledOnce();
  expect(page.queries.declined.refetch).toHaveBeenCalledOnce();
  expect(page.queries.awaitingAudio.refetch).toHaveBeenCalledOnce();
});

test('the audio count and control use the footer pattern and disable every action while voicing', async () => {
  const page = pageRun(2, 1, 3);
  expect(page.html()).toContain('<p>3 cards are waiting for audio.</p>');
  expect(page.html()).toContain('<div class="bg-gray-100 p-3 rounded space-y-3"><p>3 cards are waiting for audio.</p><button type="button" class="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">Voice 3 cards waiting for audio</button></div>');
  let finish: (() => void) | undefined;
  page.backfill.mockImplementationOnce(() => new Promise((resolve) => {
    finish = () => resolve({ capReached: true, backfill: {
      status: 'sent', sent: 1, rejected: 0, awaitingAudio: 2, unspeakable: 0, message: null, failureStage: null,
    } });
  }));
  page.sendFromFooter('onVoice');
  await vi.waitFor(() => expect(page.backfill).toHaveBeenCalledOnce());
  expect(page.html().match(/<button[^>]*disabled=""/g)).toHaveLength(4);
  page.submit();
  expect(page.generate).not.toHaveBeenCalled();
  page.storedCounts.awaitingAudio = 2;
  if (!finish) throw new Error('Expected audio request to start.');
  finish();
  await page.voicing.run;
  expect(page.html()).toContain('<p>2 cards are waiting for audio.</p>');
  expect(page.html()).toContain('<p>1 card already in Anki gained audio.</p>');
  expect(page.html()).toContain('Audio cap reached for this run.');
  expect(page.html()).not.toContain('disabled=""');
  expect(page.send).not.toHaveBeenCalled();
  expect(page.retry).not.toHaveBeenCalled();
  expect(page.queries.pending.refetch).toHaveBeenCalledOnce();
  expect(page.queries.declined.refetch).toHaveBeenCalledOnce();
  expect(page.queries.awaitingAudio.refetch).toHaveBeenCalledOnce();
});

test.each(['generation', 'onSend', 'onRetry', 'onVoice'] as const)(
  '%s displays the cap and refreshes all counts after a partial audio failure', async (action) => {
    const page = pageRun(2, 1, 4);
    const backfill: AudioBackfillReport = { status: 'failed', sent: 1, rejected: 1, awaitingAudio: 2,
      unspeakable: 1, message: 'note was not found: 102', failureStage: 'updateNoteFields' };
    page.generate.mockResolvedValueOnce(reportEvents({ results: [], audio: { unspeakable: 0, message: null }, capReached: true, send: noSend, backfill }));
    page.send.mockResolvedValueOnce({ capReached: true, send: noSend, backfill });
    page.retry.mockResolvedValueOnce({ capReached: true, send: noSend, backfill });
    page.backfill.mockResolvedValueOnce({ capReached: true, backfill });
    page.storedCounts.pending = 0;
    page.storedCounts.declined = 0;
    page.storedCounts.awaitingAudio = 3;
    if (action === 'generation') page.submit();
    else page.sendFromFooter(action);
    await (action === 'generation' ? page.generation.run : action === 'onSend' ? page.sending.run
      : action === 'onRetry' ? page.retrying.run : page.voicing.run);
    expect(page.html()).toContain('<p>3 cards are waiting for audio.</p>');
    expect(page.html()).toContain('<p>During audio backfill, 1 card could not be spoken.</p>');
    expect(page.html()).toContain('<p>Anki declined audio for 1 card.</p>');
    expect(page.html()).toContain('Audio backfill failed: note was not found: 102');
    expect(page.html().match(/Audio cap reached for this run\./g)).toEqual(['Audio cap reached for this run.']);
    expect(page.html()).not.toContain('waiting to be sent.');
    expect(page.html()).not.toContain('Retry 1 declined card');
    expect(page.queries.pending.refetch).toHaveBeenCalledOnce();
    expect(page.queries.declined.refetch).toHaveBeenCalledOnce();
    expect(page.queries.awaitingAudio.refetch).toHaveBeenCalledOnce();
  },
);

test('generation reports unspeakable cards without changing the result line or adding overlapping counts', async () => {
  const page = pageRun(0, 0, 1);
  page.generate.mockResolvedValueOnce(reportEvents({ capReached: false,
    results: [{ word: 'hablar', status: 'added', vocabCards: 1, conjugationCards: 2 }],
    audio: { unspeakable: 1, message: 'Unsupported card audio HTML tag "<b>"; check cardGenerator output (expected plain text with <br> separators only).' },
    send: noSend, backfill: { ...noBackfill, status: 'failed', awaitingAudio: 1, unspeakable: 1,
      failureStage: 'prepare', message: 'Unsupported card audio HTML tag "<b>"; check cardGenerator output (expected plain text with <br> separators only).' },
  }));
  page.submit();
  await page.generation.run;
  expect(page.html()).toContain('<p>During generation, 1 card could not be spoken.</p>');
  expect(page.html()).toContain('<p>During audio backfill, 1 card could not be spoken.</p>');
  expect(page.html()).toContain('Unsupported card audio HTML tag &quot;&lt;b&gt;&quot;');
  expect(page.html()).not.toContain('2 cards could not be spoken.');
  expect(page.html().match(/<li\b[^>]*>.*?<\/li>/g)).toEqual([
    '<li class="bg-gray-100 p-3 rounded"><span aria-hidden="true" class="text-xs mr-2">✓</span><strong>hablar</strong>: 1 vocab card plus 2 conjugation cards</li>',
  ]);
});

test('an audio-only request failure displays its observed message and refreshes stored counts', async () => {
  const page = pageRun(1, 1, 3);
  page.backfill.mockImplementationOnce(async () => {
    page.storedCounts.pending = 2;
    page.storedCounts.declined = 2;
    page.storedCounts.awaitingAudio = 1;
    throw new Error('audio count read failed');
  });
  page.sendFromFooter('onVoice');
  await expect(page.voicing.run).rejects.toThrow('audio count read failed');
  expect(page.html()).toContain('<p role="alert" class="text-red-600">audio count read failed</p>');
  expect(page.html()).toContain('<p>1 card is waiting for audio.</p>');
  expect(page.html()).toContain('Send 2 pending cards');
  expect(page.html()).toContain('Retry 2 declined cards');
  expect(page.html()).not.toContain('disabled=""');
});

test('the audio count query error is visible and does not invent a count', () => {
  const page = pageRun(0, 0);
  page.queries.awaitingAudio.state.data = undefined;
  page.queries.awaitingAudio.state.error = new Error('audio count read failed');
  expect(page.html()).toContain('<p role="alert" class="text-red-600">audio count read failed</p>');
  expect(page.html()).not.toContain('waiting for audio');
});

test.each((['generation', 'onSend', 'onRetry', 'onVoice'] as const).flatMap((action) =>
  ['partial report', 'request error'].map((previous) => ({ action, previous }))))(
  '$action clears the previous audio-only $previous before displaying a fresh outcome', async ({ action, previous }) => {
    const page = pageRun(1, 1, 2);
    page.backfill.mockResolvedValueOnce({ capReached: true,
      backfill: { ...noBackfill, status: 'failed', awaitingAudio: 2, unspeakable: 2,
        failureStage: 'prepare', message: 'old audio preparation failure' },
    });
    page.sendFromFooter('onVoice');
    await page.voicing.run;
    expect(page.html()).toContain('During audio backfill, 2 cards could not be spoken.');
    expect(page.html()).toContain('Audio cap reached for this run.');
    if (previous === 'request error') {
      page.backfill.mockRejectedValueOnce(new Error('old audio request failure'));
      page.sendFromFooter('onVoice');
      await expect(page.voicing.run).rejects.toThrow('old audio request failure');
      expect(page.html()).toContain('old audio request failure');
    }
    page.generate.mockResolvedValueOnce(reportEvents({ results: [], audio: { unspeakable: 0, message: null }, capReached: false,
      send: noSend, backfill: noBackfill }));
    page.send.mockResolvedValueOnce({ capReached: false, send: noSend, backfill: noBackfill });
    page.retry.mockResolvedValueOnce({ capReached: false, send: noSend, backfill: noBackfill });
    page.backfill.mockResolvedValueOnce({ capReached: false, backfill: noBackfill });
    page.storedCounts.awaitingAudio = 0;
    if (action === 'generation') page.submit();
    else page.sendFromFooter(action);
    await (action === 'generation' ? page.generation.run : action === 'onSend' ? page.sending.run
      : action === 'onRetry' ? page.retrying.run : page.voicing.run);
    expect(page.html()).not.toContain('old audio');
    expect(page.html()).not.toContain('could not be spoken');
    expect(page.html()).not.toContain('Audio cap reached');
    expect(page.html()).not.toContain('waiting for audio');
  },
);
