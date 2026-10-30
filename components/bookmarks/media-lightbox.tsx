"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Film, X } from "lucide-react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform, type MotionValue } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject, type SyntheticEvent } from "react";
import { isGifMedia, isMotionMedia, pbsVariant, type MediaEntry } from "@/components/bookmarks/bookmark-card";
import { useLanguage } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// Full-screen media viewer opened from the detail view. One gesture engine on pointer events
// covers mouse, touch and pen; trackpad pinch arrives as ctrl+wheel (Chrome/Firefox/Edge) or as
// WebKit GestureEvents (Safari), both mapped onto the same zoom-at-point math.
//
//   photos  pinch / ctrl+wheel / Safari pinch to zoom at the fingers or cursor, drag to pan
//           (momentum + rubber band), double-tap or click to toggle zoom, +/-/0 keys
//   all     swipe down (touch or mouse drag) to close, swipe sideways / ←→ between a post's
//           media, Esc / close button / backdrop click to close, tap toggles the controls
//   video   native controls, whose fullscreen button hands off to the native player (iPhone's
//           rotates to landscape on its own; `f` does the same on desktop); the viewer itself
//           re-fits on rotation, and Android Chrome locks landscape in element fullscreen
//
// It is a nested Radix dialog so the detail panel underneath (Radix modal on desktop, Vaul
// drawer on phones) keeps its focus trap and Esc/outside-click semantics: only the top layer
// reacts. Opening and closing zoom from/to the thumbnail's on-page rect (shared-element style).

const MAX_SCALE = 5;
const SLIDE_GAP = 24;
const TAP_SLOP = 8;
const DOUBLE_TAP_MS = 280;
const DISMISS_DISTANCE = 110;
const DISMISS_VELOCITY = 0.5; // px/ms
const SWIPE_VELOCITY = 0.35; // px/ms
const THUMB_RADIUS = 12; // the detail view's rounded-xl
const SPRING = { type: "spring", stiffness: 380, damping: 38, restDelta: 0.001 } as const;
const OPEN_SPRING = { type: "spring", stiffness: 330, damping: 33, restDelta: 0.001 } as const;
const CLOSE_TWEEN = { duration: 0.3, ease: [0.2, 0.8, 0.2, 1] } as const;
// Desktop-class pointer (mouse / trackpad) gets margins around the media and side arrows, via the
// literal `[@media(hover:hover)_and_(pointer:fine)]:` variant (Tailwind only sees whole literal
// class names). Width breakpoints would also match a phone in landscape, which stays edge to edge.

type Layout = { left: number; top: number; w: number; h: number; fitL: number; fitT: number; fitW: number; fitH: number };
type Mode = "idle" | "pending" | "pan" | "pinch" | "dismiss" | "swipe" | "ignore";
type Velocity = { vx: number; vy: number };
type GestureEventLike = Event & { scale: number; clientX: number; clientY: number };

type MediaLightboxProps = {
  media: MediaEntry[];
  initialIndex: number;
  /** The on-page element showing media[i], for the zoom-from / zoom-back transition. */
  getSource: (index: number) => HTMLElement | null;
  onClose: () => void;
};

export function MediaLightbox(props: MediaLightboxProps) {
  const { t } = useLanguage();
  const closeRef = useRef<() => void>(props.onClose);
  // Events from this portal still bubble through the React tree into the detail panel; the Vaul
  // drawer would treat a drag here as a drag of the drawer.
  const contain = (event: SyntheticEvent) => event.stopPropagation();

  return (
    <Dialog.Root open onOpenChange={(open) => (open ? undefined : closeRef.current())}>
      <Dialog.Portal>
        <Dialog.Content
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            closeRef.current();
          }}
          onPointerDown={contain}
          onPointerMove={contain}
          onPointerUp={contain}
          onPointerCancel={contain}
          onTouchStart={contain}
          onTouchMove={contain}
          onTouchEnd={contain}
          onClick={contain}
          className="fixed inset-0 z-[100] touch-none select-none overscroll-none text-white outline-none"
        >
          <Dialog.Title className="sr-only">{t("lightbox.title")}</Dialog.Title>
          <LightboxBody {...props} closeRef={closeRef} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const rubber = (value: number, min: number, max: number, k = 0.3) =>
  value < min ? min + (value - min) * k : value > max ? max + (value - max) * k : value;

function aspectOf(item: MediaEntry) {
  return item.width && item.height ? item.width / item.height : 16 / 9;
}

/** Media size inside the fit box: contained, and photos never upscaled past their pixels. */
function fittedSize(item: MediaEntry, layout: Layout) {
  const aspect = aspectOf(item);
  let w = layout.fitW;
  let h = w / aspect;
  if (h > layout.fitH) {
    h = layout.fitH;
    w = h * aspect;
  }
  if (!isMotionMedia(item) && item.width && w > item.width) {
    w = item.width;
    h = w / aspect;
  }
  return { w, h };
}

