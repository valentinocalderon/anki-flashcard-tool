'use client';

import { useState } from 'react';
import { formatResultLine } from '@/lib/resultLine';
import type { SendReport } from '@/lib/services/ankiSender';
import type { WordResult } from '@/lib/types';
import { api } from '@/trpc/react';

export default function HomePage() {
  const [text, setText] = useState('');
  const [sendReport, setSendReport] = useState<SendReport | null>(null);
  const [results, setResults] = useState<WordResult[]>([]);
  const clearPreviousRun = () => {
    setSendReport(null);
    setResults([]);
  };
  const pendingCount = api.anki.pendingCount.useQuery();
  const generation = api.anki.generateFromList.useMutation({
    onMutate: clearPreviousRun,
    onSuccess: ({ results, send }) => {
      setResults(results);
      setSendReport(send);
    },
    onSettled: async () => {
      await pendingCount.refetch();
    },
  });
  const sending = api.anki.sendPending.useMutation({
    onMutate: () => setSendReport(null),
    onSuccess: (send) => setSendReport(send),
    onSettled: async () => {
      await pendingCount.refetch();
    },
  });
  const isPending = generation.isPending || sending.isPending;

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
      {pendingCount.error && (
        <p role="alert" className="text-red-600">{pendingCount.error.message}</p>
      )}
      <ul aria-live="polite" className="text-sm space-y-2">
        {results.map((result) => <ResultLine key={result.word} result={result} />)}
      </ul>
      <SendFooter
        report={sendReport}
        pendingCount={pendingCount.data}
        isPending={isPending}
        onSend={() => sending.mutate()}
      />
    </main>
  );
}

function pluralise(count: number, singular: string, plural: string) {
  return count === 1 ? singular : plural;
}

function SendFooter({ report, pendingCount, isPending, onSend }: {
  report: SendReport | null;
  pendingCount: number | undefined;
  isPending: boolean;
  onSend: () => void;
}) {
  const hasPending = pendingCount !== undefined && pendingCount > 0;
  if (report?.status !== 'sent' && report?.status !== 'failed' && !hasPending) return null;

  return (
    <footer aria-live="polite" className="mt-6 text-sm space-y-3">
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
      {hasPending && (
        <div className="bg-gray-100 p-3 rounded space-y-3">
          <p>
            {report?.status === 'anki_closed' && 'Anki is not running. '}
            {pendingCount} {pluralise(pendingCount, 'card is', 'cards are')} waiting to be sent.
          </p>
          <button
            type="button"
            disabled={isPending}
            onClick={onSend}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Send {pendingCount} pending {pluralise(pendingCount, 'card', 'cards')}
          </button>
        </div>
      )}
    </footer>
  );
}

function ResultLine({ result }: { result: WordResult }) {
  const mark = { added: '✓', exists: '–', error: '!' }[result.status];

  return (
    <li className="bg-gray-100 p-3 rounded">
      <span aria-hidden="true" className="text-xs mr-2">{mark}</span>
      <strong>{result.word}</strong>:{' '}
      {formatResultLine(result)}
    </li>
  );
}
