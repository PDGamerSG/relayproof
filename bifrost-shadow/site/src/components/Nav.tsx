import { useEffect, useState } from "react";
import { LINKS, NAV } from "../data/site";
import { IconClose, IconMenu, Mark } from "./Icons";
import "./Nav.css";

/** The section whose top most recently passed under the bar. */
function useActiveSection(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const update = () => {
      const line = window.innerHeight * 0.35;
      let current: string | null = null;
      for (const id of ids) {
        const section = document.getElementById(id);
        if (section && section.getBoundingClientRect().top <= line) current = id;
      }
      setActive(current);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [ids]);

  return active;
}

function useScrolled(): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 8);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);
  return scrolled;
}

const SECTION_IDS = NAV.map((item) => item.href.slice(1));

export function Nav() {
  const active = useActiveSection(SECTION_IDS);
  const scrolled = useScrolled();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onResize = () => window.innerWidth > 1020 && setOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  return (
    <header className="nav" data-open={open} data-scrolled={scrolled || open}>
      <div className="nav__bar wrap">
        <a className="nav__brand" href="./" aria-label="RelayProof home" onClick={() => setOpen(false)}>
          <Mark />
          <span>RelayProof</span>
        </a>

        <nav className="nav__links" aria-label="Sections">
          {NAV.map((item) => (
            <a key={item.href} href={item.href} aria-current={active === item.href.slice(1) ? "true" : undefined}>
              {item.label}
            </a>
          ))}
        </nav>

        <div className="nav__end">
          <a className="nav__source" href={LINKS.repo}>
            GitHub
          </a>
          <a className="btn btn--small nav__cta" href="live.html" onClick={() => setOpen(false)}>
            Live console
          </a>
          <button
            type="button"
            className="nav__menu"
            aria-expanded={open}
            aria-controls="nav-sheet"
            aria-label={open ? "Close the menu" : "Open the menu"}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <IconClose /> : <IconMenu />}
          </button>
        </div>
      </div>

      <nav className="nav__sheet" id="nav-sheet" aria-label="Sections" hidden={!open}>
        <div className="wrap">
          {NAV.map((item) => (
            <a key={item.href} href={item.href} onClick={() => setOpen(false)}>
              {item.label}
            </a>
          ))}
          <a href={LINKS.repo}>GitHub</a>
        </div>
      </nav>
    </header>
  );
}
