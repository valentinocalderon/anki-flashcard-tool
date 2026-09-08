'use client';

import { useState } from 'react';
import { formatResultLine } from '@/lib/resultLine';
import type { SendReport } from '@/lib/services/ankiSender';
import type { AudioBackfillReport } from '@/lib/services/audioBackfill';
import type { WordResult } from '@/lib/types';
import { api } from '@/trpc/react';

function useAnkiRun() {
  const [sendReport, setSendReport] = useState<SendReport | null>(null);
  const [results, setResults] = useState<WordResult[]>([]);
  const [backfillReport, setBackfillReport] = useState<AudioBackfillReport | null>(null);
  const pendingCount = api.anki.pendingCount.useQuery();
  const declinedCount = api.anki.declinedCount.useQuery();
  const awaitingAudioCount = api.anki.awaitingAudioCount.useQuery();
  const refreshCounts = async () => {
    await Promise.all([pendingCount.refetch(), declinedCount.refetch(), awaitingAudioCount.refetch()]);
  };
  const sendOptions = {
    onSuccess: ({ send, backfill }: { send: SendReport; backfill: AudioBackfillReport }) => {
      setSendReport(send);
      setBackfillReport(backfill);
    },
    onSettled: refreshCounts,
  };
  const sending = api.anki.sendPending.useMutation({
    ...sendOptions,
    onMutate: () => {
      generation.reset();
      retrying.reset();
      voicing.reset();
      setSendReport(null);
      setBackfillReport(null);
    },
  });
  const retrying = api.anki.retryDeclined.useMutation({
    ...sendOptions,
    onMutate: () => {
      generation.reset();
      sending.reset();
      voicing.reset();
      setSendReport(null);
      setBackfillReport(null);
    },
  });
  const voicing = api.anki.backfillAudio.useMutation({
    onMutate: () => {
      generation.reset();
      sending.reset();
      retrying.reset();
      setSendReport(null);
      setBackfillReport(null);
    },
    onSuccess: ({ backfill }) => setBackfillReport(backfill),
    onSettled: refreshCounts,
  });
  const generation = api.anki.generateFromList.useMutation({
    onMutate: () => {
      sending.reset();
      retrying.reset();
      voicing.reset();
      setSendReport(null);
      setBackfillReport(null);
      setResults([]);
    },
    onSuccess: ({ results, send, backfill }) => {
      setResults(results);
      setSendReport(send);
      setBackfillReport(backfill);
    },
    onSettled: refreshCounts,
  });
  return {
    sendReport, backfillReport, results, pendingCount, declinedCount, awaitingAudioCount, generation, sending, retrying, voicing,
    isPending: generation.isPending || sending.isPending || retrying.isPending || voicing.isPending,
    capReached: [generation.data, sending.data, retrying.data, voicing.data].some((report) => report?.capReached === true),
  };
}

export default function HomePage() {
  const [text, setText] = useState('');
  const {
    sendReport, backfillReport, results, pendingCount, declinedCount, awaitingAudioCount, generation, sending, retrying, voicing, isPending, capReached,
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
      {voicing.error && (
        <p role="alert" className="text-red-600">{voicing.error.message}</p>
      )}
      {awaitingAudioCount.error && (
        <p role="alert" className="text-red-600">{awaitingAudioCount.error.message}</p>
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
      {capReached && (
        <p aria-live="polite" className="text-sm mb-3">Audio cap reached for this run.</p>
      )}
      {generation.data && generation.data.audio.unspeakable > 0 && (
        <>
          <p>During generation, {generation.data.audio.unspeakable} {pluralise(generation.data.audio.unspeakable, 'card', 'cards')} could not be spoken.</p>
          <p role="alert" className="text-red-600">{generation.data.audio.message}</p>
        </>
      )}
      <ul aria-live="polite" className="text-sm space-y-2">
        {results.map((result, index) => <ResultLine key={index} result={result} />)}
      </ul>
      <SendFooter
        report={sendReport}
        backfill={backfillReport}
        pendingCount={pendingCount.data}
        declinedCount={declinedCount.data ?? 0}
        awaitingAudioCount={awaitingAudioCount.data}
        isPending={isPending}
        onSend={() => sending.mutate()}
        onRetry={() => retrying.mutate()}
        onVoice={() => voicing.mutate()}
      />
    </main>
  );
}

function pluralise(count: number, singular: string, plural: string) {
  return count === 1 ? singular : plural;
}

function SendFooter({ report, backfill, pendingCount, declinedCount, awaitingAudioCount, isPending, onSend, onRetry, onVoice }: {
  report: SendReport | null;
  backfill: AudioBackfillReport | null;
  pendingCount: number | undefined;
  declinedCount: number;
  awaitingAudioCount: number | undefined;
  isPending: boolean;
  onSend: () => void;
  onRetry: () => void;
  onVoice: () => void;
}) {
  const awaitingAudio = awaitingAudioCount ?? backfill?.awaitingAudio ?? 0;
  const waiting = pendingCount ?? report?.pending ?? 0;
  const hasReport = report?.status === 'sent' || report?.status === 'failed' || report?.status === 'anki_closed';
  const backfillFailed = backfill?.status === 'failed' || backfill?.status === 'anki_closed';
  const backfilled = backfill?.sent ?? 0;
  if (!hasReport && !backfillFailed && backfilled === 0 && waiting === 0 && declinedCount === 0 && awaitingAudio === 0) {
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
          ) : backfilled > 0 ? (
            <p>Sent to Anki.</p>
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
      {backfilled > 0 && (
        <>
          <p>{backfilled} {pluralise(backfilled, 'card', 'cards')} already in Anki gained audio.</p>
          <p>Sync Anki desktop with AnkiWeb, then sync Anki on your phone to get this audio.</p>
        </>
      )}
      {backfillFailed && (
        <p role="alert" className="text-red-600">Audio backfill failed: {backfill.message}</p>
      )}
      {backfill && backfill.unspeakable > 0 && (
        <p>During audio backfill, {backfill.unspeakable} {pluralise(backfill.unspeakable, 'card', 'cards')} could not be spoken.</p>
      )}
      {backfill && backfill.rejected > 0 && (
        <p>Anki declined audio for {backfill.rejected} {pluralise(backfill.rejected, 'card', 'cards')}.</p>
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
      {awaitingAudio > 0 && (
        <div className="bg-gray-100 p-3 rounded space-y-3">
          <p>{awaitingAudio} {pluralise(awaitingAudio, 'card is', 'cards are')} waiting for audio.</p>
          <button
            type="button"
            disabled={isPending}
            onClick={onVoice}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Voice {awaitingAudio} {pluralise(awaitingAudio, 'card', 'cards')} waiting for audio
          </button>
        </div>
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
