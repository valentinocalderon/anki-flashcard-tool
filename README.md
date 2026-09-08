# Spanish to Anki

Turn pasted words or text into Spanish vocabulary, example-sentence, and conjugation cards using OpenAI, then send them to Anki in one click. Lookups and cards are saved locally to avoid regenerating existing cards.

## Setup

1. Create a `.env` file in the project root and set `OPENAI_API_KEY` to your OpenAI API key.
2. In Anki desktop, open **Tools → Add-ons → Get Add-ons**, enter code `2055492159` to install AnkiConnect, and restart Anki. Keep Anki open while sending cards.
3. Install dependencies and start the app:

   ```sh
   npm install
   npm run dev
   ```

4. Open [localhost:3000](http://localhost:3000). To sync cards to your phone, sign in to AnkiWeb in Anki desktop.

## One-click flow

Paste a Brainscape pack URL alone in the box to fetch every deck and make cards from each card's Spanish side, deduped against what is already stored. Anything else is a word list: lines, commas, semicolons, bullets, numbering, or a plain sentence. Click **Generate and send to Anki**. The app looks up each word, saves new cards, sends pending cards to Anki, and requests an AnkiWeb sync.

Each result line shows its outcome: ✓ added, ↻ updated, – already existed or skipped, and ! failed. An updated result means the saved card changed; check Anki if it was already sent. The send report shows delivery and sync status. After a successful sync, sync Anki on your phone to study the cards.

## Decks and cards

- **Spanish::Vocab**: vocabulary cards use **Basic (and reversed card)** for English ↔ Spanish; fill-in-the-blank example cards use **Basic**.
- **Spanish::Conjugation**: present and preterite conjugation cards use **Basic**. Shared regular and stem-change patterns are added once; irregular forms get their own cards.

The app creates these decks when needed.

## Sending saved cards

- **Send N pending cards** sends saved cards that have not been sent or declined, without running generation again. Use it after reopening Anki or resolving a send failure.
- **Retry N declined cards** retries cards Anki declined, together with any pending cards. Declined cards stay out of automatic sends; if Anki declines them again, they remain visible for another explicit retry.

Both buttons show the current count and are disabled while generation or sending is in progress.
