// expect: none
export async function send(url: string): Promise<number> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  return res.status;
}
