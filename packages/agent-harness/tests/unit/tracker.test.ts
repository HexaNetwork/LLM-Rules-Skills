import path from "node:path";
import { resolveHarnessPaths } from "../../src/application/paths.js";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createRunState } from "../../src/domain.js";
import { RunStore } from "../../src/store.js";
import { LocalTracker } from "../../src/tracker.js";
import { createProjectFixture, type ProjectFixture } from "../testkit/project-fixture.js";

describe("local tracker", () => {
  let fixture: ProjectFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
      fixture = undefined;
    }
  });

  it("writes the confirmed brief and grill resolutions", async () => {
    fixture = await createProjectFixture();
    const store = new RunStore(fixture.config, resolveHarnessPaths(fixture.config).stateRoot);
    await store.initialize();
    const now = new Date().toISOString();
    let state = createRunState("brief-test", "Ship billing", now);
    await store.create(state);
    state = {
      ...state,
      phase: "grilling",
      reflectBrief: {
        draft: "Draft brief",
        confirmed: "Confirmed billing brief",
        confirmedAt: now,
      },
      grillResolutions: [
        {
          id: "q-1",
          question: "Which provider?",
          answer: "Stripe",
          summary: "Use Stripe",
          resolvedAt: now,
        },
      ],
    };
    await new LocalTracker(store).sync(state);

    const brief = await readFile(path.join(store.runDirectory(state.runId), "brief.md"), "utf8");
    const grill = await readFile(path.join(store.runDirectory(state.runId), "grill.md"), "utf8");
    expect(brief).toContain("Confirmed billing brief");
    expect(brief).toContain("confirmed");
    expect(brief).not.toContain("## Idea");
    expect(brief).not.toContain("Ship billing");
    expect(grill).toContain("Which provider?");
    expect(grill).toContain("Stripe");
  });
});
