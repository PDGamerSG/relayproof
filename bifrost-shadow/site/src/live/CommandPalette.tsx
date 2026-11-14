import type { RecordsState } from "./records";
import type { Summary } from "./shadowClient";

export interface PaletteTab {
  id: string;
  label: string;
}

/** Placeholder: Cmd/Ctrl+K palette for tabs, comparisons and actions. */
export function CommandPalette(_props: { tabs: PaletteTab[]; data: RecordsState; summary?: Summary }) {
  return null;
}
