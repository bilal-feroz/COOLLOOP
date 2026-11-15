"use client";

// Shared materials and procedural textures. Nothing is downloaded: every
// surface is a standard PBR material, and the few textures are drawn on a
// canvas at start-up.

import * as THREE from "three";

function canvasTexture(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  repeat: [number, number] = [1, 1],
  srgb = true,
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  draw(ctx, width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(...repeat);
  texture.anisotropy = 8;
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Deterministic pseudo-random numbers so the plant looks the same every run. */
export function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function speckle(ctx: CanvasRenderingContext2D, w: number, h: number, amount: number, seed: number) {
  const rand = seeded(seed);
  const image = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < image.data.length; i += 4) {
    const d = (rand() - 0.5) * amount;
    image.data[i] += d;
    image.data[i + 1] += d;
    image.data[i + 2] += d;
  }
  ctx.putImageData(image, 0, 0);
}

/** Insulated wall panels: vertical seams and a faint horizontal joint. */
function claddingTexture(base: string, seam: string, repeat: [number, number]) {
  return canvasTexture(
    128,
    256,
    (ctx, w, h) => {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, w, h);
      speckle(ctx, w, h, 7, 11);
      ctx.fillStyle = seam;
      ctx.fillRect(0, 0, 3, h);
      ctx.globalAlpha = 0.35;
      ctx.fillRect(0, h * 0.5, w, 2);
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(4, 0, 2, h);
    },
    repeat,
  );
}

/** Bolted steel tank plates. */
function plateTexture(repeat: [number, number]) {
  return canvasTexture(
    256,
    128,
    (ctx, w, h) => {
      ctx.fillStyle = "#b3ab9d";
      ctx.fillRect(0, 0, w, h);
      speckle(ctx, w, h, 10, 23);
      ctx.fillStyle = "rgba(48,42,34,0.55)";
      ctx.fillRect(0, 0, w, 2);
      ctx.fillRect(0, 0, 2, h);
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.fillRect(0, 3, w, 1);
      ctx.fillStyle = "rgba(36,31,25,0.5)";
      for (let x = 14; x < w; x += 22) ctx.fillRect(x, 6, 3, 3);
    },
    repeat,
  );
}

/** Coil fins of the air-cooled chillers. */
function finTexture(repeat: [number, number]) {
  return canvasTexture(
    64,
    64,
    (ctx, w, h) => {
      ctx.fillStyle = "#423d36";
      ctx.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x += 4) {
        ctx.fillStyle = x % 8 === 0 ? "#958c7d" : "#625b51";
        ctx.fillRect(x, 0, 2, h);
      }
      ctx.fillStyle = "rgba(18,16,13,0.6)";
      ctx.fillRect(0, 0, w, 2);
    },
    repeat,
  );
}

/** Raised-floor tiles, 0.6 m. */
function tileTexture(repeat: [number, number]) {
  return canvasTexture(
    128,
    128,
    (ctx, w, h) => {
      ctx.fillStyle = "#8a8378";
      ctx.fillRect(0, 0, w, h);
      speckle(ctx, w, h, 9, 5);
      ctx.strokeStyle = "rgba(36,31,25,0.7)";
      ctx.lineWidth = 2;
      ctx.strokeRect(0, 0, w, h);
    },
    repeat,
  );
}

/** Concrete with construction joints. */
function slabTexture(repeat: [number, number]) {
  return canvasTexture(
    256,
    256,
    (ctx, w, h) => {
      ctx.fillStyle = "#3d3a35";
      ctx.fillRect(0, 0, w, h);
      speckle(ctx, w, h, 12, 41);
      ctx.strokeStyle = "rgba(24,21,17,0.55)";
      ctx.lineWidth = 2;
      ctx.strokeRect(0, 0, w, h);
    },
    repeat,
  );
}

