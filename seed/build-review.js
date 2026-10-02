/**
 * Builds seed/review.html: a local grid of every planned listing (photo, key, role, title, price,
 * queries) for checking the seed plan by eye. No network.
 *
 * Run: node seed/build-review.js   then open seed/review.html in a browser.
 */
const fs = require('fs');
const path = require('path');

const plan = JSON.parse(fs.readFileSync(path.join(__dirname, 'plan.json'), 'utf8'));

const esc = s =>
  String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const queryText = Object.fromEntries(plan.queries.map(q => [q.id, q.text]));
const gradeFor = (key, queryId) =>
  plan.queries.find(q => q.id === queryId).relevant.find(r => r.ref === `seed:${key}`)?.grade;

const card = l => {
  const queries = l.forQueries
    .map(id => {
      const grade = gradeFor(l.key, id);
      const label = grade ? `grade ${grade}` : 'not relevant';
      return `<li title="${esc(queryText[id])}">${id} · ${esc(queryText[id])} <b>${label}</b></li>`;
    })
    .join('');
  const pd = l.publicData;
  const photo = l.image
    ? `<img src="images/${esc(l.key)}.jpg" alt="${esc(l.title)}" loading="lazy">`
    : '<div class="nophoto">no photo</div>';
  return `<article class="card" data-queries="${l.forQueries.join(' ')}">
  ${photo}
  <div class="body">
    <div class="meta"><span class="role ${l.role}">${l.role}</span> <code>${esc(l.key)}</code></div>
    <h2>${esc(l.title)} · €${l.priceEur}</h2>
    <p class="cat">${esc(pd.categoryLevel2 || pd.categoryLevel1)} · colour: ${esc(
    pd.color || '—'
  )}</p>
    <p class="desc">${esc(l.description)}</p>
    <ul>${queries}</ul>
  </div>
</article>`;
};

const options = plan.queries
  .map(q => `<option value="${q.id}">${q.id} · ${esc(q.text)} (${q.tests})</option>`)
  .join('');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Seed Plan Review</title>
<style>
  :root { --bg: #f6f6f4; --card: #fff; --text: #1d1d1b; --muted: #6b6b66; --line: #e2e2dd; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #161615; --card: #22221f; --text: #ecece8; --muted: #a3a39c; --line: #3a3a35; }
  }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--text); font: 14px/1.4 system-ui, sans-serif; }
  header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 16px; }
  h1 { font-size: 20px; margin: 0; }
  select { font: inherit; padding: 4px; max-width: 100%; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .card img, .nophoto { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; }
  .nophoto { display: grid; place-items: center; color: var(--muted); background: var(--line); }
  .body { padding: 10px; }
  h2 { font-size: 15px; margin: 6px 0 2px; }
  .cat, .desc { margin: 2px 0; color: var(--muted); font-size: 13px; }
  ul { margin: 6px 0 0; padding-left: 16px; font-size: 12px; }
  .role { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--line); }
  .role.direct { background: #2e7d32; color: #fff; }
  .role.hidden { background: #1565c0; color: #fff; }
  .role.near-miss { background: #ef6c00; color: #fff; }
  .role.distractor { background: #6a1b9a; color: #fff; }
  code { font-size: 11px; color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1>Seed plan review</h1>
  <span>${plan.listings.length} listings, ${
  plan.listings.filter(l => l.image).length
} with photos</span>
  <select id="q"><option value="">All queries</option>${options}</select>
</header>
<main class="grid">
${plan.listings.map(card).join('\n')}
</main>
<script>
  document.getElementById('q').addEventListener('change', e => {
    document.querySelectorAll('.card').forEach(c => {
      c.hidden = !!e.target.value && !c.dataset.queries.split(' ').includes(e.target.value);
    });
  });
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(__dirname, 'review.html'), html);
console.log('Wrote seed/review.html');
