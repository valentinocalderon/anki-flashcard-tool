UPDATE cards SET declined_at = sent_at, sent_at = NULL WHERE anki_note_id IS NULL AND sent_at IS NOT NULL;
