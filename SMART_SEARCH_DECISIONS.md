# Smart Search: decision log

Key functional decisions for the smart search solution, with the reasoning behind each one. The API
shape is in [server/api/smart-search/CONTRACT.md](server/api/smart-search/CONTRACT.md); this file
records why things are the way they are.

Each entry has a status: **Accepted**, **Superseded** (link to the replacement) or **Rejected**.

---

## D1. Two-stage ranking: initial ranking for every candidate, then a Claude rerank of the top 20

**Status:** Accepted

### Decision

Every search request ranks results in two stages:

1. **Initial ranking** scores every candidate that passed the hard filters, using cheap
   precomputed signals.
2. **Reranking** sends the top `min(20, perPage)` candidates to Claude Sonnet, which grades each
   one against the request and writes a one-line reason.

Reranking runs only for page 1 with `sort: 'relevance'`. Everything else uses the initial-ranking
order.

### How the initial ranking works

```
semantic    = cosine(queryVector, listingVector)
              listing vectors are built offline from title + description + enriched searchText;
              only the query is embedded at request time (local model)
keyword     = BM25(expanded query terms, enriched listing text)
preferences = share of soft preferences matched by enriched tags (style, season, warmth, colour, brand)

Each signal is normalised to 0–1 within the candidate set, then:
score = 0.5·semantic + 0.3·keyword + 0.2·preferences   (starting weights; tuned with the eval)
```

It's arithmetic over precomputed data: milliseconds per request, no API cost, and it scales to
thousands of listings.

### Why reranking is needed

The initial ranking scores each signal on its own. None of them can judge whether a listing fits
the request as a whole. Examples from the current marketplace data:

| Query                        | Initial ranking alone                                                                             | With the reranker                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| "vintage jacket for autumn"  | *Kids' jeans & denim jacket bundle, 11y* ranks #2, because the keyword "jacket" matches strongly | Graded **weak**: "Includes a denim jacket, but it's a kids' 11y bundle". It moves down.        |
| "vintage jacket for autumn"  | *Brown and white wool cardigan S* has a middling score and no explanation                         | Graded **partial**: "Not a jacket, but a warm wool layer for autumn"                           |
| "something for a wedding"    | *Toddler white dress & shoes bundle* scores well on the word "dress"                              | Understands the occasion: *Dress shoes, sunglasses & tie bundle* moves up                      |
| "warm but not wool"          | Embeddings largely ignore "not", so wool sweaters rank high                                       | Reads the negation and demotes the wool items                                                  |

Illustrative initial scores for "vintage jacket for autumn":

| #   | Listing                                 | semantic | keyword | prefs | score    |
| --- | --------------------------------------- | -------- | ------- | ----- | -------- |
| 1   | Bronze bomber jacket L                  | 0.92     | 1.00    | 0.9   | **0.94** |
| 2   | Kids' jeans & denim jacket bundle, 11y  | 0.71     | 0.85    | 0.3   | **0.67** |
| 3   | Brown and white wool cardigan S         | 0.68     | 0.10    | 0.8   | **0.53** |
| 4   | Beige wool sweater M                    | 0.64     | 0.00    | 0.8   | **0.48** |

Row 2 is the failure the reranker fixes. The reranker also produces the **reasons** shown on the
result cards, which the initial ranking can't.

### Why keep the initial ranking if we rerank

The reranker sees only 20 listings. The initial ranking does everything else:

1. **It picks which 20 the reranker sees.** Reranking can only reorder what it's given. A relevant
   listing ranked #35 is never seen. The initial ranking's job is therefore **recall** (get every
   good listing into the top 20), and the reranker's job is **precision** (put the best first).
2. **It orders everything after the top 20:** page 2 onwards and the "Also possibly relevant" tier.
3. **It's the fallback** when the rerank call fails or times out, or when `rerank: false`.
4. **It drives relaxation counts.** "3 more without Size L" counts listings whose initial score is
   above the relevance threshold. A Claude call per possible relaxation would be too slow and costly.
