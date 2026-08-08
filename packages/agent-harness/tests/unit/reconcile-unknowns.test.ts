import { describe, expect, it } from "vitest";
import { reconcileUnknowns } from "../../src/engine.js";
import type { OpenUnknown, OpenUnknownDraft } from "../../src/domain.js";

const draft = (overrides: Partial<OpenUnknownDraft> = {}): OpenUnknownDraft => ({
  id: "tone",
  title: "Tone of voice",
  whyItMatters: "Sets the language throughout",
  impact: "shaping",
  ...overrides,
});

const entry = (overrides: Partial<OpenUnknown> = {}): OpenUnknown => ({
  id: "tone",
  title: "Tone of voice",
  whyItMatters: "Sets the language throughout",
  impact: "shaping",
  status: "fog",
  ...overrides,
});

describe("reconcileUnknowns", () => {
  it("keeps an incoming entry at fog when it is neither asked nor parked", () => {
    const result = reconcileUnknowns([], [draft()]);
    expect(result).toEqual([entry({ status: "fog" })]);
  });

  it("marks an entry asked when it is linked to a currently-open question", () => {
    const result = reconcileUnknowns([], [draft()], new Set(["tone"]));
    expect(result[0]?.status).toBe("asked");
  });

  it("transitions fog -> asked -> resolved as the register evolves", () => {
    const fog = reconcileUnknowns([], [draft()]);
    expect(fog[0]?.status).toBe("fog");

    const asked = reconcileUnknowns(fog, [draft()], new Set(["tone"]));
    expect(asked[0]?.status).toBe("asked");

    // Next turn: the griller no longer lists it because it was resolved.
    const resolved = reconcileUnknowns(asked, []);
    expect(resolved).toEqual([entry({ status: "resolved" })]);
  });

  it("parks an entry when the human skips its question this turn", () => {
    const asked = reconcileUnknowns([], [draft()], new Set(["tone"]));
    const parked = reconcileUnknowns(asked, [draft()], new Set(), new Set(["tone"]));
    expect(parked[0]?.status).toBe("parked");
  });

  it("keeps a parked entry parked (sticky) until the griller re-asks it", () => {
    const asked = reconcileUnknowns([], [draft()], new Set(["tone"]));
    const parked = reconcileUnknowns(asked, [draft()], new Set(), new Set(["tone"]));
    // Next turn: griller lists it again but has not re-asked it (not in askedIds).
    const stillParked = reconcileUnknowns(parked, [draft()]);
    expect(stillParked[0]?.status).toBe("parked");

    // The griller finally promotes it back into a question.
    const reAsked = reconcileUnknowns(stillParked, [draft()], new Set(["tone"]));
    expect(reAsked[0]?.status).toBe("asked");
  });

  it("marks an entry resolved when it is absent from the incoming list, and never deletes it", () => {
    const previous = [entry({ status: "asked" })];
    const result = reconcileUnknowns(previous, []);
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("resolved");
    expect(result[0]?.id).toBe("tone");
  });

  it("preserves incoming order for open entries and appends dropped ones", () => {
    const previous = [entry({ id: "a", title: "A" }), entry({ id: "old", title: "Old" })];
    const incoming = [draft({ id: "b", title: "B" }), draft({ id: "a", title: "A" })];
    const result = reconcileUnknowns(previous, incoming);
    expect(result.map((item) => item.id)).toEqual(["b", "a", "old"]);
    expect(result.find((item) => item.id === "old")?.status).toBe("dropped");
  });

  it("marks a fog entry absent from incoming as dropped, not resolved", () => {
    const previous = [entry({ status: "fog" })];
    const result = reconcileUnknowns(previous, []);
    expect(result).toEqual([entry({ status: "dropped" })]);
  });

  it("marks an asked entry absent from incoming as resolved", () => {
    const previous = [entry({ status: "asked" })];
    const result = reconcileUnknowns(previous, []);
    expect(result).toEqual([entry({ status: "resolved" })]);
  });

  it("keeps a parked entry parked when it is absent from incoming", () => {
    const previous = [entry({ status: "parked" })];
    const result = reconcileUnknowns(previous, []);
    expect(result).toEqual([entry({ status: "parked" })]);
  });

  it("returns a dropped entry to fog when it reappears in incoming", () => {
    const previous = [entry({ status: "dropped" })];
    const result = reconcileUnknowns(previous, [draft()]);
    expect(result).toEqual([entry({ status: "fog" })]);
  });

  it("fills defaults for whyItMatters and impact when the draft omits them", () => {
    const result = reconcileUnknowns([], [{ id: "x", title: "X" } as OpenUnknownDraft]);
    expect(result[0]).toMatchObject({ whyItMatters: "", impact: "shaping" });
  });
});
