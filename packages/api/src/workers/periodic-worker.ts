const parseInterval = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const startPeriodicWorker = <TResult>({
  name,
  defaultIntervalMs,
  envVar,
  run,
  onResult,
}: {
  name: string;
  defaultIntervalMs: number;
  envVar: string;
  run: () => Promise<TResult>;
  onResult?: (result: TResult) => void;
}): (() => void) => {
  const intervalMs = parseInterval(process.env[envVar], defaultIntervalMs);

  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const result = await run();
      onResult?.(result);
    } catch (error) {
      console.error(`[${name}] error:`, error);
    } finally {
      running = false;
    }
  }, intervalMs);

  console.log(`[${name}] started (interval: ${intervalMs}ms)`);

  return () => {
    clearInterval(timer);
    console.log(`[${name}] stopped`);
  };
};
