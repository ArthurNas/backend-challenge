export function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  if ('code' in error && typeof error.code === 'string') return error.code;

  if ('cause' in error) return databaseErrorCode(error.cause);

  return undefined;
}

export function isTransientDatabaseError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'KnexTimeoutError') return true;

  const code = databaseErrorCode(error);
  if (!code) return false;

  return (
    [
      '40001',
      '40P01',
      '55P03',
      '53300',
      '57P01',
      '57P02',
      '57P03',
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EPIPE',
      'ENOTFOUND',
      'EAI_AGAIN',
    ].includes(code) || code.startsWith('08')
  );
}
