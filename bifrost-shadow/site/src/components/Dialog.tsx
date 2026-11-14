import { useEffect, useId, useRef, type ReactNode } from "react";
import { useScrollLock } from "../lib/scroll";
import { IconClose } from "./Icons";
import "./Dialog.css";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** "sheet" slides in from the right edge; "modal" sits in the middle. */
  variant: "sheet" | "modal";
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
}

/** A native dialog: the browser handles focus trapping, Escape and the inert page behind it. */
export function Dialog({ open, onClose, variant, title, subtitle, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useScrollLock(open);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Fallback for browsers that close the dialog without a close event: the toggle event still fires.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    const onToggle = () => {
      if (!dialog.open) onClose();
    };
    dialog.addEventListener("toggle", onToggle);
    return () => dialog.removeEventListener("toggle", onToggle);
  }, [open, onClose]);

  return (
    <dialog
      ref={ref}
      className={`dialog dialog--${variant}`}
      aria-labelledby={titleId}
      onClose={onClose}
      // Escape: let React close it, so the state cannot outlive the dialog where a
      // browser skips the close event.
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // A click that lands on the dialog element itself is a click on the backdrop.
      onClick={(e) => e.target === ref.current && onClose()}
    >
      {open && (
        <div className="dialog__panel" data-lenis-prevent>
          <header className="dialog__head">
            <div>
              <h3 className="dialog__title" id={titleId}>
                {title}
              </h3>
              {subtitle && <p className="dialog__sub">{subtitle}</p>}
            </div>
            <button type="button" className="dialog__close" onClick={onClose} aria-label="Close">
              <IconClose />
            </button>
          </header>
          <div className="dialog__body">{children}</div>
        </div>
      )}
    </dialog>
  );
}
