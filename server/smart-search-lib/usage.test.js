const fs = require('fs');
const os = require('os');
const path = require('path');
const { costUsd, logClaudeUsage, readUsageLog, summarizeUsage, formatReport } = require('./usage');

const MILLION = 1000000;

describe('costUsd', () => {
  it('prices claude-haiku-4-5 at $1 input / $5 output per million tokens', () => {
    expect(costUsd('claude-haiku-4-5', { input_tokens: MILLION, output_tokens: 0 })).toBe(1);
    expect(costUsd('claude-haiku-4-5', { input_tokens: 0, output_tokens: MILLION })).toBe(5);
    expect(costUsd('claude-haiku-4-5', { input_tokens: 2000, output_tokens: 500 })).toBeCloseTo(
      0.0045,
      10
    );
  });

  it('prices claude-sonnet-5-5 at $2 input / $10 output per million tokens', () => {
    expect(costUsd('claude-sonnet-5-5', { input_tokens: MILLION, output_tokens: 0 })).toBe(2);
    expect(costUsd('claude-sonnet-5-5', { input_tokens: 0, output_tokens: MILLION })).toBe(10);
    expect(costUsd('claude-sonnet-5-5', { input_tokens: 5000, output_tokens: 1000 })).toBeCloseTo(
      0.02,
      10
    );
  });

  it('prices dated model ids like the alias', () => {
    expect(costUsd('claude-haiku-4-5-20251001', { input_tokens: MILLION })).toBe(1);
  });

  it('prices cache writes at 1.25× and cache reads at 0.1× input', () => {
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: MILLION,
      cache_read_input_tokens: MILLION,
    };
    expect(costUsd('claude-sonnet-5-5', usage)).toBeCloseTo(2.7, 10);
  });

  it('returns null for an unknown model', () => {
    expect(costUsd('claude-opus-5-5', { input_tokens: 10 })).toBeNull();
  });
});

describe('logClaudeUsage', () => {
  it('creates the folder and appends one JSON line per call', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-'));
    const file = path.join(dir, 'logs', 'claude-usage.jsonl');
    const usage = { input_tokens: 10, output_tokens: 5 };

    logClaudeUsage({ purpose: 'intent', model: 'claude-haiku-4-5', usage }, file);
    logClaudeUsage({ purpose: 'rerank', model: 'claude-sonnet-5-5', usage }, file);

    const lines = fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({
      time: expect.any(String),
      purpose: 'intent',
      model: 'claude-haiku-4-5',
      usage,
    });
    expect(readUsageLog(file).map(r => r.purpose)).toEqual(['intent', 'rerank']);

    fs.rmSync(dir, { recursive: true });
  });

  it('reads a missing log as empty', () => {
    expect(readUsageLog(path.join(os.tmpdir(), 'does-not-exist', 'x.jsonl'))).toEqual([]);
  });
});

describe('summarizeUsage', () => {
  const records = [
    {
      purpose: 'intent',
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 1000, output_tokens: 200 },
    },
    {
      purpose: 'intent',
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 3000, output_tokens: 600 },
    },
    {
      purpose: 'rerank',
      model: 'claude-sonnet-5-5',
      usage: { input_tokens: 5000, output_tokens: 1000 },
    },
    {
      purpose: 'rerank',
      model: 'some-unknown-model',
      usage: { input_tokens: 7, output_tokens: 3 },
    },
  ];

  it('sums calls, tokens and cost per purpose and in total', () => {
    const { byPurpose, total } = summarizeUsage(records);

    // intent: 4000 × $1/M + 800 × $5/M = 0.004 + 0.004
    expect(byPurpose.intent).toMatchObject({ calls: 2, inputTokens: 4000, outputTokens: 800 });
    expect(byPurpose.intent.costUsd).toBeCloseTo(0.008, 10);

    // rerank: 5000 × $2/M + 1000 × $10/M = 0.01 + 0.01, plus one unpriced call
    expect(byPurpose.rerank).toMatchObject({
      calls: 2,
      inputTokens: 5007,
      outputTokens: 1003,
      unpriced: 1,
    });
    expect(byPurpose.rerank.costUsd).toBeCloseTo(0.02, 10);

    expect(total).toMatchObject({ calls: 4, inputTokens: 9007, outputTokens: 1803, unpriced: 1 });
    expect(total.costUsd).toBeCloseTo(0.028, 10);
  });

  it('formats one line per purpose and a total line', () => {
    const report = formatReport(summarizeUsage(records));
    const lines = report.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^intent\s+2 calls .* \$0\.0080$/);
    expect(lines[2]).toMatch(
      /^TOTAL\s+4 calls .* \$0\.0280 \(\+1 calls with unknown model price\)$/
    );
  });
});
