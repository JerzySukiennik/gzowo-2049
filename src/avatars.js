// avatars.js — loads the RobotExpressive GLB once, clones a skinned avatar per entity via SkeletonUtils, tints its body material, scales to a runtime-measured height and grounds feet at y=0, and maps game anim states to clips with 0.2s crossfades. One AnimationMixer per avatar; advanced by the caller from the fixed-timestep step. Height is measured by unioning each SkinnedMesh.computeBoundingBox() (posed) in group space — Box3.setFromObject lies for this skinned model (reports ~148 units instead of ~1.6m), which would scale every robot down to a few centimetres.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

const CLIP_FOR = { idle: 'Idle', walk: 'Walking', run: 'Running', dance: 'Dance', arrested: 'Walking' };
const TIMESCALE = { arrested: 0.5 };
const FADE = 0.2;

let prototypeData = null;
let loadPromise = null;

export function loadAvatarPrototype(url = './assets/models/robot.glb') {
  if (loadPromise) return loadPromise;
  const loader = new GLTFLoader();
  loadPromise = new Promise((resolve) => {
    loader.load(
      url,
      (gltf) => { prototypeData = { scene: gltf.scene, animations: gltf.animations }; resolve(prototypeData); },
      undefined,
      () => { prototypeData = null; resolve(null); }
    );
  });
  return loadPromise;
}

export function isReady() { return !!prototypeData; }

function measureSkinned(group) {
  group.updateMatrixWorld(true);
  const box = new THREE.Box3();
  box.makeEmpty();
  const tmp = new THREE.Box3();
  let measured = 0;
  group.traverse((o) => {
    if (o.isSkinnedMesh && typeof o.computeBoundingBox === 'function') {
      o.computeBoundingBox();
      if (o.boundingBox) { tmp.copy(o.boundingBox).applyMatrix4(o.matrixWorld); box.union(tmp); measured++; }
    }
  });
  if (!measured) box.setFromObject(group);
  return box;
}

function tintMaterial(mat, bodyColor, accent) {
  const m = mat.clone();
  if (mat.name === 'Main') {
    m.color = bodyColor.clone();
    m.emissive = accent ? new THREE.Color(accent).multiplyScalar(0.5) : bodyColor.clone().multiplyScalar(0.12);
  }
  return m;
}

export function createAvatar({ color = '#ffffff', accent = null, height = 1.8 } = {}) {
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
  for (const clip of prototypeData.animations) actions[clip.name] = mixer.clipAction(clip);

  let current = null;
  function setAnim(name) {
    const clipName = CLIP_FOR[name] || 'Idle';
    const next = actions[clipName];
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
