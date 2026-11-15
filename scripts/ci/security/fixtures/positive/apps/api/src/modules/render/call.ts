// expect: shroomap.egress.no-raw-http-outside-platform-egress
export async function ping(): Promise<number> {
  const res = await fetch('https://api.example.test/ping');
  return res.status;
}
