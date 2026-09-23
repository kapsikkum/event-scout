import { useState } from 'react';

/** A line break, so the tooltip below stays one readable expression. */
const NEWLINE = String.fromCharCode(10);
import { MergedEvent, haversineKm } from '../api';
import { useStore } from '../store';
import { formatWhen } from './EventCard';
import { decodeEntities } from '../text';
import EventImage, { OptionalImage } from './EventImage';
import { enrichedTooltip } from '../enriched';
import EventEditor from './EventEditor';

/**
 * Full event view, so a listing can be read without leaving the app.
 *
 * Social handles are derived from the links the event already carries rather
 * than looked up anywhere: organisers almost always link their own pages from
 * the listing, and inventing a lookup would mean guessing at identity.
 */

interface Social { network: string; handle: string; url: string; icon: string }

const NETWORKS: { host: RegExp; network: string; icon: string }[] = [
  { host: /(^|\.)facebook\.com$/i, network: 'Facebook', icon: '📘' },
  { host: /(^|\.)instagram\.com$/i, network: 'Instagram', icon: '📷' },
  { host: /(^|\.)(twitter|x)\.com$/i, network: 'X', icon: '🐦' },
  { host: /(^|\.)tiktok\.com$/i, network: 'TikTok', icon: '🎵' },
  { host: /(^|\.)youtube\.com$/i, network: 'YouTube', icon: '▶️' },
  { host: /(^|\.)eventbrite\.[a-z.]+$/i, network: 'Eventbrite', icon: '🎟' },
  { host: /(^|\.)meetup\.com$/i, network: 'Meetup', icon: '👥' },
];

/**
 * Every distinct URL an event carries, from its sources and its description.
 *
 * Descriptions arrive as raw HTML, so entities are decoded first — otherwise a
 * link is captured with "&lt;" welded onto the end — and trailing punctuation
 * is trimmed, which regexes over prose always pick up.
 */
export function findUrls(ev: MergedEvent): string[] {
  const urls = new Set<string>();
  for (const s of ev.sources) if (s.url) urls.add(s.url);
  const text = decodeEntities(ev.description ?? '');
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
    urls.add(m[0].replace(/[.,;:!?)\]]+$/, ''));
  }
  return [...urls];
}

/** Group links by host, so the detail view can list them usefully. */
export function findLinks(ev: MergedEvent): { host: string; url: string }[] {
  const seen = new Map<string, { host: string; url: string }>();
  for (const raw of findUrls(ev)) {
    try {
      const host = new URL(raw).hostname.replace(/^www\./, '');
      if (!seen.has(raw)) seen.set(raw, { host, url: raw });
    } catch {
      // Not a usable URL.
    }
  }
  return [...seen.values()];
}

/** Pull organiser profiles out of the event's links. */
export function findSocials(ev: MergedEvent): Social[] {
  const urls = findUrls(ev);

  const found = new Map<string, Social>();
  for (const raw of urls) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    const match = NETWORKS.find((n) => n.host.test(url.hostname));
    if (!match) continue;
    // First path segment is the handle on every network here; anything deeper
    // is a specific post, which is not what we want to show as the org.
    const segment = url.pathname.split('/').filter(Boolean)[0];
    if (!segment) continue;
    const handle = decodeURIComponent(segment).replace(/^@/, '').trim();
    // These are permalink prefixes, not organisers: facebook.com/events/<id>
    // and eventbrite.com/e/<slug> identify the event, not who is running it.
    if (/^(events?|e|watch|p|posts?|share|pages|profile\.php)$/i.test(handle)) continue;
    if (!/^[A-Za-z0-9._-]{2,}$/.test(handle)) continue;
    const key = `${match.network}:${handle.toLowerCase()}`;
    if (!found.has(key)) {
      found.set(key, { network: match.network, handle, url: raw, icon: match.icon });
    }
  }
  return [...found.values()];
}

