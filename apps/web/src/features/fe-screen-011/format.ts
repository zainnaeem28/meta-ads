const DAY = 86_400_000;

/** `u_8f3a…c21d`: the user ID as the design shows it (first and last four characters). */
export function shortId(id: string): string {
  const hex = id.replace(/-/g, '');
  return `u_${hex.slice(0, 4)}…${hex.slice(-4)}`;
}

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "Today", "Yesterday", "9 days ago" up to a month, otherwise the calendar date. */
export function addedLabel(iso: string, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(new Date(iso).getTime())) / DAY);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
