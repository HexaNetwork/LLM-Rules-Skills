import path from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createRunState, type DecisionTicket } from "../../src/domain.js";
import { RunStore } from "../../src/store.js";
import { LocalTracker, decisionFrontier } from "../../src/tracker.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

describe("Wayfinder local tracker", () => {
  it("keeps the map low-resolution and derives the unblocked frontier", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const store = new RunStore(config);
    await store.initialize();
    const now = new Date().toISOString();
    let state = createRunState("map-test", "Ship billing", now);
    await store.create(state);
    const tickets: DecisionTicket[] = [
      ticket("provider", "Choose payment provider", [], "resolved", now),
      ticket("refunds", "Define refund behavior", ["provider"], "open", now),
      ticket("receipts", "Define receipt layout", ["refunds"], "open", now),
    ];
    state = {
      ...state,
      phase: "wayfinding",
      map: {
        destination: "A build-ready billing spec",
        notes: [],
        decisionsSoFar: [
          { ticketId: "provider", title: "Choose payment provider", gist: "Use Stripe" },
        ],
        notYetSpecified: ["Tax behavior"],
        outOfScope: [],
        readyToPlan: false,
      },
      decisionTickets: tickets,
    };
    await new LocalTracker(store).sync(state);

    expect(decisionFrontier(tickets).map((item) => item.id)).toEqual(["refunds"]);
    const map = await readFile(path.join(store.runDirectory(state.runId), "map.md"), "utf8");
    expect(map).toContain("Choose payment provider");
    expect(map).not.toContain("Define refund behavior");
    expect(map).toContain("Tax behavior");
  });
});

function ticket(
  id: string,
  title: string,
  blockedBy: string[],
  status: DecisionTicket["status"],
  now: string,
): DecisionTicket {
  return {
    id,
    title,
    question: `${title}?`,
    kind: "grilling",
    interaction: "HITL",
    status,
    blockedBy,
    conversation: [],
    resolution: status === "resolved" ? "Use Stripe" : undefined,
    resolutionSummary: status === "resolved" ? "Use Stripe" : undefined,
    createdAt: now,
    updatedAt: now,
  };
}
