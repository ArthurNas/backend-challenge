import type { Subprocess } from 'bun';

export class ApiProcess {
  private constructor(
    private readonly child: Subprocess<'ignore', 'pipe', 'inherit'>,
    readonly url: string,
    readonly pid: number,
  ) {}

  static async start(
    databaseUrl: string,
    environment: Record<string, string> = {},
  ): Promise<ApiProcess> {
    const child = Bun.spawn([process.execPath, 'test/support/serve-api.ts'], {
      env: { ...process.env, DATABASE_URL: databaseUrl, ...environment },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'inherit',
    });
    try {
      const ready = await ApiProcess.readReady(child.stdout);
      return new ApiProcess(child, ready.url, ready.pid);
    } catch (error) {
      child.kill();
      await child.exited;
      throw error;
    }
  }

  async stop(force = false): Promise<void> {
    if (this.child.exitCode === null) this.child.kill(force ? 'SIGKILL' : 'SIGTERM');
    await this.child.exited;
  }

  async waitForCommit(): Promise<void> {
    const value = await ApiProcess.readLine(this.child.stdout);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('phase' in value) ||
      value.phase !== 'committed'
    ) {
      throw new Error('Consumer did not confirm commit');
    }
  }

  async submit<T>(body: unknown, idempotencyKey: string): Promise<{ status: number; body: T }> {
    const response = await fetch(`${this.url}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    return { status: response.status, body: (await response.json()) as T };
  }

  private static async readReady(
    stream: ReadableStream<Uint8Array>,
  ): Promise<{ url: string; pid: number }> {
    const ready = await ApiProcess.readLine(stream);
    if (
      typeof ready !== 'object' ||
      ready === null ||
      !('url' in ready) ||
      typeof ready.url !== 'string' ||
      !('pid' in ready) ||
      typeof ready.pid !== 'number'
    ) {
      throw new Error('Invalid API process readiness message');
    }
    return { url: ready.url, pid: ready.pid };
  }

  private static async readLine(stream: ReadableStream<Uint8Array>): Promise<unknown> {
    const reader = stream.getReader();
    const timeout = setTimeout(() => {
      void reader.cancel();
    }, 15000);
    let output = '';
    try {
      while (!output.includes('\n')) {
        const result = await reader.read();
        if (result.done) throw new Error('API process did not announce readiness');
        output += new TextDecoder().decode(result.value);
      }
      return JSON.parse(output.split('\n')[0]!) as unknown;
    } finally {
      clearTimeout(timeout);
      reader.releaseLock();
    }
  }
}
