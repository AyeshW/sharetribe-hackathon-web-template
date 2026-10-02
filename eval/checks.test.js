const { found, bestInTop3, passes } = require('./checks');

// Four correct listings: two clearly right (grade 2), two also relevant (grade 1).
const relevant = [
  { id: 'a', grade: 2 },
  { id: 'b', grade: 2 },
  { id: 'c', grade: 1 },
  { id: 'd', grade: 1 },
];

const ids = n => Array.from({ length: n }, (_, i) => `x${i}`);

describe('found', () => {
  it('counts nothing when no correct listing is in the results', () => {
    expect(found(ids(10), relevant)).toEqual({ found: 0, total: 4 });
  });

  it('counts every correct listing that is in the first ten results', () => {
    expect(found(['a', 'b', 'c', 'd'], relevant)).toEqual({ found: 4, total: 4 });
  });

  it('ignores results after the tenth', () => {
    expect(found([...ids(10), 'a'], relevant)).toEqual({ found: 0, total: 4 });
  });

  it('counts a repeated result once', () => {
    expect(found(['a', 'a', 'a'], relevant)).toEqual({ found: 1, total: 4 });
  });

  it('handles an empty result list', () => {
    expect(found([], relevant)).toEqual({ found: 0, total: 4 });
  });
});

describe('bestInTop3', () => {
  it('is true when a clearly right listing is in the first three', () => {
    expect(bestInTop3(['x0', 'b', 'x1'], relevant)).toBe(true);
  });

  it('is false when the best match is only at position four', () => {
    expect(bestInTop3(['x0', 'x1', 'x2', 'a'], relevant)).toBe(false);
  });

  it('is false when the first three hold only "also relevant" listings', () => {
    expect(bestInTop3(['c', 'd', 'x0'], relevant)).toBe(false);
  });

  it('is false when the query has no clearly right listing at all', () => {
    const onlyGradeOne = [{ id: 'c', grade: 1 }];
    expect(bestInTop3(['c'], onlyGradeOne)).toBe(false);
  });
});

describe('passes', () => {
  it('passes with a clearly right listing in the top three and half of the rest found', () => {
    expect(passes(['a', 'x0', 'x1', 'b', 'x2'], relevant)).toBe(true);
  });

  it('fails when the best match is at position four, even if everything is found', () => {
    expect(passes(['x0', 'x1', 'x2', 'a', 'b', 'c', 'd'], relevant)).toBe(false);
  });

  it('fails when less than half of the correct listings are found', () => {
    expect(passes(['a', ...ids(9)], relevant)).toBe(false);
  });

  it('fails on no results', () => {
    expect(passes([], relevant)).toBe(false);
  });
});
