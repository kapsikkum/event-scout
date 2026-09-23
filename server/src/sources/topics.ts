/**
 * Ready-made search topics.
 *
 * Writing good queries by hand is the fiddly part of getting anything out of
 * the search and Facebook sources, and the terms that work are not obvious —
 * "car meet" and "cruise night" surface completely different listings, and a
 * country town's calendar is mostly shows, campdrafts and rodeos that no
 * generic "events near me" query ever returns. Picking a topic expands to the
 * whole set. Custom terms still work exactly as before and are simply appended.
 */

export interface EventTopic {
  key: string;
  label: string;
  /** Plain name, used as the event's category. The label keeps the emoji. */
  category: string;
  /** Short phrases, combined with the area name by each adapter. */
  terms: string[];
  /**
   * Extra words that identify the topic in an event's own title or blurb but
   * make poor search queries — "v8" finds nothing useful on its own, yet an
   * event with it in the title is unmistakably motorsport.
   */
  hints?: string[];
}

export const EVENT_TOPICS: EventTopic[] = [
  {
    key: 'motorsport',
    category: 'Motorsport',
    hints: [
      'v8', 'supercars', 'sprint', 'circuit', 'grand prix', 'raceway', 'go kart', 'karting', 'burnout', 'drag racing', 'speedway',
      'rally', 'dragway', 'time attack', 'superbike', 'motocross', 'speedway racing', 'bathurst 1000',
    ],
    label: '🏁 Motorsport',
    terms: ['motorsport', 'race meeting', 'track day', 'drift day', 'hillclimb', 'motorkhana'],
  },
  {
    key: 'cars',
    category: 'Cars & bikes',
    hints: [
      'classic car', 'hot rod', 'motorbike', 'motorcycle', 'ute muster', 'auto', 'v-twin',
      'harley', 'cars and coffee', 'cruise', 'car club', 'holden', 'falcon', 'mustang',
      'car and bike show', 'car & bike show', 'bike show', 'car show', 'truck show', 'ute show',
      "show 'n' shine", 'show & shine', 'car meet', 'bike meet', 'car rally',
    ],
    label: '🚗 Cars & bikes',
    terms: ['car show', 'car meet', 'cruise night', 'swap meet', 'motorcycle rally', 'bike run', 'show and shine'],
  },
  {
    key: 'music',
    category: 'Live music',
    hints: [
      'band', 'dj', 'acoustic', 'orchestra', 'choir', 'tribute', 'jazz', 'blues', 'rock', 'singer',
      // Tour patterns
      'tour', 'on tour', 'touring', 'world tour', 'australian tour', 'national tour', 'album tour',
      // Performance terms
      'live in concert', 'live on stage', 'live performance', 'tribute show', 'tribute band', 'cover band',
      'covers', 'soundtrack', 'album launch', 'ep launch', 'headline show', 'headlining',
      // Instruments
      'guitar', 'bass', 'drums', 'piano', 'keys', 'synthesizer', 'vocalist', 'vocals',
      // Classical / choral
      'symphony', 'philharmonic', 'quartet', 'ensemble', 'recital', 'opera', 'aria', 'choral',
      // Genres
      'metal', 'heavy metal', 'punk', 'pop', 'indie', 'folk', 'hip hop', 'rap', 'r&b', 'soul',
      'funk', 'electronic', 'techno', 'edm', 'house music', 'disco', 'reggae', 'ska', 'bluegrass', 'country music',
      // Iconic touring acts / bands
      'pink floyd', 'led zeppelin', 'beatles', 'queen', 'fleetwood mac', 'ac/dc', 'elton john', 'david bowie', 'inxs', 'coldplay', 'metallica',
    ],
    label: '🎸 Live music',
    terms: ['live music', 'gig', 'concert', 'music festival', 'open mic'],
  },
  {
    key: 'nightlife',
    category: 'Nightlife',
    hints: [
      'bar', 'nightclub', 'karaoke', 'bingo', 'quiz night',
      'rave', 'dj set', 'silent disco', 'club night', 'cocktails', 'karaoke night',
    ],
    label: '🎉 Parties & nightlife',
    terms: ['party', 'club night', 'dance party', 'trivia night'],
  },
  {
    key: 'festivals',
    category: 'Festivals',
    hints: ['fete', 'fair', 'street party', 'expo'],
    label: '🎪 Festivals',
    terms: ['festival', 'street festival', 'carnival', 'parade'],
  },
  {
    key: 'markets',
    category: 'Markets',
    hints: ['market', 'garage sale', 'boot sale', 'stalls'],
    label: '🧺 Markets & fairs',
    terms: ['markets', 'farmers market', 'craft fair', 'car boot sale'],
  },
  {
    key: 'country',
    category: 'Country & agricultural',
    hints: ['show society', 'ag show', 'livestock', 'equestrian', 'horse', 'cattle', 'sheep', 'ploughing', 'woodchop'],
    label: '🐎 Country & agricultural',
    terms: ['agricultural show', 'rodeo', 'campdraft', 'field days', 'sheep dog trials'],
  },
  {
    key: 'sport',
    category: 'Sport',
    hints: ['football', 'rugby', 'cricket', 'netball', 'soccer', 'golf', 'marathon', 'triathlon', 'league', 'bowls', 'tennis', 'boxing', 'racing club', 'harness racing', 'races', 'basketball', 'hockey', 'swimming'],
    label: '⚽ Sport',
    terms: ['sports match', 'race day', 'fun run', 'cycling race'],
  },
  {
    key: 'arts',
    category: 'Arts & culture',
    hints: [
      'art', 'museum', 'play', 'musical', 'workshop', 'poetry', 'film', 'cinema', 'drawing', 'craft',
      'comedy', 'stand up', 'comedian', 'theatre', 'theater', 'ballet', 'stage play', 'broadway', 'cabaret', 'magic show', 'circus',
    ],
    label: '🎨 Arts & culture',
    terms: ['exhibition', 'gallery opening', 'theatre', 'comedy night'],
  },
  {
    key: 'food',
    category: 'Food & drink',
    hints: ['degustation', 'tasting', 'winery', 'brewery', 'distillery', 'high tea', 'dinner', 'bbq'],
    label: '🍷 Food & drink',
    terms: ['food festival', 'wine festival', 'brewery event', 'long lunch'],
  },
  {
    key: 'community',
    category: 'Community',
    hints: ['charity', 'volunteer', 'council', 'library', 'church', 'club meeting', 'agm', 'blood drive'],
    label: '🤝 Community',
    terms: ['community event', 'fundraiser', 'open day', 'working bee'],
  },
  {
    key: 'heritage',
    category: 'Heritage & machinery',
    hints: ['steam', 'vintage', 'heritage', 'railway', 'locomotive', 'aviation', 'aircraft', 'tractor'],
    label: '🚂 Heritage & machinery',
    terms: ['heritage railway', 'vintage machinery', 'steam rally', 'air show', 'museum open day'],
  },
  {
    key: 'seasonal',
    category: 'Seasonal',
    hints: ['halloween', 'easter', 'anzac', 'carols', 'nye', 'boxing day'],
    label: '🎆 Seasonal & fireworks',
    terms: ['fireworks', 'new years eve', 'australia day', 'christmas carols', 'anzac day'],
  },
];

