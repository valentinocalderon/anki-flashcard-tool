# Spanish to Anki

Turn pasted words or text into Spanish vocabulary, example-sentence, and conjugation cards using OpenAI, then send them to Anki in one click. Lookups and cards are saved locally to avoid regenerating existing cards.

## Setup

1. Create a `.env` file in the project root and set `OPENAI_API_KEY` to your OpenAI API key. Spanish audio also requires `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` for your ElevenLabs key and Spanish voice.
2. In Anki desktop, open **Tools → Add-ons → Get Add-ons**, enter code `2055492159` to install AnkiConnect, and restart Anki. Keep Anki open while sending cards.
3. Install dependencies and start the app:

   ```sh
   npm install
   npm run dev
   ```

4. Open [localhost:3000](http://localhost:3000). To sync cards to your phone, sign in to AnkiWeb in Anki desktop.

## One-click flow

Paste a Brainscape pack URL alone in the box to fetch every deck and make cards from each card's Spanish side, deduped against what is already stored. Anything else is a word list: lines, commas, semicolons, bullets, numbering, or a plain sentence. Click **Generate and send to Anki**. The app looks up each word, saves new cards, sends pending cards to Anki, and requests an AnkiWeb sync when it processes pending cards.

Each result line shows its outcome: ✓ added, ↻ updated, – already existed or skipped, and ! failed. An updated result means the saved card changed; check Anki if it was already sent. The send report shows delivery and sync status. When existing cards gained audio, sync Anki desktop with AnkiWeb first, then sync Anki on your phone. Otherwise, after a successful sync, sync Anki on your phone to study the cards.

Migration note: the first pack re-run after the forms migration reports updated once per old folded card.

## Decks and cards

- **Spanish::Vocab**: vocabulary cards use **Basic (and reversed card)** for English ↔ Spanish; fill-in-the-blank example cards use **Basic**.
- **Spanish::Conjugation**: present and preterite conjugation cards use **Basic**. Shared regular and stem-change patterns are added once; irregular forms get their own cards.

The app creates these decks when needed.

New cards carry ElevenLabs Spanish audio on their Back field, except when the run hits the audio cap or a card's text cannot be prepared for speech (the card is still generated, saved, and sent without audio), or when the voice service fails (the item is reported as failed and its new cards are not saved). A run stops requesting audio at 30000 characters and the page says the audio cap was reached.

After generation and sending, sending pending cards, or retrying declined cards, missing or changed audio is backfilled onto cards already in Anki through `updateNoteFields`. The Anki note's Back field receives the uploaded audio's sound tag, and the page reports how many existing cards gained audio and any backfill failure. These updates happen after the pending-card sync, so the page asks for a manual Anki desktop sync whenever any audio was pushed, including before a partial backfill failure. With no pending cards, there is no automatic sync.

The first run after the audio delivery marker migration makes a one-time pass over every card already in Anki, so its reported count includes cards whose audio Anki already had. This pass rewrites each note's Back field from the stored text, so hand edits made inside Anki on already-sent cards are replaced.

Generation and backfill share one 30000-character audio cap per run. Audio already stored locally is reused; cards left without audio at the cap can gain it on a later run.

## Sending saved cards

- **Send N pending cards** sends saved cards that have not been sent or declined, without running generation again. Use it after reopening Anki or resolving a send failure.
- **Retry N declined cards** retries cards Anki declined, together with any pending cards. Declined cards stay out of automatic sends; if Anki declines them again, they remain visible for another explicit retry.

Both buttons show the current count and are disabled while generation or sending is in progress.
