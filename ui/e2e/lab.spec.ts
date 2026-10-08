import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const problems: string[] = [];

test.beforeEach(async ({ page }) => {
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
});

test.afterAll(() => {
  expect(problems, problems.join("\n")).toEqual([]);
});

const card = (page: Page) => page.locator('[data-engine="overlap"]');

async function pickOverlap(page: Page) {
  const chip = page.getByRole("button", { name: "Word-overlap baseline", exact: true });
  await expect(chip).toBeEnabled();
  if ((await chip.getAttribute("aria-pressed")) !== "true") await chip.click();
}

test("engines page starts an engine and reports its resources", async ({ page }) => {
  await page.goto("/#/engines");
  await expect(page.getByRole("heading", { name: "Engines" })).toBeVisible();
  await expect(card(page)).toContainText("stopped");
  await card(page).getByRole("button", { name: "Start" }).click();
  await expect(card(page)).toContainText("ready", { timeout: 30_000 });
  await expect(card(page)).toContainText("Footprint");
  await expect(card(page)).toContainText(/\d+ MB/);
  await expect(page.getByText("Memory footprint")).toBeVisible();
  await card(page).getByRole("button", { name: "Log" }).click();
  await expect(page.getByRole("dialog")).toContainText("start overlap");
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("jev card explains how to get a key", async ({ page }) => {
  await page.goto("/#/engines");
  const jev = page.locator('[data-engine="jev"]');
  await expect(jev).toContainText("console.typesafe.ai");
  await expect(jev.getByRole("button", { name: "Start" })).toBeDisabled();
});

test("OpenAI card explains credentials and billable remote inference", async ({ page }) => {
  await page.goto("/#/engines");
  const openai = page.locator('[data-engine="openai"]');
  await expect(openai).toContainText("OPENAI_API_KEY");
  await expect(openai).toContainText("billable warm-up");
  await expect(openai).toContainText("sends data off this Mac");
  await expect(openai).not.toContainText("TypeSafe");
  await expect(openai.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
  await openai.screenshot({ path: "test-results/openai-engine-setup.png" });
});

test("playground runs a request and shows answers", async ({ page }) => {
  await page.goto("/#/playground");
  await page.getByRole("button", { name: "Word-overlap baseline", exact: true }).click();
  await page.getByRole("button", { name: /^Run/ }).click();
  const results = page.locator(".answer-card");
  await expect(results).toHaveCount(3);
  await expect(results.first()).toContainText("Word-overlap baseline");
  await expect(page.locator("table.data")).toContainText("Word-overlap baseline");
});

test("playground validates before sending", async ({ page }) => {
  await page.goto("/#/playground");
  await pickOverlap(page);
  const label = page.getByLabel("Option 1 label").first();
  const before = await label.inputValue();
  await label.fill("");
  await expect(page.getByText("team: every option needs a label.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Run/ })).toBeDisabled();
  await label.fill(before);
  await expect(page.getByRole("button", { name: /^Run/ })).toBeEnabled();
});

test("builder and raw JSON stay in sync", async ({ page }) => {
  await page.goto("/#/playground");
  await pickOverlap(page);
  await page.getByRole("button", { name: "Raw JSON" }).click();
  const editor = page.locator(".cm-content").first();
  await expect(editor).toContainText('"questions"');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(JSON.stringify({ state: "hello there", questions: { greet: { type: "noul", instructions: "Is it a greeting?" } } }));
  await page.getByRole("button", { name: "Builder" }).click();
  await expect(page.getByLabel("Question id")).toHaveValue("greet");
  await expect(page.locator(".question")).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.locator(".answer-card")).toHaveCount(1);
  await expect(page.locator(".answer-card")).toContainText("P(yes)");
});

test("raw JSON errors are shown, not applied", async ({ page }) => {
  await page.goto("/#/playground");
  const ids = await page.getByLabel("Question id").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  expect(ids.length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Raw JSON" }).click();
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText('{"state": "x", "questions": {"q": {"type": "maybe"}}}');
  await expect(page.getByText("questions.q.type must be choice, score or noul.")).toBeVisible();
  await page.getByRole("button", { name: "Builder" }).click();
  await expect(page.getByLabel("Question id")).toHaveCount(ids.length);
  expect(await page.getByLabel("Question id").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).toEqual(ids);
});

test("presets load into the builder", async ({ page }) => {
  await page.goto("/#/playground");
  await page.getByLabel("Load a preset").selectOption({ label: "Content moderation" });
  await expect(page.locator(".question")).toHaveCount(3);
  await expect(page.getByLabel("Question id").first()).toHaveValue("category");
});

test("demos live in tabs: create, switch, rename, persist, close and undo", async ({ page }) => {
  await page.goto("/#/playground");
  const tabs = page.getByRole("tablist", { name: "Demos" });
  await expect(tabs.getByRole("tab")).toHaveCount(1);
  await expect(tabs.getByRole("tab", { name: "Demo 1" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Question id").first()).toHaveValue("team");

  await page.getByRole("button", { name: "New demo" }).click();
  await page.getByRole("menuitem", { name: "Content moderation" }).click();
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  await expect(tabs.getByRole("tab", { name: "Content moderation" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Question id").first()).toHaveValue("category");

  await pickOverlap(page);
  await page.getByRole("button", { name: /^Run/ }).click();
  await expect(page.locator(".answer-card")).toHaveCount(3);

  await tabs.getByRole("tab", { name: "Demo 1" }).click();
  await expect(page.getByLabel("Question id").first()).toHaveValue("team");
  await expect(page.getByText("No results yet")).toBeVisible();

  await tabs.getByRole("tab", { name: "Content moderation" }).dblclick();
  const rename = page.getByLabel("Demo name");
  await rename.fill("Moderation v2");
  await rename.press("Enter");
  await expect(tabs.getByRole("tab", { name: "Moderation v2" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".answer-card")).toHaveCount(3);

  await page.reload();
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  await expect(tabs.getByRole("tab", { name: "Moderation v2" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".answer-card")).toHaveCount(3);

  await tabs.getByRole("tab", { name: "Moderation v2" }).dblclick();
  await page.getByLabel("Demo name").press("Escape");
  await expect(tabs.getByRole("tab", { name: "Moderation v2" })).toBeVisible();

  await page.getByRole("button", { name: "Close Moderation v2" }).click();
  await expect(tabs.getByRole("tab")).toHaveCount(1);
  await expect(page.getByText("Closed “Moderation v2”")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(tabs.getByRole("tab", { name: "Moderation v2" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".answer-card")).toHaveCount(3);

  await page.getByRole("button", { name: "New demo" }).click();
  await page.getByRole("menuitem", { name: "Duplicate this demo" }).click();
  await expect(tabs.getByRole("tab", { name: "Moderation v2 copy" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("No results yet")).toBeVisible();

  await page.getByRole("button", { name: "New demo" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.getByRole("button", { name: "New demo" }).click();
  await page.getByRole("menuitem", { name: "Blank demo" }).click();
  await expect(tabs.getByRole("tab", { name: "Untitled" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("State is empty.")).toBeVisible();
  await expect(tabs.getByRole("tab")).toHaveCount(4);
  await expect(page.getByRole("button", { name: /Close Demo 1/ })).toBeVisible();
});

test("benchmark runs and lists items", async ({ page }) => {
  await page.goto("/#/bench");
  await page.getByLabel("Dataset").selectOption("banking10");
  await page.getByRole("button", { name: "Word-overlap baseline", exact: true }).click();
  await page.getByRole("button", { name: "25", exact: true }).click();
  await page.getByRole("button", { name: "Run benchmark" }).click();
  await expect(page.getByText("This run")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".pill", { hasText: "done" })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("table.data").first()).toContainText("Word-overlap baseline");
  await page.getByRole("button", { name: "All", exact: true }).first().click();
  await expect(page.getByText("25 of 25 items").first()).toBeVisible();
  await page.locator("table.data", { hasText: "Input" }).first().locator("tbody tr").first().click();
  await expect(page.locator("pre.log").first()).toBeVisible();
});

test("the overview and combined leaderboard pick up the run", async ({ page }) => {
  await page.goto("/#/bench");
  await page.getByRole("button", { name: "All datasets" }).click();
  const matrix = page.locator("table.data").last();
  await expect(matrix).toContainText("Word-overlap baseline");
  await matrix.getByRole("button", { name: /Banking intents · 10/ }).click();
  await expect(page.getByText(/Latest result per engine for this dataset at 25 items/)).toBeVisible();
  await expect(page.getByText("Leaderboard").last()).toBeVisible();
});

test("load test runs", async ({ page }) => {
  await page.goto("/#/load");
  for (const c of ["4", "8"]) {
    const chip = page.getByRole("button", { name: c, exact: true });
    if ((await chip.getAttribute("aria-pressed")) === "true") await chip.click();
  }
  await page.getByLabel("Requests per level").fill("6");
  await expect(page.getByText("12 requests")).toBeVisible();
  await page.getByRole("button", { name: "Run load test" }).click();
  await expect(page.getByText("Peak throughput")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("table.data tbody tr")).toHaveCount(2);
});

test("runs are saved, reopened and deleted", async ({ page }) => {
  await page.goto("/#/runs");
  const rows = page.locator("table.data tbody tr");
  await expect(rows).toHaveCount(2);
  await rows.filter({ hasText: "benchmark" }).getByRole("button").first().click();
  await expect(page.getByText("Leaderboard")).toBeVisible();
  await page.getByRole("button", { name: "← All runs" }).click();
  await rows.filter({ hasText: "load test" }).getByRole("button", { name: /Delete/ }).click();
  await page.getByRole("button", { name: "Keep" }).click();
  await expect(rows).toHaveCount(2);
  await rows.filter({ hasText: "load test" }).getByRole("button", { name: /Delete/ }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(rows).toHaveCount(1);
});

test("stopping the engine updates every page", async ({ page }) => {
  await page.goto("/#/engines");
  await card(page).getByRole("button", { name: "Stop" }).click();
  await expect(card(page)).toContainText("stopped", { timeout: 15_000 });
  await page.goto("/#/playground");
  await expect(page.getByRole("button", { name: "Word-overlap baseline", exact: true })).toBeDisabled();
  await expect(page.getByText("No engine is running.")).toBeVisible();
});
