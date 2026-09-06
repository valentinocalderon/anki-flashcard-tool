# Repo state — anki-flashcard-tool (feature/kit-eval)

Superseded by unit eval-01 on 2026-09-06: config.json is deleted, the key is read only through src/env.js, and `npm run check` and `npm run build` pass. The findings below describe the tree before that unit.

Date: 2026-09-06. Read-only evaluation. Investigator: fresh-context Claude (opus) subagent — the Codex investigator could not start nested inside the driver sandbox ("failed to initialize in-process app-server client: Operation not permitted"); see Open questions. Build commands were run once by the driver from the repo root; output quoted verbatim. All paths relative to the repo root.

## Branches and remotes

`git remote -v` shows one remote, not two:

```
origin	https://github.com/valentinocalderon/anki-flashcard-tool.git (fetch)
origin	https://github.com/valentinocalderon/anki-flashcard-tool.git (push)
```

origin holds three refs, all stale (no fetch was run): origin/main = 398a135 "Initial commit from create T3 app"; origin/develop = 8654cd5 "Complete config system setup"; origin/feature/config-setup = 398a135 (same as main). No origin ref exists for feature/anki-export, feature/anki-export-2, feature/kit-eval, or feature/word-lookup.

Seven local branches, one linear chain off 398a135; none is behind main:

| branch | tip | ahead of main | upstream |
|---|---|---|---|
| main | 398a135 | 0 | origin/main, in sync |
| feature/config-setup | 8654cd5 | 1 | origin/feature/config-setup, ahead 1 |
| feature/word-lookup | 7822e45 | 4 | none |
| develop | 1f822be | 5 | origin/develop, ahead 4 |
| feature/anki-export-2 | 1f822be | 5 | none |
| feature/anki-export | 7cd76e2 | 5 | none |
| feature/kit-eval (HEAD) | 8c6797f | 6 | none |

Chain: 8654cd5, then fb7e774, then 0221d17, then 7822e45, then a fork: 1f822be "Renamed router and route to anki" (develop / anki-export-2) vs 7cd76e2 "First attempt anki export" (anki-export).

- develop and feature/anki-export-2 are the identical commit 1f822be. anki-export-2 is a duplicate label, not separate work.
- feature/anki-export vs feature/anki-export-2 (11 files): anki-export-2 deletes the export feature — src/lib/utils/ankiExporter.ts (-20), src/lib/types/anki-apkg-export.d.ts (-7), the anki-apkg-export dependency in package.json, and 131 lines of src/app/page.tsx. It renames src/lib/types/types.ts to src/lib/types.ts and routers/ankiRouter.ts to routers/lookupRouter.ts (src/server/api/root.ts:3). The "-2" branch is a revert, not a follow-up.
- feature/anki-export-2 vs feature/kit-eval: 2 files, 9 insertions. Commit 8c6797f renames wordInfoSchema to WordInfoSchema (src/lib/types.ts:25, src/lib/services/aiLookup.ts:3,46) and adds CardSchema (src/lib/types.ts:43-47, no trailing newline). Nothing else.
- feature/word-lookup vs develop: 3 files; develop adds 145 lines to src/app/page.tsx plus the router rename.

Working tree clean; zero untracked non-ignored files.

## Build chain

Node v22.18.0, npm 10.9.3. Run 2026-09-06 inside a network-filtered sandbox.

**npm ci — exit 0.** "added 356 packages in 5s".

**npm run check (`next lint && tsc --noEmit`, package.json:8) — exit 1.** Five ESLint errors, verbatim:

```
./src/app/page.tsx
13:23  Error: Prefer using nullish coalescing operator (`??`) instead of a logical or (`||`), as it is a safer operator.  @typescript-eslint/prefer-nullish-coalescing
62:55  Error: Prefer using nullish coalescing operator (`??`) instead of a logical or (`||`), as it is a safer operator.  @typescript-eslint/prefer-nullish-coalescing
63:57  Error: Prefer using nullish coalescing operator (`??`) instead of a logical or (`||`), as it is a safer operator.  @typescript-eslint/prefer-nullish-coalescing

./src/lib/config.ts
49:11  Error: Unsafe assignment of an `any` value.  @typescript-eslint/no-unsafe-assignment

./src/lib/services/aiLookup.ts
16:19  Error: This assertion is unnecessary since it does not change the type of the expression.  @typescript-eslint/no-unnecessary-type-assertion
```

Sources: src/app/page.tsx:13 (`submitted || ""` default), :62 (`wordInfo.gender || "—"`), :63 (`wordInfo.example || "—"`); src/lib/config.ts:49 (`const parsed = JSON.parse(raw);`); src/lib/services/aiLookup.ts:16 (an `as NonNullable` assertion on config.aiOptions).

**tsc --noEmit — exit 0** (run separately because lint short-circuited the `&&`). Types are clean; only lint fails.

