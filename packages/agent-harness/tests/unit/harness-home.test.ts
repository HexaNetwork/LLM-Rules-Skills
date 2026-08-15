import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultHarnessHomeRoot,
  resolveHarnessHome,
  resolveProjectPaths,
  HARNESS_HOME_ENV} from "../../src/application/harness-home.js";

describe("defaultHarnessHomeRoot", () => {
  it("uses non-roaming LocalAppData on Windows", () => {
    const root = defaultHarnessHomeRoot("win32", () => "C:\\Users\\dev", {
      LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local"});
    expect(root.replaceAll("/", "\\").toLowerCase()).toBe(
      "c:\\users\\dev\\appdata\\local\\agent-harness",
    );
  });

  it("uses Application Support on macOS", () => {
    expect(defaultHarnessHomeRoot("darwin", () => "/Users/dev")).toBe(
      "/Users/dev/Library/Application Support/agent-harness",
    );
  });

  it("uses XDG_STATE_HOME on Linux when set", () => {
    expect(
      defaultHarnessHomeRoot("linux", () => "/home/dev", {
        XDG_STATE_HOME: "/var/lib/xdg-state"}),
    ).toBe("/var/lib/xdg-state/agent-harness");
  });

  it("falls back to ~/.local/state on Linux", () => {
    expect(defaultHarnessHomeRoot("linux", () => "/home/dev", {})).toBe(
      "/home/dev/.local/state/agent-harness",
    );
  });
});

describe("resolveHarnessHome", () => {
  it("prefers explicit homeRoot over env and platform defaults", () => {
    const home = resolveHarnessHome({
      homeRoot: "/tmp/custom-home",
      env: { [HARNESS_HOME_ENV]: "/tmp/env-home" },
      platform: "linux",
      homedir: () => "/home/dev",
      cwd: "/tmp"});
    expect(home.homeRoot).toBe(path.resolve("/tmp/custom-home"));
    expect(home.projectsRoot).toBe(path.join(home.homeRoot, "projects"));
    expect(home.sharedGuidanceRoot).toBe(path.join(home.homeRoot, "guidance"));
    expect(home.workflowsRoot).toBe(path.join(home.homeRoot, "workflows"));
    expect(home.agentsRoot).toBe(path.join(home.homeRoot, "agents"));
  });

  it("uses AGENT_HARNESS_HOME when set", () => {
    const home = resolveHarnessHome({
      env: { [HARNESS_HOME_ENV]: "/tmp/from-env" },
      platform: "linux",
      homedir: () => "/home/dev",
      cwd: "/tmp"});
    expect(home.homeRoot).toBe(path.resolve("/tmp/from-env"));
  });
});

describe("resolveProjectPaths", () => {
  it("places project state under harness home", () => {
    const home = resolveHarnessHome({
      homeRoot: "/tmp/harness-home",
      cwd: "/tmp"});
    const controlRoot = path.resolve("/tmp/repos/demo");
    const paths = resolveProjectPaths({
      projectKey: "abc123",
      controlRoot,
      home});
    expect(paths.projectStateRoot).toBe(path.join(home.projectsRoot, "abc123"));
    expect(paths.runsRoot).toBe(path.join(paths.projectStateRoot, "runs"));
    expect(paths.projectStateRoot).not.toBe(controlRoot);
  });
});
