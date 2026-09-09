import { test } from "node:test";
import assert from "node:assert/strict";
import { TodoistTaskSource } from "./todoistTaskSource";

function fakeFetch(opts: {
  tasks?: unknown;
  tasksOk?: boolean;
  tasksStatus?: number;
  projects?: unknown;
  projectsOk?: boolean;
  capturedHeaders?: Record<string, string>[];
}): typeof fetch {
  const {
    tasks = [],
    tasksOk = true,
    tasksStatus = 200,
    projects = [],
    projectsOk = true,
    capturedHeaders,
  } = opts;

  return (async (url: string, init?: RequestInit) => {
    if (capturedHeaders) capturedHeaders.push({ ...(init?.headers as Record<string, string>) });
    if (String(url).includes("/projects")) {
      return { ok: projectsOk, status: 200, json: async () => projects } as unknown as Response;
    }
    return { ok: tasksOk, status: tasksStatus, json: async () => tasks } as unknown as Response;
  }) as unknown as typeof fetch;
}

test("no tasks returns an empty array", async () => {
  const source = new TodoistTaskSource({ apiToken: "tok" }, fakeFetch({ tasks: [] }));
  const result = await source.fetchActiveTasks();
  assert.deepEqual(result, []);
});

test("maps a task with a specific due time (has a reminder equal to the due time)", async () => {
  const source = new TodoistTaskSource(
    { apiToken: "tok" },
    fakeFetch({
      tasks: [
        {
          id: "1",
          content: "Finish the NIMBUS email integration",
          description: "",
          is_completed: false,
          priority: 4,
          due: { date: "2026-09-09", datetime: "2026-09-09T15:00:00.000000Z" },
          project_id: "p1",
          created_at: "2026-09-01T10:00:00.000000Z",
        },
      ],
      projects: [{ id: "p1", name: "Work" }],
    })
  );
  const [task] = await source.fetchActiveTasks();

  assert.equal(task.title, "Finish the NIMBUS email integration");
  assert.equal(task.dueIsDateOnly, false);
  assert.equal(task.dueAt, new Date("2026-09-09T15:00:00.000000Z").toISOString());
  assert.equal(task.reminderAt, task.dueAt);
  assert.equal(task.sourcePriority, 4);
  assert.equal(task.listName, "Work");
  assert.equal(task.completed, false);
});

test("a due date without a time is mapped as date-only, with no reminder", async () => {
  const source = new TodoistTaskSource(
    { apiToken: "tok" },
    fakeFetch({ tasks: [{ id: "2", content: "Buy groceries", due: { date: "2026-09-10" } }] })
  );
  const [task] = await source.fetchActiveTasks();

  assert.equal(task.dueIsDateOnly, true);
  assert.ok(task.dueAt);
  assert.equal(task.reminderAt, null);
});

test("a task with no due field at all has a null due date", async () => {
  const source = new TodoistTaskSource({ apiToken: "tok" }, fakeFetch({ tasks: [{ id: "3", content: "Someday" }] }));
  const [task] = await source.fetchActiveTasks();

  assert.equal(task.dueAt, null);
  assert.equal(task.dueIsDateOnly, false);
});

test("missing content defaults to a placeholder title rather than crashing", async () => {
  const source = new TodoistTaskSource({ apiToken: "tok" }, fakeFetch({ tasks: [{ id: "4" }] }));
  const [task] = await source.fetchActiveTasks();
  assert.equal(task.title, "(Untitled task)");
});

test("a task in a project with no matching project entry has a null list name", async () => {
  const source = new TodoistTaskSource(
    { apiToken: "tok" },
    fakeFetch({ tasks: [{ id: "5", content: "Orphaned", project_id: "missing" }], projects: [] })
  );
  const [task] = await source.fetchActiveTasks();
  assert.equal(task.listName, null);
});

test("a failed projects request still lets tasks through, just without list names", async () => {
  const source = new TodoistTaskSource(
    { apiToken: "tok" },
    fakeFetch({ tasks: [{ id: "6", content: "Still here", project_id: "p1" }], projectsOk: false })
  );
  const [task] = await source.fetchActiveTasks();
  assert.equal(task.title, "Still here");
  assert.equal(task.listName, null);
});

test("a non-ok tasks response throws a descriptive error", async () => {
  const source = new TodoistTaskSource({ apiToken: "tok" }, fakeFetch({ tasksOk: false, tasksStatus: 401 }));
  await assert.rejects(() => source.fetchActiveTasks(), /status 401/);
});

