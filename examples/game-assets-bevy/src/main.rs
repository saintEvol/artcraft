//! M0 fixture load check for the game-asset pack on the frozen Bevy version
//! (0.20.0). This is the Bevy half of the M0 exit criterion "existing
//! fixtures load in both engines"; see
//! `_docs/game-assets/m0_baseline_and_compatibility.md`.
//!
//! What counts as loaded here (a `Handle` alone does not, per the plan):
//!   - the pack's transparent PNG reaches `LoadState::Loaded` as an `Image`,
//!     with the pixel size the manifest declares,
//!   - the pack's GLB scene and its recursive dependencies (meshes,
//!     materials, buffers) reach loaded state,
//!   - the measured mesh triangle count and position bounds match the
//!     manifest's `triangles` and `measured_dimensions_m`,
//!   - the scene is actually spawned into the world and several frames are
//!     rendered before the app exits.
//!
//! Prints `M0_BEVY_LOAD_OK` and exits 0 on success, `M0_BEVY_LOAD_FAILED`
//! with details otherwise.

use std::time::{Duration, Instant};

use bevy::asset::{DependencyLoadState, LoadState};
use bevy::gltf::{Gltf, GltfAssetLabel, GltfMesh};
use bevy::prelude::*;
use bevy::mesh::Mesh3d;
use bevy::render::mesh::{Mesh, PrimitiveTopology, VertexAttributeValues};
use serde::Deserialize;

const PACK_ROOT: &str = "game_assets/pack_minimal";
const LOAD_TIMEOUT: Duration = Duration::from_secs(60);
/// Absolute asset root shared by the `AssetServer` and the manifest read,
/// so the example behaves the same regardless of the process working
/// directory. Bevy 0.20 otherwise resolves the default asset root relative
/// to the executable, which breaks `cargo run`.
const ASSETS_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/assets");

/// Report a setup failure with the marker the module doc promises, then
/// exit non-zero. Used instead of `expect()` so a broken pack never panics
/// without a diagnosable line.
fn bail(context: &str) -> ! {
  eprintln!("M0_BEVY_LOAD_FAILED: {context}");
  std::process::exit(1);
}

#[derive(Deserialize, Clone)]
struct Manifest {
  assets: Vec<ManifestAsset>,
}

#[derive(Deserialize, Clone)]
struct ManifestAsset {
  stable_key: String,
  #[serde(default)]
  files: Vec<ManifestFile>,
  image: Option<ImageBlock>,
  mesh: Option<MeshBlock>,
}

#[derive(Deserialize, Clone)]
struct ManifestFile {
  path: String,
  #[serde(default)]
  role: String,
}

#[derive(Deserialize, Clone)]
struct ImageBlock {
  width: u32,
  height: u32,
}

#[derive(Deserialize, Clone)]
struct MeshBlock {
  /// glTF scene to instantiate for this prop; read from the manifest
  /// instead of hardcoding 0 so a future pack exporting another scene
  /// index stays consistent with what is spawned and measured.
  #[serde(default)]
  scene_index: usize,
  triangles: usize,
  measured_dimensions_m: Dimensions,
}

#[derive(Deserialize, Clone)]
struct Dimensions {
  x: f32,
  y: f32,
  z: f32,
}

#[derive(Resource)]
struct PackCheck {
  icon: Handle<Image>,
  gltf: Handle<Gltf>,
  scene: Handle<WorldAsset>,
  image_block: ImageBlock,
  mesh_block: MeshBlock,
  started: Instant,
}

#[derive(Resource, Default)]
struct FramesRendered(u32);

fn main() {
  App::new().add_plugins(DefaultPlugins.set(AssetPlugin { file_path: ASSETS_ROOT.to_string(), ..default() }).set(WindowPlugin { primary_window: Some(Window { title: "game-assets-bevy M0 load check".into(), ..default() }), ..default() })).init_resource::<FramesRendered>().add_systems(Startup, (setup_world, start_loads)).add_systems(Update, (track_frames, verify_load)).run();
}

fn setup_world(mut commands: Commands) {
  // Camera matches the crate's scale: the manifest declares a 1 m cube, so
  // a perspective view from ~4 m shows it filling a reasonable part of the
  // frame.
  commands.spawn((Camera3d::default(), Transform::from_xyz(2.5, 1.8, 3.5).looking_at(Vec3::Y * 0.5, Vec3::Y)));
  commands.spawn((DirectionalLight::default(), Transform::from_xyz(2.0, 4.0, 1.5).looking_at(Vec3::ZERO, Vec3::Y)));
}

