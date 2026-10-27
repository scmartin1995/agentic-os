// One small line-icon set for the dock, tabs, palette and buttons (24 px grid, 1.8 px strokes).
import type { ReactNode } from 'react';

const PATHS: Record<string, ReactNode> = {
  home: <><circle cx="12" cy="12" r="2.4" /><circle cx="5" cy="6" r="1.6" /><circle cx="19" cy="7" r="1.6" /><circle cx="6" cy="18.5" r="1.6" /><circle cx="18.5" cy="18" r="1.6" /><path d="M10.2 10.6 6.2 7.2M14 10.8l3.8-2.8M10.4 13.8l-3.3 3.5M13.8 13.7l3.5 3.2" /></>,
  actions: <><circle cx="12" cy="12" r="8.5" /><path d="m8.4 12.2 2.4 2.4 4.8-5" /></>,
  notes: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>,
  projects: <><rect x="3" y="4" width="8" height="7" rx="1.6" /><rect x="13" y="4" width="8" height="7" rx="1.6" /><rect x="3" y="13" width="8" height="7" rx="1.6" /><rect x="13" y="13" width="8" height="7" rx="1.6" /></>,
  skills: <><path d="M12 3l2.5 5.3 5.8.8-4.2 4 1 5.7L12 16.1 6.9 18.8l1-5.7-4.2-4 5.8-.8z" /></>,
  dreams: <><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /><path d="M16 4.5v3M14.5 6h3" /></>,
  value: <><path d="M4 19V10M10 19V5M16 19v-7M21 19H3" /><path d="M16 8l2-2 2 2" /></>,
  health: <><path d="M3 12h4l2-5 4 10 2-5h6" /></>,
  connectors: <><path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0z" /><path d="M12 16v5" /></>,
  dashboard: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v9M14.6 9.6c-.5-.9-1.5-1.3-2.6-1.3-1.5 0-2.6.8-2.6 1.9 0 2.7 5.4 1.2 5.4 3.9 0 1.1-1.2 1.9-2.8 1.9-1.2 0-2.3-.5-2.8-1.4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.5 2.6a7.6 7.6 0 0 0-2.6 1.5l-2.3-1-2 3.4 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.4 2.3-1a7.6 7.6 0 0 0 2.6 1.5l.5 2.6h4l.5-2.6a7.6 7.6 0 0 0 2.6-1.5l2.3 1 2-3.4z" /></>,
  files: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>,
  phone: <><rect x="7" y="2.5" width="10" height="19" rx="2.4" /><path d="M11 18.5h2" /></>,
  mail: <><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="m4 7.5 8 6 8-6" /></>,
  chat: <><path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-6l-4.5 3.5V17H6a2 2 0 0 1-2-2z" /></>,
  tools: <><circle cx="6" cy="6" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="18" r="2" /><circle cx="12" cy="12" r="2" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>,
  clip: <><path d="M20 11.5 12.5 19a5 5 0 0 1-7-7l8-8a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4L15 7" /></>,
  up: <><path d="M12 19V5M5 12l7-7 7 7" /></>,
  ear: <><path d="M6 8.5a6 6 0 1 1 12 0c0 3.5-3 4.5-3.5 7a3.5 3.5 0 0 1-6.5 1.5" /><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-1.5 2-1.5 3.5" /></>,
  sound: <><path d="M11 5 6 9H2v6h4l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" /></>,
  mute: <><path d="M11 5 6 9H2v6h4l5 4z" /><path d="m22 9-6 6M16 9l6 6" /></>,
  spark: <><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" /></>,
  brain: <><path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 0V7a3 3 0 0 0-3-3zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 0" /></>,
  discord: <><path d="M8 7c2.6-1 5.4-1 8 0l1.5 9.5c-1 .9-2.3 1.5-3.5 1.8l-.8-1.6M8 7 6.5 16.5c1 .9 2.3 1.5 3.5 1.8l.8-1.6M9 16.200c2 .6 4 .6 6 0" /><circle cx="9.7" cy="12" r="1" /><circle cx="14.3" cy="12" r="1" /></>,
  power: <><path d="M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0" /></>,
  chev: <><path d="m14.5 6-6 6 6 6" /></>,
  check: <><path d="m5 12.500 4.500 4.500L19 7" /></>,
};

export type IconName = keyof typeof PATHS;
export default function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {PATHS[name] ?? PATHS.file}
    </svg>
  );
}