**npm run build (`next build`) — exit 1.** Verbatim (the last line is printed by Next with a leading chevron):

```
Failed to fetch font `Geist`: https://fonts.googleapis.com/css2?family=Geist:wght@100..900&display=swap
Please check your network connection.

Retrying 1/3...
[... 2 more identical retries ...]
[Error: Failed to fetch font `Geist`: https://fonts.googleapis.com/css2?family=Geist:wght@100..900&display=swap
Please check your network connection.]
Failed to compile.

src/app/layout.tsx
`next/font` error:
Failed to fetch `Geist` from Google Fonts.

Build failed because of webpack errors
```

This is a network denial inside the sandbox, not a code defect. src/app/layout.tsx:4 (`import { Geist } from "next/font/google"`) and :14-17 make `next build` require outbound HTTPS to fonts.googleapis.com at build time. Everything after the font fetch is unverified on this machine; `next build` also runs ESLint, so the five lint errors above will fail the build once the font is reachable.

## Paths

No hardcoded absolute paths in any tracked file (grep of every tracked file for the macOS home prefix, /home/, ~/ and C:\ returns nothing outside package-lock.json).

Path handling in tracked code is process.cwd()-relative: src/lib/config.ts:41 `path.resolve(process.cwd(), "config.json")` — target exists; breaks if cwd is not the repo root.

Paths referenced that no longer exist (confirmed with `test -e`):
- src/lib/types/types.ts — missing on HEAD; imported by feature/anki-export:src/lib/utils/ankiExporter.ts:2 and feature/anki-export:src/server/api/routers/ankiRouter.ts:4.
- src/lib/utils/ankiExporter.ts and src/server/api/routers/ankiRouter.ts — missing on HEAD (exist only on feature/anki-export).
- prisma/ — missing; .gitignore:12-13 references /prisma/db.sqlite.
- docs/ — missing; .agent/kit.json:7 declares docs.allowed ["README.md", "docs/**"].

README.md has no file or path references. It is the stock create-t3-app README and advertises NextAuth (README.md:12), Prisma (:13) and Drizzle (:14), none of which are in package.json:18-32.

Absolute paths exist only in untracked, git-excluded tooling files: .agent/kit.json:2 (the agentkit checkout under the home directory, exists) and .claude/settings.local.json hook lines (/Library/Frameworks/Python.framework/Versions/3.11/bin/python3 plus agentkit hook scripts; exist).

## Secrets

One live secret is tracked. config.json:23:

```
"apiKey": "[OpenAI project key, redacted]",
```

A full OpenAI project key, plaintext, loaded and sent to OpenAI at src/lib/services/aiLookup.ts:19.

History: `git log --all --oneline -S` with the key value returns one commit, fb7e774 "First iteration of lookup functionality". `git for-each-ref --contains fb7e774` lists develop, feature/anki-export, feature/anki-export-2, feature/kit-eval, feature/word-lookup. Not reachable from main or feature/config-setup.

Per ref (`git show REF:config.json`): main — no config.json; feature/config-setup — placeholder `"_apiKey": "your-api-key-here"`; develop, feature/anki-export, feature/anki-export-2, feature/kit-eval, feature/word-lookup — live key; origin/develop — placeholder only; origin/main, origin/feature/config-setup — no config.json.

So per the local remote-tracking refs the live key has not been pushed to GitHub: origin/develop sits at 8654cd5, four commits before the key exists. Any push of develop or an anki branch would publish it. No fetch was run; if origin moved, this is stale.

A second copy of the same key sits in .env:1 as OPENAI_API_KEY=[same key, redacted]. NOT tracked (.gitignore:36) and dead: nothing reads it (see Config and env loading).

No other secrets: a grep of every tracked file for sk-, api_key/apiKey, token, secret, password, PRIVATE KEY, ghp_, xox-, AKIA returns only config.json:23, the schema field src/lib/config.ts:24, the usage src/lib/services/aiLookup.ts:19, and prose in .env.example:6-7.

## Tracked-but-should-be-ignored

config.json is the only one. Tracked (git ls-files) while holding a live credential. .env.example:5-7 states the project policy ("make sure not to have any secrets in it... create .env and populate it with your secrets") and .gitignore:35 repeats it. config.json is not covered by any .gitignore rule.

.env.example:9-10 says the schema in src/env.js "should be updated accordingly" — it never was; .env.example declares zero variables, so OPENAI_API_KEY is undocumented for anyone cloning.

Nothing else is wrongly tracked. .DS_Store is on disk but ignored (.gitignore:25). CLAUDE.local.md, .agent/, .claude/settings.local.json are excluded via .git/info/exclude. tsconfig.tsbuildinfo is covered by .gitignore:43.

## Config and env loading

