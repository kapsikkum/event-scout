/**
 * The schema.org types read as events. See README.md in this directory.
 * PublicationEvent (a broadcast) and DeliveryEvent (a parcel pickup) are kinds
 * of Event too, and are left out: neither is somewhere to go.
 */
export const EVENT_TYPES = new Set([
  'Event', 'MusicEvent', 'Festival', 'TheaterEvent', 'ComedyEvent', 'DanceEvent',
  'SportsEvent', 'ScreeningEvent', 'SocialEvent', 'ExhibitionEvent', 'FoodEvent',
  'VisualArtsEvent', 'EducationEvent', 'BusinessEvent', 'ChildrensEvent',
  'LiteraryEvent', 'CourseInstance',
  'CommunityEvent', 'SaleEvent', 'UserInteraction', 'Hackathon',
]);

const LOWER_EVENT_TYPES = new Set([...EVENT_TYPES].map((t) => t.toLowerCase()));
const EXCLUDED_TYPES = new Set(['publicationevent', 'deliveryevent']);

/** Whether a JSON-LD @type, a string or a list of them, names an event. */
export function isEventType(type: unknown): boolean {
  if (typeof type === 'string') {
    const s = type.trim().replace(/^(?:https?:\/\/(?:www\.)?schema\.org\/|schema:)/i, '').trim();
    const lower = s.toLowerCase();
    if (!lower || EXCLUDED_TYPES.has(lower)) return false;
    return EVENT_TYPES.has(s) || LOWER_EVENT_TYPES.has(lower) || lower.endsWith('event');
  }
  if (Array.isArray(type)) return type.some(isEventType);
  return false;
}
