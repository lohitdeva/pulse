import { useId, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";

export { Sheet } from "./Sheet";
export type { SheetProps } from "./Sheet";

function cx(...classes: Array<string | undefined | false>) {
  return classes.filter(Boolean).join(" ");
}

export type CardProps = HTMLAttributes<HTMLDivElement>;

export function Card({ className, ...props }: CardProps) {
  return <div className={cx("pulse-card", className)} {...props} />;
}

export type StatTileProps = {
  label: string;
  value: ReactNode;
  unit?: string;
  icon?: ReactNode;
  accent?: "blue" | "mint" | "orange" | "red";
  hint?: string;
};

export function StatTile({ label, value, unit, icon, accent = "blue", hint }: StatTileProps) {
  return (
    <Card className="stat-tile" role="group" aria-label={label}>
      {icon && <span className={`icon-chip icon-chip-${accent}`} aria-hidden="true">{icon}</span>}
      <span className="stat-tile-copy">
        <span className="stat-label">{label}</span>
        <span className="stat-value">
          {value}
          {unit && <span className="stat-unit">{unit}</span>}
        </span>
        {hint && <span className="stat-label">{hint}</span>}
      </span>
    </Card>
  );
}

export type RingGaugeProps = {
  value: number;
  max: number;
  label: string;
  unit?: string;
  valueLabel?: ReactNode;
  className?: string;
};

export function RingGauge({ value, max, label, unit, valueLabel, className }: RingGaugeProps) {
  const id = useId().replaceAll(":", "");
  const gradientId = `pulse-ring-${id}`;
  const safeMax = max > 0 ? max : 1;
  const progress = Math.min(100, Math.max(0, (value / safeMax) * 100));
  const displayValue = valueLabel ?? value;

  return (
    <div
      className={cx("ring-gauge", className)}
      role="img"
      aria-label={`${label}: ${String(displayValue)}${unit ? ` ${unit}` : ""}, ${Math.round(progress)}%`}
    >
      <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#3a8dff" />
            <stop offset="100%" stopColor="#7fe3d6" />
          </linearGradient>
        </defs>
        <circle className="ring-track" cx="50" cy="50" r="42" />
        <circle
          className="ring-progress"
          cx="50"
          cy="50"
          r="42"
          pathLength="100"
          stroke={`url(#${gradientId})`}
          strokeDashoffset={100 - progress}
          transform="rotate(-90 50 50)"
        />
      </svg>
      <span className="ring-content" aria-hidden="true">
        <span className="ring-value">{displayValue}</span>
        <span className="ring-label">{label}</span>
        {unit && <span className="ring-unit">{unit}</span>}
      </span>
    </div>
  );
}

export type IconChipProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label" | "type"> & {
  label: string;
  icon: ReactNode;
  tone?: "blue" | "mint" | "orange" | "red";
};

export function IconChip({ label, icon, tone = "blue", className, ...props }: IconChipProps) {
  return (
    <button className={cx(`icon-chip icon-chip-${tone}`, className)} {...props} type="button" aria-label={label}>
      {icon}
    </button>
  );
}

export type ListRowProps = {
  label: string;
  value?: ReactNode;
  hint?: string;
  icon?: ReactNode;
  onClick?: () => void;
  className?: string;
};

export function ListRow({ label, value, hint, icon, onClick, className }: ListRowProps) {
  const contents = (
    <>
      {icon && <span className="list-row-icon" aria-hidden="true">{icon}</span>}
      <span className="list-row-copy">
        <span className="list-row-label">{label}</span>
        {hint && <span className="list-row-hint">{hint}</span>}
      </span>
      {value !== undefined && <span className="list-row-value">{value}</span>}
      {onClick && <Chevron />}
    </>
  );

  if (onClick) {
    return (
      <button className={cx("list-row", className)} type="button" onClick={onClick}>
        {contents}
      </button>
    );
  }

  return <div className={cx("list-row", className)}>{contents}</div>;
}

export type TrendChipProps = {
  value: string;
  direction: "up" | "down" | "flat";
  label?: string;
  className?: string;
};

export function TrendChip({ value, direction, label, className }: TrendChipProps) {
  const symbol = direction === "up" ? "↗" : direction === "down" ? "↘" : "→";
  const accessibleLabel = label ?? `${direction === "flat" ? "No change" : `Trending ${direction}`}: ${value}`;

  return (
    <span className={cx("trend-chip", direction === "down" && "trend-down", direction === "flat" && "trend-flat", className)} role="img" aria-label={accessibleLabel}>
      <span aria-hidden="true">{symbol}</span>
      {value}
    </span>
  );
}

export const TAB_NAMES = ["Today", "Plan", "Fitness", "Insights", "More"] as const;
export type TabName = (typeof TAB_NAMES)[number];

const tabGlyphs: Record<TabName, string> = {
  Today: "◷",
  Plan: "▦",
  Fitness: "⌁",
  Insights: "◫",
  More: "•••",
};

export type BottomTabsProps = {
  activeTab: TabName;
  onChange: (tab: TabName) => void;
  className?: string;
};

export function BottomTabs({ activeTab, onChange, className }: BottomTabsProps) {
  return (
    <nav className={cx("tabs-dock", className)} aria-label="Primary">
      <div className="bottom-tabs">
        {TAB_NAMES.map((tab) => (
          <button
            key={tab}
            className="tab-button"
            type="button"
            aria-current={activeTab === tab ? "page" : undefined}
            aria-label={tab}
            onClick={() => onChange(tab)}
          >
            <span className="tab-glyph" aria-hidden="true">{tabGlyphs[tab]}</span>
            <span>{tab}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

function Chevron() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
      <path d="m7 4 6 6-6 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
