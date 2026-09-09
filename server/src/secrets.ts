import { Settings } from './sources/types.js';

/**
 * Keeping the credentials out of the settings response.
 *
 * `GET /api/settings` used to hand back the Facebook cookie and every API key
 * in plaintext. It is gated behind the password, so this was not a hole so much
 * as a needless risk: the page has to know *whether* a cookie is set, and never
 * needs the value read back to it. Anything that only ever travels one way
 * cannot leak through a screenshot, a proxy log, a browser cache or a shoulder.
 *
 * Redaction happens at the HTTP boundary only. `getSettings()` inside the
 * server still returns the real values, because the scrapers need them — so
 * nothing about how the app works changes, only what it says out loud.
 */

/** The fields never sent back. Each is a credential for somebody else's API. */
export const SECRET_KEYS = [
  'ticketmasterKey',
  'seatgeekClientId',
  'eventbriteToken',
  'fbCookie',
] as const;

export type SecretKey = (typeof SECRET_KEYS)[number];

/** What the settings response says instead of the values. */
export interface RedactedSettings extends Settings {
  /**
   * Which credentials are stored, so the page can say "set" without being told
   * what to. The only thing that replaces the values.
   */
  secretsSet: Record<SecretKey, boolean>;
}

export function redactSettings(settings: Settings): RedactedSettings {
  const out = { ...settings } as RedactedSettings;
  const secretsSet = {} as Record<SecretKey, boolean>;
  for (const key of SECRET_KEYS) {
    secretsSet[key] = Boolean(settings[key]?.trim());
    out[key] = '';
  }
  out.secretsSet = secretsSet;
  return out;
}

/**
 * What a credential should become, given what the client sent.
 *
 * The rule is forced by how the page saves: it PUTs the whole settings object
 * it was given, and what it was given has the credentials blanked. So an empty
 * string has to mean "leave it alone" — read the other way, every save from the
 * settings page would wipe every key the moment this shipped.
 *
 * That leaves no way to spell "remove it", so `null` is it. Explicit, and
 * impossible to arrive at by accident: a text input yields `''`, never null.
 */
export function resolveSecret(current: string, supplied: unknown): string {
  if (supplied === null) return '';
  if (typeof supplied !== 'string') return current;
  const trimmed = supplied.trim();
  if (!trimmed) return current;
  return trimmed;
}

/**
 * Apply an incoming settings body over the stored one, credentials included.
 *
 * Kept beside the redaction rather than in the route, because the two only make
 * sense read together: this is the half that undoes what that half did.
 */
export function mergeSecrets(current: Settings, body: Record<string, unknown>): Partial<Settings> {
  const out: Record<string, string> = {};
  for (const key of SECRET_KEYS) {
    out[key] = resolveSecret(current[key] ?? '', body[key]);
  }
  return out as Partial<Settings>;
}
