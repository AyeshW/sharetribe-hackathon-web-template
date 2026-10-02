# Smart search demo

About 5 minutes. Every query below comes from the eval (`eval/report.html`, run on 2 October 2026).

**The headline:** Old search: 14 of 25 test queries pass. New search: 22 of 25. On average the new
search finds 79% of the right listings (old: 52%), and no query returns an empty page (old: 1).

---

## Start-up checklist

Do this before the demo, not during it.

1. `yarn install` (only if `node_modules` is missing).
2. `.env` has these keys:
   - `REACT_APP_SHARETRIBE_SDK_CLIENT_ID`
   - `SHARETRIBE_SDK_CLIENT_SECRET`
   - `ANTHROPIC_API_KEY`
   - (`SHARETRIBE_INTEGRATION_CLIENT_ID` and `SHARETRIBE_INTEGRATION_CLIENT_SECRET` only if you need
     to re-run the indexer.)
3. Run the self-check. Every line should say PASS. It makes no Claude calls.
   ```bash
   NODE_ENV=development node server/smart-search-lib/check-demo.js
   ```
4. Start the app: `yarn run dev` (the API runs on port 3500).
5. Check the endpoint in a second terminal. Each command makes one Claude call (about \$0.003).
   ```bash
   node server/api/smart-search/try.js "snekers"
   node server/api/smart-search/try.js "sneakers size 45"
   node server/api/smart-search/try.js "warm coat for women size M under 50€"
   ```
   The last one prints a `State` line at the end. Save that JSON to a file, then:
   ```bash
   node server/api/smart-search/try.js "cheaper" --state state.json
   ```
6. **Restart the server after any index change** (re-running the indexer or changing `vectors.json`)
   and after changing listing settings in Console. The server loads them only when it starts.

---

## Demo queries

For each query: type it, show the result, and say the sentence.

### 1. `snekers` (a typo)

- **Old:** an empty page.
- **New:** Black and white hi-top sneakers · White canvas sneakers 39 · Star print canvas shoes,
  size 28 (all 6 sneakers found).
- **Say:** "A typo used to mean an empty page. Now it understands what you meant."

### 2. `trainers` (a synonym)

- **Old:** one result, Olive knit trainers, size 43.
- **New:** Olive knit trainers, size 43 · White canvas sneakers 39 · Black and white hi-top sneakers
  (all 6 found).
- **Say:** "Sellers write 'sneakers', buyers type 'trainers'. The new search knows it's the same
  thing."

### 3. `leather jakcet` (a typo)

- **Old:** Leather belt, brown · Brown leather jacket L · Brown leather work boots.
- **New:** Brown leather jacket L · Tan leather biker jacket M · Faux leather jacket S.
- **Say:** "The old search matched the word 'leather'. The new one also understands you want a
  jacket."

### 4. `something for a wedding` (an occasion)

- **Old:** Green satin mini dress M · Bride squad t-shirt · Jeans for 8 year old.
- **New:** Green satin mini dress M · Navy suit, jacket + trousers · Dark blue party dress M (5 of 6
  found, old 1 of 6).
- **Say:** "No listing says 'wedding', but it knows what people wear to one."

### 5. `y2k` (a style)

- **Old:** one result, Y2K baby tee, white eyelet.
- **New:** Y2K baby tee, white eyelet · Velour zip hoodie M · Low rise flared jeans S.
- **Say:** "It knows the style, not just the word. The seller of the velour hoodie never wrote
  'y2k'."

### 6. `red handbag` (colour from the photo)

- **Old:** Red striped handbag · Black handbag · Red puffer coat L.
- **New:** Red striped handbag · Small shoulder bag with chain · Hand-dyed red scarf (all 3 found).
- **Say:** "Old search matched 'red' or 'handbag' anywhere. The new one stays with accessories and
  prefers red ones, using the colour it read from each photo."

### 7. `summer holiday clothes` (a season)

- **Old:** Girls clothes bundle 8y · Summer camp hoodie 12y · Light blue summer dress M.
- **New:** White linen shirt L · Summer camp hoodie 12y · Light blue summer dress M (6 of 8 found,
  old 3 of 8).
- **Say:** "It understands what you would pack for a summer holiday."

---

## Follow-up flow: refine without starting over

1. Type `warm coat for women size M under 50€`.
   - Chips: **Women · Tops · Size M · Under €50**.
   - Top results: Camel wool coat M (€40) · Knitted coat with faux fur hood M (€35) · Warm winter
     parka M (€45).
   - **Say:** "One sentence became four filters you can see and remove."
2. Type `cheaper`.
   - Chips: **Women · Tops · Size M · Under €40**. The price chip changed and the other chips
     stayed.
   - Top results: Knitted coat with faux fur hood M (€35) · Camel wool coat M (€40) · Talvitakki,
     koko M (€38).
   - **Say:** "It remembers the search. 'Cheaper' only lowers the price."
   - (The old search returns nothing for `cheaper`.)

## Relaxation flow: no dead ends

1. Type `sneakers size 45`.
   - There are no shoes in size 45. Instead of an empty page, the new search drops the **EU 45**
     chip by itself, says so, and shows sneakers in other sizes: White canvas sneakers 39 · Red
     canvas high tops 37 · Black and white hi-top sneakers.
   - **Say:** "When nothing matches, it tells you which filter it relaxed, and you can put it back
     with one click."
   - (The old search ignores the size and mixes in a bundle, jeans and a dress.)

---

## An honest limitation

`warm but not wool` (eval: fails in both searches, and the new search is slightly worse).

- **New:** Camel wool coat M · Brown and white wool cardigan S · Grey wool coat L.
- **Say:** "Negation isn't handled yet. It understands 'warm' but not 'not wool'. The planned next
  step is a rerank: Claude reads the top 20 results against the request, moves the wool items down,
  and writes a short reason for each result."

If asked about other misses: `baby blue dress` is read as a kids' search ("baby"), so adult blue
dresses rank too low. The rerank step is meant for this kind of mistake as well.
