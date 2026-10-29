import { describe, expect, it } from "vitest";
import { readSettings, RECOMMENDED_SETTINGS, settingsProblem, writeSettings } from "./profile";

describe("project output settings", () => {
  it("restores all editable settings after saving and reloading", () => {
    const edited = {
      ...RECOMMENDED_SETTINGS,
      style: "冷色石雕",
      iconSize: 1024,
      iconInset: 80,
      meshHeight: 0.5,
      collision: "box" as const,
      engine: "bevy" as const,
      anchorY: 1,
      referenceTokens: ["ga_art_reference"],
    };
    expect(readSettings(writeSettings(edited))).toEqual(edited);
  });

  it("does not erase unrelated existing project fields", () => {
    const saved = writeSettings(RECOMMENDED_SETTINGS, {
      attribution: "project owner",
      specs: { icon_2d: { custom_policy: "retain" }, future_kind: { foo: true } },
    });
    expect(saved.attribution).toBe("project owner");
    expect((saved.specs as Record<string, unknown>).future_kind).toEqual({ foo: true });
    expect(((saved.specs as Record<string, unknown>).icon_2d as Record<string, unknown>).custom_policy).toBe("retain");
  });

  it("rejects impossible layouts and non-finite or unsupported output settings", () => {
    expect(settingsProblem({ ...RECOMMENDED_SETTINGS, iconInset: 256 })).not.toBeNull();
    expect(settingsProblem({ ...RECOMMENDED_SETTINGS, meshHeight: NaN })).not.toBeNull();
    expect(settingsProblem({ ...RECOMMENDED_SETTINGS, textureSize: 999 })).not.toBeNull();
    expect(settingsProblem(RECOMMENDED_SETTINGS)).toBeNull();
  });
});