/** Rack door: perforated steel with status LEDs. Returns [map, emissiveMap]. */
function rackTextures(): [THREE.CanvasTexture, THREE.CanvasTexture] {
  const rand = seeded(91);
  const leds: [number, number, string][] = [];
  for (let y = 10; y < 248; y += 9) {
    if (rand() < 0.2) continue;
    const colour = rand() < 0.08 ? "#e2a440" : rand() < 0.55 ? "#f1e3c6" : "#7fc79a";
    leds.push([14 + Math.floor(rand() * 3) * 5, y, colour]);
    if (rand() < 0.45) leds.push([96 + Math.floor(rand() * 3) * 5, y, "#f1e3c6"]);
  }
  const map = canvasTexture(128, 256, (ctx, w, h) => {
    ctx.fillStyle = "#171512";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#0d0c0a";
    for (let y = 6; y < h - 4; y += 9) ctx.fillRect(8, y, w - 16, 6);
    ctx.fillStyle = "#2a2621";
    ctx.fillRect(0, 0, 4, h);
    ctx.fillRect(w - 4, 0, 4, h);
    ctx.fillRect(0, 0, w, 4);
    for (const [x, y, c] of leds) {
      ctx.fillStyle = c;
      ctx.fillRect(x, y + 2, 3, 2);
    }
  });
  const emissive = canvasTexture(128, 256, (ctx, w, h) => {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    for (const [x, y, c] of leds) {
      ctx.fillStyle = c;
      ctx.fillRect(x - 1, y + 1, 5, 4);
    }
  });
  return [map, emissive];
}

/** Soft round sprite for vapour plumes and warm exhaust. */
function puffTexture() {
  return canvasTexture(64, 64, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, "rgba(255,255,255,0.9)");
    g.addColorStop(0.45, "rgba(255,255,255,0.32)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

/** Flow marker for a pipe circuit: a soft bright dash on black, used as an
 *  emissive map. Animating its offset makes the dashes travel along the pipe. */
function flowTexture(): THREE.CanvasTexture {
  return canvasTexture(
    128,
    4,
    (ctx, w, h) => {
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, w, h);
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0.0, "#000000");
      g.addColorStop(0.5, "#000000");
      g.addColorStop(0.74, "#9a9a9a");
      g.addColorStop(0.8, "#ffffff");
      g.addColorStop(0.84, "#000000");
      g.addColorStop(1.0, "#000000");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    },
    [1, 1],
    false,
  );
}

const std = (color: string, roughness: number, metalness = 0, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });

const glow = (color: string, intensity = 1.6) =>
  new THREE.MeshStandardMaterial({ color: "#0e0d0b", emissive: color, emissiveIntensity: intensity, roughness: 0.4 });

export interface Circuit {
  /** Equipment id a click on this circuit selects. */
  id: string;
  material: THREE.MeshStandardMaterial;
  flow: THREE.CanvasTexture;
  /** Length of one flow dash in metres. */
  dash: number;
}

function circuit(id: string, base: string, glowColour: string, insulated = false): Circuit {
  const flow = flowTexture();
  const material = new THREE.MeshStandardMaterial({
    color: base,
    emissiveMap: flow,
    emissive: new THREE.Color(glowColour),
    emissiveIntensity: 0,
    roughness: insulated ? 0.78 : 0.42,
    metalness: insulated ? 0.05 : 0.35,
  });
  return { id, material, flow, dash: 4.2 };
}

