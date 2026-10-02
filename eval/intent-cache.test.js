const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  readIntentCache,
  writeIntentCache,
  missingTexts,
  recordIntent,
  replayClient,
} = require('./intent-cache');
const { config, fakeAnthropic, rawIntent } = require('../server/api/smart-search/test-data');

const tempFile = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'intent-cache-')), 'intent-cache.json');

describe('readIntentCache / writeIntentCache', () => {
  it('is empty without a file and reads back what was written', () => {
    const file = tempFile();
    expect(readIntentCache(file)).toEqual({ entries: {} });

    writeIntentCache({ entries: { jumper: { state: { q: 'jumper' } } } }, file);
    expect(readIntentCache(file).entries.jumper.state.q).toBe('jumper');
  });
});

describe('missingTexts', () => {
  it('lists each query text without a cache entry once', () => {
    const queries = [{ text: 'jumper' }, { text: 'y2k' }, { text: 'y2k' }];
    expect(missingTexts(queries, { entries: { jumper: {} } })).toEqual(['y2k']);
  });
});

describe('recordIntent', () => {
  const logUsage = jest.fn();

  it('saves the raw reply and the merged state, and logs usage', async () => {
    const anthropic = fakeAnthropic(rawIntent({ terms: ['sweater'], preferences: ['warm'] }));
    const entry = await recordIntent({ text: 'jumper', config, anthropic, logUsage });

    expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
    expect(logUsage).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'intent' }));
    expect(entry.reply.stop_reason).toBe('end_turn');
    expect(entry.reply.content[0].text).toContain('sweater');
    expect(entry.state).toMatchObject({ q: 'jumper', terms: ['sweater'], preferences: ['warm'] });
  });

  it('returns null when the call fails, so a failure is never cached', async () => {
    const anthropic = { messages: { create: jest.fn(() => Promise.reject(new Error('down'))) } };
    const onError = jest.fn();
    const entry = await recordIntent({ text: 'jumper', config, anthropic, logUsage, onError });

    expect(entry).toBeNull();
    expect(onError).toHaveBeenCalled();
  });
});

describe('replayClient', () => {
  it('answers with the cached reply', async () => {
    const reply = { stop_reason: 'end_turn', content: [] };
    await expect(replayClient({ reply }).messages.create()).resolves.toBe(reply);
  });
});
