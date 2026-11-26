import { useEffect, useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  istDateTimeLocalToUtc,
  istParts,
  utcToIstDateTimeLocal,
} from "@pulse/shared";
import "./taskPlan.css";
import {
  createTask,
  deleteTask,
  listTasks,
  TASK_CATEGORIES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  updateTask,
  type CreateTaskInput,
  type Task,
  type TaskCategory,
  type TaskPriority,
  type TaskStatus,
  type UpdateTaskInput,
} from "./tasks";

export interface TaskPlanProps {
  client: SupabaseClient;
  userId: string;
}

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; error: unknown }
  | { phase: "ready"; tasks: Task[] };

function formString(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

function nullableLocalInstant(data: FormData, name: string): string | null {
  const value = formString(data, name).trim();
  return value ? istDateTimeLocalToUtc(value) : null;
}

/** Build the quick-add contract from the three required form values. */
export function quickAddFieldsFromForm(data: FormData): CreateTaskInput {
  return {
    title: formString(data, "title"),
    deadline_at: istDateTimeLocalToUtc(formString(data, "deadline_at")),
    estimate_minutes: Number(formString(data, "estimate_minutes")),
  };
}

/** Build an editable task patch from the editor form; source is intentionally fixed. */
export function taskFieldsFromForm(data: FormData): UpdateTaskInput {
  return {
    title: formString(data, "title"),
    category: formString(data, "category") as TaskCategory,
    linked_course: formString(data, "linked_course").trim() || null,
    priority: formString(data, "priority") as TaskPriority,
    deadline_at: nullableLocalInstant(data, "deadline_at"),
    estimate_minutes: Number(formString(data, "estimate_minutes")),
    scheduled_start_at: nullableLocalInstant(data, "scheduled_start_at"),
    scheduled_end_at: nullableLocalInstant(data, "scheduled_end_at"),
    status: formString(data, "status") as TaskStatus,
    actual_start_at: nullableLocalInstant(data, "actual_start_at"),
    actual_end_at: nullableLocalInstant(data, "actual_end_at"),
    notes: formString(data, "notes").trim() || null,
  };
}

/** Selecting the same task again dismisses its delete confirmation. */
export function toggleDeleteConfirmation(
  currentTaskId: string | null,
  selectedTaskId: string,
): string | null {
  return currentTaskId === selectedTaskId ? null : selectedTaskId;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message;
    if (typeof message === "string") return message;
  }
  return "Something went wrong. Please try again.";
}

function formatDeadline(value: string | null): string {
  if (!value) return "No deadline";
  const instant = new Date(value);
  const parts = istParts(instant);
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const weekday = weekdays[new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()];
  return `${weekday}, ${parts.day} ${months[parts.month - 1]} · ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")} IST`;
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((left, right) => {
    const leftDeadline = left.deadline_at ? Date.parse(left.deadline_at) : Number.POSITIVE_INFINITY;
    const rightDeadline = right.deadline_at ? Date.parse(right.deadline_at) : Number.POSITIVE_INFINITY;
    return (
      leftDeadline - rightDeadline ||
      left.created_at.localeCompare(right.created_at) ||
      left.id.localeCompare(right.id)
    );
  });
}

function dateTimeInputValue(value: string | null): string {
  return value ? utcToIstDateTimeLocal(value) : "";
}

/** A manual task list and editor for the Plan tab. */
export function TaskPlan(props: TaskPlanProps) {
  // Remount on account changes so drafts, confirmation prompts, and rows never bleed across users.
  return <TaskPlanSession key={props.userId} {...props} />;
}

