export {};

if (!process.env.TEST_DATABASE_URL || !process.env.TEST_SQS_ENDPOINT) {
  throw new Error('Set TEST_DATABASE_URL and TEST_SQS_ENDPOINT to run real PostgreSQL/SQS tests');
}

const testRun = Bun.spawn([process.execPath, 'test', 'test/integration/async.test.ts'], {
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});

process.exitCode = await testRun.exited;
