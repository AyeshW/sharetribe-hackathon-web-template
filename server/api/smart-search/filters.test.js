const { matchesFilter, applyFilters } = require('./filters');
const { listing, filter } = require('./test-data');

const allRelevant = () => true;
const ids = listings => listings.map(l => l.id.uuid);

describe('matchesFilter', () => {
  const jacket = listing({
    id: 'jacket',
    price: 4000,
    publicData: {
      categoryLevel1: 'men',
      categoryLevel2: 'men-tops',
      size: 'l',
      condition: 'gently-used',
      petFreeHome: 'yes',
      brand: ' Levi’s ',
      shippingEnabled: true,
    },
    metadata: { ai: { colorDetected: ['black', 'white'], brand: 'Levi Strauss' } },
  });

  it.each([
    ['enum eq', filter('size', 'l'), true],
    ['enum eq, other value', filter('size', 'm'), false],
    ['enum in', filter('size', ['m', 'l'], { op: 'in' }), true],
    ['enum, field missing', filter('smokeFreeHome', 'yes'), false],
    ['notIn, excluded', filter('categoryLevel2', ['men-tops'], { op: 'notIn' }), false],
    ['notIn, not excluded', filter('categoryLevel2', ['men-bundles'], { op: 'notIn' }), true],
    ['price at max (inclusive)', filter('price', { max: 4000 }), true],
    ['price above max', filter('price', { max: 3999 }), false],
    ['price at min (inclusive)', filter('price', { min: 4000 }), true],
    ['price below min', filter('price', { min: 4001 }), false],
    ['brand, seller text, any case', filter('brand', 'levi’s'), true],
    ['brand, normalised by the indexer', filter('brand', 'LEVI STRAUSS'), true],
    ['brand, other', filter('brand', 'Nike'), false],
    ['shippingEnabled true', filter('shippingEnabled', true), true],
    ['shippingEnabled false', filter('shippingEnabled', false), false],
    ['colour from the photo when the seller left it empty', filter('color', 'white'), true],
    ['colour not in the photo', filter('color', 'red'), false],
  ])('%s', (name, f, expected) => {
    expect(matchesFilter(f, jacket)).toBe(expected);
  });

  it("uses the seller's colour over the detected one", () => {
    const blue = listing({
      id: 'blue',
      publicData: { color: 'blue' },
      metadata: { ai: { colorDetected: ['blue', 'black'] } },
    });
    expect(matchesFilter(filter('color', 'blue'), blue)).toBe(true);
    expect(matchesFilter(filter('color', 'black'), blue)).toBe(false);
  });

  it('treats a listing without shipping as not shippable', () => {
    const local = listing({ id: 'local' });
    expect(matchesFilter(filter('shippingEnabled', true), local)).toBe(false);
  });
});