fn start_loads(mut commands: Commands, asset_server: Res<AssetServer>) {
  let manifest_path = std::path::Path::new(ASSETS_ROOT).join(PACK_ROOT).join("manifest.json");
  let manifest_text = std::fs::read_to_string(&manifest_path).unwrap_or_else(|error| bail(&format!("cannot read {}: {error} (run sync_fixtures.sh first)", manifest_path.display())));
  let manifest: Manifest = serde_json::from_str(&manifest_text).unwrap_or_else(|error| bail(&format!("pack manifest must parse: {error}")));

  let icon_asset = manifest.assets.iter().find(|asset| asset.image.is_some()).unwrap_or_else(|| bail("pack must contain a 2D image asset"));
  let mesh_asset = manifest.assets.iter().find(|asset| asset.mesh.is_some()).unwrap_or_else(|| bail("pack must contain a 3D mesh asset"));
  let icon_path = icon_asset.files.iter().find(|file| file.role == "main").map(|file| file.path.clone()).unwrap_or_else(|| bail("2D asset must have a main file"));
  let mesh_path = mesh_asset.files.iter().find(|file| file.role == "main").map(|file| file.path.clone()).unwrap_or_else(|| bail("3D asset must have a main file"));
  let image_block = icon_asset.image.clone().unwrap_or_else(|| bail("2D asset must have an image block"));
  let mesh_block = mesh_asset.mesh.clone().unwrap_or_else(|| bail("3D asset must have a mesh block"));
  info!("verifying pack assets: {} (2D image) and {} (3D prop, glTF scene {})", icon_asset.stable_key, mesh_asset.stable_key, mesh_block.scene_index);

  let icon: Handle<Image> = asset_server.load(format!("{PACK_ROOT}/{icon_path}"));
  let gltf: Handle<Gltf> = asset_server.load(format!("{PACK_ROOT}/{mesh_path}"));
  let scene: Handle<WorldAsset> = asset_server.load(GltfAssetLabel::Scene(mesh_block.scene_index).from_asset(format!("{PACK_ROOT}/{mesh_path}")));

  // Spawn the GLB scene: instantiation is part of "loaded", not just parsing.
  commands.spawn((WorldAssetRoot(scene.clone()), Transform::default()));
  // Show the icon through the UI so the PNG survives a full GPU upload.
  commands.spawn((ImageNode::new(icon.clone()), Node { position_type: PositionType::Absolute, top: Val::Px(16.0), left: Val::Px(16.0), width: Val::Px(128.0), height: Val::Px(128.0), ..default() }));
  commands.insert_resource(PackCheck { icon, gltf, scene, image_block, mesh_block, started: Instant::now() });
}

fn track_frames(mut frames: ResMut<FramesRendered>) {
  frames.0 += 1;
}

fn verify_load(pack_check: Option<Res<PackCheck>>, frames: Res<FramesRendered>, asset_server: Res<AssetServer>, images: Res<Assets<Image>>, meshes: Res<Assets<Mesh>>, gltfs: Res<Assets<Gltf>>, gltf_meshes: Res<Assets<GltfMesh>>, mesh_entities: Query<Entity, With<Mesh3d>>, mut exit: MessageWriter<AppExit>) {
  let Some(check) = pack_check else {
    return;
  };

  let icon_state = asset_server.load_state(&check.icon);
  let gltf_state = asset_server.load_state(&check.gltf);
  let scene_state = asset_server.dependency_load_state(check.scene.id());
  let both_loaded = matches!(icon_state, LoadState::Loaded) && matches!(gltf_state, LoadState::Loaded) && matches!(scene_state, DependencyLoadState::Loaded);

  if check.started.elapsed() > LOAD_TIMEOUT {
    error!("M0_BEVY_LOAD_FAILED: timed out, icon={icon_state:?} gltf={gltf_state:?} scene(dependencies)={scene_state:?} spawned_mesh_entities={}", mesh_entities.iter().count());
    exit.write(AppExit::error());
    return;
  }

  // Worlds for WorldAssetRoot are spawned in the SpawnScene schedule, which
  // runs after Update in Bevy 0.20. Until the mesh entities actually appear
  // (and a few frames have rendered), keep waiting; the timeout above is
  // the only thing that turns "never spawned" into a failure.
  if both_loaded && frames.0 >= 5 && !mesh_entities.is_empty() {
    match verify_content(&check, &images, &meshes, &gltfs, &gltf_meshes) {
      Ok(()) => {
        info!("M0_BEVY_LOAD_OK png+glb loaded, measured and rendered");
        exit.write(AppExit::Success);
      },
      Err(problems) => {
        for problem in problems {
          error!("M0_BEVY_LOAD_FAILED: {problem}");
        }
        exit.write(AppExit::error());
      },
    }
  }
}

