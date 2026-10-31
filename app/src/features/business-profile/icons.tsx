import type { ReactNode } from 'react';

const STROKE = '#333d4b';
const FILL = '#cfe0ff';
const MUTED = '#e5e8eb';

function Icon({ children, size = 56 }: Readonly<{ children: ReactNode; size?: number }>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 56 56"
      fill="none"
      stroke={STROKE}
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function KoreanFoodIcon() {
  return (
    <Icon>
      <path d="M22 9c-2 2 2 3 0 5M28 8c-2 2 2 3 0 5M34 9c-2 2 2 3 0 5" />
      <path d="M17 24c2-5 7-7 11-7s9 2 11 7" fill="#fff" />
      <path d="M10 25h36c0 10-8 17-18 17s-18-7-18-17Z" fill={FILL} />
      <path d="M21 42h14l-2 5H23l-2-5Z" fill="#fff" />
      <path d="M38 14 46 6M41 16l7-7" />
    </Icon>
  );
}

export function CoffeeIcon() {
  return (
    <Icon>
      <path d="M17 13h22l-1 5H18l-1-5Z" fill="#fff" />
      <path d="M15 18h26" />
      <path d="M18 18h20l-3 30H21l-3-30Z" fill={FILL} />
      <path d="M19.5 28h17l-1 10h-15l-1-10Z" fill="#fff" />
      <circle cx="28" cy="33" r="2.6" />
      <path d="M22 9h12l1 4H21l1-4Z" fill="#fff" />
    </Icon>
  );
}

const AREA_FILL = { small: 15, medium: 24, large: 34 } as const;

export function AreaIcon({ size }: Readonly<{ size: keyof typeof AREA_FILL }>) {
  const filled = AREA_FILL[size];
  return (
    <Icon>
      <rect x="11" y="11" width="34" height="34" rx="1.5" fill={MUTED} stroke="#b0b8c1" strokeDasharray="2 2" />
      <rect x="11" y={45 - filled} width={filled} height={filled} rx="1.5" fill={FILL} />
      <path d={`M8 ${45 - filled}h6M${11 + filled} 48v-6`} stroke="#6b7684" />
    </Icon>
  );
}

const FLOOR_ROW = { BASEMENT_1: 2, GROUND_1: 1, UPPER_2_PLUS: 0 } as const;

export function FloorIcon({ floor }: Readonly<{ floor: keyof typeof FLOOR_ROW }>) {
  const row = FLOOR_ROW[floor];
  return (
    <Icon>
      <path d="M8 40h40" stroke="#b0b8c1" />
      <circle cx="12" cy="31" r="3.5" fill="#d7ead0" stroke="#6b8f5e" />
      <path d="M12 34.5V40" stroke="#6b8f5e" />
      <circle cx="44" cy="31" r="3.5" fill="#d7ead0" stroke="#6b8f5e" />
      <path d="M44 34.5V40" stroke="#6b8f5e" />
      {[0, 1, 2].map((index) => (
        <rect
          key={index}
          x="20"
          y={16 + index * 12}
          width="16"
          height="12"
          fill={index === row ? FILL : '#fff'}
          stroke={STROKE}
        />
      ))}
      <path d="M20 40h16" stroke={STROKE} strokeWidth={2} />
    </Icon>
  );
}

export function BuildingTypeIcon({
  type,
}: Readonly<{ type: 'SMALL_RETAIL' | 'MEDIUM_LARGE_RETAIL' | 'COLLECTIVE_RETAIL' }>) {
  if (type === 'SMALL_RETAIL')
    return (
      <Icon>
        <path d="M10 46h36" stroke="#b0b8c1" />
        <path d="M14 24h28v22H14z" fill="#fff" />
        <path d="M12 18h32l-2 7H14l-2-7Z" fill={FILL} />
        <path d="M18 18v7M24 18v7M30 18v7M36 18v7" />
        <path d="M18 32h8v14h-8zM31 32h7v7h-7z" fill={FILL} />
      </Icon>
    );
  if (type === 'MEDIUM_LARGE_RETAIL')
    return (
      <Icon>
        <path d="M8 48h40" stroke="#b0b8c1" />
        <path d="M16 8h24v40H16z" fill="#fff" />
        <path d="M21 14h4v4h-4zM31 14h4v4h-4zM21 23h4v4h-4zM31 23h4v4h-4zM21 32h4v4h-4zM31 32h4v4h-4z" />
        <path d="M16 40h24v8H16z" fill={FILL} />
        <path d="M26 42h4v6h-4z" fill="#fff" />
      </Icon>
    );
  return (
    <Icon>
      <path d="M8 48h40" stroke="#b0b8c1" />
      <path d="M10 18h36v30H10z" fill="#fff" />
      <path d="M10 18 28 9l18 9" />
      <path d="M10 33h36M22 18v30M34 18v30" />
      <path d="M10 33h12v15H10zM34 18h12v15H34z" fill={FILL} />
    </Icon>
  );
}

export function SearchIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true" focusable="false">
      <circle cx="9.5" cy="9.5" r="6.5" stroke={STROKE} strokeWidth="1.8" />
      <path d="m14.5 14.5 5 5" stroke={STROKE} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function TipIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M11 3.5a5.5 5.5 0 0 0-3.2 10c.5.4.7.9.7 1.5h5c0-.6.2-1.1.7-1.5a5.5 5.5 0 0 0-3.2-10Z"
        fill="#ffe27a"
        stroke={STROKE}
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M8.8 17.5h4.4M9.5 19.5h3" stroke={STROKE} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
