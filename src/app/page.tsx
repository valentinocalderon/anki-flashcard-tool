'use client';

import { useState } from 'react';
import { formatResultLine } from '@/lib/resultLine';
import type { SendReport } from '@/lib/services/ankiSender';
import type { WordResult } from '@/lib/types';
import { api } from '@/trpc/react';

function useAnkiRun() {
  const [sendReport, setSendReport] = useState<SendReport | null>(null);
  const [results, setResults] = useState<WordResult[]>([]);
  const pendingCount = api.anki.pendingCount.useQuery();
  const declinedCount = api.anki.declinedCount.useQuery();
  const refreshCounts = async () => {
    await Promise.all([pendingCount.refetch(), declinedCount.refetch()]);
  };
  const sendOptions = {
    onSuccess: (send: SendReport) => setSendReport(send),
    onSettled: refreshCounts,
  };
  const sending = api.anki.sendPending.useMutation({
    ...sendOptions,
    onMutate: () => {
      generation.reset();
      retrying.reset();
      setSendReport(null);
    },
  });
  const retrying = api.anki.retryDeclined.useMutation({
    ...sendOptions,
    onMutate: () => {
      generation.reset();
      sending.reset();
      setSendReport(null);
    },
  });
  const generation = api.anki.generateFromList.useMutation({
    onMutate: () => {
      sending.reset();
      retrying.reset();
      setSendReport(null);
      setResults([]);
    },
    onSuccess: ({ results, send }) => {
      setResults(results);
      setSendReport(send);
    },
    onSettled: refreshCounts,
  });
  return {
    sendReport, results, pendingCount, declinedCount, generation, sending, retrying,
    isPending: generation.isPending || sending.isPending || retrying.isPending,
  };
}

export default function HomePage() {
  const [text, setText] = useState('');
  const {
    sendReport, results, pendingCount, declinedCount, generation, sending, retrying, isPending,
  } = useAnkiRun();

  return (
    <main className="max-w-2xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-4">Spanish to Anki</h1>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!isPending) generation.mutate({ text });
        }}
        className="flex flex-col gap-3 mb-6"
      >
        <label htmlFor="words" className="font-semibold">Words: lines, commas or a sentence; a Brainscape pack URL alone runs the whole pack</label>
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
          disabled={isPending}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 self-start disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Generate and send to Anki
        </button>
      </form>

      {generation.error && (
        <p role="alert" className="text-red-600">{generation.error.message}</p>
      )}
      {sending.error && (
        <p role="alert" className="text-red-600">{sending.error.message}</p>
      )}
      {retrying.error && (
        <p role="alert" className="text-red-600">{retrying.error.message}</p>
      )}
      {pendingCount.error && (
        <p role="alert" className="text-red-600">{pendingCount.error.message}</p>
      )}
      {declinedCount.error && (
        <p role="alert" className="text-red-600">{declinedCount.error.message}</p>
      )}
      {generation.isSuccess && results.length === 0 && (
        <p aria-live="polite">No words found in the text.</p>
      )}
      {generation.data?.capReached && (
        <p aria-live="polite" className="text-sm mb-3">Audio cap reached for this run.</p>
      )}
      <ul aria-live="polite" className="text-sm space-y-2">
        {results.map((result, index) => <ResultLine key={index} result={result} />)}
      </ul>
      <SendFooter
        report={sendReport}
        pendingCount={pendingCount.data}
        declinedCount={declinedCount.data ?? 0}
        isPending={isPending}
        onSend={() => sending.mutate()}
        onRetry={() => retrying.mutate()}
      />
    </main>
  );
}

function pluralise(count: number, singular: string, plural: string) {
  return count === 1 ? singular : plural;
}

function SendFooter({ report, pendingCount, declinedCount, isPending, onSend, onRetry }: {
  report: SendReport | null;
  pendingCount: number | undefined;
  declinedCount: number;
  isPending: boolean;
  onSend: () => void;
  onRetry: () => void;
}) {
  const waiting = pendingCount ?? report?.pending ?? 0;
  const hasReport = report?.status === 'sent' || report?.status === 'failed' || report?.status === 'anki_closed';
  if (!hasReport && waiting === 0 && declinedCount === 0) {
    return null;
  }

  return (
    <footer aria-live="polite" className="mt-6 text-sm space-y-3">
      {report?.status === 'anki_closed' && (
        <p>{report.message ?? 'Anki is not running.'}</p>
      )}
      {report?.status === 'failed' && (
        <p role="alert" className="text-red-600">Anki returned an error: {report.message}</p>
      )}
      {report?.status === 'sent' && (
        <div className="space-y-2">
          {report.syncedAt === null ? (
            <p>Sent to Anki. AnkiWeb sync failed: {report.message}</p>
          ) : (
            <p>
              Synced to AnkiWeb at {new Date(report.syncedAt).toLocaleTimeString('en-GB', {
                hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
              })}. {report.sent > 0 && 'Open Anki on your phone and it pulls the new cards.'}
            </p>
          )}
          {report.rejected > 0 && (
            <p>Anki declined {report.rejected} {pluralise(report.rejected, 'card', 'cards')}.</p>
          )}
        </div>
      )}
      {waiting > 0 && (
        <div className="bg-gray-100 p-3 rounded space-y-3">
          <p>
            {waiting} {pluralise(waiting, 'card is', 'cards are')} waiting to be sent.
          </p>
          <button
            type="button"
            disabled={isPending}
            onClick={onSend}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Send {waiting} pending {pluralise(waiting, 'card', 'cards')}
          </button>
        </div>
      )}
      {declinedCount > 0 && (
        <button
          type="button"
          disabled={isPending}
          onClick={onRetry}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Retry {declinedCount} declined {pluralise(declinedCount, 'card', 'cards')}
        </button>
      )}
    </footer>
  );
}

function ResultLine({ result }: { result: WordResult }) {
  const mark = { added: '✓', updated: '↻', exists: '–', skipped: '–', error: '!' }[result.status];

  return (
    <li className="bg-gray-100 p-3 rounded">
      <span aria-hidden="true" className="text-xs mr-2">{mark}</span>
      <strong>{result.word}</strong>:{' '}
      {formatResultLine(result)}
    </li>
  );
}
