# Smart search

A smarter search for a secondhand clothing marketplace, built on the Sharetribe Web Template.

Buyers type what they want in their own words: _"warm coat for women size M under 50€"_,
_"snekers"_, _"something for a wedding"_. The search turns the sentence into filters they can see
and edit, finds listings by meaning as well as words, and reads each listing's **photo**, so it
finds items that the seller never described well.

## At a glance

|                                  | Old search | Smart search                        |
| -------------------------------- | ---------- | ----------------------------------- |
| Test queries passed (25)         | 14         | **22**                              |
| Right listings found, on average | 52%        | **79%**                             |
| Queries with an empty page       | 1          | **0**                               |
| Understands the photo            | no         | **yes**                             |
| Cost per typed search            | \$0        | **about \$0.003** (chip edits: \$0) |

Full report: [eval/report.html](eval/report.html).

**In one sentence:** buyers describe what they want in their own words, and the search finds it,
even when the seller's text doesn't say it but the photo shows it.

---

## The problems, before and now

| Problem                                                            | Before (keyword search)                                        | Now (smart search)                                                                              |
| ------------------------------------------------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **What's in the photo:** a red coat whose seller never wrote "red" | Only text is searched, so the coat is invisible for `red coat` | Claude vision reads every photo. The colour, garment, style and brand it sees become searchable |
| **Other languages:** a Finnish listing, _"Talvitakki, koko M"_     | Not found by an English query                                  | Vision adds English tags ("warm red wool winter coat"), so `red winter coat` finds it at #2     |
| **Typos:** `snekers`, `leather jakcet`                             | Empty page, or the wrong items                                 | Understands what was meant                                                                      |
| **Different words:** `trainers` vs "sneakers"                      | Exact words only, so 1 result                                  | Matches by meaning and AI-added synonyms (all 6 found)                                          |
| **Vague needs:** `something for a wedding`, `y2k`                  | Matches words, not intent                                      | Understands occasion, style and season                                                          |
| **Long requests:** `warm coat for women size M under 50€`          | Words matched one by one; size and price ignored               | Turned into chips the buyer can edit: **Women · Tops · Size M · Under €50**                     |
| **Follow-ups:** `cheaper`, `in black`                              | Starts over (`cheaper` finds nothing)                          | Edits the current search: only the price chip changes                                           |
| **No results:** `sneakers size 45`                                 | Empty page, or unrelated items                                 | Relaxes the blocking filter, says so, and offers a one-click undo                               |

Filters the buyer sets themselves are **never** loosened. Only filters the AI guessed can be
relaxed.

---

## How it works

```
 OFFLINE (run by hand, once per new listing)
 ┌──────────────┐   photo URL + text   ┌──────────────┐  tags   ┌───────────────────────────┐
 │ Sharetribe   │ ───────────────────▶ │ Claude Haiku │ ──────▶ │ listing metadata (Sharetribe) │
 │ listings     │                      │   (vision)   │         └───────────────────────────┘
 └──────────────┘                      └──────────────┘
        │ title + description + tags  ┌─────────────────────┐          ┌────────────────────────────────┐
        └───────────────────────────▶ │ local embedding model │ ───────▶ │ server/search-index/vectors.json │
                                      └─────────────────────┘          └────────────────────────────────┘

 ONLINE (every POST /api/smart-search)
 ① Intent   Claude Haiku turns the text (+ current chips) into filters, preferences and terms
 ② Fetch    ONE Marketplace API query with the buyer's own filters (fresh data, images, authors)
 ③ Filter   apply the AI-guessed filters in memory; if nothing is left, relax one and say so
 ④ Rank     0.5 × meaning (vectors) + 0.3 × word match (BM25) + 0.2 × preference match (tags)
 ⑥ Respond  ranked listings in SDK shape, split into "best" and "related", with paging and sort
```

(⑤, a Claude rerank of the top 20, is designed but deferred. See "Next steps".)

Key design points. All of them are explained in
[SMART_SEARCH_DECISIONS.md](SMART_SEARCH_DECISIONS.md).

