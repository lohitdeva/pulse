import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  DayPlan,
  ItemLogStatus,
  MealLogRow,
  MealName,
  MealPlace,
  PlanClass,
  mealsSummary,
  waterTotals,
} from "@pulse/shared";
import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  defaultBedtime,
  defaultWakeTime,
  hygieneChanges,
  hygieneItems,
  instantToTimeInput,
  markItemMissed,
  MISSED_REASONS,
  morningTimesToSave,
  planSummary,
  saveMiddayCheckIn,
  saveMorningCheckIn,
  saveNightCheckIn,
  setMissedReason,
  unloggedItems,
  type CheckInKind,
  type CheckInRow,
  type MissedReason,
  type MissedRow,
  type ReminderResolution,
  type UnloggedItem,
} from "./checkIns";
import { logAttendance } from "./classOverrides";
import { logItem } from "./offline/queue";
import { MealsCard, WaterCard } from "./LoggingCards";
import { createTask } from "./tasks";
import { formatTime } from "./Today";
import { Sheet } from "./ui";

export interface CheckInSheetProps {
  /** Which check-in is open; null = closed. */
  kind: CheckInKind | null;
  onClose: () => void;
  client: SupabaseClient | null;
  userId: string;
  dayKey: string;
  plan: DayPlan;
  /** The saved (or queued) row for this kind, used to prefill. */
  existing?: CheckInRow | undefined;
  habitStatuses: Record<string, ItemLogStatus>;
  water: ReturnType<typeof waterTotals>;
  meals: ReturnType<typeof mealsSummary>;
  onAddWater: (amountMl: number, isGym: boolean) => void;
  onSetMeal: (meal: MealName, place: MealPlace) => void;
  /** Hook for the T4.1 overbooking warning; nothing is shown until then. */
  planWarning?: ReactNode;
  /** Data for the night check-in's unlogged sweep. */
  night?: NightSweepData;
}

export interface NightSweepData {
  now: Date;
  classes: PlanClass[];
  itemLogs: ReadonlyArray<{ item_key: string }>;
  mealLogs: MealLogRow[];
  reminders: ReminderResolution[];
  /** Dispatcher-marked Missed items (today and yesterday) still waiting for a reason. */
  missed: MissedRow[];
  /** Re-read the missed list after a reason was saved. */
  onMissedChanged: () => void;
}

const MOOD_LABELS = ["Low", "Meh", "Okay", "Good", "Great"];

function ScaleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | undefined;
  onChange: (next: number | undefined) => void;
}) {
  return (
    <div className="checkin-field">
      <span className="checkin-label">{label}</span>
      <div className="checkin-scale" role="group" aria-label={label}>
        {MOOD_LABELS.map((text, index) => {
          const n = index + 1;
          const selected = value === n;
          return (
            <button
              key={n}
              type="button"
              className={`place-btn${selected ? " place-btn-active" : ""}`}
              aria-pressed={selected}
              aria-label={`${label} ${n} of 5, ${text}`}
              onClick={() => onChange(selected ? undefined : n)}
            >
              {n}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SheetActions({
  busy,
  onSkip,
  saveLabel = "Save",
}: {
  busy: boolean;
  onSkip: () => void;
  saveLabel?: string;
}) {
  return (
    <div className="checkin-actions">
      <button className="button button-secondary" type="button" onClick={onSkip}>
        Skip for now
      </button>
      <button className="button button-primary" type="submit" disabled={busy}>
        {busy ? "Saving…" : saveLabel}
      </button>
    </div>
  );
}

function MorningForm({
  client,
  userId,
  dayKey,
  plan,
  existing,
  habitStatuses,
  planWarning,
  onClose,
}: CheckInSheetProps & { onClose: () => void }) {
  const items = useMemo(() => hygieneItems(dayKey), [dayKey]);
  const saved = existing?.payload ?? {};
  const [bedtime, setBedtime] = useState(
    instantToTimeInput(typeof saved.bedtime === "string" ? saved.bedtime : defaultBedtime(dayKey)),
  );
  const [wake, setWake] = useState(
    instantToTimeInput(typeof saved.wakeTime === "string" ? saved.wakeTime : defaultWakeTime(dayKey)),
  );
  // The times shown start as suggestions; only an edit or a Confirm tap makes them data.
  const [bedtimeTouched, setBedtimeTouched] = useState(typeof saved.bedtime === "string");
  const [wakeTouched, setWakeTouched] = useState(typeof saved.wakeTime === "string");
  const [mood, setMood] = useState<number | undefined>(
    typeof saved.mood === "number" ? saved.mood : undefined,
  );
  const [energy, setEnergy] = useState<number | undefined>(
    typeof saved.energy === "number" ? saved.energy : undefined,
  );
  const [draft, setDraft] = useState<Record<string, "done" | "skipped" | undefined>>(() =>
    Object.fromEntries(
      items.map((item) => {
        const status = habitStatuses[item.itemKey];
        return [item.itemKey, status === "done" || status === "skipped" ? status : undefined];
      }),
    ),
  );
  const [busy, setBusy] = useState(false);
  const bedId = useId();
  const wakeId = useId();
  const today = useMemo(() => planSummary(plan), [plan]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await saveMorningCheckIn(
        userId,
        dayKey,
        {
          ...morningTimesToSave(dayKey, { bedtime, wake, bedtimeTouched, wakeTouched }),
          mood,
          energy,
        },
        hygieneChanges(draft, habitStatuses),
        client,
      );
      onClose();
    } catch {
      setBusy(false);
    }
  };

  return (
    <form className="checkin-form" onSubmit={(e) => void submit(e)}>
      <div className="checkin-times">
        <div className="checkin-field">
          <label className="checkin-label" htmlFor={bedId}>
            Bedtime
          </label>
          <input
            id={bedId}
            className="checkin-input"
            type="time"
            value={bedtime}
            onChange={(e) => {
              setBedtime(e.target.value);
              setBedtimeTouched(true);
            }}
          />
          {!bedtimeTouched ? (
            <button className="button button-secondary checkin-confirm" type="button" onClick={() => setBedtimeTouched(true)}>
              Confirm
            </button>
          ) : null}
        </div>
        <div className="checkin-field">
          <label className="checkin-label" htmlFor={wakeId}>
            Woke up
          </label>
          <input
            id={wakeId}
            className="checkin-input"
            type="time"
            value={wake}
            onChange={(e) => {
              setWake(e.target.value);
              setWakeTouched(true);
            }}
          />
          {!wakeTouched ? (
            <button className="button button-secondary checkin-confirm" type="button" onClick={() => setWakeTouched(true)}>
              Confirm
            </button>
          ) : null}
        </div>
      </div>
      <p className="checkin-hint">
        These times are suggestions. Edit one or tap Confirm to log it; otherwise it is not saved.
      </p>

      <ScaleRow label="Mood" value={mood} onChange={setMood} />
      <ScaleRow label="Energy" value={energy} onChange={setEnergy} />

      <div className="checkin-field">
        <span className="checkin-label">Morning routine</span>
        <ul className="checkin-hygiene">
          {items.map((item) => {
            const status = draft[item.itemKey];
            return (
              <li key={item.itemKey} className="checkin-hygiene-row">
                <span>{item.label}</span>
                <div className="checkin-hygiene-actions" role="group" aria-label={item.label}>
                  {(["done", "skipped"] as const).map((next) => (
                    <button
                      key={next}
                      type="button"
                      className={`place-btn${status === next ? " place-btn-active" : ""}`}
                      aria-pressed={status === next}
                      onClick={() =>
                        setDraft((d) => ({ ...d, [item.itemKey]: status === next ? undefined : next }))
                      }
                    >
                      {next === "done" ? "Done" : "Skip"}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="checkin-field">
        <span className="checkin-label">Today's plan</span>
        {today.length > 0 ? (
          <ul className="checkin-plan">
            {today.map((row) => (
              <li key={row.key}>
                <span className="checkin-plan-time">{row.startAt ? formatTime(row.startAt) : "—"}</span>
                <span>{row.title}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="checkin-hint">Nothing fixed today.</p>
        )}
        {planWarning}
      </div>

      <SheetActions busy={busy} onSkip={onClose} />
    </form>
  );
}

function MiddayForm({
  client,
  userId,
  dayKey,
  existing,
  water,
  meals,
  onAddWater,
  onSetMeal,
  onClose,
}: CheckInSheetProps & { onClose: () => void }) {
  const saved = existing?.payload ?? {};
  const [mood, setMood] = useState<number | undefined>(
    typeof saved.mood === "number" ? saved.mood : undefined,
  );
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string[]>([]);
  const [taskError, setTaskError] = useState("");
  const taskId = useId();

  const addTask = async () => {
    const text = title.trim();
    if (!text || !client) return;
    setAdding(true);
    setTaskError("");
    try {
      await createTask(client, userId, { title: text });
      setAdded((list) => [...list, text]);
      setTitle("");
    } catch {
      // Tasks are not in the offline queue yet, so adding needs a connection.
      setTaskError("Couldn't add the task. Check your connection and try again.");
    } finally {
      setAdding(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await saveMiddayCheckIn(userId, dayKey, { mood }, client);
      onClose();
    } catch {
      setBusy(false);
    }
  };

  return (
    <form className="checkin-form" onSubmit={(e) => void submit(e)}>
      <MealsCard summary={meals} onSet={onSetMeal} />
      <WaterCard totals={water} onAdd={onAddWater} />
      <ScaleRow label="Mood" value={mood} onChange={setMood} />

      <div className="checkin-field">
        <label className="checkin-label" htmlFor={taskId}>
          Quick add a task
        </label>
        <div className="checkin-task-row">
          <input
            id={taskId}
            className="checkin-input"
            autoComplete="off"
            maxLength={240}
            placeholder="Task title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void addTask();
              }
            }}
          />
          <button
            className="button button-secondary"
            type="button"
            disabled={adding || !title.trim() || !client}
            onClick={() => void addTask()}
          >
            Add
          </button>
        </div>
        {added.length > 0 ? (
          <ul className="checkin-added" aria-label="Tasks added">
            {added.map((text, i) => (
              <li key={`${i}-${text}`}>Added: {text}</li>
            ))}
          </ul>
        ) : null}
        {taskError ? <p role="alert" className="checkin-error">{taskError}</p> : null}
      </div>

      <SheetActions busy={busy} onSkip={onClose} />
    </form>
  );
}

const SAVE_FAILED = "Couldn't save that. Check your connection and try again.";

type SweepMode = "missed" | "meal";

function ReasonChips({
  label,
  onPick,
}: {
  label: string;
  onPick: (reason: MissedReason) => void;
}) {
  return (
    <div className="sweep-chips" role="group" aria-label={`Why was ${label} missed?`}>
      {MISSED_REASONS.map((r) => (
        <button key={r.value} type="button" className="place-btn sweep-chip" onClick={() => onPick(r.value)}>
          {r.label}
        </button>
      ))}
    </div>
  );
}

const MEAL_PLACES: ReadonlyArray<{ place: MealPlace; label: string }> = [
  { place: "mess", label: "Mess" },
  { place: "outside", label: "Outside" },
  { place: "ordered_in", label: "Ordered in" },
];

function SweepRow({
  item,
  outcome,
  onDone,
  onMeal,
  onMissed,
}: {
  item: UnloggedItem;
  outcome: string | undefined;
  onDone: () => void;
  onMeal: (place: MealPlace) => void;
  onMissed: (reason: MissedReason) => void;
}) {
  const [mode, setMode] = useState<SweepMode | null>(null);
  return (
    <li className="sweep-row">
      <div className="sweep-head">
        <span className="sweep-title">{item.title}</span>
        <span className="checkin-plan-time">{formatTime(item.startAt)}</span>
      </div>
      {outcome ? (
        <p className="sweep-outcome" role="status">
          {outcome}
        </p>
      ) : (
        <>
          <div className="sweep-actions" role="group" aria-label={item.title}>
            <button
              type="button"
              className={`place-btn${mode === "meal" ? " place-btn-active" : ""}`}
              aria-pressed={mode === "meal"}
              onClick={() => (item.meal ? setMode(mode === "meal" ? null : "meal") : onDone())}
            >
              Done
            </button>
            <button
              type="button"
              className={`place-btn${mode === "missed" ? " place-btn-active" : ""}`}
              aria-pressed={mode === "missed"}
              onClick={() => setMode(mode === "missed" ? null : "missed")}
            >
              Missed
            </button>
          </div>
          {mode === "meal" ? (
            <div className="sweep-chips" role="group" aria-label={`Where was ${item.title}?`}>
              {MEAL_PLACES.map((p) => (
                <button key={p.place} type="button" className="place-btn sweep-chip" onClick={() => onMeal(p.place)}>
                  {p.label}
                </button>
              ))}
            </div>
          ) : null}
          {mode === "missed" ? <ReasonChips label={item.title} onPick={onMissed} /> : null}
        </>
      )}
    </li>
  );
}

function NightForm({
  client,
  userId,
  dayKey,
  plan,
  existing,
  water,
  onAddWater,
  onSetMeal,
  night,
  onClose,
}: CheckInSheetProps & { onClose: () => void }) {
  const saved = existing?.payload ?? {};
  const savedReflection =
    saved.reflection && typeof saved.reflection === "object"
      ? (saved.reflection as Record<string, unknown>)
      : {};
  const text = (key: string) => (typeof savedReflection[key] === "string" ? (savedReflection[key] as string) : "");
  const [wentWell, setWentWell] = useState(text("wentWell"));
  const [didntGo, setDidntGo] = useState(text("didntGo"));
  const [tomorrow, setTomorrow] = useState(text("tomorrow"));
  const [mood, setMood] = useState<number | undefined>(
    typeof saved.mood === "number" ? saved.mood : undefined,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resolved, setResolved] = useState<Record<string, { item: UnloggedItem; label: string }>>({});
  const [reasoned, setReasoned] = useState<Record<string, { row: MissedRow; label: string }>>({});
  const ids = [useId(), useId(), useId()] as const;

  const live = useMemo(
    () =>
      night
        ? unloggedItems(
            plan,
            night.classes,
            { itemLogs: night.itemLogs, mealLogs: night.mealLogs },
            night.reminders,
            night.missed,
            night.now,
          )
        : [],
    [plan, night],
  );
  // Rows stay on screen with their outcome after being logged, so a tap never makes them jump away.
  const rows = useMemo(() => {
    const keys = new Set(live.map((i) => i.itemKey));
    const extra = Object.values(resolved)
      .map((r) => r.item)
      .filter((i) => !keys.has(i.itemKey));
    return [...live, ...extra].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  }, [live, resolved]);
  const missedRows = useMemo(() => {
    const rowKey = (m: MissedRow) => `${m.day_key}|${m.item_key}`;
    const keys = new Set((night?.missed ?? []).map(rowKey));
    const extra = Object.entries(reasoned)
      .filter(([k]) => !keys.has(k))
      .map(([, r]) => r.row);
    return [...(night?.missed ?? []), ...extra];
  }, [night?.missed, reasoned]);

  const guard = async (fn: () => Promise<void>) => {
    setError("");
    try {
      await fn();
    } catch {
      setError(SAVE_FAILED);
    }
  };

  const finish = (item: UnloggedItem, label: string) =>
    setResolved((r) => ({ ...r, [item.itemKey]: { item, label } }));

  const markDone = (item: UnloggedItem) =>
    guard(async () => {
      if (item.kind === "class" && item.classId) {
        await logAttendance(userId, item.classId, "attended", item.startAt, client);
      } else {
        await logItem(userId, dayKey, item.itemKey, "done", client);
      }
      finish(item, "Done");
    });

  const markMeal = (item: UnloggedItem, place: MealPlace) => {
    if (!item.meal) return;
    onSetMeal(item.meal, place);
    finish(item, "Done");
  };

  const markMissed = (item: UnloggedItem, reason: MissedReason) =>
    guard(async () => {
      await markItemMissed(userId, dayKey, item, reason, client);
      finish(item, `Missed: ${reasonLabel(reason)}`);
    });

  const giveReason = (row: MissedRow, reason: MissedReason) =>
    guard(async () => {
      if (!client || !(await setMissedReason(client, userId, row, reason))) {
        throw new Error("reason not saved");
      }
      setReasoned((r) => ({
        ...r,
        [`${row.day_key}|${row.item_key}`]: { row, label: reasonLabel(reason) },
      }));
      night?.onMissedChanged();
    });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await saveNightCheckIn(userId, dayKey, { wentWell, didntGo, tomorrow, mood }, client);
      onClose();
    } catch {
      setBusy(false);
    }
  };

  const prompts = [
    { id: ids[0], label: "What went well?", value: wentWell, set: setWentWell },
    { id: ids[1], label: "What didn't go to plan?", value: didntGo, set: setDidntGo },
    { id: ids[2], label: "What is the one thing for tomorrow?", value: tomorrow, set: setTomorrow },
  ];

  return (
    <form className="checkin-form" onSubmit={(e) => void submit(e)}>
      {missedRows.length > 0 ? (
        <div className="checkin-field">
          <span className="checkin-label">Marked Missed. What happened?</span>
          <ul className="sweep-list">
            {missedRows.map((row) => {
              const done = reasoned[`${row.day_key}|${row.item_key}`];
              return (
                <li key={`${row.day_key}|${row.item_key}`} className="sweep-row">
                  <div className="sweep-head">
                    <span className="sweep-title">{row.title}</span>
                    {row.day_key !== dayKey ? <span className="checkin-plan-time">Yesterday</span> : null}
                  </div>
                  {done ? (
                    <p className="sweep-outcome" role="status">
                      Missed: {done.label}
                    </p>
                  ) : (
                    <ReasonChips label={row.title} onPick={(reason) => void giveReason(row, reason)} />
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div className="checkin-field">
        <span className="checkin-label">Still unlogged today</span>
        {rows.length > 0 ? (
          <ul className="sweep-list">
            {rows.map((item) => (
              <SweepRow
                key={item.itemKey}
                item={item}
                outcome={resolved[item.itemKey]?.label}
                onDone={() => void markDone(item)}
                onMeal={(place) => markMeal(item, place)}
                onMissed={(reason) => void markMissed(item, reason)}
              />
            ))}
          </ul>
        ) : (
          <p className="checkin-hint">Nothing left unlogged.</p>
        )}
      </div>
      {error ? <p role="alert" className="checkin-error">{error}</p> : null}

      <WaterCard totals={water} onAdd={onAddWater} />
      <ScaleRow label="Mood" value={mood} onChange={setMood} />

      {prompts.map((p) => (
        <div className="checkin-field" key={p.id}>
          <label className="checkin-label" htmlFor={p.id}>
            {p.label}
          </label>
          <textarea
            id={p.id}
            className="checkin-input checkin-textarea"
            rows={2}
            maxLength={1000}
            value={p.value}
            onChange={(e) => p.set(e.target.value)}
          />
        </div>
      ))}

      <SheetActions busy={busy} onSkip={onClose} />
    </form>
  );
}

function reasonLabel(value: MissedReason): string {
  return MISSED_REASONS.find((r) => r.value === value)?.label ?? "Other";
}

const TITLES: Record<CheckInKind, string> = {
  morning: "Morning check-in",
  midday: "Midday check-in",
  night: "Night check-in",
};

export function CheckInSheet(props: CheckInSheetProps) {
  const { kind, onClose } = props;
  return (
    <Sheet
      open={kind !== null}
      onClose={onClose}
      title={TITLES[kind ?? "morning"]}
      description="Everything is optional. Skip what you don't need."
    >
      {kind === "morning" ? <MorningForm {...props} /> : null}
      {kind === "midday" ? <MiddayForm {...props} /> : null}
      {kind === "night" ? <NightForm {...props} /> : null}
    </Sheet>
  );
}
