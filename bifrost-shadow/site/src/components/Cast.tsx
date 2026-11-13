import type { ElementType } from "react";
import "./Cast.css";

interface CastProps {
  /** One entry per line: each line stands on its own ground and casts its own shadow. */
  lines: string[];
  as?: ElementType;
  className?: string;
  id?: string;
}

/** Display type that stands on the page and casts a shadow. The shadow follows the scroll (lib/scroll). */
export function Cast({ lines, as: Tag = "h1", className = "", id }: CastProps) {
  return (
    <Tag className={`cast ${className}`} data-cast id={id} aria-label={lines.join(" ")}>
      {lines.map((line, i) => (
        <span className="cast__line" key={line} style={{ "--i": i } as React.CSSProperties} aria-hidden="true">
          <span className="cast__text">{line}</span>
          <span className="cast__shadow">{line}</span>
        </span>
      ))}
    </Tag>
  );
}
