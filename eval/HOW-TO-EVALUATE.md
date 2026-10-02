# How to evaluate the search

This takes about 15 minutes. You don't need to know anything about search engines.

We have 25 test queries (things a real shopper might type) and, for each one, a list of the listings
it _should_ find. The eval types each query into both searches for you and checks whether the right
listings came back: the **old search** (the marketplace's current keyword search) and the **new
smart search** (without rerank, which is not built yet).

---

## 1. Run it

Prerequisites:

- `yarn install` has been run in this folder.
- A `.env` file exists in the project root (it holds the marketplace keys).
- The seed listings have been uploaded, so `seed/uploaded.json` exists.
- The embedding model has been downloaded once before (it lives in
  `node_modules/@huggingface/transformers/.cache/`). The eval never downloads it; if it's missing,
  the script stops and says so.
- The app does **not** need to be running. No browser, no `yarn dev`.

Then:

```bash
NODE_ENV=development node eval/run.js
```

It may first ask before spending money on Claude (see section 5); type `y`. It finishes in about a
minute. The last lines look like this:

```
Old search: 14 of 25 queries pass. New search: 22 of 25 pass.
New search weights: meaning 0.5 · word match 0.3 · preferences 0.2
Report: /…/eval/report.html
Saved results: /…/eval/results/2026-10-02T09-00-00-000.json
```

Open the report in a browser:

```bash
open eval/report.html      # macOS
xdg-open eval/report.html  # Linux
```

If the script stops with an error, it says what's missing (usually a setting in `.env`, or the seed
listings not uploaded yet). Send that message to the team.

---

## 2. Read the report

**The summary line at the top** is the headline: how many of the 25 queries each search gets right.
Higher is better.

Each query gets a ✅ or ❌. A query passes when **both** of these are true:

1. **Best in top 3** — at least one of the clearly-right listings is among the first 3 results.
   (Shoppers rarely scroll.)
2. **Found at least half** — at least half of the listings that should have matched are somewhere in
   the first 10 results.

The report also shows, per query:

- **Found 3 of 4** — how many of the correct listings turned up in the first 10 results.
- **The top 3 result titles** — what the search actually showed. This is the quickest way to see
  whether a result is nonsense.
- **better / worse / same** — how the new search compares with the old one for that query.

**A red row means the new search is worse than the old one for that query.** Those are the most
important rows to report back: they're the cases where the change would hurt shoppers.

**Click any row** to see the listings that query should have found.

Two numbers under the summary line:

- **average found %** — across all queries, what share of the correct listings each search turns up.
  A rough "how much does it miss" number.
- **queries with no results at all** — searches that returned an empty page. These are the worst
  experience for a shopper, so this number should go down, not up.

---

## 3. Check 5 queries by hand on the real site

The script only checks ids. Your eyes catch things it can't, such as a result that is technically
correct but looks wrong. Open the marketplace, type each query into the search box and tick the box
if **at least one sensible listing is in the first 3 results**.

| #   | Type this into the search             | Sensible listing in the first 3? |
| --- | ------------------------------------- | -------------------------------- |
| 1   | `trainers`                            | ☐ yes ☐ no                       |
| 2   | `snekers`                             | ☐ yes ☐ no                       |
| 3   | `something for a wedding`             | ☐ yes ☐ no                       |
| 4   | `black ankle boots size 38 under 40€` | ☐ yes ☐ no                       |
| 5   | `green jacket`                        | ☐ yes ☐ no                       |

"Sensible" means: if you were shopping, would you be happy to be shown this? A pair of shoes for
`snekers` is sensible. A jacket is not.

---

## 4. What to send back

1. The summary line from the terminal, copied as it is.
2. The queries with a ❌, and every red row, by their query text.
3. Your 5 ticks from the table above.
4. Anything that looked odd: a listing appearing for a query that has nothing to do with it, the
   same listing shown twice, an empty page, or the report taking very long to produce.

Attaching `eval/report.html` is helpful but not required.

---

## 5. Cost

The new search asks Claude what each query means (one call per query, about \$0.004 each). The
answers are saved in `eval/results/intent-cache.json` and reused, so **only queries that aren't in
that file yet cost anything**. A first run costs about \$0.10; later runs usually cost nothing. The
script prints the number of calls and the cost and asks you to confirm with `y` before it spends
anything.

After someone changes how the intent step works (`server/api/smart-search/intent.js`), the saved
answers are out of date. Then run `NODE_ENV=development node eval/run.js --fresh-intent` to ask
Claude again (about \$0.10). The whole project budget is \$20. **Please check with the team before
running it with `--fresh-intent` more than 5 times in a row.**

---

## 6. Comparing ranking weights

The new search adds up three scores: meaning, word match and preferences. To see how other mixes
would do on the same 25 queries:

```bash
NODE_ENV=development node eval/compare-weights.js
```

It uses the same saved Claude answers, so it usually costs nothing. It prints a table (one row per
mix: queries passed, average found, empty results, and how many queries changed against today's mix)
and writes `eval/results/weights-comparison.html`. It doesn't choose or change anything; the team
decides.