- **No extra infrastructure.** There's no vector database and no Python. Vectors are a JSON file and
  tags live in Sharetribe listing metadata, so they arrive with every listing.
- **Fresh data for filters.** Price, size, category and availability always come from the
  Marketplace API in the same request. Nothing is cached.
- **The browser holds the search state.** Chip edits (remove, lock, change) don't call Claude. Only
  new text does.
- **It never breaks.** If Claude or the embedding model fails, the search still answers with filters
  and word match, plus a warning.

### What Claude vision adds to a listing

For each listing, Claude Haiku looks at the photo and the text and returns tags such as garment
type, synonyms, colour seen in the photo, brand, style, season, warmth, occasion, and an English
`searchText`. Real examples from the marketplace:

| Listing (as the seller wrote it)                                                | Seller colour | What vision added                                                       |
| ------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------- |
| **Talvitakki, koko M**: _"Lämmin talvitakki, käytetty kaksi talvea…"_ (Finnish) | none          | "Warm **red** wool **winter coat**, size M", season autumn/winter, warm |
| **Kevättakki S**: _"Ohut kevättakki, vähän käytetty."_ (Finnish)                | none          | "Light **red spring coat**", warmth light                               |
| **Small shoulder bag with chain**                                               | none          | "Small **red** quilted leather shoulder bag with gold chain strap"      |
| **Zip ankle boots, size 38**                                                    | none          | "**Black** leather ankle boots with side zip"                           |
| **Lumberjack flannel**                                                          | none          | "Thick checked flannel shirt in **red and white plaid**"                |

---

## Demo queries

The full demo script, with what to say, is in [DEMO.md](DEMO.md). These are the strongest queries.
All come from the eval run of 2 October 2026.

### Typos, synonyms, meaning

| Query                     | Old search                  | Smart search                                             |
| ------------------------- | --------------------------- | -------------------------------------------------------- |
| `snekers`                 | empty page                  | all 6 sneakers                                           |
| `trainers`                | 1 result                    | all 6 sneakers and trainers                              |
| `leather jakcet`          | leather belt, jacket, boots | 3 leather jackets                                        |
| `something for a wedding` | 1 of 6 right                | 5 of 6 right: satin dress, navy suit, party dress        |
| `y2k`                     | 1 result                    | Y2K tee, velour hoodie, low-rise flares (none say "y2k") |

### Found only because Claude read the photo

| Query                                 | The listing                                       | Why old search misses it                          | Smart search            |
| ------------------------------------- | ------------------------------------------------- | ------------------------------------------------- | ----------------------- |
| `red winter coat`                     | **Talvitakki, koko M**                            | Finnish text, no colour set; "red" only in photo  | **#2** (old: not found) |
| `red handbag`                         | **Small shoulder bag with chain**                 | No colour, and the word "handbag" isn't in it     | **#2** (old: not found) |
| `black ankle boots size 38 under 40€` | **Zip ankle boots, size 38**                      | No colour set; black only in photo                | **#1** (old: #2)        |
| `warm for winter`                     | **Talvitakki, koko M**                            | Finnish: "lämmin talvitakki" = "warm winter coat" | **#3** (old: not found) |
| `marimekko`                           | **Kids trousers 98 cm** (seller wrote "Marimeko") | Misspelled brand                                  | **#2** (old: not found) |

Also worth showing on `red winter coat`: the Finnish **Kevättakki** (a red _spring_ coat) is also
found, but ranks below the warm coats, because vision tagged it as light.

**Best single demo:** `red winter coat`. The Finnish listing has no colour and no English words, and
it comes second, right after the obvious red puffer coat.

### Follow-ups and no dead ends

1. `warm coat for women size M under 50€` gives the chips **Women · Tops · Size M · Under €50**.
   Then `cheaper` changes only the price chip to **Under €40**.
2. `sneakers size 45`: there are no size-45 shoes, so the search drops the **EU 45** chip, says so,
   and shows sneakers in other sizes. One click puts the chip back.

### Honest limitations

- `warm but not wool`: negation isn't understood yet, so wool coats still rank high.
- `baby blue dress` is read as a baby/kids search, so adult light-blue dresses rank too low.
- `green jacket`: the "Padded parka" was meant to be green, but its Pixabay photo is brown and
  vision correctly says brown. The search is right, and the test's expected answer is wrong.

