/**
 * Day plan builder (PRD section 4): turns a DayTemplate + pulse day key into
 * concrete schedule items with UTC instants, and places the leftover daily
 * news-reading minutes into the earliest free slots. Pure, no I/O.
 */
import { blockInstants } from "./time.ts";
import {
  WEEKDAY_TEMPLATE,
  WEEKEND_TEMPLATE,
  type BlockType,
  type DayTemplate,
  type TemplateBlock,
} from "./schedule.ts";

export interface PlanInterval {
  start: Date;
  end: Date;
}

export interface ScheduleItem {
  sortOrder: number;
  templateBlockSortOrder: number | null;
  title: string;
  blockType: BlockType;
  source: "template" | "class";
  startAt: Date | null;
  endAt: Date | null;
  meta: Record<string, unknown>;
}

/** A real timetable class, already resolved to its effective times and title. */
export interface PlanClass {
  id: string;
  kind: "class" | "exam" | "event";
  title: string;
  startAt: Date;
  endAt: Date;
  course: string | null;
  room: string | null;
  session: number | null;
  professor: string | null;
  /** Cancelled classes stay on the timeline (struck through) but are not busy. */
  cancelled: boolean;
}

export interface DayPlan {
  dayKey: string;
  items: ScheduleItem[];
  newsLeftoverMinutes: Record<string, number>;
}

const MS_MIN = 60_000;
const NEWS_PRIORITY = ["inshorts", "mint", "wsj"];

function newsBudget(block: TemplateBlock): Record<string, number> {
  const raw = block.meta?.newsMinutes as Record<string, number> | undefined;
  return { ...(raw ?? {}) };
}

/** Source keys in consumption order: inshorts, mint, wsj, then any others. */
function orderedSources(budget: Record<string, number>): string[] {
  const known = NEWS_PRIORITY.filter((k) => k in budget);
  const rest = Object.keys(budget).filter((k) => !NEWS_PRIORITY.includes(k));
  return [...known, ...rest];
}

/** Take up to `minutes` from the budget in priority order; returns what was taken. */
function consume(
  budget: Record<string, number>,
  minutes: number,
): Record<string, number> {
  const taken: Record<string, number> = {};
  let remaining = minutes;
  for (const key of orderedSources(budget)) {
    if (remaining <= 0) break;
    const take = Math.min(budget[key] ?? 0, remaining);
    if (take > 0) {
      taken[key] = take;
      budget[key] = (budget[key] ?? 0) - take;
      remaining -= take;
    }
  }
  return taken;
}

/** `region` minus `busy`, as sorted non-overlapping gaps no earlier than `notBefore`. */
function freeGaps(
  region: PlanInterval,
  busy: PlanInterval[],
  notBefore: Date,
): PlanInterval[] {
  const from = Math.max(region.start.getTime(), notBefore.getTime());
  const to = region.end.getTime();
  const sorted = busy
    .map((b) => ({ s: b.start.getTime(), e: b.end.getTime() }))
    .filter((b) => b.e > b.s && b.e > from && b.s < to)
    .sort((a, b) => a.s - b.s);
  const gaps: PlanInterval[] = [];
  let cursor = from;
  for (const b of sorted) {
    if (b.s > cursor) gaps.push({ start: new Date(cursor), end: new Date(b.s) });
    cursor = Math.max(cursor, b.e);
  }
  if (cursor < to) gaps.push({ start: new Date(cursor), end: new Date(to) });
  return gaps;
}

function blockToItem(block: TemplateBlock, dayKey: string): ScheduleItem {
  let startAt: Date | null = null;
  let endAt: Date | null = null;
  if (block.startHHMM && block.endHHMM) {
    const { start, end } = blockInstants(dayKey, block.startHHMM, block.endHHMM);
    startAt = start;
    endAt = end;
  } else if (block.startHHMM) {
    startAt = blockInstants(dayKey, block.startHHMM, block.startHHMM).start;
  } else if (block.endHHMM) {
    // Open-start block (e.g. "Study block 1"): only its end is fixed.
    endAt = blockInstants(dayKey, block.endHHMM, block.endHHMM).start;
  }
  return {
    sortOrder: 0,
    templateBlockSortOrder: block.sortOrder,
    title: block.title,
    blockType: block.blockType,
    source: "template",
    startAt,
    endAt,
    meta: { ...(block.meta ?? {}) },
  };
}

function classToItem(c: PlanClass): ScheduleItem {
  return {
    sortOrder: 0,
    templateBlockSortOrder: null,
    title: c.title,
    blockType: "fixed",
    source: "class",
    startAt: c.startAt,
    endAt: c.endAt,
    meta: {
      classId: c.id,
      kind: c.kind,
      course: c.course,
      room: c.room,
      session: c.session,
      professor: c.professor,
      cancelled: c.cancelled,
    },
  };
}

