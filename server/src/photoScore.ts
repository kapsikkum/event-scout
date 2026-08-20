import { RawEvent } from './sources/types.js';

// Keyword → weight. Tuned for "would a photographer want to shoot this?"
const KEYWORDS: [RegExp, number][] = [
  [/\b(festival|fest)\b/i, 30],
  [/\b(parade|procession)\b/i, 35],
  [/\b(air ?show|fly-?in|airshow)\b/i, 35],
  [/\b(car show|cars? (and|&) coffee|auto show|motorcycle|cruise-?in)\b/i, 30],
  [/\b(fireworks?)\b/i, 30],
  [/\b(carnival|fair|county fair|state fair)\b/i, 28],
  [/\b(market|farmers'? market|night market|flea)\b/i, 22],
  [/\b(concert|live music|band|orchestra|symphony)\b/i, 18],
  [/\b(rodeo|races?|racing|marathon|triathlon|regatta)\b/i, 25],
  [/\b(balloon|kite|lantern)\b/i, 32],
  [/\b(outdoor|open air|park|plaza|riverfront|waterfront|downtown)\b/i, 15],
  [/\b(cosplay|comic ?con|renaissance|reenactment)\b/i, 28],
  [/\b(food truck|brewfest|beer fest|wine walk|taste of)\b/i, 18],
  [/\b(art walk|gallery|mural|sculpture|exhibition|installation)\b/i, 15],
  [/\b(dance|ballet|performance|theater|theatre|circus)\b/i, 12],
  [/\b(holiday|christmas|halloween|easter|4th of july|independence day|new year)\b/i, 15],
  [/\b(grand opening|ribbon cutting|ceremony|dedication)\b/i, 12],
  [/\b(protest|rally|march)\b/i, 18],
  [/\b(sports?|game|match|tournament|championship)\b/i, 12],
  [/\b(wildlife|nature|garden|bloom|botanical)\b/i, 14],
  // Negative signals — hard to shoot or visually dull
  [/\b(webinar|zoom|virtual|online only|livestream)\b/i, -50],
  [/\b(class|workshop|seminar|lecture|training|course)\b/i, -10],
  [/\b(networking|meeting|conference call|book club)\b/i, -12],
  [/\b(bingo|trivia)\b/i, -8],
];

const CATEGORY_SCORES: Record<string, number> = {
  music: 18,
  sports: 14,
  'arts & theatre': 14,
  arts: 14,
  festival: 30,
  community: 12,
  film: 5,
  miscellaneous: 5,
};

export function photoScore(ev: RawEvent): number {
  if (ev.isOnline) return 0;
  let score = 10; // base: any in-person event is shootable
  const text = `${ev.title} ${ev.description ?? ''}`.slice(0, 2000);
  for (const [re, w] of KEYWORDS) {
    if (re.test(text)) score += w;
  }
  const cat = (ev.category ?? '').toLowerCase();
  for (const [key, w] of Object.entries(CATEGORY_SCORES)) {
    if (cat.includes(key)) {
      score += w;
      break;
    }
  }
  if (ev.imageUrl) score += 5; // organizers who post imagery tend to run visual events
  return Math.max(0, Math.min(100, score));
}
