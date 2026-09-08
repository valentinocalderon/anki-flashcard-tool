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

function pageRun(pending = 1, declined = 1) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: Infinity } } });
  const send = vi.fn<() => Promise<{ send: SendReport; backfill: SendReport }>>()
    .mockRejectedValue(new Error('Unexpected send request.'));
  const retry = vi.fn<() => Promise<{ send: SendReport; backfill: SendReport }>>()
    .mockRejectedValue(new Error('Unexpected retry request.'));
  const generate = vi.fn<(input: { text: string }) => Promise<{
    results: WordResult[]; capReached: boolean; send: SendReport; backfill: SendReport;
  }>>().mockRejectedValue(new Error('Unexpected generation request.'));
  const sending = pageMutation(client, send);
  const retrying = pageMutation(client, retry);
  const generation = pageMutation(client, generate);
  const api = { anki: {
    pendingCount: { useQuery: () => ({ data: pending, refetch: vi.fn().mockResolvedValue({ data: pending }) }) },
    declinedCount: { useQuery: () => ({ data: declined, refetch: vi.fn().mockResolvedValue({ data: declined }) }) },
    sendPending: sending, retryDeclined: retrying, generateFromList: generation,
  } };
  const state: (string | SendReport | WordResult[] | null)[] = ['casa'];
  let stateIndex = 0;
  const useState = (initial: string | SendReport | WordResult[] | null) => {
    const index = stateIndex++;
    if (index === state.length) state.push(initial);
    return [state[index], (value: string | SendReport | WordResult[] | null) => { state[index] = value; }];
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
    send, retry, generate, sending, retrying, generation,
    html: () => renderToStaticMarkup(render()),
    submit: () => {
      const form = children().find((child) => React.isValidElement(child) && child.type === 'form');
      if (!React.isValidElement<{ onSubmit: (event: { preventDefault: () => void }) => void }>(form)) {
        throw new Error('Expected the generation form.');
      }
      form.props.onSubmit({ preventDefault: vi.fn() });
    },
    sendFromFooter: (action: 'onSend' | 'onRetry') => {
      const footer = children().find((child) =>
        React.isValidElement(child) && typeof child.type === 'function',
      );
      if (!React.isValidElement<{ onSend: () => void; onRetry: () => void }>(footer)) {
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
      finish = () => resolve({ results: [
        { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
      ], capReached: true, send: {
        status: 'sent', sent: 2, rejected: 0, pending: 0, syncedAt: 123, message: null,
      }, backfill: { status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null } });
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
  page.generate.mockResolvedValueOnce({ results: [
    { word: 'casa', status: 'added', vocabCards: 2, conjugationCards: 0 },
  ], capReached: false, send: {
    status: 'sent', sent: 2, rejected: 0, pending: 0, syncedAt: 123, message: null,
  }, backfill: { status: 'sent', sent: 1, rejected: 0, pending: 0, syncedAt: null, message: null } });
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

const backfillOutcomes: { name: string; report: SendReport; line: string | null; alert: string | null }[] = [
  {
    name: 'one card', line: '<p>1 card already in Anki gained audio.</p>', alert: null,
    report: { status: 'sent', sent: 1, rejected: 0, pending: 0, syncedAt: null, message: null },
  },
  {
    name: 'multiple cards', line: '<p>2 cards already in Anki gained audio.</p>', alert: null,
    report: { status: 'sent', sent: 2, rejected: 0, pending: 0, syncedAt: null, message: null },
  },
  {
    name: 'partial failure', line: '<p>1 card already in Anki gained audio.</p>',
    alert: '<p role="alert" class="text-red-600">Audio backfill failed: note was not found: 102</p>',
    report: { status: 'failed', sent: 1, rejected: 0, pending: 2, syncedAt: null, message: 'note was not found: 102' },
  },
  {
    name: 'partial voice failure', line: '<p>1 card already in Anki gained audio.</p>',
    alert: '<p role="alert" class="text-red-600">Audio backfill failed: ElevenLabs request returned HTTP 429: quota exceeded; check the response before retrying.</p>',
    report: { status: 'failed', sent: 1, rejected: 0, pending: 1, syncedAt: null,
      message: 'ElevenLabs request returned HTTP 429: quota exceeded; check the response before retrying.' },
  },
  {
    name: 'partial Anki timeout', line: '<p>1 card already in Anki gained audio.</p>',
    alert: '<p role="alert" class="text-red-600">Audio backfill failed: AnkiConnect request timed out: The operation timed out</p>',
    report: { status: 'anki_closed', sent: 1, rejected: 0, pending: 1, syncedAt: null,
      message: 'AnkiConnect request timed out: The operation timed out' },
  },
  {
    name: 'voice failure', line: null,
    alert: '<p role="alert" class="text-red-600">Audio backfill failed: ElevenLabs request returned HTTP 429: quota exceeded; check the response before retrying.</p>',
    report: { status: 'failed', sent: 0, rejected: 0, pending: 1, syncedAt: null,
      message: 'ElevenLabs request returned HTTP 429: quota exceeded; check the response before retrying.' },
  },
  {
    name: 'unreachable Anki', line: null,
    alert: '<p role="alert" class="text-red-600">Audio backfill failed: AnkiConnect request timed out: The operation timed out</p>',
    report: { status: 'anki_closed', sent: 0, rejected: 0, pending: 1, syncedAt: null,
      message: 'AnkiConnect request timed out: The operation timed out' },
  },
  {
    name: 'nothing sent', line: null, alert: null,
    report: { status: 'nothing', sent: 0, rejected: 0, pending: 1, syncedAt: null, message: null },
  },
];

test.each(backfillOutcomes.flatMap((outcome) => ['generation', 'sending', 'retrying'].map((mutation) => ({ ...outcome, mutation }))))(
  '$mutation displays backfill $name even when there are no pending or declined cards', async ({ mutation, report, line, alert }) => {
    const page = pageRun(0, 0);
    const send: SendReport = { status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null };
    if (mutation === 'generation') {
      page.generate.mockResolvedValueOnce({ results: [
        { word: 'casa', status: 'skipped', vocabCards: 0, conjugationCards: 0 },
      ], capReached: false, send, backfill: report });
      page.submit();
      await page.generation.run;
      expect(page.html().match(/<li\b[^>]*>.*?<\/li>/g)).toEqual([
        '<li class="bg-gray-100 p-3 rounded"><span aria-hidden="true" class="text-xs mr-2">–</span><strong>casa</strong>: skipped: already stored</li>',
      ]);
    } else if (mutation === 'sending') {
      page.send.mockResolvedValueOnce({ send, backfill: report });
      page.sendFromFooter('onSend');
      await page.sending.run;
    } else {
      page.retry.mockResolvedValueOnce({ send, backfill: report });
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
    expect(html).not.toContain('<button type="button"');
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
    const backfill: SendReport = { status: 'sent', sent: 1, rejected: 0, pending: 0, syncedAt: null, message: null };
    if (mutation === 'generation') {
      page.generate.mockResolvedValueOnce({ results: [
        { word: 'casa', status: 'skipped', vocabCards: 0, conjugationCards: 0 },
      ], capReached: false, send, backfill });
      page.submit();
      await page.generation.run;
    } else if (mutation === 'sending') {
      page.send.mockResolvedValueOnce({ send, backfill });
      page.sendFromFooter('onSend');
      await page.sending.run;
    } else {
      page.retry.mockResolvedValueOnce({ send, backfill });
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
    page.generate.mockResolvedValueOnce({ results: [], capReached: false,
      send: { status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null },
      backfill: { status: 'failed', sent: 1, rejected: 0, pending: 1, syncedAt: null, message: 'old backfill failure' },
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
  page.send.mockResolvedValueOnce({
    send: { status: 'sent', sent: 1, rejected: 0, pending: 0, syncedAt: 123, message: null },
    backfill: { status: 'sent', sent: 2, rejected: 0, pending: 0, syncedAt: null, message: null },
  });
  page.sendFromFooter('onSend');
  await page.sending.run;
  expect(page.html()).not.toContain('Synced to AnkiWeb at ');
  expect(page.html()).toContain('Sync Anki desktop with AnkiWeb, then sync Anki on your phone to get this audio.');
  expect(page.html()).toContain('<p>2 cards already in Anki gained audio.</p>');

  page.retry.mockResolvedValueOnce({
    send: { status: 'sent', sent: 1, rejected: 0, pending: 0, syncedAt: 456, message: null },
    backfill: { status: 'nothing', sent: 0, rejected: 0, pending: 0, syncedAt: null, message: null },
  });
  page.sendFromFooter('onRetry');
  await page.retrying.run;
  expect(page.html()).toContain('Synced to AnkiWeb at ');
  expect(page.html()).not.toContain('already in Anki gained audio');
  expect(page.html()).not.toContain('Sync Anki desktop with AnkiWeb');
});
