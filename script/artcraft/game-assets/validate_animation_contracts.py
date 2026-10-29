#!/usr/bin/env python3
"""Check publication schemas and positive/negative schema-only fixtures.

Dependencies: jsonschema==4.25.1, rfc3339-validator==0.1.4.
Run sync_animation_contracts.py --check separately to verify Rust authority.
This checks file shape only; no asset creation or engine acceptance is claimed.
"""
import json
from pathlib import Path
from jsonschema import Draft202012Validator, FormatChecker

SCHEMAS = ["anim2d_frames.v1", "anim3d_skeleton_map.v1", "character_3d_spec", "anim_2d_spec", "anim_3d_spec", "rig_profile.v1", "asset_pack_manifest_v2"]


def main():
  root = Path(__file__).resolve().parents[3] / "test_data/game_assets/contracts"
  passed = 0
  for name in SCHEMAS:
    schema = json.loads((root / "schemas" / f"{name}.schema.json").read_text())
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    fixtures = sorted((root / "fixtures" / name).glob("*.json"))
    assert fixtures, f"Missing fixtures for {name}"
    assert any(file.name.startswith("valid_") for file in fixtures)
    assert any(file.name.startswith("invalid_") for file in fixtures)
    for file in fixtures:
      assert file.name.startswith(("valid_", "invalid_")), f"Unclassified fixture {file}"
      errors = list(validator.iter_errors(json.loads(file.read_text())))
      valid = file.name.startswith("valid_")
      assert bool(errors) != valid, f"{file}: expected valid={valid}; {[e.message for e in errors[:3]]}"
      passed += 1
  print(json.dumps({"schemas": len(SCHEMAS), "fixtures_passed": passed, "scope": "schema_only", "production_or_engine_acceptance": False}))


if __name__ == "__main__":
  main()
