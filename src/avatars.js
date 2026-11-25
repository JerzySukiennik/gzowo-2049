// avatars.js — loads the Quaternius Animated Robot GLB (robot2.glb) once, clones a
// skinned avatar per entity via SkeletonUtils, tints its 'Main' material, scales to a
// runtime-measured height and grounds feet at y=0, and maps game anim states to clips
// with 0.2s crossfades. Clip names are the pipe-joined Mixamo-style strings
// ('RobotArmature|RobotArmature|Robot_Idle', ...), so they are matched tolerantly by the
// suffix after the last '_' (or /Robot_(\w+)$/) rather than hardcoded in full. One
// AnimationMixer per avatar; advanced by the caller from the fixed-timestep step. Height
// is measured by unioning each posed SkinnedMesh.computeBoundingBox() in group space —
// Box3.setFromObject lies for skinned models and would scale every robot to a few cm.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

const CLIP_FOR = { idle: 'idle', walk: 'walking', run: 'running', dance: 'dance', wave: 'wave', arrested: 'walking', sitting: 'sitting', carried: 'sitting', death: 'death' };
const TIMESCALE = { arrested: 0.5 };
const FADE = 0.2;

let prototypeData = null;
let loadPromise = null;

export function loadAvatarPrototype(url = './assets/models/robot2.glb') {
  if (loadPromise) return loadPromise;
  const loader = new GLTFLoader();
  loadPromise = new Promise((resolve) => {
    loader.load(
      url,
      (gltf) => {
        // Strip scale tracks: the Blender FBX->GLB export bakes the armature's
        // unit-conversion scale into every clip, so the first mixer update
        // shrinks the whole model ~5x. Nothing in these clips animates scale
        // intentionally.
        for (const clip of gltf.animations) {
          clip.tracks = clip.tracks.filter((t) => !t.name.endsWith('.scale'));
        }
        prototypeData = { scene: gltf.scene, animations: gltf.animations };
        resolve(prototypeData);
      },
      undefined,
      () => { prototypeData = null; resolve(null); }
    );
  });
  return loadPromise;
}

export function isReady() { return !!prototypeData; }

// Tolerant clip key: last token after '_' in the pipe-joined clip name, lowercased.
function clipKey(name) {
  const m = /Robot_(\w+)$/.exec(name);
  if (m) return m[1].toLowerCase();
  const parts = String(name).split('_');
  return parts[parts.length - 1].toLowerCase();
}

function measureSkinned(group) {
  // Box3.setFromObject (three r15x+) accounts for skinning/bind pose at
  // runtime — geometry boundingBox does NOT (armature vs node scale from the
  // FBX->GLB export makes it lie ~5x here).
  group.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(group);
}

function tintMaterial(mat, bodyColor, accent) {
  const m = mat.clone();
  // The Blender FBX import carries TransparencyFactor=0 into the GLB —
  // materials arrive with opacity 0 and render invisible. Force opaque.
  m.opacity = 1;
  m.transparent = false;
  if (mat.name === 'Main') {
    m.color = bodyColor.clone();
    m.emissive = accent ? new THREE.Color(accent).multiplyScalar(0.5) : bodyColor.clone().multiplyScalar(0.12);
  }
  return m;
}

export function createAvatar({ color = '#ffffff', accent = null, height = 1.5 } = {}) {
  if (!prototypeData) return null;

  const group = new THREE.Group();
  const model = skeletonClone(prototypeData.scene);
  const bodyColor = new THREE.Color(color);

  model.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) {
      o.castShadow = true;
      o.frustumCulled = false;
      if (Array.isArray(o.material)) o.material = o.material.map((m) => tintMaterial(m, bodyColor, accent));
      else o.material = tintMaterial(o.material, bodyColor, accent);
    }
  });

  group.add(model);

  const size = new THREE.Vector3();
  measureSkinned(group).getSize(size);
  const s = size.y > 0.0001 ? height / size.y : 1;
  model.scale.setScalar(s);

  model.position.y -= measureSkinned(group).min.y;

  const mixer = new THREE.AnimationMixer(model);
  const actions = {};
  for (const clip of prototypeData.animations) {
    const key = clipKey(clip.name);
    if (!actions[key]) actions[key] = mixer.clipAction(clip);
  }

  let current = null;
  function setAnim(name) {
    const key = CLIP_FOR[name] || 'idle';
    const next = actions[key] || actions.idle;
    if (!next) return;
    const ts = TIMESCALE[name] || 1;
    if (next === current) { next.setEffectiveTimeScale(ts); return; }
    if (current) current.fadeOut(FADE);
    next.reset().setEffectiveTimeScale(ts).setEffectiveWeight(1).fadeIn(FADE).play();
    current = next;
  }
  setAnim('idle');

  return {
    group,
    mixer,
    setAnim,
    update(dt) { mixer.update(dt); }
  };
}
