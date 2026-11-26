import { istDateTimeLocalToUtc } from "../time";

/** Raw `getDisplayValues()` rows and A1 ranges from the Schedule sheet bridge. */
export interface TimetableBridgePayload {
  values: readonly (readonly string[])[];
  merges: readonly string[];
}

export type TimetableItemKind = "class" | "exam" | "event";

/**
 * A parsed Section C sheet item. `date` is the sheet's local calendar date;
 * `startsAt` and `endsAt` are ISO UTC instants for those wall times in IST.
 */
export interface ParsedTimetableItem {
  date: string;
  startsAt: string;
  endsAt: string;
  kind: TimetableItemKind;
  title: string;
  course: string | null;
  session: number | null;
  professor: string | null;
  room: string | null;
}

interface Slot {
  column: number;
  start: string;
  end: string;
}

interface CellRange {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
  key: string;
}

const SLOTS: readonly Slot[] = [
  { column: 3, start: "09:30", end: "11:00" },
  { column: 4, start: "11:15", end: "12:45" },
  { column: 6, start: "14:00", end: "15:30" },
  { column: 7, start: "15:45", end: "17:15" },
];

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const COURSE_PATTERN = /\b(MM|OM|OB|FM|DS)\s*-\s*(II|I)(?:\s*-\s*(\d+))?\b/i;
const TIME_RANGE_PATTERN = /(\d{1,2})\s*:\s*(\d{2})\s*(AM|PM)?\s*-\s*(\d{1,2})\s*:\s*(\d{2})\s*(AM|PM)?/i;
const TIME_RANGE_GLOBAL = /(\d{1,2})\s*:\s*(\d{2})\s*(AM|PM)?\s*-\s*(\d{1,2})\s*:\s*(\d{2})\s*(AM|PM)?/gi;

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function columnToIndex(letters: string): number {
  let value = 0;
  for (const letter of letters.toUpperCase()) {
    value = value * 26 + letter.charCodeAt(0) - 64;
  }
  return value - 1;
}

function parseCellRange(value: string): CellRange {
  const match = /^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i.exec(value.trim());
  if (!match) throw new Error(`Invalid merged range: ${value}`);

  const firstColumn = columnToIndex(match[1]!);
  const firstRow = Number(match[2]) - 1;
  const lastColumn = columnToIndex(match[3] ?? match[1]!);
  const lastRow = Number(match[4] ?? match[2]) - 1;
  if (firstRow < 0 || lastRow < firstRow || lastColumn < firstColumn) {
    throw new Error(`Invalid merged range: ${value}`);
  }

  return {
    startRow: firstRow,
    endRow: lastRow,
    startColumn: firstColumn,
    endColumn: lastColumn,
    key: `${firstColumn}:${firstRow}-${lastColumn}:${lastRow}`,
  };
}

function parseSheetDate(value: string): string {
  const match = /^(\d{1,2})-([A-Za-z]{3})$/.exec(value.trim());
  if (!match) throw new Error(`Invalid timetable date: ${value}`);
  const day = Number(match[1]);
  const month = MONTHS[match[2]!.toLowerCase()];
  if (month === undefined) throw new Error(`Invalid timetable date: ${value}`);
  const year = month >= 9 ? 2026 : 2027;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`Invalid timetable date: ${value}`);
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function minuteOfDay(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour! * 60 + minute!;
}

function timeCandidates(hour: number, minute: number, suffix: string | undefined): number[] {
  if (hour < 0 || hour > 12 || minute < 0 || minute > 59) return [];
  if (suffix) {
    if (hour < 1 || hour > 12) return [];
    const normalizedHour = hour % 12 + (suffix.toUpperCase() === "PM" ? 12 : 0);
    return [normalizedHour * 60 + minute];
  }

  const candidates =
    hour === 12
      ? [12 * 60 + minute]
      : [hour * 60 + minute, (hour + 12) * 60 + minute];
  return [...new Set(candidates.filter((candidate) => candidate >= 6 * 60 && candidate <= 18 * 60))];
}

function closestCandidate(candidates: number[], target: number): number | undefined {
  return candidates
    .slice()
    .sort((left, right) => Math.abs(left - target) - Math.abs(right - target) || left - right)[0];
}

