'use client';

import { useState } from 'react';
import type { WordResult } from '@/lib/services/listGenerationService';
import { api } from '@/trpc/react';

export default function HomePage() {
  const [text, setText] = useState('');
  const generation = api.anki.generateFromList.useMutation();

  return (
    <main className="max-w-2xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-4">Spanish to Anki</h1>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          generation.mutate({ text });
        }}
        className="flex flex-col gap-3 mb-6"
      >
        <label htmlFor="words" className="font-semibold">Words, one per line</label>
        <textarea
          id="words"
          rows={8}
          required
          className="border border-gray-300 rounded px-3 py-2 w-full"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <button
          type="submit"
          disabled={generation.isPending}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 self-start disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Generate
        </button>
      </form>

      {generation.error && (
        <p role="alert" className="text-red-600">{generation.error.message}</p>
      )}
      <ul aria-live="polite" className="text-sm space-y-2">
        {generation.data?.map((result) => <ResultLine key={result.word} result={result} />)}
      </ul>
    </main>
  );
}

function ResultLine({ result }: { result: WordResult }) {
  const mark = { added: '✓', exists: '–', error: '!' }[result.status];

  return (
    <li className="bg-gray-100 p-3 rounded">
      <span aria-hidden="true" className="text-xs mr-2">{mark}</span>
      <strong>{result.word}</strong>:{' '}
      {result.status === 'added' && (
        <>
          {result.vocabCards} vocab cards
          {result.conjugationCards > 0 && ` plus ${result.conjugationCards} conjugation cards`}
        </>
      )}
      {result.status === 'exists' && 'already stored'}
      {result.status === 'error' && result.message}
    </li>
  );
}
