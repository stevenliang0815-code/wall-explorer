export function latestCompletedMarketDate(now = new Date()) {
  const taipei = new Date(now.getTime() + 8 * 60 * 60_000);
  if (taipei.getUTCHours() < 17) taipei.setUTCDate(taipei.getUTCDate() - 1);
  while ([0, 6].includes(taipei.getUTCDay())) taipei.setUTCDate(taipei.getUTCDate() - 1);
  return taipei.toISOString().slice(0, 10);
}

export function nextWeekday(date: string) {
  const cursor = new Date(`${date}T12:00:00Z`);
  do cursor.setUTCDate(cursor.getUTCDate() + 1);
  while ([0, 6].includes(cursor.getUTCDay()));
  return cursor.toISOString().slice(0, 10);
}

export function freshnessStatus(latestDate: string | null, targetDate = latestCompletedMarketDate()) {
  if (!latestDate) return "rebuilding" as const;
  return latestDate >= targetDate ? "fresh" as const : "catching_up" as const;
}
