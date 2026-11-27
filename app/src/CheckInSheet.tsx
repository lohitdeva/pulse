import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  DayPlan,
  ItemLogStatus,
  MealName,
  MealPlace,
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
  planSummary,
  saveMiddayCheckIn,
  saveMorningCheckIn,
  timeInputToInstant,
  type CheckInRow,
} from "./checkIns";
import { MealsCard, WaterCard } from "./LoggingCards";
import { createTask } from "./tasks";
import { formatTime } from "./Today";
import { Sheet } from "./ui";

export interface CheckInSheetProps {
  /** Which check-in is open; null = closed. */
  kind: "morning" | "midday" | null;
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
          bedtime: timeInputToInstant(dayKey, bedtime, "bedtime"),
          wakeTime: timeInputToInstant(dayKey, wake, "wake"),
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
          <input id={bedId} className="checkin-input" type="time" value={bedtime} onChange={(e) => setBedtime(e.target.value)} />
        </div>
        <div className="checkin-field">
          <label className="checkin-label" htmlFor={wakeId}>
            Woke up
          </label>
          <input id={wakeId} className="checkin-input" type="time" value={wake} onChange={(e) => setWake(e.target.value)} />
        </div>
      </div>
      <p className="checkin-hint">Clear a time to skip it.</p>

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

export function CheckInSheet(props: CheckInSheetProps) {
  const { kind, onClose } = props;
  return (
    <Sheet
      open={kind !== null}
      onClose={onClose}
      title={kind === "midday" ? "Midday check-in" : "Morning check-in"}
      description="Everything is optional. Skip what you don't need."
    >
      {kind === "morning" ? <MorningForm {...props} /> : null}
      {kind === "midday" ? <MiddayForm {...props} /> : null}
    </Sheet>
  );
}
