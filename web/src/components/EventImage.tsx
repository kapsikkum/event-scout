import { useEffect, useState } from 'react';

/**
 * An image that falls through to the next candidate when one fails to load.
 *
 * Merging makes this necessary. A merged event carries an image from every
 * listing behind it, and Facebook's CDN URLs are signed and expire — so the
 * first image is quite often a dead one, which renders as a zero-width box
 * while a perfectly good picture from another source sits unused behind it.
 * Only the browser knows which URLs still resolve, so the choice has to happen
 * here rather than when the event is merged.
 */
export default function EventImage({
  images, className, alt = '', onNone,
}: {
  images: string[];
  className?: string;
  alt?: string;
  /** Called when every candidate has failed, for callers that show a placeholder. */
  onNone?: () => void;
}) {
  const [index, setIndex] = useState(0);
  const key = images.join('|');

  // A different event may reuse this component instance.
  useEffect(() => setIndex(0), [key]);

  const src = images[index];
  useEffect(() => {
    if (!src && images.length > 0) onNone?.();
  }, [src, images.length, onNone]);

  if (!src) return null;
  return (
    <img
      key={src}
      className={className}
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setIndex((i) => i + 1)}
    />
  );
}

/** A single image that takes itself off the page rather than showing broken. */
export function OptionalImage({ src, className, alt = '' }: {
  src: string; className?: string; alt?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) return null;
  return (
    <img className={className} src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
  );
}