5. **It keeps cost flat.** Reranking the whole catalog would mean one Sonnet call over thousands of
   listings. The initial ranking caps the expensive step at 20.

### Rules that protect accuracy

- The reranker **grades and reorders. It never removes.** Listings graded `weak` move to the "Also
  possibly relevant" tier and stay visible.
- It only reorders within the top 20, so no candidate below it is lost.
- If the call fails or times out (~2 s budget), the initial ranking is returned and
  `meta.warnings` contains `RERANK_SKIPPED` (D6).

### Trade-offs accepted

- About **$0.016 and 1–2 seconds** per reranked search (Sonnet, 20 listings).
- With today's 27 listings, the top 20 is often the whole candidate set, so the initial ranking
  matters mostly for the fallback, relaxation and scaling. It becomes essential as the catalog grows.

### How we verify it

The eval runs every query with `rerank: false` and `rerank: true`. If reranking stops improving
recall@10 / precision@5 for the test queries, revisit this decision.

---

## D2. The server returns ranked listings, fetched once with images and authors

**Status:** Accepted (replaces the earlier draft where the server returned IDs only and the browser
loaded the listings with `listings.query({ ids })`)

### Decision

`POST /api/smart-search` returns the page's listings in the SDK response shape (`data` +
`included`), in display order, alongside `results` (tier, grade, reason). The server fetches
candidates with **one query** per request, including images and authors. Buyer-set filters are in
that query, inferred filters are applied to its results in memory (D5), and what remains is ranked
and returned.

### Why not return IDs only

The server already fetches fresh listing data to filter and rank. Returning only IDs makes the
browser fetch the same data again, and that second fetch caused three problems:

| Problem with IDs only                                                                                  | With listings in the response                     |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Two round trips: our API, then Sharetribe                                                              | One                                               |
| `listings.query({ ids })` returns listings in its own order, so the browser had to re-sort them        | Order is correct by construction                  |
| A price could change between our response and the browser's fetch, so an "Under €60" chip could sit above a €70 card | What was filtered is exactly what is shown |

### Why one fetch, not a second one for images

Images and authors are cheap to include. Like the default SearchPage, the fetch uses
`include: ['author', 'images']` with `'limit.images': 1`, so each listing brings one image and an
author with only `displayName`. The server ignores them while filtering and ranking, then copies
only the current page's images and authors into `listings.included`.

### How it fits the template

- The response is `application/transit+json`, as the comment in `src/util/api.js` asks for when
  returning SDK data. It carries UUID and Money types.
- The page duck dispatches `addMarketplaceEntities({ data: response.listings }, { listingFields })`,
  stores the result IDs in server order, and reads cards with `getListingsById`, the same pattern
  `SearchPage` uses. `ListingCard` works unchanged.
- The browser sends the card image variant (`config.layout.listingImage`) in the request, because
  the server needs it before the fetch.

### Trade-offs accepted

- Fetching images for every candidate gets wasteful with thousands of candidates. At that point
  the server would fetch images only for the current page in a second server-side call. That isn't
  needed at hackathon scale.
- Responses are larger than an ID list, at about 24 listings with one image each.

---

## D3. The client holds the search state; the server keeps no memory

**Status:** Accepted

### Decision

Every response returns a `SearchState` (filters, preferences, removed keys, `similarTo`, expanded
terms). The frontend stores it, keeps it in the URL, and sends it back with the next request. The
server stores nothing between requests.

### Why

- **Follow-ups need context.** "Cheaper", "in black" or "not bundles" mean nothing without the
  search they refer to.
- **Chat history isn't enough.** Removed chips, filters picked from a menu, locked chips and
  "more like this" clicks are never typed, so they exist only in the state.
- **Shareable and testable.** The state is the URL, so a refined search can be bookmarked,
  reloaded and replayed by the eval script.

### Server rules for the state