function TaskPlanSession({ client, userId }: TaskPlanProps) {
  const [loadState, setLoadState] = useState<LoadState>({ phase: "loading" });
  const [reloadAttempt, setReloadAttempt] = useState(0);
  const [operation, setOperation] = useState<"create" | "save" | "delete" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoadState({ phase: "loading" });
    listTasks(client, userId).then(
      (tasks) => {
        if (active) setLoadState({ phase: "ready", tasks });
      },
      (error: unknown) => {
        if (active) setLoadState({ phase: "error", error });
      },
    );
    return () => {
      active = false;
    };
  }, [client, userId, reloadAttempt]);

  const allTasks = loadState.phase === "ready" ? loadState.tasks : [];
  const tasks = allTasks.filter((task) => task.source === "Manual");
  const isLoading = loadState.phase === "loading";
  const isLoadError = loadState.phase === "error";
  const isBusy = operation !== null;

  function applyTask(updated: Task) {
    setLoadState((current) => {
      if (current.phase !== "ready") return current;
      const exists = current.tasks.some((task) => task.id === updated.id);
      const next = exists
        ? current.tasks.map((task) => (task.id === updated.id ? updated : task))
        : [...current.tasks, updated];
      return { phase: "ready", tasks: sortTasks(next) };
    });
  }

  async function handleQuickAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setActionError(null);
    setOperation("create");
    try {
      const created = await createTask(
        client,
        userId,
        quickAddFieldsFromForm(new FormData(form)),
      );
      applyTask(created);
      form.reset();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setOperation(null);
    }
  }

  async function handleEdit(event: FormEvent<HTMLFormElement>, taskId: string) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setActionError(null);
    setOperation("save");
    try {
      const updated = await updateTask(
        client,
        userId,
        taskId,
        taskFieldsFromForm(data),
      );
      if (!updated) throw new Error("This task is no longer available. Reload the list and try again.");
      applyTask(updated);
      setEditingTaskId(null);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setOperation(null);
    }
  }

  async function handleDelete(taskId: string) {
    setActionError(null);
    setOperation("delete");
    try {
      await deleteTask(client, userId, taskId);
      setLoadState((current) =>
        current.phase === "ready"
          ? { phase: "ready", tasks: current.tasks.filter((task) => task.id !== taskId) }
          : current,
      );
      setConfirmDeleteId(null);
      if (editingTaskId === taskId) setEditingTaskId(null);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setOperation(null);
    }
  }

  return (
    <main className="task-plan" aria-labelledby="task-plan-title">
      <header className="task-plan-header">
        <div>
          <p className="section-kicker">Plan</p>
          <h1 id="task-plan-title">Tasks and deadlines</h1>
          <p className="task-plan-intro">Keep the next piece of work clear and manageable.</p>
        </div>
      </header>

      <section className="task-panel task-quick-panel" aria-labelledby="quick-add-title">
        <div className="task-panel-heading">
          <div>
            <h2 id="quick-add-title">Quick add</h2>
            <p>Start with the task, its deadline, and the time you expect it to take.</p>
          </div>
        </div>
        <form className="task-quick-form" onSubmit={handleQuickAdd}>
          <label className="task-field task-field-title">
            <span>Task title</span>
            <input autoComplete="off" maxLength={240} name="title" required />
          </label>
          <label className="task-field">
            <span>Deadline</span>
            <input name="deadline_at" required type="datetime-local" />
          </label>
          <label className="task-field task-field-estimate">
            <span>Estimate</span>
            <span className="task-input-suffix">
              <input min={1} name="estimate_minutes" required type="number" defaultValue={30} />
              <span aria-hidden="true">min</span>
            </span>
          </label>
          <button className="button button-primary task-quick-submit" disabled={isBusy || isLoading || isLoadError} type="submit">
            {operation === "create" ? "Adding…" : "Add task"}
          </button>
        </form>
        <p className="task-timezone-note">Times are shown in India Standard Time (IST), regardless of your device timezone.</p>
      </section>

      {actionError ? <p className="task-error" role="alert">{actionError}</p> : null}
      {operation ? (
        <p className="task-operation-status" role="status" aria-live="polite">
          {operation === "create" ? "Adding task…" : operation === "save" ? "Saving task…" : "Deleting task…"}
        </p>
      ) : null}

      <section className="task-panel task-list-panel" aria-labelledby="task-list-title">
        <div className="task-panel-heading task-list-heading">
          <div>
            <h2 id="task-list-title">Your tasks</h2>
            <p>Sorted by deadline, with tasks without a deadline at the end.</p>
          </div>
          {!isLoading && !isLoadError ? <span className="task-count">{tasks.length}</span> : null}
        </div>

        {isLoading ? (
          <p className="task-state" role="status" aria-live="polite">Loading tasks…</p>
        ) : null}
        {isLoadError ? (
          <div className="task-state task-load-error">
            <p role="alert">Could not load tasks: {errorMessage(loadState.error)}</p>
            <button className="button button-secondary" type="button" onClick={() => setReloadAttempt((attempt) => attempt + 1)}>
              Try again
            </button>
          </div>
        ) : null}
        {!isLoading && !isLoadError && tasks.length === 0 ? (
          <p className="task-state task-empty">No tasks yet. Add one above to get started.</p>
        ) : null}
        {!isLoading && !isLoadError && tasks.length > 0 ? (
          <ol className="task-list">
            {tasks.map((task) => (
              <li className="task-list-item" key={task.id}>
                <article className="task-row">
                  <div className="task-row-main">
                    <div className="task-row-title-line">
                      <h3>{task.title}</h3>
                      <span className={`task-priority task-priority-${task.priority.toLowerCase()}`}>{task.priority}</span>
                    </div>
                    <p className="task-row-meta">
                      <span>{formatDeadline(task.deadline_at)}</span>
                      <span>{task.estimate_minutes} min estimate</span>
                      <span>{task.category}</span>
                      {task.linked_course ? <span>{task.linked_course}</span> : null}
                    </p>
                    <p className="task-row-status">{task.status}</p>
                  </div>
                  <div className="task-row-actions">
                    <button
                      className="button button-secondary"
                      disabled={isBusy}
                      type="button"
                      onClick={() => {
                        setActionError(null);
                        setEditingTaskId(editingTaskId === task.id ? null : task.id);
                        setConfirmDeleteId(null);
                      }}
                    >
                      {editingTaskId === task.id ? "Close editor" : "Edit"}
                    </button>
                    <button
                      className="button button-secondary task-delete-trigger"
                      disabled={isBusy}
                      type="button"
                      onClick={() => {
                        setActionError(null);
                        setConfirmDeleteId((current) => toggleDeleteConfirmation(current, task.id));
                        setEditingTaskId(null);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </article>

                {editingTaskId === task.id ? (
                  <TaskEditor
                    task={task}
                    saving={operation === "save"}
                    onCancel={() => setEditingTaskId(null)}
                    onSubmit={(event) => handleEdit(event, task.id)}
                  />
                ) : null}

                {confirmDeleteId === task.id ? (
                  <div className="task-delete-confirm" role="group" aria-label={`Confirm deletion of ${task.title}`}>
                    <p>Delete “{task.title}”? This cannot be undone.</p>
                    <div className="task-row-actions">
                      <button className="button button-secondary" disabled={isBusy} type="button" onClick={() => setConfirmDeleteId((current) => toggleDeleteConfirmation(current, task.id))}>
                        Cancel
                      </button>
                      <button className="button button-danger" disabled={isBusy} type="button" onClick={() => void handleDelete(task.id)}>
                        {operation === "delete" ? "Deleting…" : "Confirm delete"}
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}
      </section>
    </main>
  );
}

interface TaskEditorProps {
  task: Task;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

function TaskEditor({ task, saving, onCancel, onSubmit }: TaskEditorProps) {
  return (
    <form className="task-editor" aria-label={`Edit ${task.title}`} onSubmit={onSubmit}>
      <div className="task-editor-grid">
        <label className="task-field task-editor-wide">
          <span>Task title</span>
          <input autoComplete="off" maxLength={240} name="title" required defaultValue={task.title} />
        </label>
        <label className="task-field">
          <span>Category</span>
          <select name="category" defaultValue={task.category}>
            {TASK_CATEGORIES.map((category) => <option key={category}>{category}</option>)}
          </select>
        </label>
        <label className="task-field">
          <span>Linked course</span>
          <input autoComplete="off" maxLength={120} name="linked_course" defaultValue={task.linked_course ?? ""} />
        </label>
        <label className="task-field">
          <span>Priority</span>
          <select name="priority" defaultValue={task.priority}>
            {TASK_PRIORITIES.map((priority) => <option key={priority}>{priority}</option>)}
          </select>
        </label>
        <label className="task-field">
          <span>Deadline</span>
          <input name="deadline_at" type="datetime-local" defaultValue={dateTimeInputValue(task.deadline_at)} />
        </label>
        <label className="task-field">
          <span>Estimate in minutes</span>
          <input min={1} name="estimate_minutes" required type="number" defaultValue={task.estimate_minutes} />
        </label>
        <label className="task-field">
          <span>Scheduled block starts</span>
          <input name="scheduled_start_at" type="datetime-local" defaultValue={dateTimeInputValue(task.scheduled_start_at)} />
        </label>
        <label className="task-field">
          <span>Scheduled block ends</span>
          <input name="scheduled_end_at" type="datetime-local" defaultValue={dateTimeInputValue(task.scheduled_end_at)} />
        </label>
        <label className="task-field">
          <span>Status</span>
          <select name="status" defaultValue={task.status}>
            {TASK_STATUSES.map((status) => <option key={status}>{status}</option>)}
          </select>
        </label>
        <label className="task-field">
          <span>Actual start</span>
          <input name="actual_start_at" type="datetime-local" defaultValue={dateTimeInputValue(task.actual_start_at)} />
        </label>
        <label className="task-field">
          <span>Actual end</span>
          <input name="actual_end_at" type="datetime-local" defaultValue={dateTimeInputValue(task.actual_end_at)} />
        </label>
        <label className="task-field task-editor-wide">
          <span>Notes</span>
          <textarea maxLength={4000} name="notes" rows={3} defaultValue={task.notes ?? ""} />
        </label>
      </div>
      <p className="task-source-note">Source: <strong>Manual</strong>. Task times are entered in IST.</p>
      <div className="task-editor-actions">
        <button className="button button-primary" disabled={saving} type="submit">
          {saving ? "Saving…" : "Save changes"}
        </button>
        <button className="button button-secondary" disabled={saving} type="button" onClick={onCancel}>
          Cancel edit
        </button>
      </div>
    </form>
  );
}
