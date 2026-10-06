// Attached images, full size: the picture grows out of its thumbnail and
// shrinks back into it on close, over a dimmed backdrop. Arrow keys (or the
// side buttons) step through the message's images; the caption carries the
// same #N label and size as the thumbnail, so "image #2" means one thing.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconChevronRight, IconX } from "../icons.js";
import { dataUrl, type PendingImage } from "../images.js";

const OPEN_MS = 280;
const CLOSE_MS = 200;
const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

const still = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** One image's colour, by its number, so its thumbnail, label, and caption match. */
export const imageHue = (index: number) => `var(--image-hue-${index % 6})`;

/** "473×228", or nothing when the size is unknown. */
export const imageSize = (image: PendingImage) => (image.width && image.height ? `${image.width}×${image.height}` : "");

/** The transform that puts `to` where `from` is (a FLIP start frame). */
function fromRect(from: DOMRect, to: DOMRect): string {
  const scale = Math.max(from.width / to.width, from.height / to.height);
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  return `translate(${dx}px, ${dy}px) scale(${scale})`;
}

export function ImageViewer({
  images,
  start,
  thumbnail,
  onClose,
}: {
  images: PendingImage[];
  start: number;
  /** The thumbnail of image `i`, to grow from and shrink back into. */
  thumbnail: (i: number) => HTMLElement | null;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const [index, setIndex] = useState(start);
  const closing = useRef(false);
  const image = images[index];

  // Grow out of the thumbnail once the picture has its final size.
  useLayoutEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
    const img = picture.current;
    const thumb = thumbnail(start);
    if (!img || !thumb || still()) return;
    const run = () => {
      const transform = fromRect(thumb.getBoundingClientRect(), img.getBoundingClientRect());
      img.animate([{ transform, borderRadius: "14px", opacity: 0.6 }, { transform: "none", borderRadius: "10px", opacity: 1 }], { duration: OPEN_MS, easing: EASE });
    };
    if (img.complete) run();
    else img.addEventListener("load", run, { once: true });
    // Only on open.
  }, []);

  useEffect(() => () => dialog.current?.close(), []);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    const img = picture.current;
    const thumb = thumbnail(index);
    const el = dialog.current;
    if (!img || !thumb || still()) return onClose();
    el?.classList.add("is-closing");
    const transform = fromRect(thumb.getBoundingClientRect(), img.getBoundingClientRect());
    const done = img.animate([{ transform: "none", opacity: 1 }, { transform, opacity: 0.4 }], { duration: CLOSE_MS, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" });
    done.onfinish = onClose;
    done.oncancel = onClose;
  }, [index, onClose, thumbnail]);

  const step = useCallback(
    (by: 1 | -1) => {
      if (images.length < 2) return;
      setIndex((i) => (i + by + images.length) % images.length);
    },
    [images.length],
  );

  // A new image slides in from the side it came from.
  const last = useRef(index);
  useLayoutEffect(() => {
    const from = last.current;
    last.current = index;
    if (from === index || !picture.current || still()) return;
    const forward = index === (from + 1) % images.length;
    picture.current.animate([{ transform: `translateX(${forward ? 28 : -28}px)`, opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 220, easing: EASE });
  }, [index, images.length]);

  if (!image) return null;
  const size = imageSize(image);
  return (
    <dialog
      ref={dialog}
      className="image-lightbox"
      aria-label={`Image #${index + 1}`}
      style={{ ["--hue" as string]: imageHue(index) }}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("image-lightbox-stage")) close();
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") step(1);
        else if (e.key === "ArrowLeft") step(-1);
      }}
    >
      <button type="button" className="image-lightbox-close" aria-label="Close" onClick={close}>
        <IconX size={16} />
      </button>
      <div className="image-lightbox-stage">
        {images.length > 1 ? (
          <button type="button" className="image-lightbox-nav is-prev" aria-label="Previous image" onClick={() => step(-1)}>
            <IconChevronRight size={18} />
          </button>
        ) : null}
        <img ref={picture} className="image-lightbox-img" src={dataUrl(image)} alt={`Image #${index + 1}${size ? `, ${size}` : ""}`} />
        {images.length > 1 ? (
          <button type="button" className="image-lightbox-nav is-next" aria-label="Next image" onClick={() => step(1)}>
            <IconChevronRight size={18} />
          </button>
        ) : null}
      </div>
      <div className="image-lightbox-caption">
        <span className="image-tag">#{index + 1}</span>
        {size ? <span>{size}</span> : null}
        {images.length > 1 ? <span className="muted">{`${index + 1} of ${images.length}`}</span> : null}
      </div>
    </dialog>
  );
}
