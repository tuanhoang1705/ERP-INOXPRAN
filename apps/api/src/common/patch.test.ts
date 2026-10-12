import { describe, expect, it } from 'vitest';
import { UpdateProductSchema } from '@inoxpran/contracts';
import { onlyProvided } from './patch';

describe('onlyProvided', () => {
  it('drops zod defaults for fields the client did not send', () => {
    const raw = { version: 3, name: 'Nồi inox 3 đáy' };
    const parsed = UpdateProductSchema.parse(raw);
    expect(parsed.status).toBe('ACTIVE');
    expect(onlyProvided(raw, parsed)).toEqual({ version: 3, name: 'Nồi inox 3 đáy' });
  });

  it('keeps explicit values, including false and empty arrays', () => {
    const raw = { version: 1, clearance: false, unitConversions: [] };
    expect(onlyProvided(raw, UpdateProductSchema.parse(raw))).toEqual(raw);
  });
});