The planned rerank (below) targets the first two.

---

## Running it

Prerequisites: Node 22 (`nvm use 22`), `yarn install`, and a `.env` with:

| Variable                                                                   | Needed for                         |
| -------------------------------------------------------------------------- | ---------------------------------- |
| `REACT_APP_SHARETRIBE_SDK_CLIENT_ID`, `SHARETRIBE_SDK_CLIENT_SECRET`       | the search endpoint                |
| `ANTHROPIC_API_KEY`                                                        | intent parsing (endpoint), indexer |
| `SHARETRIBE_INTEGRATION_CLIENT_ID`, `SHARETRIBE_INTEGRATION_CLIENT_SECRET` | indexer and seeder only            |
| `PIXABAY_API_KEY`, `SEED_AUTHOR_IDS`                                       | seeding only                       |

```bash
NODE_ENV=development node server/smart-search-lib/check-demo.js   # every line should say PASS
yarn run dev                                                      # app on :3000, API on :3500
node server/api/smart-search/try.js "red winter coat"             # one Claude call, ~$0.003
yarn test-server                                                  # tests, no real services
NODE_ENV=development node eval/run.js                             # old vs new report, see eval/HOW-TO-EVALUATE.md
```

**Restart the server after re-running the indexer**, because vectors and config load at start-up.

### Adding new listings to the index

```bash
NODE_ENV=development node server/search-index/build.js            # preview: asks before spending, then shows the tags in preview.json; no Sharetribe writes
NODE_ENV=development node server/search-index/build.js --confirm  # after you have checked the preview
```

Unchanged listings are skipped (content hash). A listing that isn't indexed yet still shows up in
results through filters and word match. It just has no photo tags or meaning score until the next
run.

---

## Cost

### Per search

Measured from the usage log. An average typed search sends about 2,400 input tokens and gets about
70 back.

| Search action                         | Claude calls | Cost             |
| ------------------------------------- | ------------ | ---------------- |
| Typed search or follow-up (`cheaper`) | 1 (Haiku)    | **\$0.0028**     |
| Removing or locking a chip            | 0            | \$0              |
| Next page, sort change                | 0            | \$0              |
| Query embedding                       | 0 (local)    | \$0              |
| **1,000 typed searches**              | 1,000        | **about \$2.80** |

### One-off

| What                                | Model            | Cost                                    |
| ----------------------------------- | ---------------- | --------------------------------------- |
| Indexing one listing (photo + text) | Claude Haiku 4.5 | \$0.0033, once per listing change       |
| All 126 listings                    | Claude Haiku 4.5 | about \$0.41                            |
| **Total spent so far** (209 calls)  |                  | **\$0.65** of the \$20 hackathon budget |

With the rerank step (deferred), a typed search would cost about \$0.02.

Every call is logged to `logs/claude-usage.jsonl`. Run `node server/smart-search-lib/usage.js` for
the totals.

---

## Where things are

```
server/api/smart-search/     the endpoint (POST /api/smart-search), CONTRACT.md for the frontend
server/smart-search-lib/     clients, marketplace config loader, usage log, set-up checks
server/search-index/         indexer (Claude vision tags + embeddings) and vectors.json
seed/                        test listings planned around the eval queries, and the seeder
eval/                        25 test queries, old vs new runner, HTML report
SMART_SEARCH_DECISIONS.md    every design decision and why
DEMO.md                      demo script
```

Frontend developers only need
[server/api/smart-search/CONTRACT.md](server/api/smart-search/CONTRACT.md) and
[sample-response.json](server/api/smart-search/sample-response.json).

---

## Next steps

- **Rerank (designed, deferred):** Claude Sonnet reads the top 20 results against the request, fixes
  cases like negation ("not wool"), and writes a one-line reason per result. It's deferred because
  it adds several seconds per search (D16, D18).
- **Automatic indexing:** run the indexer on listing events instead of by hand.
- **Search by photo:** the same vision tags make "find similar to this picture" possible.
