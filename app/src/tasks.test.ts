import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  createTask,
  deleteTask,
  listTasks,
  updateTask,
  type Task,
} from "./tasks";

type QueryResult = { data: unknown; error: unknown };
type QueryBuilder = PromiseLike<QueryResult> & {
  delete: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

function fakeClient(response: QueryResult = { data: null, error: null }) {
  const builder: QueryBuilder = {
    delete: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    insert: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => response),
    order: vi.fn(() => builder),
    select: vi.fn(() => builder),
    single: vi.fn(async () => response),
    update: vi.fn(() => builder),
    then: (onfulfilled, onrejected) =>
      Promise.resolve(response).then(onfulfilled, onrejected),
  };
  const from = vi.fn(() => builder);
  return {
    client: { from } as unknown as SupabaseClient,
    from,
    builder,
  };
}

const task: Task = {
  id: "task-1",
  user_id: "user-1",
  title: "Submit report",
  category: "Course",
  linked_course: "OM-I",
  priority: "P1",
  deadline_at: "2026-11-27T18:30:00.000Z",
  estimate_minutes: 90,
  scheduled_start_at: null,
  scheduled_end_at: null,
  status: "To do",
  actual_start_at: null,
  actual_end_at: null,
  source: "Manual",
  notes: null,
  created_at: "2026-11-26T10:00:00.000Z",
  updated_at: "2026-11-26T10:00:00.000Z",
};

describe("manual task storage", () => {
  it("lists the signed-in user's tasks in stable deadline order", async () => {
    const { client, from, builder } = fakeClient({ data: [task], error: null });

    await expect(listTasks(client, "user-1")).resolves.toEqual([task]);

    expect(from).toHaveBeenCalledWith("tasks");
    expect(builder.select).toHaveBeenCalledWith("*");
    expect(builder.eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(builder.order.mock.calls).toEqual([
      ["deadline_at", { ascending: true, nullsFirst: false }],
      ["created_at", { ascending: true }],
      ["id", { ascending: true }],
    ]);
  });

  it("creates a task with user scope, defaults, and UTC normalized timestamps", async () => {
    const { client, from, builder } = fakeClient({ data: task, error: null });

    await createTask(client, "user-1", {
      title: "  Submit report  ",
      category: "Course",
      linked_course: "OM-I",
      priority: "P1",
      deadline_at: "2026-11-28T00:00:00+05:30",
      estimate_minutes: 90,
      notes: "Draft is ready",
    });

    expect(from).toHaveBeenCalledWith("tasks");
    expect(builder.insert).toHaveBeenCalledWith({
      user_id: "user-1",
      title: "Submit report",
      category: "Course",
      linked_course: "OM-I",
      priority: "P1",
      deadline_at: "2026-11-27T18:30:00.000Z",
      estimate_minutes: 90,
      scheduled_start_at: null,
      scheduled_end_at: null,
      status: "To do",
      actual_start_at: null,
      actual_end_at: null,
      source: "Manual",
      notes: "Draft is ready",
    });
    expect(builder.select).toHaveBeenCalledWith("*");
    expect(builder.single).toHaveBeenCalledOnce();
  });

  it("updates only editable fields and scopes by user and task", async () => {
    const { client, builder } = fakeClient({ data: task, error: null });

    await expect(
      updateTask(client, "user-1", "task-1", {
        status: "In progress",
        actual_start_at: "2026-11-26T08:00:00+05:30",
      }),
    ).resolves.toEqual(task);

    expect(builder.update).toHaveBeenCalledWith({
      status: "In progress",
      actual_start_at: "2026-11-26T02:30:00.000Z",
    });
    expect(builder.eq.mock.calls).toEqual([
      ["user_id", "user-1"],
      ["id", "task-1"],
    ]);
    expect(builder.select).toHaveBeenCalledWith("*");
    expect(builder.maybeSingle).toHaveBeenCalledOnce();
  });

  it("returns null when an update finds no row", async () => {
    const { client } = fakeClient({ data: null, error: null });
    await expect(
      updateTask(client, "user-1", "missing", { status: "Done" }),
    ).resolves.toBeNull();
  });

  it("deletes only the requested user's task", async () => {
    const { client, builder } = fakeClient();

    await expect(deleteTask(client, "user-1", "task-1")).resolves.toBeUndefined();

    expect(builder.delete).toHaveBeenCalledOnce();
    expect(builder.eq.mock.calls).toEqual([
      ["user_id", "user-1"],
      ["id", "task-1"],
    ]);
  });

  it("preserves Supabase errors", async () => {
    const error = { code: "42501", message: "permission denied" };
    const { client } = fakeClient({ data: null, error });

    await expect(listTasks(client, "user-1")).rejects.toBe(error);
    await expect(
      createTask(client, "user-1", { title: "Task" }),
    ).rejects.toBe(error);
    await expect(
      updateTask(client, "user-1", "task-1", { status: "Done" }),
    ).rejects.toBe(error);
    await expect(deleteTask(client, "user-1", "task-1")).rejects.toBe(error);
  });

  it("validates values before calling Supabase", async () => {
    const { client, from } = fakeClient();

    await expect(createTask(client, "user-1", { title: "  " })).rejects.toThrow(
      "Task title is required",
    );
    await expect(
      createTask(client, "user-1", { title: "Task", priority: "P4" as "P3" }),
    ).rejects.toThrow("Invalid task priority");
    await expect(
      createTask(client, "user-1", { title: "Task", estimate_minutes: 0 }),
    ).rejects.toThrow("Estimate must be a positive whole number");
    await expect(
      createTask(client, "user-1", {
        title: "Task",
        deadline_at: "2026-11-27T10:00:00",
      }),
    ).rejects.toThrow("Task timestamps must include a timezone");
    await expect(
      createTask(client, "user-1", {
        title: "Task",
        scheduled_start_at: "2026-11-27T10:00:00Z",
      }),
    ).rejects.toThrow("Scheduled block needs both start and end times");
    await expect(
      updateTask(client, "user-1", "task-1", { user_id: "other" } as never),
    ).rejects.toThrow("Task updates cannot change user ownership");
    expect(from).not.toHaveBeenCalled();
  });
});
