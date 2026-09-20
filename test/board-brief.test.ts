import { BOARD_BRIEF_MAX_CHARS, BOARD_SPECS_PATH_MAX_CHARS, BoardSchema } from "@shared/board-schema";
import type { Snapshot } from "@shared/schema";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BRIEF_MAX_BYTES } from "../config.ts";
import { ENVIRONMENTS } from "../environments.ts";
import { createApi } from "../server/api.ts";
import { BRIEF_PREAMBLE, composeBrief, withBoardBrief } from "../server/brief.ts";
import type { Poller } from "../server/poller.ts";
import type { SpawnOpts } from "../server/spawn.ts";
import { createStorage } from "../server/storage.ts";

const snap: Snapshot = { envs: { "work-local": { reachable: true } }, sessions: [] };
const poller: Poller = {
  getSnapshot: () => snap,
  getAttention: () => ({}),
  onSnapshot: () => () => undefined,
  pollOnce: async () => undefined,
  refreshEnv: async () => undefined,
  runClaudeSweepOnce: async () => undefined,
  applyRegistry: () => undefined,
  start: () => undefined,
  stop: () => undefined,
};

describe("BoardSchema project fields", () => {
  it("heals a board file written before the fields existed", () => {
    const b = BoardSchema.parse({ id: "b", label: "B", columns: [{ id: "todo", label: "Todo" }] });
    expect(b.brief).toBe("");
    expect(b.specsPath).toBe("");
  });

  it("keeps stored values", () => {
    const b = BoardSchema.parse({
      id: "b", label: "B", columns: [], brief: "Maths Garden is Tara's maths app.", specsPath: "maths-garden/specs",
    });
    expect(b.brief).toBe("Maths Garden is Tara's maths app.");
    expect(b.specsPath).toBe("maths-garden/specs");
  });

  it("parses a value longer than the PATCH cap — the cap is a boundary rule, not a stored one", () => {
    const long = "x".repeat(BOARD_BRIEF_MAX_CHARS + 1);
    expect(BoardSchema.parse({ id: "b", label: "B", columns: [], brief: long }).brief).toBe(long);
  });
});

describe("PATCH /api/boards/:bid — brief and specsPath", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(path.join(os.tmpdir(), "board-brief-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  function app() {
    return createApi({ poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir) });
  }

  async function makeBoard(a: ReturnType<typeof createApi>): Promise<void> {
    await a.request("/api/boards", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Test" }),
    });
  }

  function patch(a: ReturnType<typeof createApi>, body: unknown) {
    return a.request("/api/boards/test", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  }

  it("stores both fields and returns them from the single-board read", async () => {
    const a = app();
    await makeBoard(a);
    expect((await patch(a, { brief: "What this project is.", specsPath: "maths-garden/specs" })).status).toBe(200);
    const board = await (await a.request("/api/boards/test")).json() as { brief: string; specsPath: string };
    expect(board.brief).toBe("What this project is.");
    expect(board.specsPath).toBe("maths-garden/specs");
  });

  it("returns them from the board LIST too, which is what the web and the MCP read", async () => {
    const a = app();
    await makeBoard(a);
    await patch(a, { brief: "Project brief.", specsPath: "specs" });
    const boards = await (await a.request("/api/boards")).json() as { brief: string; specsPath: string }[];
    expect(boards[0]?.brief).toBe("Project brief.");
    expect(boards[0]?.specsPath).toBe("specs");
  });

  it("trims both before storing", async () => {
    const a = app();
    await makeBoard(a);
    await patch(a, { brief: "  Project brief.\n  ", specsPath: "  specs  " });
    const board = await (await a.request("/api/boards/test")).json() as { brief: string; specsPath: string };
    expect(board.brief).toBe("Project brief.");
    expect(board.specsPath).toBe("specs");
  });

  it("refuses a brief over the cap and leaves the stored value alone", async () => {
    const a = app();
    await makeBoard(a);
    await patch(a, { brief: "kept" });
    expect((await patch(a, { brief: "x".repeat(BOARD_BRIEF_MAX_CHARS + 1) })).status).toBe(400);
    const board = await (await a.request("/api/boards/test")).json() as { brief: string };
    expect(board.brief).toBe("kept");
  });

  it("measures the cap AFTER trimming, so trailing whitespace alone never refuses a save", async () => {
    const a = app();
    await makeBoard(a);
    const res = await patch(a, { brief: `${"x".repeat(BOARD_BRIEF_MAX_CHARS)}   ` });
    expect(res.status).toBe(200);
  });

  it("refuses a specsPath over its own cap", async () => {
    const a = app();
    await makeBoard(a);
    expect((await patch(a, { specsPath: "x".repeat(BOARD_SPECS_PATH_MAX_CHARS + 1) })).status).toBe(400);
  });

  it("leaves both untouched when the patch omits them", async () => {
    const a = app();
    await makeBoard(a);
    await patch(a, { brief: "Project brief.", specsPath: "specs" });
    await patch(a, { label: "Renamed" });
    const board = await (await a.request("/api/boards/test")).json() as { brief: string; specsPath: string };
    expect(board.brief).toBe("Project brief.");
    expect(board.specsPath).toBe("specs");
  });
});