function LightboxBody({ media, initialIndex, getSource, onClose, closeRef }: MediaLightboxProps & { closeRef: RefObject<() => void> }) {
  const { t } = useLanguage();
  const reduceMotion = useReducedMotion();
  const [index, setIndex] = useState(initialIndex);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [chrome, setChrome] = useState(true);
  const [zoomed, setZoomed] = useState(false);
  const [hiRes, setHiRes] = useState<ReadonlySet<number>>(() => new Set());

  const stageRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const layoutRef = useRef<Layout | null>(null);
  const indexRef = useRef(initialIndex);
  const closingRef = useRef(false);
  const zoomedRef = useRef(false);
  const hiResRequested = useRef(new Set<number>());
  // What the detail view already shows for each item (in the HTTP cache): painted under the
  // larger rendition so the viewer never opens blank. Read once, before thumbnails get hidden.
  const [placeholders] = useState(() => media.map((_, i) => getSource(i)?.querySelector("img")?.currentSrc || undefined));

  // Zoom/pan of the active slide, the slide track, and open/close progress (backdrop opacity).
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const scale = useMotionValue(1);
  const trackX = useMotionValue(0);
  const backdrop = useMotionValue(0);
  const mediaOpacity = useMotionValue(1);
  // Clip (unscaled px per side) so a cover-cropped thumbnail grows into the full media and back,
  // plus its rounded corners while shrunk (open/close/drag); square once full size.
  const clipX = useMotionValue(0);
  const clipY = useMotionValue(0);
  const clipPath = useTransform(() => {
    const radius = ((1 - backdrop.get()) * THUMB_RADIUS) / Math.max(scale.get(), 0.05);
    return `inset(${clipY.get()}px ${clipX.get()}px round ${radius}px)`;
  });
  const chromeOpacity = useTransform(backdrop, [0.75, 1], [0, 1]);

  const gesture = useRef({
    pointers: new Map<number, { x: number; y: number }>(),
    mode: "idle" as Mode,
    pointerType: "mouse",
    onVideo: false,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
    originScale: 1,
    pinchDist: 1,
    pinchMidX: 0,
    pinchMidY: 0,
    samples: [] as Array<{ t: number; x: number; y: number }>,
    lastTap: { t: 0, x: 0, y: 0 },
    tapTimer: 0,
  });

  const count = media.length;

  // ---------------------------------------------------------------- geometry

  const measure = useCallback(() => {
    const stage = stageRef.current?.getBoundingClientRect();
    const fit = fitRef.current?.getBoundingClientRect();
    if (!stage || !fit || !stage.width || !fit.width) return null;
    const next: Layout = {
      left: stage.left,
      top: stage.top,
      w: stage.width,
      h: stage.height,
      fitL: fit.left - stage.left,
      fitT: fit.top - stage.top,
      fitW: fit.width,
      fitH: fit.height,
    };
    layoutRef.current = next;
    setLayout(next);
    return next;
  }, []);

  /** Allowed translation at a scale: the zoomed media may not leave a gap at the stage edges. */
  const bounds = useCallback(
    (s: number) => {
      const L = layoutRef.current!;
      const { w, h } = fittedSize(media[indexRef.current], L);
      const cx = L.fitL + L.fitW / 2;
      const cy = L.fitT + L.fitH / 2;
      const axis = (size: number, stage: number, center: number) => {
        if (size <= stage) {
          const recenter = stage / 2 - center; // fit box can sit off-center (safe areas)
          return [Math.min(0, recenter), Math.max(0, recenter)];
        }
        return [stage - center - size / 2, size / 2 - center];
      };
      const [minX, maxX] = axis(w * s, L.w, cx);
      const [minY, maxY] = axis(h * s, L.h, cy);
      return { minX, maxX, minY, maxY };
    },
    [media],
  );

  const local = (event: { clientX: number; clientY: number }) => {
    const L = layoutRef.current!;
    return { x: event.clientX - L.left, y: event.clientY - L.top };
  };

  /** Scale to s1 keeping the content point under (px, py) — stage coordinates — fixed. */
  const zoomTo = useCallback(
    (s1: number, px: number, py: number, animated: boolean) => {
      const L = layoutRef.current;
      if (!L) return;
      const s0 = scale.get();
      const dx = px - (L.fitL + L.fitW / 2);
      const dy = py - (L.fitT + L.fitH / 2);
      const b = bounds(s1);
      const tx = clamp(dx - (dx - x.get()) * (s1 / s0), b.minX, b.maxX);
      const ty = clamp(dy - (dy - y.get()) * (s1 / s0), b.minY, b.maxY);
      if (animated) {
        animate(scale, s1, SPRING);
        animate(x, tx, SPRING);
        animate(y, ty, SPRING);
      } else {
        scale.stop();
        x.stop();
        y.stop();
        scale.set(s1);
        x.set(tx);
        y.set(ty);
      }
    },
    [bounds, scale, x, y],
  );

  const resetZoom = useCallback(
    (animated: boolean) => {
      if (animated) {
        animate(scale, 1, SPRING);
        animate(x, 0, SPRING);
        animate(y, 0, SPRING);
      } else {
        scale.jump(1);
        x.jump(0);
        y.jump(0);
      }
    },
    [scale, x, y],
  );

  /** Zoom in to a useful level (fill the screen, at least 2.5×) or back out. */
  const toggleZoom = useCallback(
    (px: number, py: number) => {
      const L = layoutRef.current;
      if (!L) return;
      if (scale.get() > 1.01) return resetZoom(true);
      const { w, h } = fittedSize(media[indexRef.current], L);
      const fill = Math.max(L.w / w, L.h / h);
      zoomTo(clamp(fill, 2.5, MAX_SCALE), px, py, true);
    },
    [media, resetZoom, scale, zoomTo],
  );

  /** Transform that puts the active media exactly over its on-page thumbnail, if visible. */
  const sourceTransform = useCallback(
    (i: number) => {
      const L = layoutRef.current;
      const el = getSource(i);
      if (!L || !el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) return null;
      // The thumbnail covers its box (cropped when the box is narrower or wider than the media):
      // scale the full media to cover the box, and clip it to the box.
      const { w, h } = fittedSize(media[i], L);
      const s = Math.max(r.width / w, r.height / h);
      return {
        x: r.left + r.width / 2 - L.left - (L.fitL + L.fitW / 2),
        y: r.top + r.height / 2 - L.top - (L.fitT + L.fitH / 2),
        scale: s,
        clipX: Math.max(0, (w - r.width / s) / 2),
        clipY: Math.max(0, (h - r.height / s) / 2),
      };
    },
    [getSource, media],
  );

  // ---------------------------------------------------------------- open / close / navigate

  const requestClose = useCallback(
    (velocity: Velocity = { vx: 0, vy: 0 }) => {
      if (closingRef.current) return;
      closingRef.current = true;
      videoRef.current?.pause();
      const i = indexRef.current;
      getSource(i)?.scrollIntoView({ block: "nearest", inline: "nearest" });
      const target = reduceMotion ? null : sourceTransform(i);
      const L = layoutRef.current;
      let animations;
      if (target) {
        animations = [
          animate(x, target.x, CLOSE_TWEEN),
          animate(y, target.y, CLOSE_TWEEN),
          animate(scale, target.scale, CLOSE_TWEEN),
          animate(clipX, target.clipX, CLOSE_TWEEN),
          animate(clipY, target.clipY, CLOSE_TWEEN),
          animate(backdrop, 0, CLOSE_TWEEN),
        ];
      } else {
        const fling = L && !reduceMotion ? Math.sign(velocity.vy || 1) * L.h * 0.35 : 0;
        animations = [
          animate(y, y.get() + fling, { duration: 0.25, ease: "easeIn" }),
          animate(mediaOpacity, 0, { duration: 0.22 }),
          animate(backdrop, 0, { duration: 0.25 }),
        ];
      }
      Promise.all(animations).then(onClose, onClose);
    },
    [backdrop, clipX, clipY, getSource, mediaOpacity, onClose, reduceMotion, scale, sourceTransform, x, y],
  );

  useEffect(() => {
    closeRef.current = () => requestClose();
  }, [closeRef, requestClose]);

  const goTo = useCallback(
    (next: number, velocityX = 0) => {
      const L = layoutRef.current;
      if (!L) return;
      const target = clamp(next, 0, count - 1);
      if (target !== indexRef.current) {
        indexRef.current = target;
        setIndex(target);
        resetZoom(false);
      }
      animate(trackX, -target * (L.w + SLIDE_GAP), { type: "spring", stiffness: 300, damping: 34, velocity: velocityX * 1000 });
    },
    [count, resetZoom, trackX],
  );

  // Measure, then zoom out of the thumbnail (or fade in when it isn't on screen).
  useLayoutEffect(() => {
    const L = measure();
    if (!L) return;
    trackX.jump(-initialIndex * (L.w + SLIDE_GAP));
    const from = reduceMotion ? null : sourceTransform(initialIndex);
    if (from) {
      x.jump(from.x);
      y.jump(from.y);
      scale.jump(from.scale);
      clipX.jump(from.clipX);
      clipY.jump(from.clipY);
      animate(clipX, 0, OPEN_SPRING);
      animate(clipY, 0, OPEN_SPRING);
      animate(x, 0, OPEN_SPRING);
      animate(y, 0, OPEN_SPRING);
      animate(scale, 1, OPEN_SPRING);
      animate(backdrop, 1, { duration: 0.28, ease: "easeOut" });
    } else {
      scale.jump(reduceMotion ? 1 : 0.94);
      mediaOpacity.jump(0);
      animate(scale, 1, { duration: 0.22, ease: "easeOut" });
      animate(mediaOpacity, 1, { duration: 0.22 });
      animate(backdrop, 1, { duration: 0.22 });
    }
    // Mount-only: the opening transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rotation / resize: re-fit, drop the zoom, and re-align the track.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let first = true;
    const observer = new ResizeObserver(() => {
      if (first) return void (first = false);
      const L = measure();
      if (!L || closingRef.current) return;
      resetZoom(false);
      trackX.jump(-indexRef.current * (L.w + SLIDE_GAP));
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [measure, resetZoom, trackX]);

  // The thumbnail of the slide on screen is hidden while the viewer owns it (shared element).
  useEffect(() => {
    const el = getSource(index);
    if (!el) return;
    el.style.visibility = "hidden";
    return () => {
      el.style.visibility = "";
    };
  }, [getSource, index]);

  // Black browser chrome (iOS status bar / Safari tint, Android address bar) while open.
  useEffect(() => {
    const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
    const previous = metas.map((meta) => meta.content);
    metas.forEach((meta) => (meta.content = "#000000"));
    return () => metas.forEach((meta, i) => (meta.content = previous[i]));
  }, []);

  // Cursor state + upgrade to the 4096px rendition once the zoom outgrows the 2048px one.
  useEffect(
    () =>
      scale.on("change", (s) => {
        const isZoomed = s > 1.01;
        if (isZoomed !== zoomedRef.current) {
          zoomedRef.current = isZoomed;
          setZoomed(isZoomed);
        }
        const i = indexRef.current;
        const item = media[i];
        const L = layoutRef.current;
        if (!L || !item.url || isMotionMedia(item) || (item.width ?? 0) <= 2048 || hiResRequested.current.has(i)) return;
        if (fittedSize(item, L).w * s * window.devicePixelRatio <= 2200) return;
        hiResRequested.current.add(i);
        const img = new Image();
        img.onload = () => setHiRes((prev) => new Set(prev).add(i));
        img.src = pbsVariant(item.url, "4096x4096");
      }),
    [media, scale],
  );

  // ---------------------------------------------------------------- keyboard, wheel, Safari pinch

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (closingRef.current || event.metaKey || event.ctrlKey || event.altKey) return;
      const L = layoutRef.current;
      const onVideo = (event.target as HTMLElement | null)?.closest?.("video");
      const center = L ? { x: L.fitL + L.fitW / 2, y: L.fitT + L.fitH / 2 } : { x: 0, y: 0 };
      const photo = !isMotionMedia(media[indexRef.current]);
      let handled = true;
      if ((event.key === "ArrowLeft" || event.key === "k") && !onVideo) goTo(indexRef.current - 1);
      else if ((event.key === "ArrowRight" || event.key === "j") && !onVideo) goTo(indexRef.current + 1);
      else if ((event.key === "+" || event.key === "=") && photo) zoomTo(clamp(scale.get() * 1.6, 1, MAX_SCALE), center.x, center.y, true);
      else if (event.key === "-" && photo) zoomTo(clamp(scale.get() / 1.6, 1, MAX_SCALE), center.x, center.y, true);
      else if (event.key === "0" && photo) resetZoom(true);
      else if (event.key === "f" && videoRef.current) toggleNativeFullscreen(videoRef.current);
      else handled = false;
      // Capture phase on window: runs before the detail view's own ←/→ listener.
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [goTo, media, resetZoom, scale, zoomTo]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let wheelAccum = 0;
    let wheelLocked = false;
    let wheelIdle = 0;
    let safariStart = { s: 1, x: 0, y: 0 };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const L = layoutRef.current;
      if (!L || closingRef.current) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? L.h : 1;
      const dx = event.deltaX * unit;
      const dy = event.deltaY * unit;
      const photo = !isMotionMedia(media[indexRef.current]);
      if (event.ctrlKey || event.metaKey) {
        // Trackpad pinch (Chrome / Firefox / Edge send ctrl+wheel) or ⌘/ctrl + mouse wheel.
        if (!photo) return;
        const p = local(event);
        zoomTo(clamp(scale.get() * Math.exp(-dy * 0.01), 1, MAX_SCALE), p.x, p.y, false);
        return;
      }
      if (scale.get() > 1.01) {
        // Two-finger scroll pans the zoomed photo.
        const b = bounds(scale.get());
        x.stop();
        y.stop();
        x.set(clamp(x.get() - dx, b.minX, b.maxX));
        y.set(clamp(y.get() - dy, b.minY, b.maxY));
        return;
      }
      // Unzoomed: a horizontal two-finger swipe flips between the post's media.
      if (count > 1 && Math.abs(dx) > Math.abs(dy)) {
        wheelAccum += dx;
        if (!wheelLocked && Math.abs(wheelAccum) > 60) {
          wheelLocked = true;
          goTo(indexRef.current + Math.sign(wheelAccum));
        }
        window.clearTimeout(wheelIdle);
        wheelIdle = window.setTimeout(() => {
          wheelLocked = false;
          wheelAccum = 0;
        }, 220);
      }
    };

    // Safari (macOS trackpad) pinch. iOS fires these too during a touch pinch; the pointer
    // engine owns that case, so skip while two pointers are down.
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      const e = event as GestureEventLike;
      if (!layoutRef.current) return;
      const p = local(e);
      safariStart = { s: scale.get(), x: p.x, y: p.y };
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const e = event as GestureEventLike;
      if (gesture.current.pointers.size >= 2 || closingRef.current || isMotionMedia(media[indexRef.current])) return;
      zoomTo(clamp(safariStart.s * e.scale, 1, MAX_SCALE), safariStart.x, safariStart.y, false);
    };
    const onGestureEnd = (event: Event) => event.preventDefault();

    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("gesturestart", onGestureStart, { passive: false });
    stage.addEventListener("gesturechange", onGestureChange, { passive: false });
    stage.addEventListener("gestureend", onGestureEnd, { passive: false });
    return () => {
      window.clearTimeout(wheelIdle);
      stage.removeEventListener("wheel", onWheel);
      stage.removeEventListener("gesturestart", onGestureStart);
      stage.removeEventListener("gesturechange", onGestureChange);
      stage.removeEventListener("gestureend", onGestureEnd);
    };
  }, [bounds, count, goTo, media, scale, x, y, zoomTo]);

  // ---------------------------------------------------------------- pointer gestures

  function velocityOf(upTime: number): Velocity {
    const samples = gesture.current.samples;
    const last = samples[samples.length - 1];
    const first = samples.find((sample) => last && last.t - sample.t <= 100) ?? last;
    // A finger that stopped before lifting has no fling.
    if (!last || !first || upTime - last.t > 60 || last.t === first.t) return { vx: 0, vy: 0 };
    // Capped: coalesced events with near-identical timestamps would otherwise fling to the edge.
    const dt = Math.max(8, last.t - first.t);
    return { vx: clamp((last.x - first.x) / dt, -4, 4), vy: clamp((last.y - first.y) / dt, -4, 4) };
  }

  function startPinch() {
    const G = gesture.current;
    const [a, b] = [...G.pointers.values()];
    G.mode = "pinch";
    G.pinchDist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    G.pinchMidX = (a.x + b.x) / 2;
    G.pinchMidY = (a.y + b.y) / 2;
    G.originX = x.get();
    G.originY = y.get();
    G.originScale = scale.get();
    window.clearTimeout(G.tapTimer);
  }

  function rebase(p: { x: number; y: number }, time: number, mode: Mode) {
    const G = gesture.current;
    G.mode = mode;
    G.startX = p.x;
    G.startY = p.y;
    G.originX = x.get();
    G.originY = y.get();
    G.originScale = scale.get();
    G.samples = [{ t: time, x: p.x, y: p.y }];
  }

  function settleZoom() {
    const s = scale.get();
    const G = gesture.current;
    if (s < 1) resetZoom(true);
    else if (s > MAX_SCALE) zoomTo(MAX_SCALE, G.pinchMidX, G.pinchMidY, true);
    else {
      const b = bounds(s);
      animate(x, clamp(x.get(), b.minX, b.maxX), SPRING);
      animate(y, clamp(y.get(), b.minY, b.maxY), SPRING);
    }
  }

  function settlePan({ vx, vy }: Velocity) {
    const b = bounds(scale.get());
    // Momentum: glide about a quarter second's worth of the release speed, then stop at the edge.
    const momentum = { type: "spring", stiffness: 220, damping: 32 } as const;
    animate(x, clamp(x.get() + vx * 240, b.minX, b.maxX), { ...momentum, velocity: vx * 1000 });
    animate(y, clamp(y.get() + vy * 240, b.minY, b.maxY), { ...momentum, velocity: vy * 1000 });
  }

  function springBack() {
    animate(x, 0, SPRING);
    animate(y, 0, SPRING);
    animate(scale, 1, SPRING);
    animate(backdrop, 1, SPRING);
  }

  function isOnMedia(p: { x: number; y: number }) {
    const L = layoutRef.current!;
    const { w, h } = fittedSize(media[indexRef.current], L);
    const s = scale.get();
    const cx = L.fitL + L.fitW / 2 + x.get();
    const cy = L.fitT + L.fitH / 2 + y.get();
    return Math.abs(p.x - cx) <= (w * s) / 2 && Math.abs(p.y - cy) <= (h * s) / 2;
  }

  function handleTap(p: { x: number; y: number }, time: number) {
    const G = gesture.current;
    const motionItem = isMotionMedia(media[indexRef.current]);
    if (G.pointerType === "mouse") {
      if (G.onVideo) return; // the native controls own clicks
      if (!isOnMedia(p)) return scale.get() > 1.01 ? resetZoom(true) : requestClose();
      if (!motionItem) toggleZoom(p.x, p.y);
      return;
    }
    const last = G.lastTap;
    if (time - last.t < DOUBLE_TAP_MS && Math.hypot(p.x - last.x, p.y - last.y) < 32) {
      window.clearTimeout(G.tapTimer);
      G.lastTap = { t: 0, x: 0, y: 0 };
      if (!motionItem) toggleZoom(p.x, p.y);
      return;
    }
    G.lastTap = { t: time, x: p.x, y: p.y };
    if (G.onVideo) return;
    G.tapTimer = window.setTimeout(() => setChrome((visible) => !visible), DOUBLE_TAP_MS);
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (closingRef.current || !layoutRef.current) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const G = gesture.current;
    const p = local(event);
    G.pointers.set(event.pointerId, p);
    if (G.pointers.size === 1) {
      G.pointerType = event.pointerType;
      G.onVideo = Boolean((event.target as HTMLElement).closest("video"));
      // Don't steal the pointer from native video controls until a drag is recognized.
      if (!G.onVideo) capture(event);
      x.stop();
      y.stop();
      scale.stop();
      trackX.stop();
      rebase(p, event.timeStamp, "pending");
    } else if (G.pointers.size === 2 && !isMotionMedia(media[indexRef.current]) && (G.mode === "pending" || G.mode === "pan")) {
      capture(event);
      startPinch();
    }
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const G = gesture.current;
    if (!G.pointers.has(event.pointerId) || closingRef.current) return;
    const L = layoutRef.current!;
    const p = local(event);
    G.pointers.set(event.pointerId, p);

    if (G.mode === "pinch") {
      const [a, b] = [...G.pointers.values()];
      if (!a || !b) return;
      let s = (G.originScale * Math.hypot(a.x - b.x, a.y - b.y)) / G.pinchDist;
      s = s > MAX_SCALE ? MAX_SCALE + (s - MAX_SCALE) * 0.25 : s < 1 ? 1 - (1 - s) * 0.5 : s;
      // The content point that was under the starting midpoint follows the current midpoint.
      const fx = G.pinchMidX - (L.fitL + L.fitW / 2);
      const fy = G.pinchMidY - (L.fitT + L.fitH / 2);
      scale.set(s);
      x.set((a.x + b.x) / 2 - G.pinchMidX + fx - (fx - G.originX) * (s / G.originScale));
      y.set((a.y + b.y) / 2 - G.pinchMidY + fy - (fy - G.originY) * (s / G.originScale));
      return;
    }
    if (G.pointers.size !== 1) return;

    G.samples.push({ t: event.timeStamp, x: p.x, y: p.y });
    if (G.samples.length > 12) G.samples.shift();
    const dx = p.x - G.startX;
    const dy = p.y - G.startY;

    if (G.mode === "pending") {
      if (Math.hypot(dx, dy) < TAP_SLOP) return;
      if (G.originScale > 1.01) G.mode = "pan";
      else if (Math.abs(dy) > Math.abs(dx)) G.mode = G.onVideo && G.pointerType === "mouse" ? "ignore" : "dismiss";
      else G.mode = G.onVideo ? "ignore" : "swipe"; // sideways on a video = scrubbing
      if (G.mode !== "ignore") capture(event);
      window.clearTimeout(G.tapTimer);
    }

    if (G.mode === "pan") {
      const b = bounds(scale.get());
      x.set(rubber(G.originX + dx, b.minX, b.maxX));
      y.set(rubber(G.originY + dy, b.minY, b.maxY));
    } else if (G.mode === "dismiss") {
      if (dy < 0) {
        // Upward: resist and spring back; only a downward swipe closes.
        x.set(dx * 0.3);
        y.set(dy * 0.3);
        return;
      }
      const progress = Math.min(1, dy / (L.h * 0.55));
      x.set(dx);
      y.set(dy);
      scale.set(1 - progress * 0.3);
      backdrop.set(1 - progress * 0.9);
    } else if (G.mode === "swipe") {
      const atEdge = (dx > 0 && indexRef.current === 0) || (dx < 0 && indexRef.current === count - 1);
      trackX.set(-indexRef.current * (L.w + SLIDE_GAP) + (atEdge ? dx * 0.3 : dx));
    }
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const G = gesture.current;
    if (!G.pointers.has(event.pointerId)) return;
    G.pointers.delete(event.pointerId);
    if (closingRef.current) return;
    const cancelled = event.type === "pointercancel";

    if (G.mode === "pinch") {
      if (G.pointers.size === 1) {
        // One finger lifted: keep panning with the other, no jump.
        const [rest] = G.pointers.values();
        rebase(rest, event.timeStamp, "pan");
      } else if (G.pointers.size === 0) {
        G.mode = "idle";
        settleZoom();
      }
      return;
    }
    if (G.pointers.size > 0) return;

    const mode = G.mode;
    G.mode = "idle";
    const L = layoutRef.current!;
    const p = local(event);
    const velocity = velocityOf(event.timeStamp);

    if (mode === "pending") {
      if (!cancelled) handleTap(p, event.timeStamp);
    } else if (mode === "pan") {
      if (scale.get() < 1 || scale.get() > MAX_SCALE) settleZoom();
      else settlePan(velocity);
    } else if (mode === "dismiss") {
      const dy = p.y - G.startY;
      if (!cancelled && (dy > DISMISS_DISTANCE || (velocity.vy > DISMISS_VELOCITY && dy > 16))) requestClose(velocity);
      else springBack();
    } else if (mode === "swipe") {
      const dx = p.x - G.startX;
      let next = indexRef.current;
      if (!cancelled && (dx < -L.w * 0.18 || velocity.vx < -SWIPE_VELOCITY)) next += 1;
      else if (!cancelled && (dx > L.w * 0.18 || velocity.vx > SWIPE_VELOCITY)) next -= 1;
      goTo(next, velocity.vx);
    }
  }

  // ---------------------------------------------------------------- render

  const visibleChrome = chrome;
  const fineOnly = "hidden [@media(hover:hover)_and_(pointer:fine)]:grid";

  return (
    <>
      <motion.div aria-hidden className="absolute inset-0 bg-black" style={{ opacity: backdrop }} />

      <div
        ref={stageRef}
        className="absolute inset-0 overflow-hidden"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDragStart={(event) => event.preventDefault()}
      >
        {/* Where media is fitted: edge to edge (minus safe areas) on touch, framed on desktop. */}
        <div
          ref={fitRef}
          aria-hidden
          className={cn(
            "pointer-events-none absolute bottom-[env(safe-area-inset-bottom)] left-[env(safe-area-inset-left)] right-[env(safe-area-inset-right)] top-[env(safe-area-inset-top)]",
            "[@media(hover:hover)_and_(pointer:fine)]:inset-y-16",
            count > 1 ? "[@media(hover:hover)_and_(pointer:fine)]:inset-x-24" : "[@media(hover:hover)_and_(pointer:fine)]:inset-x-12",
          )}
        />

        {layout ? (
          <motion.div className="absolute inset-0" style={{ x: trackX }}>
            {media.map((item, i) =>
              Math.abs(i - index) <= 1 ? (
                <div
                  key={`${item.url}-${i}`}
                  className="absolute top-0 h-full"
                  style={{ left: i * (layout.w + SLIDE_GAP), width: layout.w }}
                  aria-hidden={i !== index}
                >
                  <Slide
                    item={item}
                    layout={layout}
                    active={i === index}
                    hiRes={hiRes.has(i)}
                    placeholder={placeholders[i]}
                    zoomed={zoomed}
                    motionValues={i === index ? { x, y, scale, clipPath, opacity: mediaOpacity } : null}
                    videoRef={videoRef}
                  />
                </div>
              ) : null,
            )}
          </motion.div>
        ) : null}
      </div>

      {/* Controls: fade with the open/close progress, and toggle with a tap on touch screens. */}
      <motion.div className="pointer-events-none absolute inset-0" style={{ opacity: chromeOpacity }}>
        <div className={cn("absolute inset-0 transition-opacity duration-200", visibleChrome ? "opacity-100" : "opacity-0")}>
          <div
            className="absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/45 to-transparent pb-8"
            style={{
              paddingTop: "max(0.75rem, env(safe-area-inset-top))",
              paddingLeft: "max(1rem, env(safe-area-inset-left))",
              paddingRight: "max(0.75rem, env(safe-area-inset-right))",
            }}
          >
            {count > 1 ? (
              <span className="text-[13px] font-medium tabular-nums text-white/75">
                {index + 1} / {count}
              </span>
            ) : null}
            <div className={cn("ml-auto flex items-center gap-2", visibleChrome ? "pointer-events-auto" : "")}>
              <ChromeButton label={t("detail.close")} onClick={() => requestClose()}>
                <X size={18} />
              </ChromeButton>
            </div>
          </div>

          {count > 1 ? (
            <>
              <div className={cn("absolute inset-y-0 left-4 place-items-center", fineOnly, visibleChrome ? "pointer-events-auto" : "")}>
                <ChromeButton label={t("detail.prev")} onClick={() => goTo(index - 1)} disabled={index === 0} large>
                  <ChevronLeft size={22} />
                </ChromeButton>
              </div>
              <div className={cn("absolute inset-y-0 right-4 place-items-center", fineOnly, visibleChrome ? "pointer-events-auto" : "")}>
                <ChromeButton label={t("detail.next")} onClick={() => goTo(index + 1)} disabled={index === count - 1} large>
                  <ChevronRight size={22} />
                </ChromeButton>
              </div>
              <div
                className="absolute inset-x-0 bottom-0 flex justify-center gap-1.5"
                style={{ paddingBottom: "max(1rem, calc(env(safe-area-inset-bottom) + 0.5rem))" }}
                aria-hidden
              >
                {media.map((item, i) => (
                  <span
                    key={`${item.url}-${i}`}
                    className={cn("size-1.5 rounded-full transition-colors duration-200", i === index ? "bg-white" : "bg-white/35")}
                  />
                ))}
              </div>
            </>
          ) : null}
        </div>
      </motion.div>
    </>
  );
}

