import { useEffect, useState } from "react";
import { LINKS, NAV } from "../data/site";
import { IconClose, IconMenu, Mark } from "./Icons";
import "./Nav.css";

/** The section whose top most recently passed under the bar. */
function useActiveSection(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const sections = ids.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => el !== null);
    const update = () => {
      const line = window.innerHeight * 0.35;
      let current: string | null = null;
      for (const section of sections) {
        if (section.getBoundingClientRect().top <= line) current = section.id;
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

const SECTION_IDS = NAV.map((item) => item.href.slice(1));

export function Nav() {
  const active = useActiveSection(SECTION_IDS);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="nav" data-open={open}>
      <div className="nav__bar">
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
          <a className="btn btn--sun btn--small" href="live.html" onClick={() => setOpen(false)}>
            Try it live
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
        {NAV.map((item) => (
          <a key={item.href} href={item.href} onClick={() => setOpen(false)}>
            {item.label}
          </a>
        ))}
        <a href={LINKS.repo}>GitHub</a>
      </nav>
    </header>
  );
}
