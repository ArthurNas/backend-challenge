export async function eventually(
  condition: () => Promise<boolean>,
  timeout = 15000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(50);
  }
  throw new Error('Condition did not become true before timeout');
}
