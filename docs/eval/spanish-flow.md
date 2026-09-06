# Spanish word list to Anki cards

**What exists today.** One word at a time. You type a word on the home page; the app asks OpenAI for meaning, gender, article, part of speech, an example sentence and conjugations, then builds cards in memory (basic, reverse, gender, cloze, conjugation) and renders them in the browser. Card types and tags come from the config; deck name and model name are validated but never used.

**What is missing.**
- No list input: no textarea, no file upload, no batching. Every word is a separate query.
- No export: cards never leave the browser. No .apkg writer, no TSV, no AnkiConnect push. The old feature/anki-export branch had an .apkg writer with a wrong download URL; it is not on this branch.
- No persistence: a page refresh loses everything.

**Simplest path.**
1. Add a list input on the page (one word per line) that calls the existing lookup once per word, in sequence, and collects the cards.
2. Add one "Download TSV" action that writes the collected cards in Anki's plain-text import format (front, back, tags). Anki's File, Import menu reads TSV natively: no library, no AnkiConnect, no deck plumbing.
3. In Anki, pick the deck and the Basic note type at import. Cloze cards need the Cloze note type, so write them to a second file or skip cloze at first.

Two small units: list input with sequential lookup, then TSV download. AnkiConnect or .apkg can follow only if the import step becomes a chore.
