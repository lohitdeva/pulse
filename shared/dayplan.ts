/**
 * Day plan builder (PRD section 4): turns a DayTemplate + pulse day key into
 * concrete schedule items with UTC instants, and places the leftover daily
 * news-reading minutes into the earliest free slots. Pure, no I/O.
 */
import { blockInstants } from "./time";
import type { BlockType, DayTemplate, TemplateBlock } from "./schedule";

export interface PlanInterval {
  start: Date;
  end: Date;
}

export interface ScheduleItem {
  sortOrder: number;
  templateBlockSortOrder: number | null;
  title: string;
  blockType: BlockType;
  source: "template";
  startAt: Date | null;
  endAt: Date | null;
  meta: Record<string, unknown>;
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

function sortKey(item: ScheduleItem): number {
  return (item.startAt ?? item.endAt)?.getTime() ?? Number.POSITIVE_INFINITY;
}

export function buildDayPlan(
  template: DayTemplate,
  dayKey: string,
  busy: PlanInterval[] = [],
): DayPlan {
  const newsBlock = template.blocks.find((b) => b.meta?.newsMinutes);
  const breakfast = template.blocks.find((b) => b.meta?.newsOverlap === true);
  const fillable = template.blocks.find((b) => b.meta?.fillable === true);

  const items: ScheduleItem[] = template.blocks
    .filter((b) => b !== newsBlock)
    .map((b) => blockToItem(b, dayKey));

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
      gaps = freeGaps({ start, end }, busy, breakfastEnd);
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
