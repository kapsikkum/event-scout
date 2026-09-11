/**
 * Posting to a Discord webhook.
 *
 * Only ever to Discord's own webhook addresses: the address comes from a form,
 * and a server that will POST to wherever it is told is a server that will POST
 * into its own network. A 429 is waited out as Discord asks, up to a point.
 */

const WEBHOOK = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+(?:\?[\w=&-]*)?$/;

export const isDiscordWebhook = (url: string): boolean => WEBHOOK.test(url.trim());

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function sendDiscord(webhookUrl: string, payloads: Record<string, unknown>[]): Promise<void> {
  if (!webhookUrl.trim()) throw new Error('No webhook address stored for this target');
  if (!isDiscordWebhook(webhookUrl)) throw new Error('That is not a Discord webhook address');
  const url = new URL(webhookUrl.trim());
  url.searchParams.set('wait', 'true');
  for (const payload of payloads) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 429 && attempt < 3) {
        const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
        await sleep(Math.min(30000, Math.max(500, (body.retry_after ?? 1) * 1000)));
        continue;
      }
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 200);
        throw new Error(`Discord answered HTTP ${res.status}${text ? `: ${text}` : ''}`);
      }
      break;
    }
  }
}
