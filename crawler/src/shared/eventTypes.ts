/**
 * The schema.org types read as events. See README.md in this directory.
 * PublicationEvent (a broadcast) and DeliveryEvent (a parcel pickup) are kinds
 * of Event too, and are left out: neither is somewhere to go.
 */
const EVENT_TYPES = new Set([
  'Event', 'MusicEvent', 'Festival', 'TheaterEvent', 'ComedyEvent', 'DanceEvent',
  'SportsEvent', 'ScreeningEvent', 'SocialEvent', 'ExhibitionEvent', 'FoodEvent',
  'VisualArtsEvent', 'EducationEvent', 'BusinessEvent', 'ChildrensEvent',
  'LiteraryEvent', 'CourseInstance',
]);

/** Whether a JSON-LD @type, a string or a list of them, names an event. */
export function isEventType(type: unknown): boolean {
  if (typeof type === 'string') return EVENT_TYPES.has(type.replace(/^https?:\/\/schema\.org\//, ''));
  if (Array.isArray(type)) return type.some(isEventType);
  return false;
}
