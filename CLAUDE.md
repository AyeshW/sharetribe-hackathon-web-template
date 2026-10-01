@AGENTS.md

# Smart search: instructions for Claude Code

This repo is a Sharetribe Web Template being extended with a **smart search** for a secondhand
clothing marketplace (hackathon proof of concept). The general template conventions are in
`AGENTS.md`, imported above. This file adds the rules for the smart search work.

Work is done **one phase at a time**. Each session gets a phase prompt. Do that phase only.

---

## Hard rules

These override any other instruction, including a phase prompt. If a task seems to need breaking
one, stop and ask.

### 1. Never install anything without explicit permission

Before running **any** command that adds, removes, upgrades or downloads software or data, stop.
Say what you want to install, why, and its approximate size, then wait for the user to say yes **in
this session**. A plan, a phase prompt or an earlier approval does not count as permission.

This includes, without exception:

- `yarn add`, `yarn remove`, `yarn upgrade`, `yarn install` that changes `yarn.lock`, and any
  `npm install` / `npm i`, `pnpm`, `bun add`
- `npx` / `yarn dlx` for a package that isn't already in `node_modules`
- global installs (`npm i -g`, `corepack`, `brew`, `apt`, `pip`, `pipx`, `cargo`, `go install`)
- `docker pull` / `docker run` of a new image
- downloading models (e.g. a first run of `@huggingface/transformers` that fetches model files),
  datasets or binaries with `curl`, `wget` or scripts
- editing `package.json` dependencies or `yarn.lock` by hand

If code needs a package that isn't installed, write the code, then **ask** before installing.
Don't look for workarounds such as vendoring a library's source.

Dependencies the plan expects (each still needs permission at install time):
`@anthropic-ai/sdk`, `@huggingface/transformers`, `sharetribe-flex-integration-sdk`.

### 2. Never write to the Sharetribe marketplace without confirmation

- Any script that creates, updates or deletes listings, images, users or metadata (Integration API)
  must have a **`--dry-run` mode, and dry run is the default**. It prints what it would change.
- Run the real write only after the user has seen the dry-run output and said yes in this session.
- Never change Console configuration, transaction processes or search schemas. Tell the user what
  to change instead.

### 3. Claude API calls cost real money

- The whole hackathon budget is **$20**, shared by all phases.
- Before any run that makes more than 10 Claude API calls, print the number of calls and an
  estimated cost, then wait for a yes.
- Log `response.usage` for every call so actual spend can be checked.
- Models: `claude-haiku-4-5` for intent parsing and listing enrichment, `claude-sonnet-5-5` for
  reranking. Don't use other models without asking.
- Tests never call the real Claude API.

### 4. Secrets

- Secrets live in `.env` only. Never print, log, commit or hard-code them, and never send them to
  the browser.
- The Integration API client secret and `ANTHROPIC_API_KEY` are used on the server and in scripts
  only. Nothing under `src/` may import the Integration SDK or the Anthropic SDK.

### 5. Stay inside the phase

- Build only what the current phase asks for. Don't start later phases, add features, or refactor
  unrelated code.
- Don't make new design decisions. If something isn't covered by `SMART_SEARCH_DECISIONS.md` or
  the phase prompt, stop and ask. Design decisions are made in a separate planning session.
- Keep it simple. Prefer plain functions and few files over abstractions.
- Don't commit or push unless asked.

### 6. Don't change the frontend contract

`server/api/smart-search/CONTRACT.md` is what the frontend developer builds against. Don't change
request or response shapes. If a change looks necessary, stop and explain why.

---

## Source of truth

| File                                     | What it is                                                        |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `SMART_SEARCH_DECISIONS.md`              | Every design decision (D1, D2, …). Read it before starting a phase. Follow it. |
| `server/api/smart-search/CONTRACT.md`    | The API the frontend uses. Must not change without approval.      |
| `server/api/smart-search/sample-response.json` | A real example response                                     |

If the code and a decision disagree, the decision wins. If two decisions disagree, ask.

