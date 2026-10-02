/**
 * Claude API usage log. Every Claude call must be logged with logClaudeUsage.
 *
 * Report: node server/smart-search-lib/usage.js
 */
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', '..', 'logs', 'claude-usage.jsonl');

// USD per million tokens. Cache writes cost 1.25× input and cache reads 0.1× input.
const PRICES = {
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
};

// Also matches dated ids that the API may return, e.g. 'claude-haiku-4-5-20251001'.
const priceFor = model =>
  Object.entries(PRICES).find(([id]) => model === id || model?.startsWith(`${id}-`))?.[1] || null;

/**
 * Estimated cost in USD of one call, or null for a model without a known price.
 */
const costUsd = (model, usage = {}) => {
  const price = priceFor(model);
  if (!price) {
    return null;
  }
  const inputTokens =
    (usage.input_tokens || 0) +
    1.25 * (usage.cache_creation_input_tokens || 0) +
    0.1 * (usage.cache_read_input_tokens || 0);
  return (inputTokens * price.input + (usage.output_tokens || 0) * price.output) / 1e6;
};

/**
 * Append one JSON line for a Claude call.
 *
 * @param {{ purpose: string, model: string, usage: Object }} call usage is response.usage
 * @param {string} file log file (tests pass a temp file)
 */
const logClaudeUsage = ({ purpose, model, usage }, file = LOG_FILE) => {
  const record = { time: new Date().toISOString(), purpose, model, usage };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
  return record;
};

const readUsageLog = (file = LOG_FILE) =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line))
    : [];

const emptyTotals = () => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpriced: 0 });

const addRecord = (totals, { model, usage = {} }) => {
  const cost = costUsd(model, usage);
  totals.calls += 1;
  totals.inputTokens +=
    (usage.input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0);
  totals.outputTokens += usage.output_tokens || 0;
  totals.costUsd += cost || 0;
  totals.unpriced += cost === null ? 1 : 0;
};

/**
 * Calls, tokens and estimated cost per purpose and in total.
 */
const summarizeUsage = records => {
  const byPurpose = {};
  const total = emptyTotals();
  records.forEach(record => {
    const purpose = record.purpose || '(none)';
    byPurpose[purpose] = byPurpose[purpose] || emptyTotals();
    addRecord(byPurpose[purpose], record);
    addRecord(total, record);
  });
  return { byPurpose, total };
};

const formatLine = (name, t) =>
  `${name.padEnd(20)} ${String(t.calls).padStart(6)} calls ` +
  `${String(t.inputTokens).padStart(10)} in ${String(t.outputTokens).padStart(9)} out ` +
  `$${t.costUsd.toFixed(4)}` +
  (t.unpriced ? ` (+${t.unpriced} calls with unknown model price)` : '');

const formatReport = summary =>
  [
    ...Object.entries(summary.byPurpose).map(([purpose, t]) => formatLine(purpose, t)),
    formatLine('TOTAL', summary.total),
  ].join('\n');

if (require.main === module) {
  const records = readUsageLog();
  console.log(
    records.length ? formatReport(summarizeUsage(records)) : `No calls logged in ${LOG_FILE}`
  );
}

module.exports = {
  LOG_FILE,
  PRICES,
  costUsd,
  logClaudeUsage,
  readUsageLog,
  summarizeUsage,
  formatReport,
};
