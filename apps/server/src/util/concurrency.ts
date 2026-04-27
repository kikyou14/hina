export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const parallelism = Math.max(1, Math.min(limit, items.length));
  const out = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: parallelism }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      out[idx] = await worker(items[idx], idx);
    }
  });

  await Promise.all(runners);
  return out;
}