export default function EventDetail({
  ev: initialEv,
  onClose,
  editMode: editModeProp = false,
}: {
  ev: MergedEvent;
  onClose: () => void;
  editMode?: boolean;
}) {
  const { events, settings, setGroupFlag, unmergeGroup, setMergeParent, editEvent, editMode: storeEditMode } = useStore();
  const editMode = editModeProp || storeEditMode;
  const ev = events.find((e) => e.group === initialEv.group) ?? initialEv;
  // Only the originals: a stored copy is a path on this server, and an image
  // override has to be an address a card can load anywhere.
  const flyers = [...new Set(ev.images.filter((src) => /^https?:\/\//i.test(src)))];
  const [editing, setEditing] = useState(false);
  const socials = findSocials(ev);
  // Links already shown as a source row would just be duplicates.
  const sourceUrls = new Set(ev.sources.map((s) => s.url).filter(Boolean));
  const links = findLinks(ev).filter((l) => !sourceUrls.has(l.url));
  const distance =
    settings?.lat != null && settings.lng != null && ev.lat != null && ev.lng != null
      ? haversineKm(settings.lat, settings.lng, ev.lat, ev.lng)
      : null;

  const mapUrl =
    ev.lat != null && ev.lng != null
      ? `https://www.google.com/maps/search/?api=1&query=${ev.lat},${ev.lng}`
      : ev.address
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.address)}`
        : null;

  const description = decodeEntities(ev.description ?? '').trim();
  const raw = decodeEntities(ev.rawDescription ?? '').trim();
  const rawAvailable = Boolean(raw) && raw !== description;
  const [showRaw, setShowRaw] = useState(false);
  const shownDescription = showRaw && rawAvailable ? raw : description;

  // One line rather than a panel: what a machine had a hand in, if anything.
  const aiMark = enrichedTooltip(ev) || (rawAvailable ? 'The description was rewritten from the listing.' : '');
  const aiTitle = rawAvailable
    ? [aiMark, '', 'Click to read it as the source published it.'].join(NEWLINE)
    : aiMark;

  return (
    <div className="detail__backdrop" onClick={onClose} role="presentation">
      <div
        className="detail"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={decodeEntities(ev.title)}
      >
        <button className="detail__close" onClick={onClose} aria-label="Close">✕</button>

        {ev.images.length > 0 && (
          <div className="detail__images">
            {/* Contained, not cropped: these are posters, and a poster cropped
                to a letterbox loses the date and half the title. */}
            <EventImage className="detail__image" images={ev.images} />
            {ev.images.slice(1).map((src) => (
              <OptionalImage key={src} className="detail__image detail__image--alt" src={src} />
            ))}
          </div>
        )}

        {/* Picking the flyer: every picture behind the event, the one on the
            card outlined. In edit mode, with the other hand edits. */}
        {editMode && flyers.length > 1 && (
          <div className="detail__flyers">
            <span className="detail__flyers-label">Flyer</span>
            {flyers.map((src) => (
              <button
                key={src}
                type="button"
                className={`flyerpick${src === ev.imageUrl ? ' is-current' : ''}`}
                title={src === ev.imageUrl ? 'Shown on the card' : 'Show this one on the card'}
                onClick={() => void editEvent(ev.group, { imageUrl: src }).catch(() => undefined)}
              >
                <img src={src} alt="" loading="lazy" />
              </button>
            ))}
            {ev.edited.includes('imageUrl') && (
              <button
                type="button"
                className="ghost flyerpick__auto"
                title="Go back to the main listing's own picture"
                onClick={() => void editEvent(ev.group, { imageUrl: '' }).catch(() => undefined)}
              >
                Automatic
              </button>
            )}
          </div>
        )}

        <h2>{decodeEntities(ev.title)}</h2>
        {ev.rawTitle && (
          <p className="detail__listed" title="Named by the local model; this is the title the listing gave">
            Listed as “{decodeEntities(ev.rawTitle)}”
          </p>
        )}

        <div className="detail__meta">
          <span className="detail__when">{formatWhen(ev, { full: true })}</span>
          {ev.category && <span className="tag">{ev.category}</span>}
          {ev.priceText && <span className="tag">{ev.priceText}</span>}
          {ev.isOnline && <span className="tag">Online</span>}
          {ev.photoScore > 0 && <span className="tag">📸 {ev.photoScore.toFixed(1)}</span>}
        </div>

        {/* Read off the flyer, so it is shown as found and nothing is derived
            from it — a gates time is worth knowing and worth trusting no
            further than that. */}
        {ev.note && (
          <div className="detail__block">
            <h4>On the flyer</h4>
            <p>{decodeEntities(ev.note)}</p>
          </div>
        )}

        {(ev.venueName || ev.address) && (
          <div className="detail__block">
            <h4>Location</h4>
            <p>
              {decodeEntities([ev.venueName, ev.address].filter(Boolean).join(' — '))}
              {distance != null && <span className="detail__sub"> · {distance.toFixed(1)} km away</span>}
            </p>
            {mapUrl && (
              <a href={mapUrl} target="_blank" rel="noreferrer" className="detail__link">
                Open in Maps ↗
              </a>
            )}
          </div>
        )}

        {shownDescription && (
          <div className="detail__block">
            <h4>Details</h4>
            <p className="detail__description">
              {shownDescription}
              {/* The whole AI note, reduced to one mark against the paragraph it
                  is actually about. It is also the switch: the rewrite is
                  usually an improvement and sometimes a loss, and reading what
                  the source wrote should not mean opening the source. */}
              {aiMark && (
                <button
                  className={`aimark${showRaw ? ' is-off' : ''}`}
                  onClick={() => rawAvailable && setShowRaw(!showRaw)}
                  disabled={!rawAvailable}
                  aria-pressed={!showRaw}
                  title={aiTitle}
                >
                  {showRaw ? '✧' : '✨'}
                </button>
              )}
            </p>
            {showRaw && <p className="detail__sub">As the source published it.</p>}
          </div>
        )}

        {socials.length > 0 && (
          <div className="detail__block">
            <h4>Organiser</h4>
            <div className="detail__socials">
              {socials.map((s) => (
                <a key={`${s.network}-${s.handle}`} href={s.url} target="_blank" rel="noreferrer">
                  {s.icon} {s.network} <span className="detail__handle">@{s.handle}</span>
                </a>
              ))}
            </div>
          </div>
        )}

        {ev.members.length > 1 && (
          <div className="detail__block">
            <h4>{ev.manual ? 'Merged listings' : 'Matched listings'}</h4>
            <ul className="detail__members">
              {/* In the order the server weighs them: the first speaks for the
                  event, and any other can be made to. */}
              {ev.members.map((m, i) => (
                <li key={m.id}>
                  <span className="badge">{m.source}</span>
                  <span className="detail__member-title">{decodeEntities(m.title)}</span>
                  {m.imageUrl && <span className="detail__member-flag" title="Has an image">🖼</span>}
                  {i === 0 ? (
                    <span
                      className="detail__member-main"
                      title={m.parent ? 'Picked as the main listing' : 'Leads by default: the event’s own page comes before posts about it'}
                    >
                      Main
                    </span>
                  ) : (
                    <button
                      className="ghost detail__member-make"
                      title="Take the title, date, picture and details from this listing"
                      onClick={() => void setMergeParent(ev.group, m.id).catch(() => undefined)}
                    >
                      Make main
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {ev.manual && (
              <button
                className="ghost detail__unmerge"
                onClick={async () => {
                  await unmergeGroup(ev.group);
                  onClose();
                }}
              >
                Unmerge
              </button>
            )}
          </div>
        )}

        <div className="detail__block">
          <h4>Sources</h4>
          <div className="detail__sources">
            {ev.sources.map((s) =>
              s.url ? (
                <a key={s.source + s.url} href={s.url} target="_blank" rel="noreferrer">
                  {s.source} ↗
                </a>
              ) : (
                <span key={s.source} className="tag">{s.source}</span>
              )
            )}
          </div>
        </div>

        {editMode && (
          editing ? (
            <EventEditor ev={ev} onDone={() => setEditing(false)} />
          ) : (
            <div className="detail__block">
              <button className="ghost" onClick={() => setEditing(true)}>&#9998; Edit this event</button>
              {ev.edited.length > 0 && (
                <p className="hint" style={{ marginTop: 6 }}>
                  Edited by hand: {ev.edited.join(', ')}.
                </p>
              )}
            </div>
          )
        )}

        {links.length > 0 && (
          <div className="detail__block">
            <h4>Links</h4>
            <div className="detail__sources">
              {links.map((l) => (
                <a key={l.url} href={l.url} target="_blank" rel="noreferrer" title={l.url}>
                  {l.host} ↗
                </a>
              ))}
            </div>
          </div>
        )}

        <div className="detail__actions">
          <button
            className={ev.starred ? 'primary' : 'ghost'}
            onClick={() => void setGroupFlag(ev.group, { starred: !ev.starred })}
          >
            {ev.starred ? '★ Shortlisted' : '☆ Shortlist'}
          </button>
          <button
            className="ghost detail__remove"
            onClick={() => {
              void setGroupFlag(ev.group, { hidden: true });
              onClose();
            }}
          >
            Remove
          </button>
        </div>
        <p className="detail__note">
          Removing hides it from every view. Restore it from Events → Show removed.
        </p>
      </div>
    </div>
  );
}
