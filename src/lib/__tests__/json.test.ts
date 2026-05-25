import { describe, it, expect } from 'vitest';
import { deepCloneJSON } from '../json';

describe('deepCloneJSON', () => {
  describe('Primitives', () => {
    it('should return null for null', () => {
      expect(deepCloneJSON(null)).toBe(null);
    });

    it('should return undefined for undefined', () => {
      expect(deepCloneJSON(undefined)).toBe(undefined);
    });

    it('should return the same number', () => {
      expect(deepCloneJSON(42)).toBe(42);
      expect(deepCloneJSON(0)).toBe(0);
      expect(deepCloneJSON(-1)).toBe(-1);
    });

    it('should return the same string', () => {
      expect(deepCloneJSON('hello')).toBe('hello');
      expect(deepCloneJSON('')).toBe('');
    });

    it('should return the same boolean', () => {
      expect(deepCloneJSON(true)).toBe(true);
      expect(deepCloneJSON(false)).toBe(false);
    });
  });

  describe('Dates', () => {
    it('should convert Date to ISO string', () => {
      const date = new Date('2023-01-01T00:00:00Z');
      expect(deepCloneJSON(date)).toBe(date.toISOString());
    });
  });

  describe('Arrays', () => {
    it('should clone a simple array', () => {
      const input = [1, 2, 3];
      const result = deepCloneJSON(input);
      expect(result).toEqual(input);
      expect(result).not.toBe(input);
    });

    it('should convert undefined in arrays to null', () => {
      const input = [1, undefined, 3];
      const result = deepCloneJSON(input);
      expect(result).toEqual([1, null, 3]);
    });

    it('should deeply clone nested arrays', () => {
      const input = [[1], [2, [3]]];
      const result = deepCloneJSON(input);
      expect(result).toEqual(input);
      expect(result[0]).not.toBe(input[0]);
      expect((result[1] as any)[1]).not.toBe((input[1] as any)[1]);
    });
  });

  describe('Objects', () => {
    it('should clone a simple object', () => {
      const input = { a: 1, b: 'test', c: true };
      const result = deepCloneJSON(input);
      expect(result).toEqual(input);
      expect(result).not.toBe(input);
    });

    it('should omit undefined values in objects', () => {
      const input = { a: 1, b: undefined, c: 3 };
      const result = deepCloneJSON(input);
      expect(result).toEqual({ a: 1, c: 3 });
      expect(result).not.toHaveProperty('b');
    });

    it('should omit functions and symbols', () => {
      const input = {
        a: 1,
        b: () => {},
        c: Symbol('test'),
      };
      const result = deepCloneJSON(input);
      expect(result).toEqual({ a: 1 });
    });

    it('should deeply clone nested objects', () => {
      const input = { a: { b: { c: 1 } }, d: [1, 2] };
      const result = deepCloneJSON(input);
      expect(result).toEqual(input);
      expect(result.a).not.toBe(input.a);
      expect(result.a.b).not.toBe(input.a.b);
      expect(result.d).not.toBe(input.d);
    });

    it('should respect toJSON method', () => {
      const input = {
        a: 1,
        b: {
          toJSON: () => 'custom json',
        },
      };
      const result = deepCloneJSON(input);
      expect(result).toEqual({ a: 1, b: 'custom json' });
    });

    it('should respect toJSON at the root', () => {
      const input = {
        id: 1,
        toJSON: () => ({ val: 123 })
      };
      expect(deepCloneJSON(input)).toEqual({ val: 123 });
    });
  });

  describe('Complex structures', () => {
    it('should clone complex nested structures', () => {
      const input = {
        id: 1,
        name: 'Test',
        metadata: {
          tags: ['a', 'b'],
          created: new Date('2023-01-01T00:00:00Z'),
          items: [
            { id: 10, value: undefined },
            { id: 11, toJSON: () => ({ val: 123 }) }
          ]
        }
      };

      const expected = {
        id: 1,
        name: 'Test',
        metadata: {
          tags: ['a', 'b'],
          created: '2023-01-01T00:00:00Z',
          items: [
            { id: 10 },
            { val: 123 }
          ]
        }
      };

      expect(deepCloneJSON(input)).toEqual(expected);
    });
  });
});
