# Build log — project revive (2026-09-06)

Requested by Valentino's kit-driver session; written by the unit driver (claude/fable). Scope for every count: eval-01 (opened before the project layer) plus the seven revive units. Times are register timestamps truncated to the minute. Waits are given only where two register events bracket them: the verdict or refusal that raised the question, and the receipt or stamp that answered it. DECISION: the answer changed what happened next. RELAY: a stamp or a default pick.

1. eval-01 interview, route normal, five locked decisions. DECISION.
2. eval-01 open stamp 14:13. RELAY.
3. eval-01 review 1 BLOCKING, options A/B/C; plain-language version asked for, A picked. 14:33 verdict to 14:38 receipt. RELAY.
4. eval-01 close 14:43, commit. 14:41 verdict to 14:43 stamp. RELAY.
5. Merge to main blocked by GitHub push protection (key in history); squash proposed and run. RELAY.
6. Interview Q1 export path: pointed at the trading vault, then chose AnkiConnect over vault files, plus SQLite. DECISION.
7. Q2 card types: kept 1, 2, 5; kept conjugation with a compromise that became the patterns table. DECISION.
8. Q3 tenses and Q5 deck names: defaults. RELAY, RELAY.
9. Q4 flow: mockup asked for twice, artifact built, default picked. RELAY.
10. Q6 cleanup: yes, and moved first; became m2 before any feature. DECISION.
11. Charter shown; project open 15:41. 15:39 violation event to 15:41 stamp. RELAY.
12. m1-verify open 15:43, m1-docs open 15:45, close/abandon/accept 15:52. RELAY x5.
13. m2-clean open 15:54; two kit defects blocked the build, kit fixed by the driver, "rerun" relayed. 15:54 open stamp to 16:05 receipt. RELAY x2.
14. m2 close, accept, commit 16:07. RELAY.
15. m3-db open 16:10, waiver 16:12, npm installs with a peer conflict resolved by @types/node 22. 16:07 accept to 16:14 first receipt. RELAY.
16. m3-db review 1 BLOCKING, A picked. 16:23 verdict to 16:26 receipt. RELAY.
17. m3 close, accept, commit, dev smoke with screenshot. RELAY.
18. m4-cards open 16:36. RELAY.
19. m4 review 1 BLOCKING, A "one clean run". 16:52 verdict to 17:35 receipt. RELAY.
20. m4 s3 check red on an s2 lint line; A picked over budget. RELAY.
21. m5-fixes open, close, commit; m5-anki open; two blocking rounds, A picked both times. RELAY x5.
22. m5 close, accept, commit; live smoke on desktop and phone. RELAY.

Counts, all in the scope above. Units 8: 7 closed, 1 abandoned. States 17. Builder-seat runs 30 (32 report files under out/, minus the two eval-01 launches that failed before the seat started); 3 of them were false greens before the kit fix; 10 of the 14 states that ran a seat were green on the first run. Reviews 20. Blocking verdicts 12. Human rulings given after a blocking verdict 5.

Interview decisions that later mattered: "system font, no network" (s3 build in the seat); "history untouched" (push protection, squash); "AnkiConnect not files" (no Obsidian, m5 design); "conjugation compromise" (patterns table); "cleanup first" (m2 order).

Kit defects surfaced, with a trace in this repo: the bare "kit" exclusion pattern kept the seat from starting (eval-01 worklog); project new writes docs/DECISIONS.md outside a fence (register); a diff-less unit has no path to a verdict (m1-verify worklog); build precheck counted ignored files (fixed; m2-clean worklog); audit flagged tsconfig.tsbuildinfo (fixed; m2-clean worklog); receipt taken on a RED seat (fixed; m4-cards worklog). Observed by the driver in the session only, no repo trace: reg clear --all cannot clear a no-unit violation; build precheck counts another open unit's fenced dirt as dirt.

Recommendation on stamp policy: drop every open, close and accept stamp and every default-pick ruling; keep the waiver stamp on dependency changes even in an unattended run.
