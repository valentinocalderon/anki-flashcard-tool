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
import type { GenerationAudioReport } from './listGenerationService';

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
  const generate = vi.fn<(input: { text: string }) => Promise<{
    results: WordResult[]; capReached: boolean; audio: GenerationAudioReport; send: SendReport; backfill: AudioBackfillReport;
  }>>().mockRejectedValue(new Error('Unexpected generation request.'));
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
  const state: (string | SendReport | AudioBackfillReport | WordResult[] | null)[] = ['casa'];
  let stateIndex = 0;
  const useState = (initial: string | SendReport | AudioBackfillReport | WordResult[] | null) => {
    const index = stateIndex++;
    if (index === state.length) state.push(initial);
    return [state[index], (value: string | SendReport | AudioBackfillReport | WordResult[] | null) => { state[index] = value; }];
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
      finish = () => resolve({ audio: { unspeakable: 0, message: null }, results: [
        { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
      ], capReached: true, send: {
        status: 'sent', sent: 2, rejected: 0, pending: 0, syncedAt: 123, message: null,
      }, backfill: { status: 'nothing', sent: 0, rejected: 0, awaitingAudio: 0, unspeakable: 0, failureStage: null, message: null } });
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
  page.generate.mockResolvedValueOnce({ audio: { unspeakable: 0, message: null }, results: [
    { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
  ], capReached: false, send: {
    status: 'sent', sent: 2, rejected: 0, pending: 0, syncedAt: 123, message: null,
  }, backfill: { status: 'sent', sent: 1, rejected: 0, awaitingAudio: 0, unspeakable: 0, failureStage: null, message: null } });
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
      page.generate.mockResolvedValueOnce({ audio: { unspeakable: 0, message: null }, results: [
        { word: 'casa', status: 'skipped', vocabCards: 0, conjugationCards: 0 },
      ], capReached: false, send, backfill: report });
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
      page.generate.mockResolvedValueOnce({ audio: { unspeakable: 0, message: null }, results: [
        { word: 'casa', status: 'skipped', vocabCards: 0, conjugationCards: 0 },
      ], capReached: false, send, backfill });
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
    page.generate.mockResolvedValueOnce({ audio: { unspeakable: 0, message: null }, results: [], capReached: false,
      send: { status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null },
      backfill: { status: 'failed', sent: 1, rejected: 0, awaitingAudio: 1, unspeakable: 0, failureStage: null, message: 'old backfill failure' },
    });
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
    page.generate.mockResolvedValueOnce({ results: [], audio: { unspeakable: 0, message: null }, capReached: true, send: noSend, backfill });
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
  page.generate.mockResolvedValueOnce({ capReached: false,
    results: [{ word: 'hablar', status: 'added', vocabCards: 1, conjugationCards: 2 }],
    audio: { unspeakable: 1, message: 'Unsupported card audio HTML tag "<b>"; check cardGenerator output (expected plain text with <br> separators only).' },
    send: noSend, backfill: { ...noBackfill, status: 'failed', awaitingAudio: 1, unspeakable: 1,
      failureStage: 'prepare', message: 'Unsupported card audio HTML tag "<b>"; check cardGenerator output (expected plain text with <br> separators only).' },
  });
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
    page.generate.mockResolvedValueOnce({ results: [], audio: { unspeakable: 0, message: null }, capReached: false,
      send: noSend, backfill: noBackfill });
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
