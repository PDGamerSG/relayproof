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

/** Smooth scrolling, unless the reader asked for reduced motion. Anchors honour scroll-margin-top. */
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
    if (reduced) return;

    const lenis = new Lenis({ autoRaf: true, anchors: true, lerp: 0.12 });
    lenisRef.current = lenis;
    return () => {
      lenis.destroy();
      lenisRef.current = null;
    };
  }, []);

  return <ScrollContext.Provider value={api}>{children}</ScrollContext.Provider>;
}