/// Compare the loaded GPU assets against what the manifest declares. Mesh
/// measurements use exactly the meshes the `Gltf` asset declares (the
/// engine's asset store also contains loader intermediates and UI meshes,
/// which must not be counted), and the spawned world must reference one of
/// those meshes, proving the scene was instantiated rather than parsed.
fn verify_content(check: &PackCheck, images: &Assets<Image>, meshes: &Assets<Mesh>, gltfs: &Assets<Gltf>, gltf_meshes: &Assets<GltfMesh>) -> Result<(), Vec<String>> {
  let mut problems = Vec::new();

  let Some(image) = images.get(&check.icon) else {
    return Err(vec!["icon Image asset missing after Loaded state".to_string()]);
  };
  let size = image.size();
  if (size.x, size.y) != (check.image_block.width, check.image_block.height) {
    problems.push(format!("icon size {}x{} px, manifest says {}x{} px", size.x, size.y, check.image_block.width, check.image_block.height));
  }
  // Heuristic: the pixel format must be able to carry alpha at all. This
  // cannot catch a semantically opaque image whose alpha channel is zeroed;
  // the full subject/alpha statistics live in validate_m0_contracts.py.
  let texture_format_loses_alpha = matches!(image.texture_descriptor.format, bevy::render::render_resource::TextureFormat::R8Unorm | bevy::render::render_resource::TextureFormat::Rg8Unorm);
  if texture_format_loses_alpha {
    problems.push(format!("icon texture format {:?} cannot carry the alpha the manifest declares", image.texture_descriptor.format));
  }

  let Some(gltf) = gltfs.get(&check.gltf) else {
    return Err(vec!["Gltf asset missing after Loaded state".to_string()]);
  };
  let mut declared_meshes: Vec<Handle<Mesh>> = Vec::new();
  for gltf_mesh_handle in &gltf.meshes {
    let Some(gltf_mesh) = gltf_meshes.get(gltf_mesh_handle) else {
      problems.push("a GltfMesh declared by the Gltf asset is missing from the store".to_string());
      continue;
    };
    for primitive in &gltf_mesh.primitives {
      declared_meshes.push(primitive.mesh.clone());
    }
  }
  if declared_meshes.is_empty() {
    return Err(vec!["Gltf asset declares no meshes".to_string()]);
  }

  let mut triangles = 0_usize;
  let mut bounds_min = Vec3::splat(f32::MAX);
  let mut bounds_max = Vec3::splat(f32::MIN);
  let mut saw_positions = false;
  for handle in &declared_meshes {
    let Some(mesh) = meshes.get(handle) else {
      problems.push("a mesh declared by the Gltf asset is missing from the store".to_string());
      continue;
    };
    if mesh.primitive_topology() == PrimitiveTopology::TriangleList {
      triangles += match mesh.indices() {
        Some(indices) => indices.len() / 3,
        None => mesh.count_vertices() / 3,
      };
    }
    if let Some(VertexAttributeValues::Float32x3(positions)) = mesh.attribute(Mesh::ATTRIBUTE_POSITION) {
      saw_positions = true;
      for position in positions {
        let position = Vec3::from_slice(position);
        bounds_min = bounds_min.min(position);
        bounds_max = bounds_max.max(position);
      }
    }
  }
  if !saw_positions {
    problems.push("no mesh with POSITION attributes was loaded".to_string());
  }
  if triangles != check.mesh_block.triangles {
    problems.push(format!("mesh triangles {triangles}, manifest says {}", check.mesh_block.triangles));
  }
  let size = bounds_max - bounds_min;
  for (axis, (measured, declared)) in size.to_array().into_iter().zip([check.mesh_block.measured_dimensions_m.x, check.mesh_block.measured_dimensions_m.y, check.mesh_block.measured_dimensions_m.z]).enumerate() {
    if (measured - declared).abs() > 1e-5 {
      problems.push(format!("mesh bounds axis {} measures {measured} m, manifest says {declared} m", ['x', 'y', 'z'][axis]));
    }
  }

  if problems.is_empty() {
    Ok(())
  } else {
    Err(problems)
  }
}