describe("withBoardBrief", () => {
  it("prepends the board brief, separated by a blank line", () => {
    expect(withBoardBrief("Project.", "Card.", 1000)).toEqual({ text: "Project.\n\nCard.", droppedBoardBrief: false });
  });

  it("passes the composed brief through untouched when the board has none", () => {
    expect(withBoardBrief("   ", "Card.", 1000)).toEqual({ text: "Card.", droppedBoardBrief: false });
  });

  it("drops the board brief whole — never truncated — when the pair is over the cap", () => {
    const out = withBoardBrief("x".repeat(200), "Card.", 100);
    expect(out).toEqual({ text: "Card.", droppedBoardBrief: true });
  });

  it("measures bytes, not characters", () => {
    // 4 two-byte characters plus "\n\n" plus a 1-byte card brief is 11 bytes, one over.
    expect(withBoardBrief("éééé", "C", 10).droppedBoardBrief).toBe(true);
    expect(withBoardBrief("éééé", "C", 11).droppedBoardBrief).toBe(false);
  });
});

describe("POST spawn — the board brief reaches the session", () => {
  let tmpDir: string;
  let seen: SpawnOpts[];
  beforeEach(() => { tmpDir = mkdtempSync(path.join(os.tmpdir(), "spawn-board-brief-")); seen = []; });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  function app() {
    return createApi({
      poller, envs: ENVIRONMENTS, storage: createStorage(tmpDir),
      briefRoot: path.join(tmpDir, "briefs"),
      spawn: async (opts) => {
        seen.push(opts);
        return {
          paneId: "w1:p2", tabId: "t2", workspaceId: "ws1", workspaceLabel: "repo",
          tabLabel: "refactor-the-api-a", cwdSnapshot: "/repo", idempotent: false,
        };
      },
    });
  }

  async function boardWithBrief(a: ReturnType<typeof createApi>, brief: string): Promise<string> {
    await a.request("/api/boards", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Test" }),
    });
    await a.request("/api/boards/test", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brief }),
    });
    const { id } = await (await a.request("/api/boards/test/tasks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Refactor the API", status: "todo" }),
    })).json() as { id: string };
    return id;
  }

  async function spawnBody(a: ReturnType<typeof createApi>, tid: string, body: Record<string, unknown>): Promise<string> {
    const res = await a.request(`/api/boards/test/tasks/${tid}/spawn`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: "work-local", repo: "repo", ...body }),
    });
    expect(res.status).toBe(200);
    const briefPath = seen.at(-1)?.briefPath;
    if (briefPath === undefined) throw new Error("expected a briefPath");
    return readFileSync(briefPath, "utf8");
  }

  it("prepends the board brief to the composed card brief", async () => {
    const a = app();
    const tid = await boardWithBrief(a, "Maths Garden is Tara's maths app. Specs in maths-garden/specs.");
    const written = await spawnBody(a, tid, { brief: "Continue the refactor." });
    expect(written).toBe(`Maths Garden is Tara's maths app. Specs in maths-garden/specs.\n\n${composeBrief("Continue the refactor.")}`);
    expect(written.indexOf("Maths Garden")).toBeLessThan(written.indexOf(BRIEF_PREAMBLE));
  });

  it("drops the board brief rather than failing the spawn when the pair is over the byte cap", async () => {
    const a = app();
    const tid = await boardWithBrief(a, "");
    // Written straight to storage: the PATCH cap (4000) is below what it takes to crowd out a brief
    // sized near BRIEF_MAX_BYTES, and this is the state a board saved before that cap can be in.
    const storage = createStorage(tmpDir);
    await storage.withBoard("test", (existing) => {
      if (existing === null) throw new Error("expected the board");
      const board = { ...existing, brief: "B".repeat(BRIEF_MAX_BYTES - 100) };
      return { board, result: board };
    });
    const cardBrief = "C".repeat(BRIEF_MAX_BYTES - 500);
    const written = await spawnBody(a, tid, { brief: cardBrief });
    expect(written).toBe(composeBrief(cardBrief));
    expect(written).not.toContain("BBB");
  });

  it("leaves a startCommand alone — it is delivered verbatim so a slash command stays at position 0", async () => {
    const a = app();
    const tid = await boardWithBrief(a, "Maths Garden is Tara's maths app.");
    const written = await spawnBody(a, tid, { startCommand: "/plan" });
    expect(written).toBe("/plan");
  });
});