function build() {
  const [rackMap, rackGlow] = rackTextures();
  const rackSide = std("#181613", 0.6, 0.5);
  const rackFront = new THREE.MeshStandardMaterial({
    map: rackMap,
    emissiveMap: rackGlow,
    emissive: new THREE.Color("#ffffff"),
    emissiveIntensity: 1.4,
    roughness: 0.55,
    metalness: 0.4,
  });

  return {
    // --- civil ---------------------------------------------------------------
    ground: std("#0d0c0a", 0.96),
    slab: new THREE.MeshStandardMaterial({ map: slabTexture([17, 14]), roughness: 0.93 }),
    asphalt: std("#191714", 0.95),
    marking: std("#8a7f63", 0.85),
    concrete: std("#67625a", 0.92),
    concreteDark: std("#44403a", 0.95),
    // --- buildings -------------------------------------------------------------
    cladLong: new THREE.MeshStandardMaterial({ map: claddingTexture("#d8cfbf", "#8e8576", [53, 1]), roughness: 0.62, metalness: 0.15 }),
    cladShort: new THREE.MeshStandardMaterial({ map: claddingTexture("#d8cfbf", "#8e8576", [33, 1]), roughness: 0.62, metalness: 0.15 }),
    cladPlant: new THREE.MeshStandardMaterial({ map: claddingTexture("#a39a8b", "#6b6357", [26, 1]), roughness: 0.6, metalness: 0.2 }),
    cladDark: std("#2f2b26", 0.6, 0.3),
    roof: std("#3b3732", 0.85, 0.1),
    cut: std("#1c1a17", 0.9),
    tile: new THREE.MeshStandardMaterial({ map: tileTexture([100, 38]), roughness: 0.5, metalness: 0.1 }),
    epoxy: std("#4a453e", 0.4, 0.05),
    walkway: std("#b28a22", 0.7),
    glazing: std("#101820", 0.12, 0.8, { emissive: "#f1c98a", emissiveIntensity: 0.22 }),
    // --- structure and metalwork ---------------------------------------------------
    steel: std("#a39d93", 0.42, 0.75),
    steelDark: std("#46413a", 0.5, 0.7),
    band: std("#4f4a42", 0.5, 0.7, { side: THREE.DoubleSide }),
    grating: std("#2d2924", 0.7, 0.6),
    frp: std("#c9c1b2", 0.58, 0.05),
    frpBand: std("#8f877a", 0.55, 0.1),
    stack: std("#b0a899", 0.5, 0.08, { side: THREE.DoubleSide }),
    louvre: std("#34302a", 0.6, 0.5),
    fan: std("#d8d2c6", 0.38, 0.55),
    // --- machines ----------------------------------------------------------------------
    chiller: std("#34444c", 0.38, 0.45),
    shell: std("#bdb5a6", 0.36, 0.6),
    insulation: std("#211e1a", 0.82, 0.02),
    motor: std("#57524a", 0.45, 0.5),
    pumpBody: std("#40656a", 0.42, 0.45),
    cabinet: std("#ddd5c6", 0.5, 0.2),
    guard: std("#c98a1c", 0.55, 0.3),
    coil: new THREE.MeshStandardMaterial({ map: finTexture([70, 1]), roughness: 0.5, metalness: 0.65 }),
    tankShell: new THREE.MeshStandardMaterial({ map: plateTexture([28, 7]), roughness: 0.5, metalness: 0.55 }),
    tankGhost: new THREE.MeshStandardMaterial({
      map: plateTexture([28, 7]),
      roughness: 0.5,
      metalness: 0.55,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
    water: std("#1f7f96", 0.12, 0.2, { emissive: "#0f5f74", emissiveIntensity: 0.35 }),
    stored: new THREE.MeshStandardMaterial({
      color: "#2aa7c4",
      emissive: "#1a8fae",
      emissiveIntensity: 0.6,
      roughness: 0.2,
      transparent: true,
      opacity: 0.78,
    }),
    // --- white space -------------------------------------------------------------------------
    rack: [rackFront, rackFront, rackSide, rackSide, rackSide, rackSide] as THREE.Material[],
    rackFront,
    crah: std("#cfc7b8", 0.5, 0.25),
    tray: std("#665f55", 0.5, 0.7),
    containment: new THREE.MeshStandardMaterial({
      color: "#d9632a",
      emissive: "#d9632a",
      emissiveIntensity: 0.5,
      transparent: true,
      opacity: 0.16,
      roughness: 0.2,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
    // --- indicators --------------------------------------------------------------------------------
    screen: glow("#f0dfbd", 1.1),
    lamp: glow("#ffd9a0", 2.4),
    gaugeBack: std("#0d0c0a", 0.7),
    gaugeFill: glow("#f0dfbd", 1.6),
    puff: puffTexture(),
    // --- pipe circuits (flow-animated) -------------------------------------------------------------------
    circuits: {
      CWS: circuit("PIPE-CWS", "#1f7d8c", "#58dcf0"),
      CWR: circuit("PIPE-CWR", "#a8542a", "#ffa56b"),
      CHWS: circuit("PIPE-CHWS", "#24549a", "#6fb1ff", true),
      CHWS_ROOF: circuit("PIPE-CHWS", "#24549a", "#6fb1ff", true),
      CHWR: circuit("PIPE-CHWR", "#4d6f96", "#b9d6f7", true),
      CHWR_ROOF: circuit("PIPE-CHWR", "#4d6f96", "#b9d6f7", true),
      MU: circuit("MU-01", "#4f8f9c", "#bdf1fa"),
      BD: circuit("BD-01", "#6f6247", "#e0c88f"),
    } as Record<string, Circuit>,
  };
}

let cache: ReturnType<typeof build> | null = null;

/** Lazily built on first use so nothing touches `document` during import. */
export function materials() {
  if (!cache) cache = build();
  return cache;
}

export const STATE_COLOURS: Record<string, string> = {
  running: "#ecdcbc",
  standby: "#7d7466",
  off: "#3a352e",
  warning: "#e2a440",
  fault: "#e5604f",
};