const BY_KEY = new Map(EVENT_TOPICS.map((t) => [t.key, t]));

/**
 * Expand selected topics into search phrases for a place.
 *
 * `format` differs per adapter because the engines want different shapes: a web
 * search reads best as natural language ("car show in Bathurst"), while
 * Facebook's own search does better with the bare pairing.
 */
export function expandTopics(
  keys: string[] | undefined, place: string, format: (term: string, place: string) => string
): string[] {
  if (!keys?.length || !place.trim()) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    for (const term of BY_KEY.get(key)?.terms ?? []) {
      const query = format(term, place.trim());
      if (seen.has(query)) continue;
      seen.add(query);
      out.push(query);
    }
  }
  return out;
}

export const webQuery = (term: string, place: string): string => `${term} in ${place}`;
export const fbQuery = (term: string, place: string): string => `${place} ${term}`;

/**
 * Take a bounded slice of the queries, moving the window each hour.
 *
 * Thirteen topics expand to sixty-odd phrases, and firing all of them at a
 * search engine every refresh is both slow and a good way to get rate-limited.
 * Truncating would mean the tail never ran at all, so the window rotates
 * instead: every phrase comes up over a few refreshes, and any one refresh stays
 * cheap. Derived from the clock rather than stored, since refreshes are hourly
 * anyway and two in a row should not repeat the same slice.
 */
export function rotateQueries(queries: string[], limit: number, now = Date.now()): string[] {
  if (queries.length <= limit) return queries;
  const offset = (Math.floor(now / 3_600_000) * limit) % queries.length;
  return [...queries.slice(offset), ...queries.slice(0, offset)].slice(0, limit);
}

/** The catch-all, for anything the classifier cannot place. */
export const GENERAL_CATEGORY = 'Event';

export const ALL_CATEGORIES = [...EVENT_TOPICS.map((t) => t.category), GENERAL_CATEGORY];

/**
 * Category names a source handed us that carry no information.
 *
 * Facebook labels every listing "Facebook", and several sources say "Event",
 * which is what everything already is. Treating those as real categories left
 * 132 of 138 events filed under "Event" and made the filter useless.
 */
const USELESS = new Set(['event', 'events', 'other', 'general', 'misc', 'facebook', 'eventbrite', 'ticketmaster', 'seatgeek', 'websearch', 'ical', '']);

