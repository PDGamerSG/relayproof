import Lenis from "lenis";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

interface ScrollApi {
  /** Stops page scrolling while an overlay is open. */
  lock: (locked: boolean) => void;
}

const ScrollContext = createContext<ScrollApi>({ lock: () => {} });

export function useScrollLock(locked: boolean) {
  const { lock } = useContext(ScrollContext);
  useEffect(() => {
    if (!locked) return;
    lock(true);
    return () => lock(false);
  }, [locked, lock]);
}

/**
 * Light follows the scroll: every element marked data-cast leans its shadow further and
 * stretches it as the element rises up the viewport, as if the sun were setting behind the page.
 */
function castShadows() {
  const nodes = document.querySelectorAll<HTMLElement>("[data-cast]");
  const vh = window.innerHeight;
  const reads = Array.from(nodes, (node) => {
    const rect = node.getBoundingClientRect();
    return { node, mid: (rect.top + rect.height / 2) / vh, near: rect.bottom > -200 && rect.top < vh + 200 };
  });
  for (const { node, mid, near } of reads) {
    if (!near) continue;
    const u = 1 - Math.min(1, Math.max(0, mid));
    node.style.setProperty("--skew", `${(34 + u * 26).toFixed(2)}deg`);
    node.style.setProperty("--len", (0.46 + u * 0.4).toFixed(3));
  }
}

export function ScrollProvider({ children }: { children: ReactNode }) {
  const lenisRef = useRef<Lenis | null>(null);
  const locks = useRef(0);

  const [api] = useState<ScrollApi>(() => ({
    lock(locked) {
      locks.current += locked ? 1 : -1;
      const on = locks.current > 0;
      if (lenisRef.current) {
        if (on) lenisRef.current.stop();
        else lenisRef.current.start();
      } else {
        document.documentElement.style.overflow = on ? "hidden" : "";
      }
    },
  }));

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    castShadows();
    if (reduced) return;

    const lenis = new Lenis({ autoRaf: true, anchors: true, lerp: 0.11 });
    lenisRef.current = lenis;
    lenis.on("scroll", castShadows);
    window.addEventListener("resize", castShadows);
    return () => {
      window.removeEventListener("resize", castShadows);
      lenis.destroy();
      lenisRef.current = null;
    };
  }, []);

  return <ScrollContext.Provider value={api}>{children}</ScrollContext.Provider>;
}
