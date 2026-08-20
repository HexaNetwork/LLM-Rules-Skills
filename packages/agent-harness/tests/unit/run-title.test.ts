import { describe, expect, it } from "vitest";
import { RUN_TITLE_MAX_LEN, RUN_TITLE_PLACEHOLDER, runTitle } from "../../src/domain/run-title.js";
import { defaultFakeReply } from "../../src/plugins/agents.js";
import type { WorkPacket } from "../../src/domain/types.js";

const idea =
  "Build a dashboard that shows every operator prompt in the heading and also dumps it into the sidebar until nobody can read the status of the run.";

function runWith(artifacts: Record<string, unknown> = {}) {
  return { state: { idea, artifacts } };
}

function fakeReflect(ideaText: string) {
  return defaultFakeReply("reflector", { input: ideaText } as WorkPacket);
}

describe("runTitle", () => {
  it("uses a placeholder before the reflector returns a title", () => {
    expect(runTitle(runWith())).toBe(RUN_TITLE_PLACEHOLDER);
    expect(runTitle(runWith({ idea }))).toBe(RUN_TITLE_PLACEHOLDER);
    expect(runTitle(runWith())).not.toContain("operator prompt");
  });

  it("uses the reflector title after reflect", () => {
    expect(
      runTitle(
        runWith({
          reflect: { title: "Operator shell titles", restatement: idea },
        }),
      ),
    ).toBe("Operator shell titles");
  });

  it("falls back to a short restatement and never the raw idea", () => {
    expect(
      runTitle(runWith({ reflect: { restatement: "A short restatement of the request." } })),
    ).toBe("A short restatement of the request.");

    const fromLong = runTitle(runWith({ reflect: { restatement: idea } }));
    expect(fromLong).not.toBe(idea);
    expect(fromLong.length).toBeLessThanOrEqual(RUN_TITLE_MAX_LEN);
    expect(fromLong).not.toContain(idea);
  });

  it("does not use the fake reflector title-from-idea", () => {
    for (const ideaText of [idea, "Add a health check"]) {
      const reflect = fakeReflect(ideaText) as { title?: unknown };
      const title = typeof reflect.title === "string" ? reflect.title.trim() : "";
      if (title) {
        expect(title).not.toBe(ideaText);
        expect(ideaText.startsWith(title)).toBe(false);
      }
      const shown = runTitle({ state: { artifacts: { reflect } } });
      expect(shown).not.toBe(ideaText);
      expect(ideaText.startsWith(shown)).toBe(false);
    }
  });
});
