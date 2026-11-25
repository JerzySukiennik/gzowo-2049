// manipulator.js — the "Manipulator": a procedural articulated robot arm standing just
// outside the prison gate. Built entirely from three.js primitives (pedestal + yawing
// turret + 2-bone arm with joint spheres + a 2-finger gripper) in the game's flat-shaded
// neon-dark palette. It idles with a slow scanning sweep, points menacingly at a nearby
// player, and — on the host/solo authority only — tracks a WANTED or under-escort robot
// that comes within reach of the gate, grabs it (analytic 2-bone IK reach, then the target
// teleport-follows the gripper), swings over the wall and drops it on a walkable yard cell.
// Visual arm motion runs on every client; only the grab DECISION and the held-target
// position are host-authoritative (positions then flow through the normal robot sync).

import * as THREE from 'three';

const L1 = 2.8;              // upper-arm length
const L2 = 2.5;              // forearm length
const SHOULDER_Y = 2.6;      // world height of the shoulder pivot
const GRAB_Y = 1.0;          // height on the target the gripper reaches for
const DETECT = 9;            // grab-trigger radius around the gate
const LEASH = 13;            // abort a track if the target strays past this from the gate
const GRAB_DIST = 2.6;       // gripper-to-target distance that confirms a grab
const TRACK_TIMEOUT = 3.5;   // reach for this long, then snap-grab anyway
const GRAB_HOLD = 1.5;       // seconds clamped shut before swinging
const SWING_SETTLE = 0.5;    // min swing time before releasing
const RELEASE_TIME = 1.0;    // lower-and-open duration
const COOLDOWN = 3.5;        // rest between grabs
const PLAYER_NOTICE = 6;     // idle menacing-point radius
const POSE_RATE = 5;         // joint smoothing rate (1/s)

const DEFAULT_PALETTE = { body: 0x2a2a34, metal: 0x14141c, joint: 0x3a3a46, accent: 0x00f0c8, alert: 0xff3860 };

const TMP = new THREE.Vector3();

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function dist2(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; }
function angDiff(a, b) { let d = a - b; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; }

