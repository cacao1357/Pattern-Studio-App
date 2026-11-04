import type { IconName } from "../types";

const PATHS: Record<IconName, { viewBox: string; body: JSX.Element }> = {
  mark: {
    viewBox: "0 0 32 32",
    body: (
      <>
        <path d="M16 3.5c4.2 4.2 8 8 12.5 12.5C24 20.5 20.2 24.3 16 28.5 11.8 24.3 8 20.5 3.5 16 8 11.5 11.8 7.7 16 3.5Z" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M16 9.6c2.3 2.3 4.1 4.1 6.4 6.4-2.3 2.3-4.1 4.1-6.4 6.4-2.3-2.3-4.1-4.1-6.4-6.4 2.3-2.3 4.1-4.1 6.4-6.4Z" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="16" cy="16" r="1.6" fill="currentColor" />
      </>
    )
  },
  history: {
    viewBox: "0 0 24 24",
    body: (
      <>
        <path d="M4.5 9.2A8.2 8.2 0 1 1 4 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <path d="M4.2 5.5v4.2h4.2M12 7.7V12l3 2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </>
    )
  },
  settings: {
    viewBox: "0 0 24 24",
    body: (
      <>
        <circle cx="12" cy="12" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M12 2.8v2.3M12 18.9v2.3M2.8 12h2.3M18.9 12h2.3M5.5 5.5l1.6 1.6M16.9 16.9l1.6 1.6M18.5 5.5l-1.6 1.6M7.1 16.9l-1.6 1.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </>
    )
  },
  image: {
    viewBox: "0 0 24 24",
    body: (
      <>
        <rect x="3.5" y="4.5" width="17" height="15" rx="2.3" fill="none" stroke="currentColor" strokeWidth="1.7" />
        <circle cx="9" cy="9.5" r="1.5" fill="currentColor" />
        <path d="m5.5 17 4.4-4.5 3.1 3 2.5-2.4 3 3.9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </>
    )
  },
  eye: {
    viewBox: "0 0 24 24",
    body: (
      <>
        <path d="M3.5 12s3.1-5.2 8.5-5.2 8.5 5.2 8.5 5.2-3.1 5.2-8.5 5.2S3.5 12 3.5 12Z" fill="none" stroke="currentColor" strokeWidth="1.7" />
        <circle cx="12" cy="12" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.7" />
      </>
    )
  },
  check: {
    viewBox: "0 0 24 24",
    body: <path d="m5 12.5 4.3 4.3L19.5 6.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
  },
  alert: {
    viewBox: "0 0 24 24",
    body: (
      <>
        <path d="M12 4.2 21 20H3L12 4.2Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M12 9.5v4.7M12 17.2v.2" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      </>
    )
  },
  crop: {
    viewBox: "0 0 24 24",
    body: <path d="M7 3.5V17h13.5M17 20.5V7H3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  },
  brush: {
    viewBox: "0 0 24 24",
    body: (
      <>
        <path d="M14.6 4.2 19.8 9.4 10 19.2H4.8v-5.2L14.6 4.2Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="m12.7 6.1 5.2 5.2M4.8 19.2 8 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </>
    )
  },
  grid: {
    viewBox: "0 0 24 24",
    body: (
      <>
        <rect x="3.5" y="3.5" width="7" height="7" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <rect x="13.5" y="3.5" width="7" height="7" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <rect x="13.5" y="13.5" width="7" height="7" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      </>
    )
  },
  spark: {
    viewBox: "0 0 24 24",
    body: <path d="M12 3.5c.5 4.5 2 6 6.5 6.5-4.5.5-6 2-6.5 6.5-.5-4.5-2-6-6.5-6.5 4.5-.5 6-2 6.5-6.5ZM18.5 15c.2 2 .9 2.8 3 3-2.1.2-2.8 1-3 3-.2-2-.9-2.8-3-3 2.1-.2 2.8-1 3-3Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
  },
  plus: {
    viewBox: "0 0 24 24",
    body: <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  },
  minus: {
    viewBox: "0 0 24 24",
    body: <path d="M5 12h14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  },
  fit: {
    viewBox: "0 0 24 24",
    body: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  }
};

export interface IconProps {
  name: IconName;
  className?: string;
}

export default function Icon({ name, className = "w-4 h-4" }: IconProps) {
  const icon = PATHS[name];
  return (
    <svg viewBox={icon.viewBox} className={className} aria-hidden="true" focusable="false">
      {icon.body}
    </svg>
  );
}
