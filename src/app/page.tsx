'use client';

import { useState } from 'react';
import { api } from '@/trpc/react';
import type { WordInfo } from '@/lib/types';
import type { Card } from '@/lib/types'; // ✅ Add this

export default function HomePage() {
  const [input, setInput] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);

  const { data, isLoading, error } = api.anki.getWordInfo.useQuery(
    { word: submitted ?? '' },
    { enabled: !!submitted }
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) {
      setSubmitted(input.trim());
    }
  };

  return (
    <main className="max-w-2xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-4">Anki Flashcard Lookup</h1>

      <form onSubmit={handleSubmit} className="flex gap-4 mb-6">
        <input
          type="text"
          placeholder="Enter a word (English or Spanish)"
          className="border border-gray-300 rounded px-3 py-2 w-full"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button
          type="submit"
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
        >
          Search
        </button>
      </form>

      {isLoading && <p>🔄 Loading...</p>}
      {error && <p className="text-red-600">❌ Error: {error.message}</p>}
      {data?.[0]?.error && <p className="text-yellow-600">⚠️ {data[0].error}</p>}

      {data && !data[0].error && <ResultsCard wordInfo={data[0]} cards={data[1]} />}
    </main>
  );
}

function ResultsCard({ wordInfo, cards }: { wordInfo: WordInfo; cards: Card[] }) {
  return (
    <div className="bg-gray-100 p-4 rounded shadow">
      <h2 className="text-lg font-semibold mb-2">
        English: <span className="italic">{wordInfo.english}</span>
      </h2>
      <ul className="text-sm space-y-1">
        <li><strong>Spanish:</strong> {wordInfo.spanish}</li>
        <li><strong>Type:</strong> {wordInfo.type}</li>
        <li><strong>Gender:</strong> {wordInfo.gender ?? '—'}</li>
        <li><strong>Example:</strong> {wordInfo.example ?? '—'}</li>
      </ul>

      {wordInfo.conjugations && (
        <div className="mt-4">
          <h3 className="font-semibold text-sm mb-1">Conjugations:</h3>
          {Object.entries(wordInfo.conjugations).map(([tense, forms]) => (
            <div key={tense} className="mb-2">
              <h4 className="font-semibold text-xs capitalize">{tense}</h4>
              <ul className="text-sm list-disc list-inside ml-4">
                {Object.entries(forms).map(([pronoun, verb]) => (
                  <li key={pronoun}>
                    <strong>{pronoun}:</strong> {verb}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <div className="mt-6">
        <h3 className="text-md font-semibold mb-2">🧠 Generated Cards:</h3>
        {cards.map((card, idx) => (
          <div
            key={idx}
            className="border border-gray-300 rounded p-3 mb-3 bg-white shadow-sm"
          >
            <p><strong>Front:</strong> {card.front}</p>
            <p><strong>Back:</strong> {card.back}</p>
            {card.tags && card.tags?.length > 0 && (
              <p className="text-xs text-gray-600 mt-1">
                <strong>Tags:</strong> {card.tags.join(', ')}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
