import type { SVGProps } from "react";

function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const IconPause = () => (
  <Icon>
    <path d="M6.2 4v10M11.8 4v10" />
  </Icon>
);

export const IconPlay = () => (
  <Icon>
    <path d="M6 3.8v10.4l8-5.2z" fill="currentColor" stroke="none" />
  </Icon>
);

export const IconRestart = () => (
  <Icon>
    <path d="M3.5 9a5.5 5.5 0 1 0 1.7-4" />
    <path d="M3.4 2.8v2.9h2.9" />
  </Icon>
);

export const IconCopy = () => (
  <Icon>
    <rect x="6.2" y="6.2" width="8.3" height="8.3" rx="1.6" />
    <path d="M11.8 6.2V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v5.3A1.5 1.5 0 0 0 5 11.8h1.2" />
  </Icon>
);

export const IconCheck = () => (
  <Icon>
    <path d="m3.8 9.4 3.3 3.3 7.1-7.4" />
  </Icon>
);

export const IconClose = () => (
  <Icon>
    <path d="m4.5 4.5 9 9M13.5 4.5l-9 9" />
  </Icon>
);

export const IconArrowDown = () => (
  <Icon>
    <path d="M9 3.5v11M4.5 10 9 14.5 13.5 10" />
  </Icon>
);

export const IconExternal = () => (
  <Icon width="14" height="14">
    <path d="M7 4.5H4.5v9h9V11M10 4.5h3.5V8M13.5 4.5 8.5 9.5" />
  </Icon>
);

export const IconMenu = () => (
  <Icon>
    <path d="M3 6h12M3 12h12" />
  </Icon>
);

/** The mark: a request standing on the page, and the shadow it casts. */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" aria-hidden="true" focusable="false">
      <path d="M3 12.5h8.5l8 8H11z" fill="currentColor" opacity="0.38" />
      <rect x="3" y="2" width="8.5" height="10.5" rx="1.4" fill="currentColor" />
      <rect x="3" y="2" width="8.5" height="3.2" rx="1.4" fill="var(--sun)" />
    </svg>
  );
}