1. A `source: 'user'` filter always beats an inferred one for the same key. If the text conflicts
   with it, the user's filter wins and the response carries a `USER_FILTER_KEPT` notice.
2. Keys in `removed` are never re-inferred until the buyer sets them again or starts a new search.
3. A new search (`state: null`, or Claude's follow-up parse returns `new_search`) resets inferred
   filters, preferences, `removed` and `similarTo`. Filters with `source: 'user'` are kept.
4. Inferred `color` and `brand` default to **soft**, because many listings lack them and a hard
   filter would hide those listings. They become hard only when the buyer locks the chip. All
   other inferred filters are hard, but can be relaxed.

### When Claude is called

| Request                                      | Intent (Haiku) | Rerank (Sonnet) |
| -------------------------------------------- | -------------- | --------------- |
| New text (new search or follow-up)           | yes            | yes             |
| Chip edit (`q: null`, edited state)          | **no**         | yes             |
| Page 2+, or `sort` other than `relevance`    | no             | **no**          |

Chip edits skip the intent call because the state is already structured, so there is no text to
interpret. Reranking runs only for page 1 with relevance sort. It reorders the top
`min(20, perPage)` results, all on page 1, so later pages continue in initial-ranking order
without overlap.

---

## D4. No caching; every request uses fresh listing data

**Status:** Accepted (replaces an earlier draft with intent, grade and response caches)

### Decision

Nothing is cached between requests. Every request, including paging and sort changes, fetches
candidates from the Marketplace API, filters them, and returns that same data (D2).

### Why

- Caching added complexity the PoC doesn't need.
- Cached result sets go stale on filter membership. If a price rises from €50 to €70, a cached
  "Under €60" response would still include it. With fresh data, what is filtered is what is shown.

### Trade-offs accepted

- Every reranked request makes one Sonnet call (about $0.016), including chip edits.
- Eval runs pay for the intent call every time. Tuning runs use `rerank: false` (about $0.12 per
  30-query run).
- One staleness window remains. AI-enriched fields (`colorDetected`, normalised `brand`, `season`)
  and vectors update only when someone **re-runs the indexer by hand**, after seeding or editing
  listings. There is no automatic event poller; it isn't needed for the PoC. These fields are soft
  by default, so stale tags affect ranking, not which listings appear.

---

## D5. Query with buyer-set filters; apply and relax inferred filters in memory

**Status:** Accepted

### Decision

1. **Main query (the only query):** listing type + the hard filters that are never relaxed, meaning
   those the buyer set (`source: 'user'`) or locked. If there are none, it returns all live sell
   listings. That's fine: the buyer hasn't narrowed anything, and ranking does the work.
2. **Inferred hard filters are applied in memory** to the main query's results.
3. **Relaxation happens in memory too**, so it needs no extra queries:
   - `relaxation.suggestions[].extra` counts the **relevant** listings (initial score above the
     relevance threshold) that pass every filter except that one.
   - If no listing passes every filter, the server drops the one inferred filter that recovers the
     most relevant listings (price only as a last resort), uses those listings as the results, and
     reports the dropped filter in `relaxation.auto`. If that still gives 0, the response is
     `NO_RESULTS`.
   - User-set and locked filters are never relaxed.
4. Soft filters (inferred colour and brand) and preferences only affect ranking, never which
   listings appear.

### Mapping buyer-set filters to Sharetribe query parameters

| Filter                                         | Query parameter                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| `categoryLevel1`, `categoryLevel2`, `size`, `shoeSize`, `kidsSize`, `color`, `condition`, `petFreeHome`, `smokeFreeHome` | `pub_<key>=<value>` (comma-separated for `in`). These fields already have search schemas from Console. |
| `categoryLevel2` with `notIn` ("No bundles")   | Rewritten as `in` over every other subcategory, from `listing-categories.json`. The API has no "not" for enums. |
| `price`                                        | `price=<min>,<max+1>` (the API's upper bound is exclusive)            |
| `shippingEnabled`, `brand`                     | No search schema, so applied in memory to the main query's results   |

### Why

- One query per search, and relaxation costs nothing extra.
- Relaxation shows the buyer exactly which filter is hiding matching listings and lets them remove
  it in one click. The case asks that simplicity never come at the cost of accuracy.

### Trade-offs accepted

- A search without buyer-set filters reads every live listing (about 125, 2 API pages). With a
  much larger catalog, inferred filters would also move into the query, and relaxation would need
  extra queries. That isn't needed for the PoC.

---

## D6. Failure handling and backend-only fields

**Status:** Accepted

- A failure in Claude or the embedding step is **not** an error. The server returns `200` and adds
  a code to `meta.warnings`: `INTENT_FALLBACK` (searched the raw text without inferred filters) or
  `RERANK_SKIPPED` (initial-ranking order, ~2 s rerank timeout). Only a failed Sharetribe query
  returns an error (`502 UPSTREAM_ERROR`).
- **`notices` are for the buyer only**, so there are just two: `USER_FILTER_KEPT` (`params:
  { label }`) and `NO_RESULTS`. Technical events go to `meta.warnings`, which the buyer never sees.
  An earlier draft also had an `AUTO_RELAXED` notice. It was removed because `relaxation.auto`
  already says the same thing, and the UI would have shown it twice.
- **Notices carry a `code` and `params`, not English text.** The frontend writes the message from
  its translation files, as AGENTS.md requires for user-facing copy. Filter `label`s are still
  English from the backend; translating them is out of scope for the PoC.
- Results contain only published `sell-used-products` listings, so "In search of" buyer requests
  never appear.
- Backend-only fields are **not** in the frontend contract:
  - request `rerank` (default `true`) and `debug` (per-signal scores), used by the eval script,
  - response `meta` (`tookMs`, `reranked`, `intent`, `warnings`), and per-result `grade` and
    `score`.

  The server may send them. The frontend ignores them.

---

## D7. ChromaDB as the vector store

**Status:** Superseded by D8. Running a Chroma server during the demo was too heavy for the PoC.

### Decision

Listing vectors and AI tags are stored in ChromaDB. The indexer writes to it. The search endpoint
queries it for meaning-based similarity, limited to the candidate IDs that came fresh from the
Marketplace API in the same request.

### What a Chroma record holds

| Part        | Content                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------- |
| `id`        | Listing UUID, the same as in Sharetribe                                                   |
| `embedding` | Vector of `document`, from our own embedding model (the same model embeds queries)        |
| `document`  | Title + description + enriched search text                                                |
| `metadata`  | AI tags for **soft** ranking: garment type, style, season, warmth, detected colour, normalised brand, plus `contentHash` so the indexer can skip unchanged listings |

**Not stored:** price, size, category, condition or listing state. Hard filters always use fresh
Marketplace API data (D4), so filter-critical fields must not have a second, possibly stale copy.

### How search uses it

1. The endpoint fetches fresh candidates from the Marketplace API and applies hard filters.
2. It queries Chroma with the query vector and `where: { id: { $in: candidateIds } }`.
3. A candidate with no Chroma record yet (created after the last index run) still takes part
   through keyword and preference matching, with a semantic score of 0.

### Why

- Similarity search runs in the database instead of hand-written code over a file.
- Persistence, and a credible path to a larger catalog.

### Trade-offs accepted

- The `chromadb` JavaScript client needs a running Chroma server (Docker
  `chromadb/chroma` or `pip install chromadb && chroma run`). It must be up for the demo and in
  any deployment.
- At the planned 100–150 listings, a JSON file would perform the same. The choice is about
  architecture and scale, not speed.
- New dependency: `chromadb` (npm), approved by the user.

---

## D8. Vectors in a JSON file, AI tags in Sharetribe listing metadata

**Status:** Accepted (replaces D7)

### Decision

| Data                                                                                       | Stored in                                                         | How search reads it                                                       |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **AI tags** (garment type, synonyms, style, season, warmth, detected colour, normalised brand) | Listing **metadata** in Sharetribe, written by the indexer (Integration API) | Arrive with the fresh candidate fetch (step 2). No separate store.     |
| **Vectors**                                                                                | `server/search-index/vectors.json`: listing ID → vector + content hash | Loaded into memory at server start. Similarity is computed in code.  |

The indexer is a script run by hand after seeding or editing listings (no automatic poller). It
writes both: tags to Sharetribe, vectors to the file.

### Why

- **Nothing extra to run.** A Chroma server during the demo was too heavy. At about 125 listings,
  comparing a query vector with every listing vector takes a few milliseconds in plain code.
- **One copy of the tags.** Tags live with the listing in Sharetribe, so they arrive fresh with
  every search, and an operator can see them in Console.
- **Vectors are the only derived data**, and they're small: about 125 × 384 numbers.

### Where the AI tags are used

1. **Word match (step ④):** synonyms and garment type are added to the listing's searchable text,
   so "coat" finds a bomber jacket.
2. **Meaning match (step ④):** the embedded text includes the tags.
3. **Preference match (step ④):** soft preferences such as "vintage" or "autumn" are compared with
   `style` and `season`.
4. **Colour and brand (steps ③/④):** `colorDetected` fills a missing seller colour. The normalised
   brand drives brand boosts and a locked brand chip.
5. **Rerank (step ⑤):** tags are sent to Claude with each listing's data.

### Trade-offs accepted

- A listing created after the last index run has no vector and no tags yet. It still appears
  through filters and word matching, and gains a meaning score after the next index run.
- `vectors.json` must ship with the server, so it's committed to the repo or rebuilt at deploy.
- Moving to a vector database later only changes how step ④ looks up vectors.

---

## D9. Seed data is designed around the eval queries, and written with Claude Code

**Status:** Accepted

### Decision

1. Write the **test queries first** (about 25), then plan the listings for each query (about 4 per
   query, ~100 in total):
   - **direct match:** obvious hit,
   - **hidden match:** relevant, but keyword search misses it (synonym, colour only in the photo),
   - **near miss:** looks relevant but shouldn't match or should rank low (wrong size, kids'
     version, wrong season),
   - **distractor:** shares a word, different meaning.
2. Queries, listings and the expected matches live in one file, `seed/plan.json`. The seeder and
   the eval both read it, so the eval's correct answers are known by construction.
3. **Claude Code writes the plan and the listing texts** (looking at each chosen photo), and writes
   a seeder script that only uploads. No Claude API calls are used for seeding.
4. Seeded listings are created through the Integration API with `metadata.seeded = true` for easy
   clean-up.

### Why

- Without planned near misses and hidden matches, keyword search looks fine and the improvement
  can't be measured.
- Seed data is test data, not product. Claude Code on the hackathon plan costs nothing from the
  $20 API budget.

---

## D10. Seed photos come from Pexels

**Status:** Accepted

- A script searches the Pexels API (free key, 200 requests/hour) for each planned listing's photo
  and downloads 2–3 candidates to `seed/images/`.
- Claude Code looks at the candidates and picks the one that fits the planned listing.
- The photographer is credited in the listing description, as in the existing listings.

---

## D11. Enrichment uses Claude Haiku 4.5 with the listing's image URL

**Status:** Accepted (replaces Sonnet for enrichment in earlier estimates)

### Decision

- One `claude-haiku-4-5` call per listing, with the photo and the listing text together.
- The photo is passed as a URL: the `scaled-medium` (750 px) image variant from Sharetribe's image
  service (`{ type: 'image', source: { type: 'url', url } }`), about 550 image tokens.
- The enrichment prompt is tuned in Claude Code on 5–10 listings first (free), then the API runs
  once over all listings (about $0.60, or $0.30 with the Batch API).
- If spot-checks show brand logos or styles are often wrong, only those listings are re-run with
  Sonnet.

### Tags requested

| Field              | Allowed values                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `garmentType`      | short free text, e.g. "bomber jacket"                                                                    |
| `synonyms`         | words buyers would type (free text)                                                                      |
| `audience`         | `adult` · `kid` · `baby` · `unknown`                                                                     |
| `colorDetected`    | the marketplace's colour options, plus an optional second colour                                         |
| `pattern`          | `solid` · `striped` · `checked` · `floral` · `print` · `graphic` · `unknown`                             |
| `materialLook`     | only if visible: `denim` · `leather` · `suede` · `knit` · `wool` · `cotton` · `synthetic` · `unknown`    |
| `style`            | `vintage` · `retro` · `y2k` · `minimalist` · `sporty` · `formal` · `casual` · `boho` · `streetwear` · `classic` |
| `season`           | `spring` · `summer` · `autumn` · `winter` · `all-season`                                                 |
| `warmth`           | `light` · `medium` · `warm` · `unknown`                                                                  |
| `occasion`         | `everyday` · `work` · `party` · `formal` · `outdoor` · `sport`                                           |
| `fit`              | `slim` · `regular` · `oversized` · `cropped` · `unknown`                                                 |
| `brand`            | visible logo or brand in the text, normalised, or empty                                                  |
| `visibleWear`      | `none` · `light` · `noticeable` · `unknown` (rerank hint only; the seller's `condition` stays the truth) |
| `photoMatchesText` | `yes` / `no` + a short note                                                                              |
| `searchText`       | 1–2 sentences in buyer language; this is the text that gets embedded                                     |

### Rules in the prompt

- Never contradict the seller's own fields (if the seller says blue, keep blue).
- Only the allowed values; free text only in `garmentType`, `synonyms` and `searchText`.
- Say `unknown` rather than guess.

---

## D12. Seed listings must be valid against the marketplace's listing config

**Status:** Accepted

### Decision

Every seeded listing must be something a seller could have created through the marketplace's own
listing form. The seeder reads `listings/listing-fields.json`, `listings/listing-categories.json`
and `listings/listing-types.json` (Asset Delivery API) **at runtime** and validates every planned
listing before upload. The dry run reports invalid listings, and none are uploaded until all pass.

### Rules (from the live config on 2026-10-02)

| Field                                         | Required?    | Only for these categories                                    |
| --------------------------------------------- | ------------ | ------------------------------------------------------------ |
| `size` (`xs`…`xxl`)                           | **required** | women/men tops and bottoms                                   |
| `shoeSize` (EU `19`…`48`)                     | **required** | women/men/kids shoes                                         |
| `kidsSize` (`3m`…`12y`)                       | **required** | kids tops and bottoms                                        |
| `condition`                                   | **required** | everything except bundles and the top-level `accessories`    |
| `conditionDetails` (text)                     | **required** | bundles                                                      |
| `color`, `brand`, `material`, `petFreeHome`, `smokeFreeHome`, `sizeDetails` | optional | all          |
| `careInstructions`                            | optional     | tops, bottoms, bundles                                       |

1. **Category:** a valid `categoryLevel1` + `categoryLevel2` pair from `listing-categories.json`,
   or the top-level `accessories` on its own.
2. **Required fields** for the category are always filled.
3. **No field outside its category** (a shoe never has `size`).
4. **Only allowed enum values.**
5. **Optional fields may be left empty on purpose.** This is how hidden matches are made, e.g. no
   `color`, but the photo shows black.
6. **Listing type values** for "Sell products": `listingType: 'sell-used-products'`,
   `transactionProcessAlias: 'default-purchase/release-1'`, `unitType: 'item'`, stock 1, title,
   description, price in EUR between €1 and €500, at least one image, and pickup/shipping fields
   (`pickupEnabled` + `location`, `shippingEnabled` + `shippingPriceInSubunitsOneItem`), following
   the existing listings.

### Why

Invalid listings would be unrealistic (a seller couldn't create them), could break listing pages,
and would make the eval unfair to the default keyword search.
