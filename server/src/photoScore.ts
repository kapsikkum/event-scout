import { RawEvent } from './sources/types.js';

/**
 * How much there is to shoot, guessed from the words.
 *
 * A first pass, not a verdict: the local model re-scores what it can reach and
 * the two are averaged, so this only has to be roughly right. It was not.
 *
 * The Repco Bathurst 1000 — a 1,000 km touring car race up a mountain, and the
 * most photographed motorsport event in the country — scored 15 out of 100,
 * which is the band this file reserves for webinars and AGMs. Three separate
 * reasons, none of them subtle:
 *
 *   - `CATEGORY_SCORES` was keyed on Ticketmaster's vocabulary ("music",
 *     "arts & theatre", "miscellaneous") and never updated when this app grew
 *     its own. Nine of the fourteen categories in `topics.ts` matched nothing,
 *     Motorsport, Cars & bikes, Markets, Sport and Heritage among them.
 *   - `\bmarket\b` does not match "Markets", and `car show` does not match
 *     "Car and Bike Show", so two of the best-signal keywords missed the very
 *     titles they were written for.
 *   - There was no motorsport vocabulary at all. Not "supercars", not "track
 *     day", not "speedway".
 *
 * So an event with no description scored base plus the image bonus, whatever it
 * was. The categories below are the ones this app actually assigns.
 */

/**
 * Keyword → weight, applied on top of the category.
 *
 * Plurals and the looser phrasings are spelled out rather than assumed: every
 * regex here was checked against titles that have actually turned up.
 */
const KEYWORDS: [RegExp, number][] = [
  // Motorsport, which had no vocabulary at all before.
  [/\b(supercars?|v8s?|touring cars?|formula|grand prix)\b/i, 30],
  [/\b(speedway|drag ?(racing|strip)|hill ?climb|khanacross|autocross|motocross|rallycross)\b/i, 30],
  [/\b(track ?day|test (and|&) tune|race ?(day|meeting|weekend)|enduro|endurance)\b/i, 25],
  [/\b(rodeo|races?|racing|marathon|triathlon|regatta)\b/i, 25],
  // Cars and bikes as objects, not as a race.
  [/\b(car|auto|motor|truck|tractor|bike|motorcycle)s? ?(show|meet|display|muster|run|cruise)\b/i, 30],
  [/\b(cars? (and|&) coffee|cruise-?in|swap meet|show ?(and|&) ?shine|burnout)\b/i, 30],
  // Everything else, largely as it was.
  [/\b(festivals?|fest)\b/i, 30],
  [/\b(parades?|processions?)\b/i, 35],
  [/\b(air ?shows?|fly-?ins?|airshows?)\b/i, 35],
  [/\b(fireworks?)\b/i, 30],
  [/\b(carnivals?|fairs?|shows?grounds?)\b/i, 24],
  [/\b(markets?|flea)\b/i, 22],
  [/\b(concerts?|live music|bands?|orchestras?|symphony|gig)\b/i, 18],
  [/\b(balloons?|kites?|lanterns?)\b/i, 32],
  [/\b(steam|vintage|veteran|classic|heritage|historic|restor\w+)\b/i, 22],
  [/\b(outdoor|open air|parks?|plazas?|riverfront|waterfront|foreshore|downtown)\b/i, 15],
  [/\b(cosplay|comic ?con|renaissance|re-?enactments?)\b/i, 28],
  [/\b(food trucks?|brew ?fest|beer fest|wine (walk|tasting)|taste of)\b/i, 18],
  [/\b(art walk|galler(y|ies)|murals?|sculptures?|exhibitions?|installations?)\b/i, 15],
  [/\b(dance|ballet|performances?|theater|theatre|circus)\b/i, 12],
  [/\b(holiday|christmas|halloween|easter|anzac|australia day|new year)\b/i, 15],
  [/\b(grand opening|ribbon cutting|ceremon(y|ies)|dedication)\b/i, 12],
  [/\b(protests?|rall(y|ies)|marches|march)\b/i, 18],
  [/\b(sports?|games?|matches|match|tournaments?|championships?|finals?)\b/i, 12],
  [/\b(wildlife|nature|gardens?|bloom|botanical)\b/i, 14],
  // Negative signals — hard to shoot or visually dull.
  [/\b(webinars?|zoom|virtual|online only|livestreams?)\b/i, -50],
  [/\b(class(es)?|workshops?|seminars?|lectures?|training|courses?)\b/i, -10],
  [/\b(networking|meetings?|conference call|book club|agm)\b/i, -12],
  [/\b(bingo|trivia)\b/i, -8],
];

/**
 * What a category is worth before anything else is read.
 *
 * These are this app's own categories, from `topics.ts`. Matched exactly rather
 * than by substring: the old code asked whether "motorsport" contained "sports"
 * — it does not — and that near-miss is what kept the whole table from firing.
 */
const CATEGORY_SCORES: Record<string, number> = {
  'motorsport': 38,
  'festivals': 34,
  'cars & bikes': 30,
  'seasonal': 30,
  'live music': 26,
  'country & agricultural': 26,
  'heritage & machinery': 24,
  'markets': 18,
  'sport': 18,
  'arts & culture': 16,
  'nightlife': 13,
  'food & drink': 13,
  'community': 10,
  // 'Event' is the catch-all and says nothing, so it is deliberately absent.
};

/**
 * The most the words alone may add.
 *
 * Positives are capped rather than summed because they stack on the very events
 * that need ranking apart: "Swap Meet, Car and Bike Show" hits swap-meet, car-
 * show and the category, and reached 110 before clamping — as did half a dozen
 * others, all landing on 100 together and telling the sort nothing. A ceiling
 * keeps the categories doing the ranking and the keywords doing the nudging.
 *
 * Negatives are not capped: a webinar that is also a lecture and an AGM should
 * be able to fall all the way to nothing.
 */
const MAX_KEYWORD_BONUS = 30;

export function photoScore(ev: RawEvent): number {
  if (ev.isOnline) return 0;
  const text = `${ev.title} ${ev.description ?? ''}`.slice(0, 2000);

  let positive = 0;
  let negative = 0;
  for (const [re, w] of KEYWORDS) {
    if (!re.test(text)) continue;
    if (w >= 0) positive += w;
    else negative += w;
  }

  const score =
    10 + // base: any in-person event is shootable
    (CATEGORY_SCORES[(ev.category ?? '').trim().toLowerCase()] ?? 0) +
    Math.min(positive, MAX_KEYWORD_BONUS) +
    negative +
    (ev.imageUrl ? 5 : 0); // organisers who post imagery tend to run visual events

  return Math.max(0, Math.min(100, score));
}