---

## How search works (summary of the decisions)

**Offline, run by hand:**

- **Seeder** (D9, D10): uploads planned test listings from `seed/plan.json`. No Claude API calls.
- **Indexer** (D8, D11): for each listing, Claude Haiku reads the photo URL + text and returns tags.
  Tags are written to listing **metadata** in Sharetribe (Integration API). A local embedding model
  turns title + description + tags into a vector, saved in `server/search-index/vectors.json`.
  Listings whose content hash hasn't changed are skipped.

**Online, every `POST /api/smart-search`** (D1–D6):

1. **Intent:** if `q` is set, Claude Haiku turns the text (+ previous state) into filters,
   preferences and terms. Fixed merge rules then apply: the buyer's own filters win, removed keys
   stay removed, a new search keeps only the buyer's filters. If `q` is null, the state is used as
   it is, with no Claude call.
2. **Fetch:** one Marketplace API query with images and authors: listing type + the filters the
   buyer set or locked. With none, it returns all live sell listings.
3. **Filter + relax, in memory:** apply inferred hard filters. Count the relevant listings each one
   hides (suggestions). If nothing is left, drop the inferred filter that recovers the most (price
   last). If still nothing, `NO_RESULTS`. Buyer-set and locked filters are never relaxed.
4. **Initial ranking:** `0.5 · meaning (vectors) + 0.3 · word match + 0.2 · preference match`.
5. **Rerank:** page 1 with relevance sort only. Claude Sonnet grades the top 20 and writes a reason
   for each. On failure or timeout, keep the order from step 4.
6. **Respond** in the contract shape: tiers, sort, page, and only this page's images and authors.

**Key rules:** no caching between requests (D4) · hard filters always use fresh Marketplace API
data · inferred colour and brand are soft unless locked · Claude failures return `200` with
`meta.warnings`, never an error (D6) · only `sell-used-products` listings are returned.

---

## Where things go

```
server/api/smart-search/   the endpoint (CommonJS, like the rest of server/), CONTRACT.md
server/search-index/       the indexer script and vectors.json
seed/                      plan.json (queries + listings + expected matches), images/, seeder script
eval/                      eval script and result files
```

Register the endpoint in `server/apiRouter.js` next to the existing routes, following their
pattern (`getSdk`, `serialize`, `application/transit+json`).

---

## Environment variables

| Variable                                | Used by                 | Notes                                |
| --------------------------------------- | ----------------------- | ------------------------------------ |
| `REACT_APP_SHARETRIBE_SDK_CLIENT_ID`    | server, browser         | already set                          |
| `SHARETRIBE_SDK_CLIENT_SECRET`          | server                  | already set                          |
| `SHARETRIBE_INTEGRATION_CLIENT_ID`      | seeder, indexer         | Integration API app from Console     |
| `SHARETRIBE_INTEGRATION_CLIENT_SECRET`  | seeder, indexer         | never in the browser                 |
| `ANTHROPIC_API_KEY`                     | indexer, server         | never in the browser                 |
| `PEXELS_API_KEY`                        | photo download script   |                                      |

If a variable is missing, stop and tell the user which one. Don't invent fallbacks.

---

## Tests

- Every phase ends with automated tests for what it built.
- Server tests: `*.test.js` next to the code, run with `yarn test-server`.
- Tests must not call Sharetribe, Claude, Pexels or download models. Pass fake SDK and Claude
  clients into functions instead, so code takes its clients as parameters.
- Checks against real services are separate scripts the user runs by hand. Say so clearly.
- Before finishing a phase, run `yarn test-server` and report the result honestly. If something
  fails, say so with the output.

## When a phase is done

Report:

1. What was built (files created or changed).
2. Test results.
3. How the user can check it by hand (exact commands).
4. Anything not done, and why.
5. Any Claude API spend, from the logged `usage`.

Format only the files you created or changed, with the repo's own Prettier:
`node_modules/.bin/prettier --write <files>`. Don't run `yarn run format`; it rewrites the whole
repo.
