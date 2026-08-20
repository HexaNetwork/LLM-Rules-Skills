import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bootTestHost } from "../helpers.js";

describe("store settings JSON", () => {
  it("reads global settings.json that starts with a UTF-8 BOM", async () => {
    const { home, host } = await bootTestHost();
    try {
      // arrange settings file
      const payload = {};
      payload.verification = {};
      payload.verification.command = 'echo ok';
      const json = JSON.stringify(payload, null, 2) + '\n';
      const text = '\uFEFF' + json;
      await writeFile(path.join(home, 'settings.json'), text, 'utf8');
      const settings = await host.ctx.store.readGlobalSettings();
      expect(settings.verification?.command).toBe('echo ok');
    } finally {
      await host.dispose();
    }
  });
});
