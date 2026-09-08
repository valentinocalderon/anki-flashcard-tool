import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { MutationObserver, QueryClient, type MutationObserverOptions } from '@tanstack/react-query';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';
import { afterEach, expect, test, vi } from 'vitest';
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

function pageRun() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: Infinity } } });
  const send = vi.fn<() => Promise<SendReport>>().mockRejectedValue(new Error('Unexpected send request.'));
  const retry = vi.fn<() => Promise<SendReport>>().mockRejectedValue(new Error('Unexpected retry request.'));
  const generate = vi.fn<(input: { text: string }) => Promise<{
    results: WordResult[]; capReached: boolean; send: SendReport;
  }>>().mockRejectedValue(new Error('Unexpected generation request.'));
  const sending = pageMutation(client, send);
  const retrying = pageMutation(client, retry);
  const generation = pageMutation(client, generate);
  const api = { anki: {
    pendingCount: { useQuery: () => ({ data: 1, refetch: vi.fn().mockResolvedValue({ data: 1 }) }) },
    declinedCount: { useQuery: () => ({ data: 1, refetch: vi.fn().mockResolvedValue({ data: 1 }) }) },
    sendPending: sending, retryDeclined: retrying, generateFromList: generation,
  } };
  const state: (string | SendReport | WordResult[] | null)[] = ['casa', null, []];
  let stateIndex = 0;
  const useState = () => {
    const index = stateIndex++;
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

afterEach(() => vi.unstubAllGlobals());

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
      } });
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
  } });
  page.submit();
  await page.generation.run;
  expect(page.html()).toContain('Synced to AnkiWeb at ');
  expect(page.html()).toContain('<strong>casa</strong>: 2 vocab cards');

  let fail: (() => void) | undefined;
  page.generate.mockImplementationOnce(() => new Promise((_resolve, reject) => {
    fail = () => reject(new Error('Brainscape pack request failed: HTTP 503.'));
  }));
  page.submit();
  await vi.waitFor(() => expect(page.generate).toHaveBeenCalledTimes(2));
  expect(page.html()).not.toContain('Synced to AnkiWeb at ');
  expect(page.html()).not.toContain('<strong>casa</strong>');
  if (!fail) throw new Error('Expected generation to start.');
  fail();
  await expect(page.generation.run).rejects.toThrow('Brainscape pack request failed: HTTP 503.');

  expect(page.html()).not.toContain('Synced to AnkiWeb at ');
  expect(page.html()).toContain('<p role="alert" class="text-red-600">Brainscape pack request failed: HTTP 503.</p>');
  expect(fetchImpl).not.toHaveBeenCalled();
});
