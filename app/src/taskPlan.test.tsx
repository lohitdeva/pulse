import type { SupabaseClient } from "@supabase/supabase-js";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  quickAddFieldsFromForm,
  TaskPlan,
  taskFieldsFromForm,
  toggleDeleteConfirmation,
} from "./TaskPlan";
import type { Task } from "./tasks";

const task: Task = {
  id: "task-1",
  user_id: "user-1",
  title: "Submit report",
  category: "Course",
  linked_course: "OM-I",
  priority: "P1",
  deadline_at: "2026-11-27T18:30:00.000Z",
  estimate_minutes: 90,
  scheduled_start_at: "2026-11-26T03:30:00.000Z",
  scheduled_end_at: "2026-11-26T05:00:00.000Z",
  status: "Scheduled",
  actual_start_at: null,
  actual_end_at: null,
  source: "Manual",
  notes: "Draft is ready",
  created_at: "2026-11-26T10:00:00.000Z",
  updated_at: "2026-11-26T10:00:00.000Z",
};

function formData(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

describe("task plan", () => {
  it("shows an accessible loading state and the IST quick-add form", () => {
    const html = renderToStaticMarkup(
      <TaskPlan client={{} as SupabaseClient} userId="user-1" />,
    );

    expect(html).toContain("Loading tasks");
    expect(html).toContain('aria-labelledby="task-plan-title"');
    expect(html).toContain("Quick add");
    expect(html).toContain('name="deadline_at"');
    expect(html).toContain('name="estimate_minutes"');
    expect(html).toContain("Times are shown in India Standard Time (IST)");
  });

  it("builds quick-add input from title, deadline and estimate", () => {
    expect(
      quickAddFieldsFromForm(
        formData({
          title: "Submit report",
          deadline_at: "2026-11-28T00:00",
          estimate_minutes: "90",
        }),
      ),
    ).toEqual({
      title: "Submit report",
      deadline_at: "2026-11-27T18:30:00.000Z",
      estimate_minutes: 90,
    });
  });

  it("reads all editable task fields from the editor and keeps source fixed", () => {
    const update = taskFieldsFromForm(
      formData({
        title: task.title,
        category: task.category,
        linked_course: task.linked_course ?? "",
        priority: task.priority,
        deadline_at: "2026-11-28T00:00",
        estimate_minutes: "120",
        scheduled_start_at: "2026-11-26T09:00",
        scheduled_end_at: "2026-11-26T10:30",
        status: "In progress",
        actual_start_at: "2026-11-26T09:05",
        actual_end_at: "",
        notes: task.notes ?? "",
        source: "Calendar",
      }),
    );

    expect(update).toEqual({
      title: "Submit report",
      category: "Course",
      linked_course: "OM-I",
      priority: "P1",
      deadline_at: "2026-11-27T18:30:00.000Z",
      estimate_minutes: 120,
      scheduled_start_at: "2026-11-26T03:30:00.000Z",
      scheduled_end_at: "2026-11-26T05:00:00.000Z",
      status: "In progress",
      actual_start_at: "2026-11-26T03:35:00.000Z",
      actual_end_at: null,
      notes: "Draft is ready",
    });
    expect(update).not.toHaveProperty("source");
  });

  it("opens a delete confirmation and cancels it when the same task is selected", () => {
    const prompt = toggleDeleteConfirmation(null, "task-1");
    expect(prompt).toBe("task-1");
    expect(toggleDeleteConfirmation(prompt, "task-1")).toBeNull();
  });
});
