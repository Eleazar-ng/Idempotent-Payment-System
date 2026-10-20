import { canonicalize } from './canonical-json';
import { NonCanonicalValueError } from './errors';

describe('canonicalize', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalize({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}');
  });

  it('gives the same output whatever order the keys arrived in', () => {
    const one = canonicalize({ amount: 5000, currency: 'NGN', meta: { x: 1, y: [1, { q: 1, p: 2 }] } });
    const two = canonicalize({ meta: { y: [1, { p: 2, q: 1 }], x: 1 }, currency: 'NGN', amount: 5000 });
    expect(one).toBe(two);
  });

  it('is unaffected by how the original JSON text was formatted', () => {
    const compact = JSON.parse('{"a":1,"b":[1,2]}');
    const pretty = JSON.parse('{\n  "b": [ 1,\n 2 ],\n\n  "a": 1.0\n}');
    expect(canonicalize(compact)).toBe(canonicalize(pretty));
  });

  it('keeps array order, because order is meaning in an array', () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it('tells apart values that merely look alike', () => {
    const forms = [1, '1', true, 'true', null, 'null', [], {}, [[]], [{}], '', 0, false];
    const outputs = forms.map((f) => canonicalize(f));
    expect(new Set(outputs).size).toBe(forms.length);
  });

  it('treats -0 as 0 and 1.0 as 1', () => {
    expect(canonicalize(-0)).toBe('0');
    expect(canonicalize(1.0)).toBe('1');
  });

  it('distinguishes a missing key from an explicit null', () => {
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: 1, b: null }));
  });

  it('escapes strings unambiguously (quotes, backslashes, unicode, control characters)', () => {
    expect(canonicalize('a"b\\c\n')).toBe('"a\\"b\\\\c\\n"');
    expect(canonicalize({ 'k"ey': 'é😀' })).toBe('{"k\\"ey":"é😀"}');
    // a key containing JSON syntax cannot be confused with structure
    expect(canonicalize({ 'a":1,"b': 2 })).not.toBe(canonicalize({ a: 1, b: 2 }));
  });

  it('handles empty containers and deep nesting', () => {
    expect(canonicalize({})).toBe('{}');
    expect(canonicalize([])).toBe('[]');
    expect(canonicalize({ a: [[{ b: [] }]] })).toBe('{"a":[[{"b":[]}]]}');
  });

  it('accepts objects with a null prototype', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.b = 1;
    bare.a = 2;
    expect(canonicalize(bare)).toBe('{"a":2,"b":1}');
  });

  it('allows the same object to appear twice, as long as it is not circular', () => {
    const shared = { x: 1 };
    expect(canonicalize({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  describe('refuses anything without one obvious canonical form', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    it.each([
      ['undefined', undefined],
      ['undefined inside an object', { a: undefined }],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['a bigint', BigInt(1)],
      ['a function', () => 1],
      ['a symbol', Symbol('x')],
      ['a Date', new Date(0)],
      ['a Map', new Map()],
      ['a class instance', new (class Foo {})()],
      ['a sparse array', [1, , 3]], // eslint-disable-line no-sparse-arrays
      ['a circular reference', circular],
    ])('%s', (_name, value) => {
      expect(() => canonicalize(value)).toThrow(NonCanonicalValueError);
    });

    it('says where the offending value is', () => {
      expect.assertions(1);
      try {
        canonicalize({ a: [1, { b: Number.NaN }] });
      } catch (error) {
        expect((error as NonCanonicalValueError).path).toBe('$.a[1].b');
      }
    });
  });
});
