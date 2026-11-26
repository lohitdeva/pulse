/**
 * Pulse day-structure templates and facility hours (PRD section 4).
 * Pure constants, no I/O. Times are IST "HH:MM". Blocks that run past midnight
 * use e.g. "00:30"; blockInstants() maps hours before 04:00 to the next calendar day.
 */

export type BlockType =
  | "anchor"
  | "habit"
  | "habit_checklist"
  | "habit_nudge"
  | "must_do"
  | "check_in"
  | "buffer"
  | "fixed";

export interface TemplateBlock {
  sortOrder: number;
  startHHMM: string | null;
  endHHMM: string | null;
  blockType: BlockType;
  title: string;
  note?: string;
  meta?: Record<string, unknown>;
}

export interface DayTemplate {
  key: "weekday" | "weekend";
  name: string;
  blocks: TemplateBlock[];
}

type BlockSpec = Omit<TemplateBlock, "sortOrder">;

function build(
  key: DayTemplate["key"],
  name: string,
  specs: BlockSpec[],
): DayTemplate {
  return {
    key,
    name,
    blocks: specs.map((spec, index) => ({ ...spec, sortOrder: index + 1 })),
  };
}

const WEEKDAY_SPECS: BlockSpec[] = [
  {
    startHHMM: "07:00",
    endHHMM: null,
    blockType: "anchor",
    title: "Wake up",
    note: "his own alarms; no app reminder",
  },
  {
    startHHMM: "07:00",
    endHHMM: "07:30",
    blockType: "habit_checklist",
    title: "Brush and freshen up",
  },
  {
    startHHMM: "07:30",
    endHHMM: "08:00",
    blockType: "habit",
    title: "Walk (auto-logged from Strava)",
  },
  {
    startHHMM: "08:00",
    endHHMM: "08:45",
    blockType: "habit_checklist",
    title: "Shower and get ready",
    note: "ready by 8:45 at the latest",
  },
  {
    startHHMM: "08:40",
    endHHMM: null,
    blockType: "check_in",
    title: "Morning check-in: sleep, mood, today's plan",
  },
  {
    startHHMM: "08:45",
    endHHMM: "09:20",
    blockType: "must_do",
    title: "Breakfast at the mess (read Inshorts; Mint/WSJ if time)",
  },
  {
    startHHMM: null,
    endHHMM: null,
    blockType: "habit",
    title:
      "News minutes left (Inshorts 15, Mint 30, WSJ 30 total), earliest free slots, split if needed",
    meta: { newsMinutes: { inshorts: 15, mint: 30, wsj: 30 } },
  },
  {
    startHHMM: "09:30",
    endHHMM: "17:15",
    blockType: "must_do",
    title: "Classes from the timetable; free slots → study/reading/tasks",
  },
  {
    startHHMM: "13:00",
    endHHMM: null,
    blockType: "must_do",
    title: "Lunch",
    note: "mess 1:00–3:00; class break 12:45–2:00",
  },
  {
    startHHMM: "13:40",
    endHHMM: null,
    blockType: "check_in",
    title: "Midday check-in: meals so far, water, mood",
  },
  {
    startHHMM: "17:30",
    endHHMM: null,
    blockType: "must_do",
    title: "Snacks",
    note: "mess 5:30–6:30",
  },
  {
    startHHMM: "18:00",
    endHHMM: null,
    blockType: "habit_nudge",
    title: "Revision: 15 min for each subject held today",
    note: "15 min per subject held that day",
  },
  {
    startHHMM: null,
    endHHMM: "19:30",
    blockType: "habit_nudge",
    title: "Study block 1",
    note: "after revision until gym",
  },
  {
    startHHMM: "19:30",
    endHHMM: "20:45",
    blockType: "must_do",
    title: "Gym: weigh-in, workout, cardio, abs",
    note: "gym open 7:30–10:00 PM",
  },
  {
    startHHMM: "20:45",
    endHHMM: "21:00",
    blockType: "buffer",
    title: "Freshen up after the gym",
  },
  {
    startHHMM: "21:00",
    endHHMM: "21:30",
    blockType: "must_do",
    title: "Dinner",
    note: "mess 8:00–10:30",
  },
  {
    startHHMM: "21:30",
    endHHMM: "22:30",
    blockType: "habit_nudge",
    title: "Study block 2: suggested subject or priority task",
  },
  {
    startHHMM: "22:30",
    endHHMM: "00:30",
    blockType: "fixed",
    title: "Personal call",
  },
  {
    startHHMM: "00:30",
    endHHMM: "01:00",
    blockType: "check_in",
    title: "Wind-down: night check-in, then book reading",
  },
  {
    startHHMM: "01:00",
    endHHMM: null,
    blockType: "must_do",
    title: "Lights out",
    note: "6 h sleep target",
  },
];

/** Weekend: same anchors, shorter study blocks (PRD section 4). */
const WEEKEND_SPECS: BlockSpec[] = WEEKDAY_SPECS.map((spec) => {
  if (spec.title === "Study block 1")
    return {
      ...spec,
      title: "Study block 1 (weekend)",
      startHHMM: "18:30",
      endHHMM: "19:15",
    };
  if (spec.title.startsWith("Study block 2"))
    return {
      ...spec,
      title: "Study block 2 (weekend)",
      startHHMM: "21:30",
      endHHMM: "22:15",
    };
  return { ...spec };
});

export const WEEKDAY_TEMPLATE: DayTemplate = build(
  "weekday",
  "Weekday",
  WEEKDAY_SPECS,
);
export const WEEKEND_TEMPLATE: DayTemplate = build(
  "weekend",
  "Weekend",
  WEEKEND_SPECS,
);

export const DEFAULT_TEMPLATES: readonly DayTemplate[] = [
  WEEKDAY_TEMPLATE,
  WEEKEND_TEMPLATE,
];

export interface FacilityHours {
  mess: {
    breakfast: [string, string];
    lunch: [string, string];
    snacks: [string, string];
    dinner: [string, string];
  };
  gym: Array<[string, string]>;
}

export const DEFAULT_FACILITY_HOURS: FacilityHours = {
  mess: {
    breakfast: ["08:30", "10:30"],
    lunch: ["13:00", "15:00"],
    snacks: ["17:30", "18:30"],
    dinner: ["20:00", "22:30"],
  },
  gym: [
    ["07:30", "14:30"],
    ["19:30", "22:00"],
  ],
};
