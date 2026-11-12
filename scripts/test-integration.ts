export {};

if (!process.env.TEST_DATABASE_URL) {
  throw new Error('Set TEST_DATABASE_URL to a PostgreSQL server with CREATEDB permission');
}

if (!process.env.TEST_SQS_ENDPOINT) {
  throw new Error('Set TEST_SQS_ENDPOINT to run the real SQS integration tests');
}

const testRun = Bun.spawn([process.execPath, 'test', 'test/integration'], {
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});

process.exitCode = await testRun.exited;
