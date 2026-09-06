CREATE TABLE `cards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`word_id` integer NOT NULL,
	`deck` text NOT NULL,
	`kind` text NOT NULL,
	`front` text NOT NULL,
	`back` text NOT NULL,
	`tags` text NOT NULL,
	`anki_note_id` integer,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`word_id`) REFERENCES `words`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cards_deck_front_unique` ON `cards` (`deck`,`front`);--> statement-breakpoint
CREATE TABLE `conjugation_patterns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ending` text NOT NULL,
	`pattern` text NOT NULL,
	`tense` text NOT NULL,
	`card_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conjugation_patterns_ending_pattern_tense_unique` ON `conjugation_patterns` (`ending`,`pattern`,`tense`);--> statement-breakpoint
CREATE TABLE `words` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`query` text NOT NULL,
	`info` text NOT NULL,
	`looked_up_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `words_query_unique` ON `words` (`query`);