/** Whole-word match, so "art" does not fire on "Bathurst" or "party". */
function mentions(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack);
}

const VENUE_PERFORMANCE_REGEX = /\b(entertainment centre|theatre|theater|concert hall|opera house|auditorium|amphitheatre)\b/i;
const VENUE_MOTORSPORT_REGEX = /\b(circuit|raceway|speedway|dragway|motorsport park)\b/i;

const AUTO_ANCHORS = [
  'car', 'cars', 'bike', 'bikes', 'motorcycle', 'motorbike', 'vehicle', 'auto',
  'ute', 'harley', 'truck', '4x4', 'hot rod', 'cruiz', 'drive', 'race', 'racing',
  'raceway', 'speedway', 'motorsport', 'kart', 'drift', 'rally', 'circuit', 'dragway', 'bathurst 1000',
  'show and shine', "show 'n' shine", 'show & shine', 'cars and coffee', 'swap meet',
];

function hasAutomotiveAnchor(text: string): boolean {
  return AUTO_ANCHORS.some((anchor) => mentions(text, anchor)) || VENUE_MOTORSPORT_REGEX.test(text);
}

function phraseWeight(phrase: string): { title: number; body: number } {
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 3) {
    return { title: 25, body: 5 };
  }
  if (words.length === 2) {
    return { title: 16, body: 3 };
  }
  if (phrase.trim().length >= 4) {
    return { title: 8, body: 1 };
  }
  return { title: 4, body: 1 };
}

function topicMatchesSourceCategory(topic: EventTopic, sourceCat: string): boolean {
  const normCat = sourceCat.trim().toLowerCase();
  if (!normCat) return false;

  const cleanLabel = topic.label.replace(/^[^\w\s]+/, '').trim().toLowerCase();
  const cleanCat = topic.category.toLowerCase();

  if (normCat === cleanCat || normCat === cleanLabel) return true;

  const stripS = (s: string) => s.replace(/s$/, '');
  if (stripS(normCat) === stripS(cleanCat) || stripS(normCat) === stripS(cleanLabel)) return true;

  if (mentions(topic.label, normCat) || mentions(normCat, topic.category)) return true;

  for (const term of topic.terms) {
    const normTerm = term.toLowerCase();
    if (
      normCat === normTerm ||
      stripS(normCat) === stripS(normTerm) ||
      mentions(normCat, term) ||
      mentions(term, normCat)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Work out what kind of event this is, from what it says about itself.
 *
 * Specificity weighting favours multi-word phrases over single words, and
 * title matches over body matches. Contextual clues like venue types and
 * source categories provide priors, while automotive categories require an
 * explicit automotive anchor to prevent false positives.
 */
export function classifyEvent(
  title: string,
  description = '',
  sourceCategory = '',
  venueName = ''
): string {
  const head = title;
  const body = `${title} ${description}`.slice(0, 1500);
  const fullText = `${title} ${description} ${venueName}`;

  const supplied = sourceCategory.trim();
  const validSourceCat = supplied && !USELESS.has(supplied.toLowerCase());

  let best: { category: string; score: number } | null = null;

  for (const topic of EVENT_TOPICS) {
    let score = 0;

    const phrases = new Set([...topic.terms, ...(topic.hints ?? [])]);
    for (const phrase of phrases) {
      const { title: titlePts, body: bodyPts } = phraseWeight(phrase);
      if (mentions(head, phrase)) {
        score += titlePts;
      } else if (mentions(body, phrase)) {
        score += bodyPts;
      }
    }

    // Venue Context Prior
    if (venueName) {
      if (VENUE_PERFORMANCE_REGEX.test(venueName)) {
        if (topic.category === 'Live music' || topic.category === 'Arts & culture') {
          score += 6;
        }
      }
      if (VENUE_MOTORSPORT_REGEX.test(venueName)) {
        if (topic.category === 'Motorsport' || topic.category === 'Cars & bikes') {
          score += 12;
        }
      }
    }

    // Source Category Boost
    if (validSourceCat && topicMatchesSourceCategory(topic, supplied)) {
      score += 12;
    }

    // Automotive Anchor Requirement:
    // For Cars & bikes and Motorsport, do NOT assign the category unless the text has at least one automotive anchor
    if (
      (topic.category === 'Cars & bikes' || topic.category === 'Motorsport') &&
      !hasAutomotiveAnchor(fullText)
    ) {
      score = 0;
    }

    if (score > 0 && (!best || score > best.score)) {
      best = { category: topic.category, score };
    }
  }

  if (best) return best.category;

  if (validSourceCat) {
    if (
      (supplied.toLowerCase() === 'cars & bikes' || supplied.toLowerCase() === 'motorsport') &&
      !hasAutomotiveAnchor(fullText)
    ) {
      return GENERAL_CATEGORY;
    }
    return supplied;
  }

  return GENERAL_CATEGORY;
}
