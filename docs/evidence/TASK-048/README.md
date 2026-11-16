# TASK-048 brief 1/4: evidence notes

- **M0009** (`0080_task-048-brief.sql`, drizzle-kit generated from `database/schema/brief.ts`; grants appended): `brief_jobs` (provider-job
  columns of SB §3.5, kind/parent/state/cause checks, `brief_jobs_reuse_uq`, poll/submitting/copy indexes), `briefs`, `brief_segments`
  (`revision`), `claim_issues`, `claim_events` (no FK, append-only: runtime roles select and insert only), `brand_rules` (runtime roles select only).
  Constraints, cascades and grants are proven on real PostgreSQL in `modules/brief/brief.integration.test.ts` (including `claim_issues_clear_ck`:
  the database itself refuses a cleared high-risk issue, TC-REV-01).
- **Engine** (`modules/brief/domain`, pure, no IO): `claim-check.ts` (`compileRules`, `checkSegment`, `checkBrief`), `words.ts` (`countWords`,
  `removeDashes`, `shortenDialogue` with a call to action that stays whole), `issues.ts` (`reconcileIssues`: which issues an edit closes `closed_by_edit`
  and which it raises; `canClear`), `out-of-date.ts` (`isOutOfDate`, `outOfDateJobs`: a job whose `segment_revision` is below the segment's is out of date),
  `brand-rules.ts` (zod parse of `config/brand-rules.json`; per-kind parameters; `high_risk ⇒ clearable false`; ReDoS guard on patterns).
- **Rule file** `config/brand-rules.json`: four high-risk rules (treatment or cure, diagnosis, dosing, psychedelic) and the other-class rules (word count
  min 32, target 42 and hard max 45, exact CTA and 21+ framing on the last segment, em dash backstop, tone). Rule wording rests on unseen brand code
  (PRD IN-05/IN-06); the brand approver confirms it at go-live. Decisions: one finding per rule and field (first span); the CTA and 21+ framing rules
  apply to the highest position; `word_count_trimmed` is a generation-time issue id (`WORD_COUNT_TRIMMED_RULE_ID`), not a text rule; em dashes are
  removed by `removeDashes` before the rules run and the `em_dash` rule is only a backstop; the image-analysis `sensitiveAttributeFilter` word list is
  parsed and carried in the rule set (`sensitiveTerms`) for the analysis ticket.
- **Wiring**: `BriefModule.register(process.env)` is imported and registered in `bootstrap/api.module.ts` when a database is configured. It reads and checks
  the rules file at start-up (`BRAND_RULES_FILE` or `config/brand-rules.json`); a missing or invalid file stops the process. `BrandRulesReader.activeRules()`
  reads the active rows of `brand_rules` and refuses (`BrandRulesNotSeededError`) when none exist or they are older than the file, so a release that forgot
  the seed fails closed. `brandRulesSeedStep()` is the release-seed step (upsert by id; rules that left the file are switched off); registering it in
  `database/index.ts` `seedSteps` is the release/seed owner's one-line change, outside this ticket's paths (the price-table step is in the same state).
- **Proof through the real entry point**: `brief.integration.test.ts` builds the api with `createApiApp` on real PostgreSQL: unseeded table stops claim checks,
  the seed runs and reruns unchanged, the engine flags the fixtures with rules read back from the database, and `createApiApp` rejects for a faulty, unreadable
  or missing rules file.
- Unit tests: TC-BRF-02..04 (fixtures, 29..50 word sizes, dashes), TC-REV-01..03, 05 (rules side), out-of-date test. Coverage `modules/brief/domain` 100 % lines, 98.7 % branches.

Files outside the allowed paths (needed, append-only): the `reports/brief-data` junit entry and coverage include/excludes in `apps/api/vitest.config.ts`
and the `reports/brief-data` lcov copy in `apps/api/package.json`, which the ticket's report flags name; `infrastructure/repositories/*` holds the repository,
reader and file loader because `application/` is not an allowed path for this ticket.
