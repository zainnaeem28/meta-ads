// expect: none
// The generated API client calls the product's own relative API base from the browser; it is not provider egress.
export async function call(path: string): Promise<number> {
  const res = await fetch(`/api${path}`);
  return res.status;
}