export function init(opts) {
  const scene = opts.scene;
  const gs = opts.state;
  const nav = opts.nav;
  const hooks = opts.hooks || {};
  const BASE = opts.base || { x: 73, z: -48 };
  const GATE = opts.gate || { x: 70, z: -52 };
  const pal = Object.assign({}, DEFAULT_PALETTE, opts.palette || {});

  const YARD = { minX: 56, maxX: 84, minZ: -86, maxZ: -56 };
  const DROP_PREF = [
    { x: 70, z: -64 }, { x: 66, z: -66 }, { x: 74, z: -66 }, { x: 62, z: -68 },
    { x: 78, z: -68 }, { x: 70, z: -72 }, { x: 66, z: -60 }, { x: 74, z: -60 }
  ];

  // --- materials -----------------------------------------------------------
  const matBody = new THREE.MeshStandardMaterial({ color: pal.body, roughness: 0.6, metalness: 0.35, flatShading: true });
  const matMetal = new THREE.MeshStandardMaterial({ color: pal.metal, roughness: 0.8, metalness: 0.25, flatShading: true });
  const matJoint = new THREE.MeshStandardMaterial({ color: pal.joint, roughness: 0.4, metalness: 0.6, flatShading: true });
  const matAcc = new THREE.MeshBasicMaterial({ color: pal.accent });
  const matAlt = new THREE.MeshBasicMaterial({ color: pal.alert });

  function mesh(geo, material, cast) {
    const m = new THREE.Mesh(geo, material);
    if (cast) { m.castShadow = true; }
    return m;
  }

  // --- geometry hierarchy --------------------------------------------------
  const root = new THREE.Group();
  root.position.set(BASE.x, 0, BASE.z);

  const pedestal = mesh(new THREE.CylinderGeometry(1.3, 1.6, 1.4, 8), matMetal, true);
  pedestal.position.y = 0.7;
  root.add(pedestal);
  const collar = mesh(new THREE.CylinderGeometry(1.15, 1.15, 0.18, 8), matAcc, false);
  collar.position.y = 1.34;
  root.add(collar);

  const turret = new THREE.Group();
  turret.position.y = 1.4;
  root.add(turret);
  const turretBox = mesh(new THREE.BoxGeometry(2, 1.2, 2.2), matBody, true);
  turretBox.position.y = 0.6;
  turret.add(turretBox);
  const eye = mesh(new THREE.BoxGeometry(1.4, 0.34, 0.12), matAcc, false);
  eye.position.set(0, 0.7, 1.12);
  turret.add(eye);
  const beacon = mesh(new THREE.BoxGeometry(0.24, 0.24, 0.24), matAlt, false);
  beacon.position.set(0, 1.32, 0);
  turret.add(beacon);

  const shoulder = new THREE.Group();
  shoulder.position.set(0, 1.2, 0.2); // world y = 1.4 + 1.2 = SHOULDER_Y
  turret.add(shoulder);
  shoulder.add(mesh(new THREE.SphereGeometry(0.5, 12, 10), matJoint, true));
  const upper = mesh(new THREE.BoxGeometry(0.55, L1, 0.55), matBody, true);
  upper.position.y = L1 / 2;
  shoulder.add(upper);
  const upperStripe = mesh(new THREE.BoxGeometry(0.1, L1 * 0.7, 0.12), matAcc, false);
  upperStripe.position.set(0, L1 / 2, 0.3);
  shoulder.add(upperStripe);

  const elbow = new THREE.Group();
  elbow.position.y = L1;
  shoulder.add(elbow);
  elbow.add(mesh(new THREE.SphereGeometry(0.42, 12, 10), matJoint, true));
  const fore = mesh(new THREE.BoxGeometry(0.45, L2, 0.45), matBody, true);
  fore.position.y = L2 / 2;
  elbow.add(fore);
  const foreStripe = mesh(new THREE.BoxGeometry(0.09, L2 * 0.7, 0.1), matAcc, false);
  foreStripe.position.set(0, L2 / 2, 0.25);
  elbow.add(foreStripe);

  const wrist = new THREE.Group();
  wrist.position.y = L2;
  elbow.add(wrist);
  wrist.add(mesh(new THREE.SphereGeometry(0.32, 10, 8), matJoint, true));
  const gripBase = mesh(new THREE.BoxGeometry(0.5, 0.3, 0.5), matMetal, true);
  gripBase.position.y = 0.15;
  wrist.add(gripBase);

  const fingerL = new THREE.Group();
  fingerL.position.set(0, 0.3, 0.18);
  wrist.add(fingerL);
  const fingerLMesh = mesh(new THREE.BoxGeometry(0.14, 0.6, 0.14), matAcc, true);
  fingerLMesh.position.y = 0.3;
  fingerL.add(fingerLMesh);

  const fingerR = new THREE.Group();
  fingerR.position.set(0, 0.3, -0.18);
  wrist.add(fingerR);
  const fingerRMesh = mesh(new THREE.BoxGeometry(0.14, 0.6, 0.14), matAcc, true);
  fingerRMesh.position.y = 0.3;
  fingerR.add(fingerRMesh);

  const gripAnchor = new THREE.Object3D();
  gripAnchor.position.y = 0.55;
  wrist.add(gripAnchor);

  scene.add(root);

  // --- internal state ------------------------------------------------------
  const M = {
    fsm: 'IDLE',
    yaw: 0, pitch1: 0.4, pitch2: 0.8, grip: 1,
    yawTarget: 0, p1Target: 0.4, p2Target: 0.8, gripTarget: 1,
    targetId: null, grabYaw: 0, dropCell: null, dropYaw: 0,
    timer: 0, cooldown: 0, sweepT: 0,
    gripWorld: { x: BASE.x, y: SHOULDER_Y + L1 + L2, z: BASE.z },
    root, turret, shoulder, elbow, wrist, gripAnchor, fingerL, fingerR
  };

  function isHost() { return gs.mode === 'host' || gs.mode === 'solo'; }
  function robots() { return gs.robots; }
  function isWanted(r) { return !!(r.name && gs.wanted.includes(r.name.toLowerCase())); }

  // Analytic 2-bone IK in the arm's vertical plane after yawing the turret at the target.
  function ik(tx, ty, tz) {
    const dx = tx - BASE.x, dz = tz - BASE.z;
    const yaw = Math.atan2(dx, dz);
    const planar = Math.hypot(dx, dz);
    const dy = ty - SHOULDER_Y;
    let dist = Math.hypot(planar, dy);
    dist = clamp(dist, Math.abs(L1 - L2) + 0.05, L1 + L2 - 0.05);
    const phi = Math.atan2(planar, dy); // from +Y (up) toward +Z (forward)
    const a = Math.acos(clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1));
    const b = Math.acos(clamp((L1 * L1 + L2 * L2 - dist * dist) / (2 * L1 * L2), -1, 1));
    return { yaw, p1: phi - a, p2: Math.PI - b };
  }

  function findTarget() {
    let best = null, bestD = DETECT * DETECT;
    for (const r of robots().values()) {
      if (r.fsm === 'HELD' || r.fsm === 'JAILED') continue;
      if (!isWanted(r) && r.fsm !== 'CARRIED') continue;
      const d = dist2(r.p.x, r.p.z, GATE.x, GATE.z);
      if (d < bestD) { bestD = d; best = r; }
    }
    return best;
  }

  function stillTarget(r) {
    if (!r || r.fsm === 'HELD' || r.fsm === 'JAILED') return false;
    if (!isWanted(r) && r.fsm !== 'CARRIED') return false;
    return dist2(r.p.x, r.p.z, GATE.x, GATE.z) < LEASH * LEASH;
  }

  function findDropCell() {
    // Prefer the nearest free prison cell mouth (host owns cell occupancy).
    if (hooks.pickDropCell) { const c = hooks.pickDropCell(); if (c) return c; }
    for (const c of DROP_PREF) if (nav.isWalkable(c.x, c.z)) return c;
    for (let i = 0; i < 40; i++) {
      const x = YARD.minX + Math.random() * (YARD.maxX - YARD.minX);
      const z = YARD.minZ + Math.random() * (YARD.maxZ - YARD.minZ);
      if (nav.isWalkable(x, z)) return { x, z };
    }
    return { x: 70, z: -66 };
  }

  function enterGrab(r) {
    if (r.fsm === 'CARRIED' && r.captorId) {
      const officer = robots().get(r.captorId);
      if (officer && hooks.handOffEscort) hooks.handOffEscort(officer);
    }
    r.captorId = null;
    r.fsm = 'HELD';
    r.anim = 'arrested';
    if (r.heldY === undefined) r.heldY = 0;
    // Robot stays wanted while pinned — the HELD/JAILED states keep police off it,
    // so it can be jailed still-wanted and later broken out or pardoned.
    if (hooks.setAction) hooks.setAction(r, 'grabbed by the Manipulator', 'The Manipulator seized ' + r.name);
    M.grabYaw = M.yaw;
    M.fsm = 'GRAB';
    M.timer = 0;
  }

  function finishGrab() {
    const r = robots().get(M.targetId);
    if (r) {
      if (M.dropCell && M.dropCell.index != null && hooks.jailRobotInCell) hooks.jailRobotInCell(r, M.dropCell.index);
      else if (M.dropCell && hooks.jailRobotInYard) hooks.jailRobotInYard(r, M.dropCell);
      else { r.heldY = 0; r.fsm = 'WANDER'; }
    }
    M.targetId = null;
    M.dropCell = null;
    M.fsm = 'IDLE';
    M.timer = 0;
    M.cooldown = COOLDOWN;
  }

  function decide(dt) {
    switch (M.fsm) {
      case 'IDLE': {
        if (M.cooldown > 0) return;
        const t = findTarget();
        if (t) { M.targetId = t.id; M.fsm = 'TRACK'; M.timer = 0; }
        return;
      }
      case 'TRACK': {
        const r = robots().get(M.targetId);
        if (!stillTarget(r)) { M.fsm = 'IDLE'; M.targetId = null; M.timer = 0; return; }
        M.timer += dt;
        const g = M.gripWorld;
        const near = dist2(g.x, g.z, r.p.x, r.p.z) < GRAB_DIST * GRAB_DIST;
        if (near || M.timer > TRACK_TIMEOUT) enterGrab(r);
        return;
      }
      case 'GRAB': {
        M.timer += dt;
        if (M.timer > GRAB_HOLD) {
          M.dropCell = findDropCell();
          M.dropYaw = Math.atan2(M.dropCell.x - BASE.x, M.dropCell.z - BASE.z);
          M.fsm = 'SWING';
          M.timer = 0;
        }
        return;
      }
      case 'SWING': {
        M.timer += dt;
        if (Math.abs(angDiff(M.dropYaw, M.yaw)) < 0.14 && M.timer > SWING_SETTLE) { M.fsm = 'RELEASE'; M.timer = 0; }
        return;
      }
      case 'RELEASE': {
        M.timer += dt;
        if (M.timer > RELEASE_TIME) finishGrab();
        return;
      }
      default: M.fsm = 'IDLE';
    }
  }

  function computeDesiredPose(dt) {
    switch (M.fsm) {
      case 'IDLE': {
        M.sweepT += dt;
        const p = gs.player.p;
        if (dist2(p.x, p.z, BASE.x, BASE.z) < PLAYER_NOTICE * PLAYER_NOTICE) {
          M.yawTarget = Math.atan2(p.x - BASE.x, p.z - BASE.z);
          M.p1Target = 0.15; M.p2Target = 0.45; M.gripTarget = 0.5;
        } else {
          M.yawTarget = Math.sin(M.sweepT * 0.5) * 1.15;
          M.p1Target = 0.4; M.p2Target = 0.8; M.gripTarget = 1;
        }
        break;
      }
      case 'TRACK': {
        const r = robots().get(M.targetId);
        if (r) { const k = ik(r.p.x, GRAB_Y, r.p.z); M.yawTarget = k.yaw; M.p1Target = k.p1; M.p2Target = k.p2; M.gripTarget = 1; }
        break;
      }
      case 'GRAB': {
        M.yawTarget = M.grabYaw; M.p1Target = -0.15; M.p2Target = 1.3; M.gripTarget = 0.05;
        break;
      }
      case 'SWING': {
        M.yawTarget = M.dropYaw; M.p1Target = -0.1; M.p2Target = 1.2; M.gripTarget = 0.05;
        break;
      }
      case 'RELEASE': {
        const c = M.dropCell || GATE;
        const k = ik(c.x, GRAB_Y + 0.4, c.z);
        M.yawTarget = k.yaw; M.p1Target = k.p1; M.p2Target = k.p2;
        M.gripTarget = M.timer > RELEASE_TIME * 0.55 ? 1 : 0.05;
        break;
      }
    }
  }

  function applyPose(dt) {
    const s = 1 - Math.exp(-dt * POSE_RATE);
    M.yaw += angDiff(M.yawTarget, M.yaw) * s;
    M.pitch1 += (M.p1Target - M.pitch1) * s;
    M.pitch2 += (M.p2Target - M.pitch2) * s;
    M.grip += (M.gripTarget - M.grip) * s;

    turret.rotation.y = M.yaw;
    shoulder.rotation.x = M.pitch1;
    elbow.rotation.x = M.pitch2;
    const open = 0.12 + M.grip * 0.42;
    fingerL.rotation.x = open;
    fingerR.rotation.x = -open;

    root.updateMatrixWorld(true);
    gripAnchor.getWorldPosition(TMP);
    M.gripWorld.x = TMP.x; M.gripWorld.y = TMP.y; M.gripWorld.z = TMP.z;
  }

  function updateHeld() {
    if (M.fsm !== 'GRAB' && M.fsm !== 'SWING' && M.fsm !== 'RELEASE') return;
    if (!M.targetId) return;
    const r = robots().get(M.targetId);
    if (!r) { M.fsm = 'IDLE'; M.targetId = null; return; }
    const g = M.gripWorld;
    r.p.x = g.x; r.p.z = g.z;
    r.heldY = Math.max(0, g.y - 1.0);
    r.ry = M.yaw;
    r.fsm = 'HELD';
    r.anim = 'arrested';
    if (hooks.syncRobotMesh) hooks.syncRobotMesh(r);
  }

  function step(dt) {
    M.cooldown = Math.max(0, M.cooldown - dt);
    if (isHost()) decide(dt);
    computeDesiredPose(dt);
    applyPose(dt);
    if (isHost()) updateHeld();
  }

  return { step, state: M, root };
}