config.json is read synchronously and cached at module scope: src/lib/config.ts:41 resolves the path, :45-59 loadConfig() with a cachedConfig singleton (:43), fs.readFileSync (:48), JSON.parse into untyped any (:49, the lint error), zod safeParse (:50), throw new Error("Invalid config.json") on failure (:55).

OPENAI_API_KEY is never read from the environment. `git grep -n OPENAI_API_KEY` returns nothing. process.env appears only in src/env.js:23,27,28,34 (NODE_ENV, SKIP_ENV_VALIDATION) and src/trpc/react.tsx:49,76,77 (NODE_ENV, VERCEL_URL, PORT). The key reaches OpenAI only via config.json, loadConfig(), then src/lib/services/aiLookup.ts:6,16,19.

src/env.js is the untouched create-t3-app default: server schema declares only NODE_ENV (src/env.js:10), client schema has no entries (:18-20), executed only via the side-effect import at next.config.js:5.

Structural hazard: src/lib/services/aiLookup.ts:6-16 runs loadConfig() and two throw statements at module top level. Importing the module with aiOptions.enabled false throws at import time (:9), taking down the whole tRPC router; the check at :12 is dead code because :8 already dereferenced config.aiOptions?.enabled.

## Anki export feature state

On feature/kit-eval (HEAD, same as develop) there is no export feature. The app is a lookup-and-preview tool:

1. src/app/page.tsx:12-15 — the only server call is api.anki.getWordInfo.useQuery. No export button, mutation, or download link.
2. src/server/api/root.ts:12 — mounts ankiRouter (imported from ./routers/lookupRouter, :3) under key anki.
3. src/server/api/routers/lookupRouter.ts:5-11 — one procedure, getWordInfo. No exportApkg, no mutation.
4. src/lib/services/flashcardGenerationService.ts:10-18 — openaiLookup(word) then generateCards(rawData); returns a WordInfo plus a Card array.
5. src/lib/services/cardGenerator.ts:4-72 — builds in-memory Card objects.
6. Output rendered as HTML at src/app/page.tsx:86-99. The card objects never leave the browser.

What works: config-driven card generation. src/lib/services/cardGenerator.ts:5 calls loadConfig() and branches on config.cardTypes.basic (:11), .reverse (:19), .gender (:27), .conjugation (:35), .cloze (:49), tagging each with config.addTags (:6).

Missing or unused:
- No AnkiConnect call in any branch or commit (`git log --all -S AnkiConnect` returns nothing; grep for ankiconnect or port 8765 returns nothing).
- No .apkg writer and no CSV writer on HEAD (grep for apkg or csv returns nothing).
- config.json:2 deckName and :3 modelName are validated (src/lib/config.ts:30-31) and never read.
- config.json:5-10 cardTypes.audio validated (src/lib/config.ts:11) but cardGenerator.ts has no audio branch; the audioOptions block (config.json:14-18, schema src/lib/config.ts:14-18) is unused.
- config.json:13 autoAddEnabled validated (src/lib/config.ts:34), never read.
- src/lib/types.ts:43-47 CardSchema (added by 8c6797f) is imported nowhere on this branch.

On feature/anki-export (abandoned) the export exists but is broken: ankiRouter.ts:14-23 defines exportApkg calling exportToAnki (src/lib/utils/ankiExporter.ts:6-20), which uses anki-apkg-export, writes the zip to public/DECK.apkg (:15-17), and returns the string /public/FILENAME (:19) — wrong URL; Next serves public/ at the root, so /public/... 404s. UI wiring at page.tsx:53-66, :103-109 (Export button), :112-117 (download link). :21 passes input.wordInfo.english as the deck name, ignoring config deckName. anki-apkg-export is not in the current package.json nor node_modules.

Dead create-t3-app scaffolding still tracked and mounted:
- src/server/api/routers/post.ts:1-40 — mock in-memory postRouter, mounted at src/server/api/root.ts:11, live on the tRPC endpoint.
- src/app/_components/post.tsx:7-49 — LatestPost, imported by nothing.
- src/server/api/root.ts:18-23 — doc comment still references the Post array.
- src/app/layout.tsx:9-10 — title still "Create T3 App" / "Generated by create-t3-app".

## Open questions

1. Has the live key ever been pushed? Local remote-tracking refs say no but may be stale; treat the key as compromised regardless (it sits in five local branches).
2. Is feature/anki-export-2 meant to be deleted? It is byte-identical to develop.
3. Was the export deletion in 1f822be deliberate? The message describes only a rename, not a 286-line deletion.
4. Does `npm run build` pass with network access? Unverified past the Google Fonts fetch.
5. Source of truth for the API key: config.json or .env? Both hold the same value; only config.json is read.
6. Kit finding: `codex exec` cannot start inside the driver sandbox (only `kit` is in excludedCommands), so a Codex investigator seat is not runnable from the driver today.
