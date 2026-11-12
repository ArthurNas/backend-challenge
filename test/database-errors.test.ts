import { describe, expect, test } from 'bun:test';
import { isTransientDatabaseError } from '../src/infrastructure/database/database-errors';

describe('Classificação de falhas de infraestrutura', () => {
  test.each([
    '57P01',
    '57P02',
    '57P03',
    '40001',
    '40P01',
    '55P03',
    '08006',
    'ECONNREFUSED',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'EAI_AGAIN',
    'ENOTFOUND',
  ])('%s deve permitir retry do cliente', (code) => {
    expect(isTransientDatabaseError({ code })).toBe(true);
  });

  test.each(['23505', '23514', '28P01', '42601'])(
    '%s não é tratado como indisponibilidade temporária',
    (code) => {
      expect(isTransientDatabaseError({ code })).toBe(false);
    },
  );
});
