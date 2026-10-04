// Material-style ink ripple for every button, via one delegated listener.
// The ink grows from the press point while held and fades on release;
// keyboard activation (Enter/Space) ripples from the centre. Skipped for
// disabled controls, elements marked data-no-ripple, and reduced motion.
const HOST_SELECTOR = "button, .pill-select, [data-ripple]";
const SKIP_SELECTOR = "[data-no-ripple], .rail-mark";
const MIN_VISIBLE_MS = 220;

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function hostFor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const host = target.closest<HTMLElement>(HOST_SELECTOR);
  if (!host || host.closest(SKIP_SELECTOR)) return null;
  if (host.matches(":disabled, [aria-disabled='true']")) return null;
  return host;
}

function spawn(host: HTMLElement, x: number, y: number): HTMLSpanElement {
  if (getComputedStyle(host).position === "static") host.classList.add("ripple-pos");
  host.classList.add("ripple-host");
  const rect = host.getBoundingClientRect();
  // Radius reaching the farthest corner from the press point.
  const dx = Math.max(x - rect.left, rect.right - x);
  const dy = Math.max(y - rect.top, rect.bottom - y);
  const radius = Math.sqrt(dx * dx + dy * dy);
  const ink = document.createElement("span");
  ink.className = "ripple";
  ink.setAttribute("aria-hidden", "true");
  ink.style.width = ink.style.height = `${radius * 2}px`;
  ink.style.left = `${x - rect.left - radius}px`;
  ink.style.top = `${y - rect.top - radius}px`;
  ink.dataset.born = String(performance.now());
  host.appendChild(ink);
  return ink;
}

function release(ink: HTMLSpanElement): void {
  if (ink.classList.contains("is-out")) return;
  const age = performance.now() - Number(ink.dataset.born ?? 0);
  window.setTimeout(() => {
    ink.classList.add("is-out");
    const remove = () => ink.remove();
    ink.addEventListener("transitionend", remove, { once: true });
    window.setTimeout(remove, 600);
  }, Math.max(0, MIN_VISIBLE_MS - age));
}

export function installRipple(root: Document = document): () => void {
  const held = new Map<number, HTMLSpanElement>();

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || reducedMotion()) return;
    const host = hostFor(e.target);
    if (!host) return;
    const prior = held.get(e.pointerId);
    if (prior) release(prior);
    held.set(e.pointerId, spawn(host, e.clientX, e.clientY));
  };
  const onUp = (e: PointerEvent) => {
    const ink = held.get(e.pointerId);
    if (ink) release(ink);
    held.delete(e.pointerId);
  };
  // Drag events carry no pointerId: release every held ink.
  const onDragStart = () => {
    for (const ink of held.values()) release(ink);
    held.clear();
  };
  const onKey = (e: KeyboardEvent) => {
    if ((e.key !== "Enter" && e.key !== " ") || e.repeat || reducedMotion()) return;
    const host = hostFor(e.target);
    if (!host || host !== e.target) return;
    const rect = host.getBoundingClientRect();
    release(spawn(host, rect.left + rect.width / 2, rect.top + rect.height / 2));
  };

  root.addEventListener("pointerdown", onDown, { passive: true });
  root.addEventListener("pointerup", onUp, { passive: true });
  root.addEventListener("pointercancel", onUp, { passive: true });
  root.addEventListener("dragstart", onDragStart, { passive: true });
  root.addEventListener("keydown", onKey);
  return () => {
    root.removeEventListener("pointerdown", onDown);
    root.removeEventListener("pointerup", onUp);
    root.removeEventListener("pointercancel", onUp);
    root.removeEventListener("dragstart", onDragStart);
    root.removeEventListener("keydown", onKey);
  };
}
