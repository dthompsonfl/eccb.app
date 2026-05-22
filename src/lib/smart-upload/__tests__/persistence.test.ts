import { describe, expect, it } from 'vitest';
import {
  parseSmartUploadJsonArray,
  parseSmartUploadJsonField,
  serializeSmartUploadJsonField,
  serializeSmartUploadSessionData,
} from '@/lib/smart-upload/persistence';

describe('smart upload persistence helpers', () => {
  it('parses JSON strings and object values through the same typed boundary', () => {
    expect(parseSmartUploadJsonField('{"title":"Suite"}', { title: 'fallback' })).toEqual({
      title: 'Suite',
    });
    expect(parseSmartUploadJsonField({ title: 'March' }, { title: 'fallback' })).toEqual({
      title: 'March',
    });
    expect(parseSmartUploadJsonField('', { title: 'fallback' })).toEqual({ title: 'fallback' });
    expect(parseSmartUploadJsonField('not-json', { title: 'fallback' })).toEqual({ title: 'fallback' });
  });

  it('always returns an array for structured array fields', () => {
    expect(parseSmartUploadJsonArray('[{"partName":"Flute"}]')).toEqual([{ partName: 'Flute' }]);
    expect(parseSmartUploadJsonArray([{ partName: 'Clarinet' }])).toEqual([{ partName: 'Clarinet' }]);
    expect(parseSmartUploadJsonArray('{"partName":"Not an array"}')).toEqual([]);
  });

  it('serializes structured session fields before Prisma writes', () => {
    const serialized = serializeSmartUploadSessionData({
      parseStatus: 'PARSED',
      extractedMetadata: { title: 'American Patrol' },
      parsedParts: [{ partName: '1st Clarinet' }],
      cuttingInstructions: [{ partName: '1st Clarinet', pageRange: [1, 2] }],
      tempFiles: ['tmp/file.pdf'],
    });

    expect(serialized.parseStatus).toBe('PARSED');
    expect(serialized.extractedMetadata).toBe('{"title":"American Patrol"}');
    expect(serialized.parsedParts).toBe('[{"partName":"1st Clarinet"}]');
    expect(serialized.cuttingInstructions).toBe('[{"partName":"1st Clarinet","pageRange":[1,2]}]');
    expect(serialized.tempFiles).toBe('["tmp/file.pdf"]');
  });

  it('preserves already-serialized JSON and JSON-encodes plain strings', () => {
    expect(serializeSmartUploadJsonField('{"already":true}')).toBe('{"already":true}');
    expect(serializeSmartUploadJsonField('plain text')).toBe('"plain text"');
    expect(serializeSmartUploadJsonField(null)).toBeNull();
  });
});
