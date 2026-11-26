import type { SupabaseClient } from "@supabase/supabase-js";

export const TASK_CATEGORIES = [
  "Course",
  "Live project",
  "Placement",
  "Personal",
] as const;
export const TASK_PRIORITIES = ["P1", "P2", "P3"] as const;
export const TASK_STATUSES = [
  "To do",
  "Scheduled",
  "In progress",
  "Done",
  "Missed",
  "Dropped",
] as const;
export const TASK_SOURCES = ["Manual", "Gmail", "Calendar"] as const;

export type TaskCategory = (typeof TASK_CATEGORIES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskSource = (typeof TASK_SOURCES)[number];

/** A persisted task row. All *_at values are UTC ISO instants. */
export type Task = {
  id: string;
  user_id: string;
  title: string;
  category: TaskCategory;
  /** Course code or name until the courses table is available. */
  linked_course: string | null;
  priority: TaskPriority;
  deadline_at: string | null;
  estimate_minutes: number;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  status: TaskStatus;
  actual_start_at: string | null;
  actual_end_at: string | null;
  source: TaskSource;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type TaskEditableFields = Omit<
  Task,
  "id" | "user_id" | "created_at" | "updated_at"
>;

/** Quick-add fields may be supplied; unspecified fields use the storage defaults. */
export type CreateTaskInput = Pick<TaskEditableFields, "title"> &
  Partial<Omit<TaskEditableFields, "title">>;

export type UpdateTaskInput = Partial<TaskEditableFields>;

const EDITABLE_FIELDS = new Set<keyof TaskEditableFields>([
  "title",
  "category",
  "linked_course",
  "priority",
  "deadline_at",
  "estimate_minutes",
  "scheduled_start_at",
  "scheduled_end_at",
  "status",
  "actual_start_at",
  "actual_end_at",
  "source",
  "notes",
]);

function isOneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

function normalizeInstant(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("Task timestamps must be strings or null");

  const timestamp = value.trim();
  if (!/(?:z|[+-]\d{2}:\d{2})$/i.test(timestamp)) {
    throw new Error("Task timestamps must include a timezone");
  }

  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.valueOf())) throw new Error("Invalid task timestamp");
  return parsed.toISOString();
}

function normalizeNullableText(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string or null`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function assertEditableKeys(input: object): void {
  for (const key of Object.keys(input)) {
    if (key === "user_id") {
      throw new Error("Task updates cannot change user ownership");
    }
    if (!EDITABLE_FIELDS.has(key as keyof TaskEditableFields)) {
      throw new Error(`Invalid task field: ${key}`);
    }
  }
}

function normalizeFields(
  input: Partial<TaskEditableFields>,
): Partial<TaskEditableFields> {
  assertEditableKeys(input);
  const normalized: Partial<TaskEditableFields> = {};

  if ("title" in input) {
    if (typeof input.title !== "string" || input.title.trim().length === 0) {
      throw new Error("Task title is required");
    }
    normalized.title = input.title.trim();
  }
  if ("category" in input && input.category !== undefined) {
    if (!isOneOf(input.category, TASK_CATEGORIES)) {
      throw new Error("Invalid task category");
    }
    normalized.category = input.category;
  }
  if ("linked_course" in input && input.linked_course !== undefined) {
    normalized.linked_course = normalizeNullableText(
      input.linked_course,
      "Linked course",
    );
  }
  if ("priority" in input && input.priority !== undefined) {
    if (!isOneOf(input.priority, TASK_PRIORITIES)) {
      throw new Error("Invalid task priority");
    }
    normalized.priority = input.priority;
  }
  for (const field of [
    "deadline_at",
    "scheduled_start_at",
    "scheduled_end_at",
    "actual_start_at",
    "actual_end_at",
  ] as const) {
    if (field in input && input[field] !== undefined) {
      normalized[field] = normalizeInstant(input[field]);
    }
  }
  if ("estimate_minutes" in input && input.estimate_minutes !== undefined) {
    if (!Number.isSafeInteger(input.estimate_minutes) || input.estimate_minutes <= 0) {
      throw new Error("Estimate must be a positive whole number");
    }
    normalized.estimate_minutes = input.estimate_minutes;
  }
  if ("status" in input && input.status !== undefined) {
    if (!isOneOf(input.status, TASK_STATUSES)) {
      throw new Error("Invalid task status");
    }
    normalized.status = input.status;
  }
  if ("source" in input && input.source !== undefined) {
    if (!isOneOf(input.source, TASK_SOURCES)) {
      throw new Error("Invalid task source");
    }
    normalized.source = input.source;
  }
  if ("notes" in input && input.notes !== undefined) {
    normalized.notes = normalizeNullableText(input.notes, "Notes");
  }

  return normalized;
}

function validateTaskTiming(fields: Partial<TaskEditableFields>): void {
  const hasScheduledStart = fields.scheduled_start_at != null;
  const hasScheduledEnd = fields.scheduled_end_at != null;
  if (hasScheduledStart !== hasScheduledEnd) {
    throw new Error("Scheduled block needs both start and end times");
  }
  if (
    hasScheduledStart &&
    hasScheduledEnd &&
    Date.parse(fields.scheduled_start_at!) >= Date.parse(fields.scheduled_end_at!)
  ) {
    throw new Error("Scheduled block end must follow its start");
  }
  if (
    fields.actual_start_at != null &&
    fields.actual_end_at != null &&
    Date.parse(fields.actual_start_at) > Date.parse(fields.actual_end_at)
  ) {
    throw new Error("Actual end must be at or after actual start");
  }
}

export async function listTasks(
  client: SupabaseClient,
  userId: string,
): Promise<Task[]> {
  const { data, error } = await client
    .from("tasks")
    .select("*")
    .eq("user_id", userId)
    .order("deadline_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as Task[];
}

export async function createTask(
  client: SupabaseClient,
  userId: string,
  input: CreateTaskInput,
): Promise<Task> {
  const fields = normalizeFields(input);
  if (typeof fields.title !== "string") throw new Error("Task title is required");
  const record: Omit<Task, "id" | "created_at" | "updated_at"> = {
    user_id: userId,
    title: fields.title,
    category: fields.category ?? "Personal",
    linked_course: fields.linked_course ?? null,
    priority: fields.priority ?? "P2",
    deadline_at: fields.deadline_at ?? null,
    estimate_minutes: fields.estimate_minutes ?? 30,
    scheduled_start_at: fields.scheduled_start_at ?? null,
    scheduled_end_at: fields.scheduled_end_at ?? null,
    status: fields.status ?? "To do",
    actual_start_at: fields.actual_start_at ?? null,
    actual_end_at: fields.actual_end_at ?? null,
    source: fields.source ?? "Manual",
    notes: fields.notes ?? null,
  };
  validateTaskTiming(record);

  const { data, error } = await client
    .from("tasks")
    .insert(record)
    .select("*")
    .single();
  if (error) throw error;
  return data as unknown as Task;
}

export async function updateTask(
  client: SupabaseClient,
  userId: string,
  taskId: string,
  input: UpdateTaskInput,
): Promise<Task | null> {
  const fields = normalizeFields(input);
  if (Object.keys(fields).length === 0) {
    throw new Error("Task update must include at least one field");
  }
  validateTaskTiming(fields);

  const { data, error } = await client
    .from("tasks")
    .update(fields)
    .eq("user_id", userId)
    .eq("id", taskId)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as Task | null) ?? null;
}

export async function deleteTask(
  client: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<void> {
  const { error } = await client
    .from("tasks")
    .delete()
    .eq("user_id", userId)
    .eq("id", taskId);
  if (error) throw error;
}
