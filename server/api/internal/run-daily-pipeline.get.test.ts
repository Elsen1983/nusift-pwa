import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetHeader = vi.hoisted(() => vi.fn());
const mockStart = vi.hoisted(() => vi.fn());
const mockEnsureDailyNotificationsWorkflow = vi.hoisted(() => vi.fn());

(globalThis as any).defineEventHandler = (fn: any) => fn;

vi.mock("h3", () => ({
  defineEventHandler: (fn: any) => fn,
  getHeader: (...args: any[]) => mockGetHeader(...args),
  createError: ({ statusCode, statusMessage }: { statusCode: number; statusMessage: string }) =>
    Object.assign(new Error(statusMessage), { statusCode, statusMessage }),
}));

vi.mock("workflow/api", () => ({ start: (...args: any[]) => mockStart(...args) }));
vi.mock("../../workflows/daily-news-pipeline", () => ({
  runDailyNewsPipelineWorkflow: vi.fn(),
}));
vi.mock("../../utils/news-pipeline/notification-workflow-schedule", () => ({
  ensureDailyNotificationsWorkflow: (...args: any[]) => mockEnsureDailyNotificationsWorkflow(...args),
}));

describe("GET /api/internal/run-daily-pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "cron-secret";
    delete process.env.NUXT_CRON_SECRET;
    mockGetHeader.mockImplementation((_event: unknown, name: string) =>
      name === "authorization" ? "Bearer cron-secret" : "",
    );
    mockStart.mockResolvedValue({ runId: "workflow-run-1" });
    mockEnsureDailyNotificationsWorkflow.mockResolvedValue({
      started: true,
      workflowRunId: "notification-workflow-run-1",
      markerRunId: "notification-marker-1",
      dateKey: "2026-08-02",
      reason: "started",
    });
  });

  it("rejects an unauthorized invocation", async () => {
    mockGetHeader.mockReturnValue("");
    const handler = (await import("./run-daily-pipeline.get")).default;
    await expect(handler({} as any)).rejects.toMatchObject({ statusCode: 401 });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("starts one workflow and returns its durable run id", async () => {
    const handler = (await import("./run-daily-pipeline.get")).default;
    const result = await handler({} as any);

    expect(result.ok).toBe(true);
    expect(result.workflowRunId).toBe("workflow-run-1");
    expect(result.orchestrationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.triggeredAt).toBeTruthy();
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockStart.mock.calls[0]?.[1]?.[0]).toMatchObject({
      orchestrationId: result.orchestrationId,
      triggeredAt: result.triggeredAt,
    });
    expect(mockEnsureDailyNotificationsWorkflow).toHaveBeenCalledWith(expect.any(Date));
  });
});