function sortKey(item: ScheduleItem): number {
  return (item.startAt ?? item.endAt)?.getTime() ?? Number.POSITIVE_INFINITY;
}

export function buildDayPlan(
  template: DayTemplate,
  dayKey: string,
  busy: PlanInterval[] = [],
  classes: PlanClass[] = [],
): DayPlan {
  const activeClasses = classes.filter((c) => !c.cancelled);
  const allBusy: PlanInterval[] = [
    ...busy,
    ...activeClasses.map((c) => ({ start: c.startAt, end: c.endAt })),
  ];
  const newsBlock = template.blocks.find((b) => b.meta?.newsMinutes);
  const breakfast = template.blocks.find((b) => b.meta?.newsOverlap === true);
  const fillable = template.blocks.find((b) => b.meta?.fillable === true);

  const items: ScheduleItem[] = template.blocks
    .filter((b) => b !== newsBlock)
    .map((b) => blockToItem(b, dayKey));
  for (const c of classes) items.push(classToItem(c));

  const leftover: Record<string, number> = {};

  if (newsBlock) {
    const budget = newsBudget(newsBlock);

    let breakfastEnd = new Date(0);
    if (breakfast?.startHHMM && breakfast.endHHMM) {
      const { start, end } = blockInstants(
        dayKey,
        breakfast.startHHMM,
        breakfast.endHHMM,
      );
      breakfastEnd = end;
      consume(budget, Math.round((end.getTime() - start.getTime()) / MS_MIN));
    }

    let gaps: PlanInterval[] = [];
    if (fillable?.startHHMM && fillable.endHHMM) {
      const { start, end } = blockInstants(
        dayKey,
        fillable.startHHMM,
        fillable.endHHMM,
      );
      gaps = freeGaps({ start, end }, allBusy, breakfastEnd);
    }

    for (const gap of gaps) {
      const remaining = Object.values(budget).reduce((a, b) => a + b, 0);
      if (remaining <= 0) break;
      const slotMinutes = Math.floor(
        (gap.end.getTime() - gap.start.getTime()) / MS_MIN,
      );
      const used = Math.min(slotMinutes, remaining);
      if (used <= 0) continue;
      const sources = consume(budget, used);
      items.push({
        sortOrder: 0,
        templateBlockSortOrder: null,
        title: "News reading",
        blockType: "habit",
        source: "template",
        startAt: gap.start,
        endAt: new Date(gap.start.getTime() + used * MS_MIN),
        meta: { newsReading: true, minutes: used, sources },
      });
    }

    for (const [key, minutes] of Object.entries(budget)) {
      if (minutes > 0) leftover[key] = minutes;
    }
  }

  items.sort((a, b) => {
    const diff = sortKey(a) - sortKey(b);
    if (diff !== 0) return diff;
    return (
      (a.templateBlockSortOrder ?? Number.POSITIVE_INFINITY) -
      (b.templateBlockSortOrder ?? Number.POSITIVE_INFINITY)
    );
  });
  items.forEach((item, i) => {
    item.sortOrder = i;
  });

  return { dayKey, items, newsLeftoverMinutes: leftover };
}

export interface NowNext {
  current: ScheduleItem | null;
  next: ScheduleItem | null;
  /** Progress through `current` in [0, 1]; 0 when there is no current item. */
  fraction: number;
}

/**
 * The item in progress at `now` (start inclusive, end exclusive; the latest
 * start wins when several overlap), the earliest item starting after `now`,
 * and how far through the current item we are.
 */
export function nowNext(plan: DayPlan, now: Date): NowNext {
  const t = now.getTime();
  let current: ScheduleItem | null = null;
  let next: ScheduleItem | null = null;
  for (const item of plan.items) {
    if (!item.startAt || item.meta.cancelled === true) continue;
    const s = item.startAt.getTime();
    if (item.endAt && s <= t && t < item.endAt.getTime()) {
      if (!current) current = item;
      else {
        const cs = (current.startAt as Date).getTime();
        // A real class wins a tie against a template block starting at the same time.
        if (s > cs || (s === cs && item.source === "class")) current = item;
      }
    }
    if (s > t && (!next || s < (next.startAt as Date).getTime())) next = item;
  }
  let fraction = 0;
  if (current?.startAt && current.endAt) {
    const span = current.endAt.getTime() - current.startAt.getTime();
    fraction =
      span > 0
        ? Math.min(1, Math.max(0, (t - current.startAt.getTime()) / span))
        : 0;
  }
  return { current, next, fraction };
}

/** Weekend template for Saturday/Sunday of the (IST calendar) date, else weekday. */
export function templateForDayKey(dayKey: string): DayTemplate {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!m) throw new Error(`Invalid day key: ${dayKey}`);
  const dow = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
  ).getUTCDay();
  return dow === 0 || dow === 6 ? WEEKEND_TEMPLATE : WEEKDAY_TEMPLATE;
}
