import { describe, expect, it } from "vitest";
import { frameAt, parseFrameTable } from "@storyteller/api";
import { assetCandidates } from "./candidates";

describe("animation file and playback contract", () => {
  it("keeps non-looping last frames and loops at the same frame boundary", () => {
    expect(frameAt(0, 8, 4, true)).toBe(0);
    expect(frameAt(0.499, 8, 4, true)).toBe(3);
    expect(frameAt(0.5, 8, 4, true)).toBe(0);
    expect(frameAt(100, 8, 4, false)).toBe(3);
    for (const t of [-1, Infinity, NaN]) expect(() => frameAt(t, 8, 4, true)).toThrow();
  });

  it("rejects overlapping extrusion, wrong canvas, extra fields and incomplete directions", () => {
    expect(parseFrameTable(table()).anchor).toEqual({ origin: "top_left", x: 0.2, y: 0.9 });
    const overlap = table(); overlap.directions[0].frames[1].x = 3;
    expect(() => parseFrameTable(overlap)).toThrow(/重叠/);
    const wrong = table(); wrong.canvas.width = 3;
    expect(() => parseFrameTable(wrong)).toThrow();
    expect(() => parseFrameTable({ ...table(), sampling: "nearest" })).toThrow();
    const directions = table(); directions.directions.push(directions.directions[0]);
    expect(() => parseFrameTable(directions)).toThrow(/方向/);
  });

  it("follows only a character's own concept/mesh/rig lineage", () => {
    const concept = version("c", "hero", 1, "concept", "generate", null);
    const mesh = version("m", "hero", 2, "mesh", "mesh", "c");
    const rig = version("r", "hero", 3, "rigged", "rig", "m");
    const motion = version("a", "walk", 1, "animation", "retarget", null);
    motion.spec_json.rig_version_token = "r";
    const groups = assetCandidates([concept, mesh, rig, motion]);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.version.token === "r")?.files.map((v) => v.token)).toEqual(["r", "m", "c"]);
    expect(groups.find((g) => g.version.token === "a")?.files).toHaveLength(1);
    const illegal = version("bad", "other", 1, "mesh", "mesh", "c");
    expect(assetCandidates([concept, illegal])).toHaveLength(2);
  });
});

function table() {
  return { schema_version: "game.anim2d.frames.v1", clip_name: "walk", canvas: { width: 2, height: 2 },
    anchor: { origin: "top_left", x: 0.2, y: 0.9 }, atlas: { role: "main", ordinal: 0, width: 8, height: 4, extrude_px: 1 },
    fps: 8, loop: true, directions: [{ name: "default", frames: [{ x: 1, y: 1, width: 2, height: 2 }, { x: 5, y: 1, width: 2, height: 2 }] }] };
}

function version(token: string, asset_token: string, version: number, stage: string, operation: string, parent: string | null) {
  return { token, asset_token, version, maybe_parent_version_token: parent, profile_token: "profile", created_by: "user", created_at: "2026-10-28",
    spec_json: { stage, operation, creation_step_token: token, rig_version_token: undefined as string | undefined } };
}
