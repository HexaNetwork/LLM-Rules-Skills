import path from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createRunState } from "../../src/domain.js";
import { RunStore } from "../../src/store.js";
import { LocalTracker } from "../../src/tracker.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

describe("local tracker", () => {
  it("writes the confirmed brief and grill resolutions", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const store = new RunStore(config);
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
    expect(grill).toContain("Which provider?");
    expect(grill).toContain("Stripe");
  });
});