function formatTime(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function explicitTimes(
  raw: string,
  defaultStart: string,
  defaultEnd: string,
): { start: string; end: string } | undefined {
  const match = TIME_RANGE_PATTERN.exec(raw);
  if (!match) return undefined;

  const startCandidates = timeCandidates(Number(match[1]), Number(match[2]), match[3]);
  const start = closestCandidate(startCandidates, minuteOfDay(defaultStart));
  if (start === undefined) return undefined;

  const endCandidates = timeCandidates(Number(match[4]), Number(match[5]), match[6]).filter(
    (candidate) => candidate > start,
  );
  const end = closestCandidate(endCandidates, minuteOfDay(defaultEnd));
  if (end === undefined) return undefined;
  return { start: formatTime(start), end: formatTime(end) };
}

function removeExplicitTimes(value: string): string {
  return normalizeText(value.replace(TIME_RANGE_GLOBAL, " ")).replace(/\(\s*\)/g, "").trim();
}

function parseCell(value: string): Omit<ParsedTimetableItem, "date" | "startsAt" | "endsAt"> {
  const normalized = normalizeText(value);
  const courseMatch = COURSE_PATTERN.exec(normalized);
  const course = courseMatch ? `${courseMatch[1]!.toUpperCase()}-${courseMatch[2]!.toUpperCase()}` : null;
  const session = courseMatch?.[3] ? Number(courseMatch[3]) : null;
  const professorMatch = /\bProf\.?\s+([^()]+?)(?:\s*\)|\s*\(|$)/i.exec(normalized);
  const professor = professorMatch ? `Prof. ${normalizeText(professorMatch[1]!)}` : null;
  const roomMatch = /\(\s*([A-Z]\d{2,})\s*\)/i.exec(normalized);
  const room = roomMatch?.[1]?.toUpperCase() ?? null;
  const isExam = /\bexam\b|\bmid[\s-]?term\b|\bend[\s-]?term\b/i.test(normalized);
  const kind: TimetableItemKind = isExam ? "exam" : course && session !== null ? "class" : "event";
  const cleanedTitle = removeExplicitTimes(normalized);
  const title = kind === "class" ? `${course}-${session}` : cleanedTitle;

  return { kind, title, course, session, professor, room };
}

function mergedRangeAt(ranges: readonly CellRange[], row: number, column: number): CellRange | undefined {
  return ranges.find(
    (range) =>
      row >= range.startRow &&
      row <= range.endRow &&
      column >= range.startColumn &&
      column <= range.endColumn,
  );
}

/**
 * Parse Section C from a Google Sheets `getDisplayValues()` payload. The date
 * comes from the merged date column; time ranges come from the five fixed
 * timetable slots, with cell-written times taking precedence. Returned times
 * are UTC ISO strings produced by `shared/time.ts` from IST wall-clock values.
 */
export function parseSectionCTimetable(payload: TimetableBridgePayload): ParsedTimetableItem[] {
  const headerRowIndex = payload.values.findIndex((row) =>
    row.some((cell) => normalizeText(cell).toLowerCase() === "date") &&
    row.some((cell) => normalizeText(cell).toLowerCase() === "sections"),
  );
  if (headerRowIndex < 0) throw new Error("Timetable header row with Date and Sections was not found");

  const header = payload.values[headerRowIndex]!;
  const dateColumn = header.findIndex((cell) => normalizeText(cell).toLowerCase() === "date");
  const sectionColumn = header.findIndex((cell) => normalizeText(cell).toLowerCase() === "sections");
  const ranges = payload.merges.map(parseCellRange);
  const items: ParsedTimetableItem[] = [];
  let activeDate: string | undefined;

  for (let rowIndex = headerRowIndex + 1; rowIndex < payload.values.length; rowIndex += 1) {
    const row = payload.values[rowIndex] ?? [];
    const dateValue = row[dateColumn] ?? "";
    if (dateValue.trim()) activeDate = parseSheetDate(dateValue);

    const section = normalizeText(row[sectionColumn] ?? "").toUpperCase();
    if (!/^(?:SECTION\s+)?C$/.test(section) || !activeDate) continue;

    const seenMerges = new Set<string>();
    for (const slot of SLOTS) {
      const range = mergedRangeAt(ranges, rowIndex, slot.column);
      let value: string;
      let coveredSlots: Slot[];

      if (range) {
        if (seenMerges.has(range.key)) continue;
        const topLeftValue = payload.values[range.startRow]?.[range.startColumn] ?? "";
        if (!topLeftValue.trim()) continue;
        coveredSlots = SLOTS.filter(
          (candidate) => candidate.column >= range.startColumn && candidate.column <= range.endColumn,
        );
        if (coveredSlots.length === 0 || coveredSlots[0]!.column !== slot.column) continue;
        seenMerges.add(range.key);
        value = topLeftValue;
      } else {
        value = row[slot.column] ?? "";
        if (!value.trim()) continue;
        coveredSlots = [slot];
      }

      const firstSlot = coveredSlots[0]!;
      const lastSlot = coveredSlots[coveredSlots.length - 1]!;
      const times = explicitTimes(value, firstSlot.start, lastSlot.end) ?? {
        start: firstSlot.start,
        end: lastSlot.end,
      };
      const parsed = parseCell(value);
      items.push({
        date: activeDate,
        startsAt: istDateTimeLocalToUtc(`${activeDate}T${times.start}`),
        endsAt: istDateTimeLocalToUtc(`${activeDate}T${times.end}`),
        ...parsed,
      });
    }
  }

  return items;
}