test("the API token is sent as a Bearer header, never as a query parameter or body", async () => {
  const capturedHeaders: Record<string, string>[] = [];
  const source = new TodoistTaskSource({ apiToken: "super-secret-token" }, fakeFetch({ capturedHeaders }));
  await source.fetchActiveTasks();

  assert.ok(capturedHeaders.length > 0);
  for (const headers of capturedHeaders) {
    assert.equal(headers.Authorization, "Bearer super-secret-token");
  }
});

test("malformed/sparse task data does not crash the mapper", async () => {
  const source = new TodoistTaskSource(
    { apiToken: "tok" },
    fakeFetch({ tasks: [{}, { id: null }, { id: "ok", due: {} }] })
  );
  const result = await source.fetchActiveTasks();
  assert.equal(result.length, 3);
  for (const task of result) {
    assert.equal(typeof task.title, "string");
  }
});

test("requests go to the v1 API, not the retired v2 one", async () => {
  const capturedUrls: string[] = [];
  const fetchFn = (async (url: string) => {
    capturedUrls.push(String(url));
    return { ok: true, status: 200, json: async () => [] } as unknown as Response;
  }) as unknown as typeof fetch;
  const source = new TodoistTaskSource({ apiToken: "tok" }, fetchFn);
  await source.fetchActiveTasks();

  assert.ok(capturedUrls.every((u) => u.startsWith("https://api.todoist.com/api/v1/")));
  assert.ok(capturedUrls.every((u) => !u.includes("/rest/v2/")));
});

