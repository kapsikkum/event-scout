/**
 * Name the timezone for one test, and put it back afterwards.
 *
 * Day boundaries depend on it, and CI runs in UTC while a laptop here runs in
 * Sydney: a test that inherits the zone passes on one and fails on the other.
 */
export function useZone(t: { after: (fn: () => void) => void }, zone: string): void {
  const before = process.env.TZ;
  t.after(() => {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  });
  process.env.TZ = zone;
}