type SlideMotion = {
  x: MotionValue<number>;
  y: MotionValue<number>;
  scale: MotionValue<number>;
  clipPath: MotionValue<string>;
  opacity: MotionValue<number>;
};

function Slide({
  item,
  layout,
  active,
  hiRes,
  placeholder,
  zoomed,
  motionValues,
  videoRef,
}: {
  item: MediaEntry;
  layout: Layout;
  active: boolean;
  hiRes: boolean;
  placeholder?: string;
  zoomed: boolean;
  motionValues: SlideMotion | null;
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const { w, h } = fittedSize(item, layout);
  const box = {
    left: layout.fitL + (layout.fitW - w) / 2,
    top: layout.fitT + (layout.fitH - h) / 2,
    width: w,
    height: h,
  };
  const motionItem = isMotionMedia(item);
  const cursor = motionItem ? "" : zoomed && active ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in";

  // The 2048px rendition (4096px once zoomed past it) over the placeholder, so the media appears
  // instantly and sharpens in place.
  const content = (
    <>
      {placeholder ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="absolute inset-0 h-full w-full object-contain" src={placeholder} alt="" draggable={false} />
      ) : null}
      {motionItem ? (
        <VideoSlide item={item} active={active} videoRef={videoRef} />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="relative block h-full w-full [-webkit-user-drag:none]"
          src={pbsVariant(item.url ?? "", hiRes ? "4096x4096" : "large")}
          alt=""
          draggable={false}
          decoding="async"
        />
      )}
    </>
  );

  if (!motionValues) {
    return (
      <div className="absolute overflow-hidden" style={box}>
        {content}
      </div>
    );
  }
  return (
    <motion.div
      className={cn("absolute will-change-transform", cursor)}
      style={{ ...box, x: motionValues.x, y: motionValues.y, scale: motionValues.scale, clipPath: motionValues.clipPath, opacity: motionValues.opacity }}
    >
      {content}
    </motion.div>
  );
}