test("a v1-style paginated response ({ results, next_cursor }) is unwrapped correctly", async () => {
  const fetchFn = (async (url: string) => {
    if (String(url).includes("/projects")) {
      return { ok: true, status: 200, json: async () => ({ results: [{ id: "p1", name: "Work" }], next_cursor: null }) } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ results: [{ id: "1", content: "Paginated task", project_id: "p1" }], next_cursor: null }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const source = new TodoistTaskSource({ apiToken: "tok" }, fetchFn);
  const [task] = await source.fetchActiveTasks();
  assert.equal(task.title, "Paginated task");
  assert.equal(task.listName, "Work");
});

test("multiple pages of tasks (via next_cursor) are all fetched and combined", async () => {
  let call = 0;
  const fetchFn = (async (url: string) => {
    if (String(url).includes("/projects")) {
      return { ok: true, status: 200, json: async () => ({ results: [], next_cursor: null }) } as unknown as Response;
    }
    call++;
    if (call === 1) {
      assert.ok(!String(url).includes("cursor="));
      return { ok: true, status: 200, json: async () => ({ results: [{ id: "1", content: "Page one" }], next_cursor: "abc" }) } as unknown as Response;
    }
    assert.ok(String(url).includes("cursor=abc"));
    return { ok: true, status: 200, json: async () => ({ results: [{ id: "2", content: "Page two" }], next_cursor: null }) } as unknown as Response;
  }) as unknown as typeof fetch;

  const source = new TodoistTaskSource({ apiToken: "tok" }, fetchFn);
  const result = await source.fetchActiveTasks();
  assert.deepEqual(result.map((t) => t.title).sort(), ["Page one", "Page two"]);
});

test("pagination stops after a bounded number of pages rather than looping forever on a runaway cursor", async () => {
  let call = 0;
  const fetchFn = (async (url: string) => {
    if (String(url).includes("/projects")) {
      return { ok: true, status: 200, json: async () => ({ results: [], next_cursor: null }) } as unknown as Response;
    }
    call++;
    // Always returns a next_cursor — a malformed/misbehaving server that never terminates.
    return {
      ok: true,
      status: 200,
      json: async () => ({ results: [{ id: String(call), content: `Task ${call}` }], next_cursor: "forever" }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const source = new TodoistTaskSource({ apiToken: "tok" }, fetchFn);
  const result = await source.fetchActiveTasks();
  assert.ok(call <= 20); // MAX_PAGES
  assert.equal(result.length, call);
});

test("a plain array response (the old v2 shape) is still accepted, not just the new paginated wrapper", async () => {
  const source = new TodoistTaskSource({ apiToken: "tok" }, fakeFetch({ tasks: [{ id: "1", content: "Plain array task" }] }));
  const [task] = await source.fetchActiveTasks();
  assert.equal(task.title, "Plain array task");
});

// --- Write methods ---

function capturingFetch(response: unknown = { id: "new-id", content: "ok" }, ok = true, status = 200) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok, status, json: async () => response } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

test("createTask POSTs to /tasks with the mapped payload and Bearer auth", async () => {
  const { fetchFn, calls } = capturingFetch({ id: "1", content: "Buy milk" });
  const source = new TodoistTaskSource({ apiToken: "tok" }, fetchFn);
  const task = await source.createTask({ title: "Buy milk", description: "2%", dueDate: "2026-09-10", priority: 4, projectId: "p1" });

  assert.equal(task.title, "Buy milk");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.todoist.com/api/v1/tasks");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer tok");
  const body = JSON.parse(calls[0].init?.body as string);
  assert.deepEqual(body, { content: "Buy milk", description: "2%", due_date: "2026-09-10", priority: 4, project_id: "p1" });
});

test("createTask omits project_id when none is given, rather than sending an empty string", async () => {
  const { fetchFn, calls } = capturingFetch();
  const source = new TodoistTaskSource({ apiToken: "tok" }, fetchFn);
  await source.createTask({ title: "No project" });
  const body = JSON.parse(calls[0].init?.body as string);
  assert.equal("project_id" in body, false);
});

test("createTask throws a descriptive error on a non-ok response", async () => {
  const { fetchFn } = capturingFetch({}, false, 400);
  const source = new TodoistTaskSource({ apiToken: "tok" }, fetchFn);
  await assert.rejects(() => source.createTask({ title: "x" }), /status 400/);
});

test("updateTask POSTs to /tasks/{id} with only the fields actually provided", async () => {
  const { fetchFn, calls } = capturingFetch({ id: "5", content: "Renamed" });
  const source = new TodoistTaskSource({ apiToken: "tok" }, fetchFn);
  await source.updateTask("5", { title: "Renamed" });

  assert.equal(calls[0].url, "https://api.todoist.com/api/v1/tasks/5");
  assert.equal(calls[0].init?.method, "POST");
  const body = JSON.parse(calls[0].init?.body as string);
  assert.deepEqual(body, { content: "Renamed" }); // description/due_date/priority/project_id untouched
});

test("updateTask with dueDate: null clears the due date explicitly (distinct from omitting it)", async () => {
  const { fetchFn, calls } = capturingFetch();
  const source = new TodoistTaskSource({ apiToken: "tok" }, fetchFn);
  await source.updateTask("5", { dueDate: null });
  const body = JSON.parse(calls[0].init?.body as string);
  assert.equal(body.due_date, null);
  assert.equal("content" in body, false);
});

test("completeTask POSTs to /tasks/{id}/close with no body", async () => {
  const { fetchFn, calls } = capturingFetch();
  const source = new TodoistTaskSource({ apiToken: "tok" }, fetchFn);
  await source.completeTask("5");
  assert.equal(calls[0].url, "https://api.todoist.com/api/v1/tasks/5/close");
  assert.equal(calls[0].init?.method, "POST");
});

test("reopenTask POSTs to /tasks/{id}/reopen", async () => {
  const { fetchFn, calls } = capturingFetch();
  const source = new TodoistTaskSource({ apiToken: "tok" }, fetchFn);
  await source.reopenTask("5");
  assert.equal(calls[0].url, "https://api.todoist.com/api/v1/tasks/5/reopen");
});

test("deleteTask sends DELETE to /tasks/{id}", async () => {
  const { fetchFn, calls } = capturingFetch();
  const source = new TodoistTaskSource({ apiToken: "tok" }, fetchFn);
  await source.deleteTask("5");
  assert.equal(calls[0].url, "https://api.todoist.com/api/v1/tasks/5");
  assert.equal(calls[0].init?.method, "DELETE");
});

test("completeTask/reopenTask/deleteTask all throw descriptively on a non-ok response", async () => {
  const source = new TodoistTaskSource({ apiToken: "tok" }, capturingFetch({}, false, 404).fetchFn);
  await assert.rejects(() => source.completeTask("5"), /status 404/);
  await assert.rejects(() => source.reopenTask("5"), /status 404/);
  await assert.rejects(() => source.deleteTask("5"), /status 404/);
});

test("fetchProjects returns id/name pairs and throws (rather than silently returning empty) on failure", async () => {
  const source = new TodoistTaskSource({ apiToken: "tok" }, capturingFetch({ results: [{ id: "p1", name: "Work" }], next_cursor: null }).fetchFn);
  assert.deepEqual(await source.fetchProjects(), [{ id: "p1", name: "Work" }]);

  const failing = new TodoistTaskSource({ apiToken: "tok" }, capturingFetch({}, false, 500).fetchFn);
  await assert.rejects(() => failing.fetchProjects(), /status 500/);
});
