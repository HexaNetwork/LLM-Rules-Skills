import { describe, expect, it } from "vitest";
import {
  formatCursorAgentFailure,
  formatInvokeError,
  sanitizeNodeProcessOutput,
} from "../../src/domain/cursor-agent-error.js";

describe("sanitizeNodeProcessOutput", () => {
  it("keeps NetworkError details and drops minified source dumps", () => {
    const dump = `import*as e from"@bufbuild/protobuf";${"x".repeat(600)}`;
    const raw = [
      "(node:8) ExperimentalWarning: SQLite is an experimental feature",
      "(Use `node --trace-warnings ...` to show where the warning was created)",
      "file:///opt/agent-harness/node_modules/@cursor/sdk/dist/esm/index.js:1",
      dump,
      "",
      "d [NetworkError]: Network request failed",
      "    at m.<anonymous> (file:///opt/agent-harness/node_modules/@cursor/sdk/dist/esm/index.js:1:185612)",
      "  isRetryable: true,",
      "  endpoint: 'GET /v1/models',",
      "  operation: 'Agent.create'",
      "Node.js v22.22.3",
    ].join("\n");

    const cleaned = sanitizeNodeProcessOutput(raw);
    expect(cleaned).toContain("[NetworkError]: Network request failed");
    expect(cleaned).toContain("operation: 'Agent.create'");
    expect(cleaned).not.toContain("ExperimentalWarning");
    expect(cleaned).not.toContain("import*as e");
    expect(cleaned.length).toBeLessThan(raw.length);
  });
});

describe("formatCursorAgentFailure", () => {
  it("prefers sanitized stderr", () => {
    const message = formatCursorAgentFailure("reflector", {
      exitCode: 1,
      stdout: "",
      stderr: `file:///x.js:1\n${"y".repeat(600)}\nENOTFOUND api.cursor.com`,
    });
    expect(message).toBe("Cursor agent failed (reflector): ENOTFOUND api.cursor.com");
  });
});

describe("formatInvokeError", () => {
  it("walks cause chains without dumping stacks", () => {
    const leaf = Object.assign(new Error("getaddrinfo ENOTFOUND api.cursor.com"), {
      code: "ENOTFOUND",
      hostname: "api.cursor.com",
    });
    const mid = Object.assign(new TypeError("fetch failed"), { cause: leaf });
    const top = Object.assign(new Error("Network request failed"), {
      name: "NetworkError",
      cause: mid,
      operation: "Agent.create",
      endpoint: "GET /v1/models",
      isRetryable: true,
    });
    expect(formatInvokeError(top)).toBe(
      [
        "NetworkError: Network request failed",
        "operation: Agent.create",
        "endpoint: GET /v1/models",
        "retryable: true",
        "caused by: TypeError: fetch failed",
        "caused by: Error: getaddrinfo ENOTFOUND api.cursor.com: ENOTFOUND: api.cursor.com",
      ].join("\n"),
    );
  });
});
