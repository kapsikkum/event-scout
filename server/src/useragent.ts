/**
 * One user agent, used by every scraper and by the browser we drive.
 *
 * It was copy-pasted into five files, all claiming Chrome 131, and drifted
 * apart from the client hints sent alongside it — a request whose UA string
 * says Chrome 131 while its sec-ch-ua header says something else is a clearer
 * bot signal than either would be on its own. Worse, once the browser moved
 * into a Linux container it began introducing itself as HeadlessChrome on
 * X11, which is the one thing every anti-bot check looks for.
 *
 * Windows 11 genuinely reports "Windows NT 10.0" in the classic UA string —
 * Microsoft never bumped it — so the platform is carried by the client hints
 * below, where Windows 11 is platform version 13 or above.
 */

/**
 * Bump when it starts to look old. Being a few versions behind is ordinary —
 * plenty of real installs are — while claiming a version that does not exist
 * yet is the direction that stands out.
 */
const MAJOR = '151';
const FULL = '151.0.4129.93';

export const USER_AGENT =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${MAJOR}.0.0.0 Safari/537.36 Edg/${MAJOR}.0.0.0`;

/** Windows 11 24H2. Anything 13 or above reads as Windows 11 rather than 10. */
const PLATFORM_VERSION = '15.0.0';

/** The sec-ch-ua family, kept consistent with the string above. */
export const CLIENT_HINTS: Record<string, string> = {
  'sec-ch-ua': `"Chromium";v="${MAJOR}", "Microsoft Edge";v="${MAJOR}", "Not=A?Brand";v="24"`,
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-ch-ua-platform-version': `"${PLATFORM_VERSION}"`,
};

/** What a top-level navigation from a real browser looks like. */
export const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-AU,en-US;q=0.9,en;q=0.8',
  ...CLIENT_HINTS,
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
};

/**
 * The same identity in the shape `Network.setUserAgentOverride` wants.
 *
 * Setting the UA string alone leaves `navigator.userAgentData` reporting the
 * real platform, so a page that asks for high-entropy hints gets Linux back
 * and the two answers disagree. Passing the metadata keeps the story straight.
 */
export const USER_AGENT_METADATA = {
  brands: [
    { brand: 'Chromium', version: MAJOR },
    { brand: 'Microsoft Edge', version: MAJOR },
    { brand: 'Not=A?Brand', version: '24' },
  ],
  fullVersionList: [
    { brand: 'Chromium', version: FULL },
    { brand: 'Microsoft Edge', version: FULL },
    { brand: 'Not=A?Brand', version: '24.0.0.0' },
  ],
  fullVersion: FULL,
  platform: 'Windows',
  platformVersion: PLATFORM_VERSION,
  architecture: 'x86',
  model: '',
  mobile: false,
  bitness: '64',
  wow64: false,
};
