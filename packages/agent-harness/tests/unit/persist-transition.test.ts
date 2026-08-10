import { afterEach, describe, expect, it } from "vitest";
import { applyReflectOutput, createRunState, type ReflectOutput } from "../../src/domain.js";
import { RunStore } from "../../src/store.js";
import { createProjectFixture, type ProjectFixture } from "../testkit/project-fixture.js";

const NOW = "2026-08-09T12:00:00.000Z";

const REFLECT: ReflectOutput = {
  summary: "Greeting",
  restatement: "Add a greeting",
  goal: "Ship greeting",
  users: ["users"],
  inScope: ["copy"],
  outOfScope: [],
  assumptions: [],
  unknowns: [],
};

describe("persistTransition", () => {
  let fixture: ProjectFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
      fixture = undefined;
    }
  });

  it("writes artifacts, checkpoints state, then appends the expected events", async () => {
    fixture = await createProjectFixture();
    const store = new RunStore(fixture.config);
    await store.initialize();
    const initial = createRunState("persist-run", "Add greeting", NOW);
    await store.create({ ...initial, phase: "reflecting" });

    const transition = applyReflectOutput(
      { ...initial, phase: "reflecting" },
      REFLECT,
      NOW,
      { batchId: "batch-1", questionIds: ["q-1"] },
    );
    const next = await store.persistTransition("persist-run", transition, [
      { relativePath: "brief.md", contents: "# Brief\n" },
    ]);

    expect(next.revision).toBe(initial.revision + 1);
    expect(next.lastEventSequence).toBe(2);
    expect(next.phase).toBe("awaiting_input");
    expect(await store.readText("persist-run", "brief.md")).toContain("Brief");

    const events = (await store.readText("persist-run", "events.jsonl"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string; sequence: number });
    expect(events.map((event) => event.type)).toEqual(["reflect.drafted", "question.asked"]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("keeps prior state recoverable when artifact writes fail", async () => {
    fixture = await createProjectFixture();
    const store = new RunStore(fixture.config);
    await store.initialize();
    const initial = createRunState("persist-fail", "Add greeting", NOW);
    await store.create({ ...initial, phase: "reflecting" });
    const before = await store.load("persist-fail");

    const transition = applyReflectOutput(
      { ...before, phase: "reflecting" },
      REFLECT,
      NOW,
      { batchId: "batch-1", questionIds: ["q-1"] },
    );

    await expect(
      store.persistTransition("persist-fail", transition, [
        { relativePath: "../escape.txt", contents: "nope" },
      ]),
    ).rejects.toThrow(/escapes run directory/);

    const loaded = await store.load("persist-fail");
    expect(loaded.revision).toBe(before.revision);
    expect(loaded.phase).toBe("reflecting");
    expect(loaded.lastEventSequence).toBe(before.lastEventSequence);
    expect(loaded.questions).toHaveLength(0);
  });
});

