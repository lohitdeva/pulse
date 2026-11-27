import { useEffect, useRef, type ReactNode } from "react";
import {
  istParts,
  nowNext,
  type DayPlan,
  type ItemLogStatus,
  type ScheduleItem,
} from "@pulse/shared";
import type { ChangeAlert } from "./classes";
import { AddExtraClass, ClassRowActions, type ClassActionsApi } from "./ClassActions";
import { Card, IconChip, RingGauge } from "./ui";

export interface TodayProps {
  plan: DayPlan;
  /** Unseen timetable change alerts queued during this Pulse day. */
  alerts?: ChangeAlert[];
  now: Date;
  greeting: string;
  dateLabel: string;
  syncPending?: boolean;
  onOpenSettings: () => void;
  onItemDone?: (item: ScheduleItem) => void;
  onStartTimer?: (item: ScheduleItem) => void;
  habitStatuses?: Record<string, ItemLogStatus>;
  onHabitStatusChange?: (itemKey: string, status: "done" | "skipped") => void;
  logging?: ReactNode;
  /** Check-in card to offer now (see `dueCheckIn`); null/omitted = none. */
  checkInDue?: "morning" | "midday" | null;
  onOpenCheckIn?: (kind: "morning" | "midday") => void;
  /** Class attendance / cancel / move / extra-class controls; omitted = read-only classes. */
  classActions?: ClassActionsApi;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Good morning" / "Good afternoon" / "Good evening" by IST hour; ", <name>" appended only when given. */
export function greetingFor(hour: number, name?: string): string {
  const part = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const trimmed = name?.trim();
  return trimmed ? `Good ${part}, ${trimmed}` : `Good ${part}`;
}

/** "Wed, 26 Nov" for the IST calendar date of `now`. */
export function dateLabelFor(now: Date): string {
  const p = istParts(now);
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return `${WEEKDAYS[weekday]}, ${p.day} ${MONTHS[p.month - 1]}`;
}

/** "HH:MM" in IST regardless of the device timezone. */
export function formatTime(instant: Date): string {
  const p = istParts(instant);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

function formatLeft(now: Date, end: Date): string {
  const mins = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m left` : `${h}h left`;
  return `${m}m left`;
}

function isNews(item: ScheduleItem): boolean {
  return item.meta.newsReading === true;
}

function itemTitle(item: ScheduleItem): string {
  return isNews(item) ? "News reading" : item.title;
}

function isCancelled(item: ScheduleItem): boolean {
  return item.source === "class" && item.meta.cancelled === true;
}

/** "MKT · Session 4 · R12" for a class item; empty for others. */
export function classDetail(item: ScheduleItem): string {
  if (item.source !== "class") return "";
  const parts: string[] = [];
  if (typeof item.meta.course === "string" && item.meta.course) parts.push(item.meta.course);
  if (typeof item.meta.session === "number") parts.push(`Session ${item.meta.session}`);
  if (typeof item.meta.room === "string" && item.meta.room) parts.push(item.meta.room);
  return parts.join(" · ");
}

function timeRange(item: ScheduleItem): string {
  if (item.startAt && item.endAt) return `${formatTime(item.startAt)} – ${formatTime(item.endAt)}`;
  if (item.startAt) return formatTime(item.startAt);
  if (item.endAt) return `until ${formatTime(item.endAt)}`;
  return "";
}

/** Stable identity for a loggable habit item within one Pulse day. */
export function habitItemKey(dayKey: string, item: ScheduleItem): string | null {
  if (
    item.blockType !== "habit" &&
    item.blockType !== "habit_checklist" &&
    item.blockType !== "habit_nudge"
  ) {
    return null;
  }
  if (item.templateBlockSortOrder !== null) {
    return `habit:${dayKey}:${item.templateBlockSortOrder}`;
  }

  if (item.meta.newsReading === true) {
    const sources = item.meta.sources;
    if (sources && typeof sources === "object") {
      const sourceIdentity = Object.entries(sources as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([source, minutes]) => `${source}-${String(minutes)}`)
        .join("+");
      if (sourceIdentity) {
        return `habit:${dayKey}:news:${sourceIdentity}`;
      }
    }
  }
  return null;
}

function GearIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  );
}

/**
 * Item keys a timeline row answers to when a notification opens `/?focus=<itemKey>`.
 * Mirrors the dispatcher's keys: `must:`/`habit:` template blocks and `class:<id>`.
 */
export function focusKeysFor(dayKey: string, item: ScheduleItem): string[] {
  const keys: string[] = [];
  const habit = habitItemKey(dayKey, item);
  if (habit) keys.push(habit);
  if (item.source === "class") {
    if (typeof item.meta.classId === "string") keys.push(`class:${item.meta.classId}`);
  } else {
    keys.push(`must:${dayKey}:${item.templateBlockSortOrder ?? `s${item.sortOrder}`}`);
  }
  return keys;
}

/** `?focus=` value with the attendance / wind-down suffixes removed, or null. */
export function readFocusKey(search: string): string | null {
  const raw = new URLSearchParams(search).get("focus");
  if (!raw || raw.length > 120) return null;
  return raw.replace(/:(attendance|winddown)$/, "");
}

/**
 * Renders nothing. When the app was opened from a notification (`/?focus=<itemKey>`),
 * scrolls that timeline row into view and highlights it for a few seconds. Runs after
 * every render until the row exists, because the plan can still be loading.
 */
function FocusFromNotification() {
  const handled = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (handled.current) return;
    const key = readFocusKey(window.location.search);
    if (!key) {
      handled.current = true;
      return;
    }
    const row = [...document.querySelectorAll<HTMLElement>("[data-item-keys]")].find(
      (el) => el.dataset.itemKeys?.split(" ").includes(key),
    );
    if (!row) return;
    handled.current = true;
    row.scrollIntoView?.({ block: "center", behavior: "smooth" });
    row.style.outline = "2px solid var(--pulse-mint)";
    row.style.outlineOffset = "4px";
    row.style.borderRadius = "8px";
    timer.current = setTimeout(() => {
      row.style.outline = "";
      row.style.outlineOffset = "";
      row.style.borderRadius = "";
    }, 4000);
  });
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return null;
}

export function Today({
  plan,
  alerts = [],
  now,
  greeting,
  dateLabel,
  syncPending = false,
  onOpenSettings,
  onItemDone,
  onStartTimer,
  habitStatuses = {},
  onHabitStatusChange,
  logging,
  checkInDue = null,
  onOpenCheckIn,
  classActions,
}: TodayProps) {
  const { current, next, fraction } = nowNext(plan, now);
  const nowMs = now.getTime();

  return (
    <div className="today">
      <header className="today-header">
        <div className="today-heading">
          <p className="section-kicker">{dateLabel}</p>
          <h1>{greeting}</h1>
        </div>
        <div className="today-header-actions">
          <span
            className={`sync-dot ${syncPending ? "sync-dot-pending" : "sync-dot-ok"}`}
            role="img"
            aria-label={syncPending ? "Changes waiting to sync" : "All changes synced"}
          />
          <IconChip label="Settings" icon={<GearIcon />} tone="blue" onClick={onOpenSettings} />
        </div>
      </header>

      <Card className="now-card" role="group" aria-label="Now and next">
        <p className="now-label">{current ? "NOW" : "NOTHING NOW"}</p>
        {current ? (
          <>
            <h2 className="now-title">{itemTitle(current)}</h2>
            {classDetail(current) ? <p className="now-class">{classDetail(current)}</p> : null}
            <p className="now-meta">
              <span>{timeRange(current)}</span>
              {current.endAt ? <span className="now-left">{formatLeft(now, current.endAt)}</span> : null}
            </p>
            <div
              className="now-bar"
              role="progressbar"
              aria-label="Time elapsed in this block"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(fraction * 100)}
            >
              <span className="now-bar-fill" style={{ width: `${fraction * 100}%` }} />
            </div>
            <div className="now-actions">
              <button className="button button-primary" type="button" onClick={() => onItemDone?.(current)}>
                Done
              </button>
              <button className="button button-secondary" type="button" onClick={() => onStartTimer?.(current)}>
                Start timer
              </button>
            </div>
          </>
        ) : (
          <p className="now-empty">No block is running right now.</p>
        )}
        <div className="next-line">
          <span className="next-label">NEXT</span>
          {next?.startAt ? (
            <>
              <span className="next-time">{formatTime(next.startAt)}</span>
              <span className="next-title">{itemTitle(next)}</span>
              {classDetail(next) ? <span className="next-class">{classDetail(next)}</span> : null}
            </>
          ) : (
            <span className="next-title">Nothing else planned today</span>
          )}
        </div>
      </Card>

      {checkInDue && onOpenCheckIn ? (
        <Card className="checkin-card" role="group" aria-label="Check-in">
          <div className="checkin-card-copy">
            <p className="now-label">CHECK-IN</p>
            <h2 className="checkin-card-title">
              {checkInDue === "morning" ? "Morning check-in" : "Midday check-in"}
            </h2>
            <p className="log-note">
              {checkInDue === "morning"
                ? "Sleep, mood, routine and today's plan. Under 2 minutes."
                : "Meals, water, mood and quick adds. Under 2 minutes."}
            </p>
          </div>
          <button className="button button-primary" type="button" onClick={() => onOpenCheckIn(checkInDue)}>
            Start
          </button>
        </Card>
      ) : null}

      {alerts.length > 0 ? (
        <Card className="alerts-card" role="group" aria-label="Timetable changes">
          <p className="now-label">TIMETABLE CHANGES</p>
          <ul className="alerts-list">
            {alerts.map((alert) => (
              <li key={alert.id} className={`alert-${alert.change_type}`}>
                {alert.summary}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="score-card" role="group" aria-label="Score">
        <div className="score-ring">
          <RingGauge value={0} max={100} label="Today" valueLabel="—" />
        </div>
        <div className="score-side">
          <div className="score-averages">
            <div className="score-avg">
              <span className="stat-label">Week avg</span>
              <span className="score-avg-value">—</span>
            </div>
            <div className="score-avg">
              <span className="stat-label">Month avg</span>
              <span className="score-avg-value">—</span>
            </div>
          </div>
          <p className="score-note">Scores start once you log a few days</p>
        </div>
      </Card>

      {logging}

      <FocusFromNotification />
      <section aria-labelledby="timeline-title">
        <h2 id="timeline-title" className="timeline-title">
          Timeline
        </h2>
        {classActions ? <AddExtraClass api={classActions} dayKey={plan.dayKey} /> : null}
        <ol className="timeline">
          {plan.items.map((item) => {
            const end = item.endAt?.getTime() ?? item.startAt?.getTime() ?? Number.POSITIVE_INFINITY;
            const isCurrent = item === current;
            const state = isCurrent ? "current" : end <= nowMs ? "past" : "future";
            const minutes = typeof item.meta.minutes === "number" ? item.meta.minutes : null;
            const itemKey = habitItemKey(plan.dayKey, item);
            const habitStatus = itemKey ? habitStatuses[itemKey] : undefined;
            const rowKeys = focusKeysFor(plan.dayKey, item);
            const habitLabel = `${itemTitle(item)}${
              timeRange(item) ? ` at ${timeRange(item)}` : ""
            }`;
            return (
              <li
                key={item.sortOrder}
                className={`timeline-row timeline-${state}${isCancelled(item) ? " timeline-cancelled" : ""}`}
                aria-current={isCurrent ? "step" : undefined}
                data-item-keys={rowKeys.join(" ")}
              >
                <span className="timeline-time">
                  {item.startAt ? formatTime(item.startAt) : item.endAt ? `→ ${formatTime(item.endAt)}` : "—"}
                </span>
                <span className="timeline-dot" aria-hidden="true" />
                <span className="timeline-copy">
                  <span className="timeline-name">{itemTitle(item)}</span>
                  {item.source === "class" ? (
                    <span className="timeline-sub">
                      {classDetail(item)}
                      {isCancelled(item) && !classActions ? " · Cancelled" : ""}
                    </span>
                  ) : null}
                  {isNews(item) && minutes !== null ? (
                    <span className="timeline-sub">{minutes} min</span>
                  ) : item.startAt && item.endAt ? (
                    <span className="timeline-sub">{timeRange(item)}</span>
                  ) : null}
                  {item.source === "class" && classActions ? (
                    <ClassRowActions item={item} now={now} api={classActions} dayKey={plan.dayKey} />
                  ) : null}
                  {itemKey && onHabitStatusChange ? (
                    <div className="habit-logging">
                      <div
                        className="habit-actions"
                        role="group"
                        aria-label={`Log ${habitLabel}`}
                      >
                        <button
                          className="button button-secondary habit-action"
                          type="button"
                          data-habit-action="done"
                          data-habit-key={itemKey}
                          aria-label={`Mark ${habitLabel} done`}
                          aria-pressed={habitStatus === "done"}
                          onClick={() => onHabitStatusChange(itemKey, "done")}
                        >
                          Done
                        </button>
                        <button
                          className="button button-secondary habit-action"
                          type="button"
                          data-habit-action="skipped"
                          data-habit-key={itemKey}
                          aria-label={`Mark ${habitLabel} skipped`}
                          aria-pressed={habitStatus === "skipped"}
                          onClick={() => onHabitStatusChange(itemKey, "skipped")}
                        >
                          Skip
                        </button>
                      </div>
                      {habitStatus ? (
                        <span
                          className={`habit-status habit-status-${habitStatus}`}
                          role="status"
                          aria-label={`Current status: ${habitStatus}`}
                        >
                          {habitStatus === "missed"
                            ? "Missed"
                            : habitStatus === "skipped"
                              ? "Skipped"
                              : "Done"}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
