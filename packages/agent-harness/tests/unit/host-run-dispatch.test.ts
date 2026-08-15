import { describe, expect, it } from "vitest";
import { hostOwnerForAction } from "../../src/application/host-run-dispatch.js";

describe("host run dispatch", () => {
  it("keeps lifecycle and control on the host", () => {
    expect(hostOwnerForAction("continue")).toBe("lifecycle");
    expect(hostOwnerForAction("resume")).toBe("lifecycle");
    expect(hostOwnerForAction("retry")).toBe("lifecycle");
    expect(hostOwnerForAction("cancel")).toBe("control");
    expect(hostOwnerForAction("stop")).toBe("control");
    expect(hostOwnerForAction("cleanup")).toBe("control");
    expect(hostOwnerForAction("confirm_grill")).toBe("engine");
    expect(hostOwnerForAction("answer")).toBe("engine");
  });
});
