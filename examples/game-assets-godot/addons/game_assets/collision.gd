class_name GameAssetCollisionBuilder
extends RefCounted
## Builds Godot physics nodes from a manifest collision block (plan
## 13.5: "Godot 可生成对应物理节点"; v1 supports none and box — anything
## else is an explicit failure, never a silent downgrade).

const KIND_NONE := "none"
const BOX := "box"


## Build the physics nodes for one prop's mesh block. Returns an empty
## array for kind "none" and [StaticBody3D] (with a CollisionShape3D
## child) for kind "box"; returns null (and appends to `errors`) for a
## malformed/unsupported description. Typed Variant because GDScript
## return annotations are non-nullable and null IS a documented result.
static func build(mesh: Dictionary, errors: PackedStringArray) -> Variant:
	if mesh.is_empty():
		errors.append("mesh block missing: no collision to build")
		return null
	var collision_variant: Variant = mesh.get("collision", {})
	if not (collision_variant is Dictionary):
		errors.append("collision block must be an object (malformed pack input)")
		return null
	var collision: Dictionary = collision_variant
	if collision.is_empty():
		errors.append("collision block missing (required by the mesh contract)")
		return null
	var kind := String(collision.get("kind", ""))
	match kind:
		KIND_NONE:
			return []
		BOX:
			var box: Variant = _build_box(collision, errors)
			if box == null:
				return null
			return [box]
		_:
			errors.append("unsupported collision shape '%s': first version supports none and box only" % kind)
			return null


static func _build_box(collision: Dictionary, errors: PackedStringArray) -> Variant:
	var center_variant: Variant = collision.get("center", [])
	var half_variant: Variant = collision.get("half_extents", [])
	if not (center_variant is Array) or not (half_variant is Array):
		errors.append("box collision center and half_extents must be arrays")
		return null
	var center_array: Array = center_variant
	var half_array: Array = half_variant
	if center_array.size() != 3 or half_array.size() != 3:
		errors.append("box collision needs center and half_extents arrays of 3 numbers")
		return null
	var half := Vector3(float(half_array[0]), float(half_array[1]), float(half_array[2]))
	if half.x <= 0.0 or half.y <= 0.0 or half.z <= 0.0:
		errors.append("box collision half extents must be > 0 on every axis")
		return null
	var center := Vector3(float(center_array[0]), float(center_array[1]), float(center_array[2]))

	var shape := BoxShape3D.new()
	shape.size = half * 2.0
	var shape_node := CollisionShape3D.new()
	shape_node.shape = shape
	shape_node.position = center

	var body := StaticBody3D.new()
	body.name = "GameAssetCollision"
	body.add_child(shape_node)
	return body