describe('applyFilters', () => {
  // size l/m × price 3000/5000
  const lCheap = listing({ id: 'l-cheap', price: 3000, publicData: { size: 'l' } });
  const lDear = listing({ id: 'l-dear', price: 5000, publicData: { size: 'l' } });
  const mCheap = listing({ id: 'm-cheap', price: 3000, publicData: { size: 'm' } });
  const mCheap2 = listing({ id: 'm-cheap2', price: 3500, publicData: { size: 'm' } });
  const mDear = listing({ id: 'm-dear', price: 5000, publicData: { size: 'm' } });
  const all = [lCheap, lDear, mCheap, mCheap2, mDear];

  it('applies inferred hard filters, keeps API order, and ignores soft filters', () => {
    const filters = [filter('size', 'm'), filter('color', 'red', { mode: 'soft' })];
    const { results, auto } = applyFilters(all, filters, allRelevant);
    expect(ids(results)).toEqual(['m-cheap', 'm-cheap2', 'm-dear']);
    expect(auto).toBeNull();
  });

  it('does not re-apply buyer filters that the query already applied', () => {
    // The API would have filtered size; a user size filter here must not hide anything.
    const { results } = applyFilters(all, [filter('size', 'xl', { source: 'user' })], allRelevant);
    expect(results).toHaveLength(5);
  });

  it('applies buyer-set brand and shippingEnabled in memory', () => {
    const nike = listing({ id: 'nike', publicData: { brand: 'Nike', shippingEnabled: true } });
    const nikeLocal = listing({ id: 'nike-local', publicData: { brand: 'Nike' } });
    const filters = [
      filter('brand', 'nike', { source: 'user' }),
      filter('shippingEnabled', true, { locked: true }),
    ];
    const { results } = applyFilters([nike, nikeLocal, lCheap], filters, allRelevant);
    expect(ids(results)).toEqual(['nike']);
  });

  it('counts the relevant listings each inferred filter hides', () => {
    const filters = [filter('size', 'l'), filter('price', { max: 4000 })];
    const { results, suggestions } = applyFilters(all, filters, allRelevant);
    expect(ids(results)).toEqual(['l-cheap']);
    // without size: m-cheap, m-cheap2; without price: l-dear
    expect(suggestions).toEqual([
      { key: 'size', label: 'size label', extra: 2 },
      { key: 'price', label: 'price label', extra: 1 },
    ]);
  });

  it('counts only relevant listings and leaves out filters that hide nothing', () => {
    const notMCheap2 = l => l.id.uuid !== 'm-cheap2';
    const filters = [filter('size', 'l'), filter('price', { max: 4000 })];
    // size hides m-cheap (relevant) and m-cheap2 (not relevant); price hides nothing here
    const { suggestions } = applyFilters([lCheap, mCheap, mCheap2], filters, notMCheap2);
    expect(suggestions).toEqual([{ key: 'size', label: 'size label', extra: 1 }]);
  });

  it('auto-drops the inferred filter that recovers the most and suggests the rest', () => {
    const filters = [
      filter('condition', 'like-new'),
      filter('size', 'm'),
      filter('petFreeHome', 'yes'),
    ];
    const likeNewL = listing({
      id: 'like-new-l',
      publicData: { size: 'l', condition: 'like-new', petFreeHome: 'yes' },
    });
    const petFreeM = listing({ id: 'pet-free-m', publicData: { size: 'm', petFreeHome: 'yes' } });
    const petFreeM2 = listing({ id: 'pet-free-m2', publicData: { size: 'm', petFreeHome: 'yes' } });
    const { results, auto, suggestions } = applyFilters(
      [likeNewL, petFreeM, petFreeM2, mCheap],
      filters,
      allRelevant
    );
    // without condition: pet-free-m, pet-free-m2 (2); without size: like-new-l (1);
    // without petFreeHome: none
    expect(auto).toBe(filters[0]);
    expect(ids(results)).toEqual(['pet-free-m', 'pet-free-m2']);
    // after dropping condition: without petFreeHome adds m-cheap; without size adds like-new-l
    expect(suggestions).toEqual([
      { key: 'size', label: 'size label', extra: 1 },
      { key: 'petFreeHome', label: 'petFreeHome label', extra: 1 },
    ]);
  });

  it('drops price last, even when it would recover more', () => {
    const filters = [filter('price', { max: 1000 }), filter('size', 'l')];
    // without price: l-cheap, l-dear (2); without size: m-very-cheap (1)
    const mVeryCheap = listing({ id: 'm-very-cheap', price: 900, publicData: { size: 'm' } });
    const { auto, results } = applyFilters([...all, mVeryCheap], filters, allRelevant);
    expect(auto).toBe(filters[1]);
    expect(ids(results)).toEqual(['m-very-cheap']);
  });

  it('drops price when nothing else recovers any listing', () => {
    const filters = [filter('size', 'l'), filter('price', { max: 1000 })];
    const { auto, results } = applyFilters(all, filters, allRelevant);
    expect(auto).toBe(filters[1]);
    expect(ids(results)).toEqual(['l-cheap', 'l-dear']);
  });

  it('never drops buyer-set or locked filters', () => {
    const nike = listing({ id: 'nike', publicData: { brand: 'Nike', size: 'm' } });
    const filters = [
      filter('brand', 'adidas', { source: 'user' }),
      filter('shippingEnabled', true, { locked: true }),
      filter('size', 'l'),
    ];
    const { results, auto, suggestions } = applyFilters([nike, ...all], filters, allRelevant);
    expect(results).toEqual([]);
    expect(auto).toBeNull();
    expect(suggestions).toEqual([]);
  });

  it('returns nothing when no single drop recovers a relevant listing', () => {
    const filters = [filter('size', 'xl'), filter('condition', 'like-new')];
    const { results, auto } = applyFilters(all, filters, allRelevant);
    expect(results).toEqual([]);
    expect(auto).toBeNull();
  });

  it('does not auto-drop when the recovered listings are not relevant', () => {
    const { results, auto } = applyFilters(all, [filter('size', 'xl')], () => false);
    expect(results).toEqual([]);
    expect(auto).toBeNull();
  });
});
