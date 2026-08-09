import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/store.js";
import { createRunState } from "../../src/domain.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

describe("concurrent state.json read/write", () => {
  it("reads stay clean while writeState swaps the file underneath", async () => {
    const store = new RunStore(fixtureConfig(await fixtureRoot()));
    await store.initialize();
    let state = createRunState("race-run", "Race the reader", new Date().toISOString(), "hash", 1);
    await store.create(state);

    let writing = true;
    const writer = (async () => {
      // Pad the state so each write is large enough to hold the file open.
      const idea = "Race the reader ".repeat(2_000);
      for (let i = 0; i < 120 && writing; i += 1) {
        state = await store.writeState({ ...state, idea });
      }
      writing = false;
    })();

    let reads = 0;
    const errors: string[] = [];
    while (writing) {
      try {
        await store.load("race-run");
        reads += 1;
      } catch (error) {
        errors.push((error as NodeJS.ErrnoException).code ?? String(error));
      }
    }
    await writer;

    expect(errors).toEqual([]);
    expect(reads).toBeGreaterThan(0);
  }, 30_000);
});
