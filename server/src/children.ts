/**
 * Whether an event is for children: the ones taking part are kids.
 *
 * Such an event scores nothing for photos, whatever the keywords or the model
 * say. Nobody wants a stranger with a long lens at their child's dance class,
 * and a scouting list that ranks one at 40 is recommending exactly that. The
 * Highland Dancing classes in Orange did: 15 from the keywords, 40 from the
 * model, and a card with a row of five-year-olds on it.
 *
 * The hard part is the incidental mention. A car show says "kids under 12
 * free", a festival has a kids' zone, a market is family-friendly — events for
 * everyone that children happen to come to. So those phrasings are struck out
 * before anything is read, and what is left has to say who the event is for: a
 * child word in the title, or "your child", "for kids", "ages 5-12" in the
 * blurb.
 */

const CHILD_WORD = String.raw`(?:kids?|kid'?s|child(?:ren)?(?:'?s)?|toddlers?|infants?|pre-?school(?:ers?)?|juniors?|tweens?|teens?|teenagers?|youth|little ones?|playgroups?|story ?time|school holidays?)`;

/** Children mentioned as a ticket price, a welcome or a corner of something bigger. */
const INCIDENTAL: RegExp[] = [
  // "Kids under 12 free", "children aged 5-15 $10".
  /\b(?:kids?|child(?:ren)?)\s+(?:under|aged?|ages)\s+\d{1,2}[^.;\n]{0,40}/gi,
  // "Child ticket", "kids' entry", "kids go free".
  /\b(?:kids?|child(?:ren)?)'?s?\s+(?:tickets?|entry|admission|prices?|pass(?:es)?|go free|eat free|free)\b/gi,
  /\bfree for (?:kids|children)\b/gi,
  /\bunder[- ]?\d{1,2}s?\s+(?:are\s+|get in\s+|enter\s+)?(?:free|half|\$\s?\d+)/gi,
  /\$\s?\d+[^.;\n]{0,20}\bages?\s*\d{1,2}\s*(?:-|–|to)\s*\d{1,2}/gi,
  /\bages?\s*\d{1,2}\s*(?:-|–|to)\s*\d{1,2}[^.;\n]{0,15}(?:\$|free|half)/gi,
  // "Kid-friendly", "children welcome", "bring the kids".
  /\b(?:kids?|child(?:ren)?|family|pram)[- ](?:friendly|welcome)\b/gi,
  /\b(?:kids|children) (?:are |most |also )?welcome\b/gi,
  /\b(?:bring|and) the (?:kids|children|family)\b/gi,
  // "Kids' zone", "children's rides": part of an event, not its audience.
  /\b(?:kids?|child(?:ren)?)'?s?\s+(?:zone|area|corner|rides?|activities|entertainment|amusements|games|face ?painting|jumping castle)\b/gi,
  /\b(?:kids|children) (?:and|&) (?:adults|grown-?ups|parents)\b/gi,
  /\bfor (?:kids|children) (?:and|&) (?:adults|grown-?ups|parents|the whole family)\b/gi,
  // "Lantern-making workshops for children", "rides providing fun for
  // children", "Watotos Corner, designed specifically for children": what a
  // festival lays on for the kids who come, which every one of them does. These
  // are the ones that caught the Greek festival and the Campbelltown carols.
  /\b(?:activit(?:y|ies)|workshops?|fun|games|rides|entertainment|crafts?|stalls?|amusements|corner|zone|area|tent|space)\b[^.;\n]{0,40}?\b(?:for|to|suitable for|designed (?:specifically )?for|aimed at)\s+(?:kids|children|little ones|young people)\b/gi,
  /\b(?:while|as) your (?:kids|children|little ones)\b/gi,
];

/**
 * Titles that name an event for everyone.
 *
 * A festival, a fair or the carols says in its blurb what it has for the kids,
 * and however that is worded it is not a children's event. The title still
 * counts — "Kids Festival" is one — but the blurb alone may not make it one.
 */
const FOR_EVERYONE = /\b(?:festivals?|fest|fairs?|fete|carnivals?|carols|markets?|expo)\b/i;

/** Wording that says who the event is for. */
const AUDIENCE: RegExp[] = [
  /\byour (?:child|children|kids?|little ones?|toddlers?|teens?)\b/i,
  /\bfor (?:kids|children|toddlers|teens|teenagers|young people|little ones|juniors)\b/i,
  /\b(?:kids|children|toddlers|teens)\s+(?:can |will )?learn\b/i,
  /\b(?:school holiday|holiday) (?:program|programme|workshops?|activit(?:y|ies)|camps?)\b/i,
  // "Aged 8 and under", "Under 12s" once the prices are gone.
  /\b(?:aged?|ages)\s+\d{1,2}\s*(?:years?\s*)?(?:and|&)\s*under\b/i,
  /\bunder[- ]?(?:1[0-7]|[4-9])s\b/i,
];

/** "Ages 5-12", "aged 3 to 8": a range that stops short of adulthood. */
const AGE_RANGE = /\bage[sd]?\s*(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\b/gi;

const strip = (text: string): string => INCIDENTAL.reduce((t, re) => t.replace(re, ' '), text);

/** The words that made it a children's event, or null when nothing did. */
export function whyForChildren(title: string, description = ''): string | null {
  const inTitle = strip(title).match(new RegExp(String.raw`\b${CHILD_WORD}\b`, 'i'));
  if (inTitle) return inTitle[0];
  if (FOR_EVERYONE.test(title)) return null;

  const body = strip(description.slice(0, 3000));
  for (const re of AUDIENCE) {
    const m = body.match(re);
    if (m) return m[0];
  }
  for (const m of body.matchAll(AGE_RANGE)) if (Number(m[2]) <= 17) return m[0];
  // Mentioned over and over, the child is the subject.
  const words = body.match(new RegExp(String.raw`\b${CHILD_WORD}\b`, 'gi')) ?? [];
  return words.length >= 3 ? words.join(', ') : null;
}

export function isForChildren(title: string, description = ''): boolean {
  return whyForChildren(title, description) !== null;
}