function VideoSlide({ item, active, videoRef }: { item: MediaEntry; active: boolean; videoRef: RefObject<HTMLVideoElement | null> }) {
  const { t } = useLanguage();
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const gif = isGifMedia(item);
  const poster = item.thumbnail ? pbsVariant(item.thumbnail, "large") : undefined;

  // Start playback as part of the opening tap where the browser allows it; if sound isn't
  // allowed yet, fall back to muted playback (the native controls can unmute).
  useLayoutEffect(() => {
    const video = ref.current;
    if (!video || !active) return;
    videoRef.current = video;
    video.play().catch(() => {
      if (gif || video.muted) return;
      video.muted = true;
      video.play().catch(() => {});
    });
    return () => {
      video.pause();
      if (videoRef.current === video) videoRef.current = null;
    };
  }, [active, gif, videoRef]);

  // Android Chrome: a landscape video in element fullscreen locks the screen to landscape.
  useEffect(() => {
    const video = ref.current;
    if (!video || !active) return;
    const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    const onChange = () => {
      if (document.fullscreenElement === video && video.videoWidth > video.videoHeight) {
        orientation?.lock?.("landscape").catch(() => {});
      } else if (!document.fullscreenElement) {
        try {
          orientation?.unlock?.();
        } catch {
          // Not supported (desktop / iOS): nothing to undo.
        }
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [active]);

  if (failed || !item.url) {
    return (
      <div className="relative grid h-full w-full place-items-center bg-neutral-900">
        <div className="grid justify-items-center gap-2 px-4 text-center text-white/70">
          <Film size={22} />
          <p className="text-sm">{t("media.unavailable")}</p>
        </div>
      </div>
    );
  }
  if (!active) {
    // eslint-disable-next-line @next/next/no-img-element
    return poster ? <img className="relative h-full w-full object-contain" src={poster} alt="" draggable={false} /> : null;
  }
  return (
    <video
      ref={ref}
      className="relative block h-full w-full object-contain"
      src={item.url}
      poster={poster}
      autoPlay
      playsInline
      controls={!gif}
      loop={gif}
      muted={gif}
      preload="auto"
      onError={() => setFailed(true)}
    />
  );
}

/** Keep receiving a pointer's events outside the stage (mouse leaving the window, etc.). */
function capture(event: React.PointerEvent<HTMLElement>) {
  try {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    // The pointer is already gone (lifted between events): nothing to capture.
  }
}

/** Native fullscreen: iPhone only has the video player (which rotates on its own). */
function toggleNativeFullscreen(video: HTMLVideoElement) {
  const v = video as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
  if (document.fullscreenElement) {
    void document.exitFullscreen();
    return;
  }
  if (document.fullscreenEnabled && v.requestFullscreen) v.requestFullscreen().catch(() => v.webkitEnterFullscreen?.());
  else v.webkitEnterFullscreen?.();
}

function ChromeButton({
  label,
  onClick,
  disabled,
  large,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  large?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "grid cursor-pointer place-items-center rounded-full bg-white/10 text-white/90 ring-1 ring-white/15 backdrop-blur-md transition hover:bg-white/20 hover:text-white focus-visible:outline-2 focus-visible:outline-white/70 disabled:pointer-events-none disabled:opacity-0",
        large ? "size-11" : "size-10",
      )}
    >
      {children}
    </button>
  );
}
