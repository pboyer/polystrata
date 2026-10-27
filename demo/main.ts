import {
  type CycleDiagnostic,
  initPolystrata,
  inspectPipeline,
  type KernelResult,
  type Loop2D,
  type PipelineInspection,
  type Point2D,
  signedLoopArea,
  type WindingRule,
} from "../src/index.js";
import {
  DEMO_SCENARIOS,
  type DemoOp,
  type DemoScenario,
  type EditableBody,
  editableBodyToShapeInput,
} from "./examples.js";
import {
  type FuzzCumulativeStats,
  type FuzzTrialRecord,
  Prng,
  rawLoopWindingNumber,
  runSingleFuzzTrial,
} from "./fuzzer.js";
import { alpha, initTheme, onThemeChange, palette } from "./theme.js";

interface PipelineRunSnapshot {
  inspection: PipelineInspection;
  diagnostics: CycleDiagnostic[];
  result: KernelResult;
  elapsedMs: number;
  activeVertexCount: number;
  activeEdgeCount: number;
  totalArea: number;
}

interface ViewTransform {
  centerX: number;
  centerY: number;
  scale: number; // pixels per world unit
}

interface DragTarget {
  kind: "vertex" | "body" | "pan";
  pointRef?: Point2D;
  bodyRef?: EditableBody;
  startScreenX: number;
  startScreenY: number;
  lastWorldX: number;
  lastWorldY: number;
}

// Application State
let activeTab: "examples" | "fuzzer" = "examples";
let currentScenario: DemoScenario = DEMO_SCENARIOS[0]!;
let bodyA: EditableBody = { loops: [], segments: [] };
let bodyB: EditableBody = { loops: [], segments: [] };
let bodyC: EditableBody = { loops: [], segments: [] };

let currentOp: DemoOp = "difference";
let currentWindingRule: WindingRule = "positive";
let customSnapTolerance: number | null = null;
let simplifyCollinear = true;

// Layer visibility
let showLayerInput = true;
let showLayerOutputFill = true;
let showLayerOutputEdges = true;
let showLayerConsolidated = false;
let showLayerRadii = false;
let showLayerSamples = true;

let latestSnapshot: PipelineRunSnapshot | null = null;

// View & Interaction State
const view: ViewTransform = { centerX: 0, centerY: 0, scale: 8 };
let dragTarget: DragTarget | null = null;
let hoveredPointRef: Point2D | null = null;
let spacePressed = false;

// Fuzzer State
const fuzzRng = new Prng(195939070);
let fuzzRunning = false;
let fuzzAnimFrame = 0;
let fuzzMaxVerts = 9;
let fuzzDegenRate = 40;
let fuzzDisplayOp: "union" | "intersect" | "difference" | "xor" = "union";
const fuzzHistory: FuzzTrialRecord[] = [];
let selectedFuzzTrial: FuzzTrialRecord | null = null;
const fuzzStats: FuzzCumulativeStats = {
  trials: 0,
  totalBooleanOps: 0,
  manifoldPass: 0,
  crossingPass: 0,
  areaPass: 0,
  windingChecks: 0,
  windingPass: 0,
  totalElapsedMs: 0,
};

// DOM Elements
const canvas = document.getElementById("kernel-canvas") as HTMLCanvasElement;
const ctx2d = canvas.getContext("2d")!;

function worldToScreen(wx: number, wy: number): { x: number; y: number } {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  return {
    x: w * 0.5 + (wx - view.centerX) * view.scale,
    y: h * 0.5 - (wy - view.centerY) * view.scale,
  };
}

function screenToWorld(sx: number, sy: number): { x: number; y: number } {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  return {
    x: view.centerX + (sx - w * 0.5) / view.scale,
    y: view.centerY - (sy - h * 0.5) / view.scale,
  };
}

function applyWindingRule(w: number, rule: WindingRule): boolean {
  const wi = Math.round(w);
  switch (rule) {
    case "positive":
      return wi > 0;
    case "nonZero":
      return wi !== 0;
    case "evenOdd":
      return (wi & 1) !== 0;
  }
}

function buildPredicate(op: DemoOp, rule: WindingRule): (w: ReadonlyArray<number>) => boolean {
  switch (op) {
    case "heal":
      return (w) =>
        applyWindingRule((w[0] ?? 0) + (w[1] ?? 0) + (w[2] ?? 0), rule);
    case "union":
      return (w) =>
        applyWindingRule(w[0] ?? 0, rule) || applyWindingRule(w[1] ?? 0, rule);
    case "intersect":
      return (w) =>
        applyWindingRule(w[0] ?? 0, rule) && applyWindingRule(w[1] ?? 0, rule);
    case "difference":
      return (w) =>
        applyWindingRule(w[0] ?? 0, rule) && !applyWindingRule(w[1] ?? 0, rule);
    case "xor":
      return (w) =>
        applyWindingRule(w[0] ?? 0, rule) !== applyWindingRule(w[1] ?? 0, rule);
    case "custom3":
      return (w) =>
        (applyWindingRule(w[0] ?? 0, rule) || applyWindingRule(w[1] ?? 0, rule)) &&
        !applyWindingRule(w[2] ?? 0, rule);
  }
}

function runPipeline(): PipelineRunSnapshot {
  const inputs = [
    editableBodyToShapeInput(bodyA),
    editableBodyToShapeInput(bodyB),
    editableBodyToShapeInput(bodyC),
  ];

  const predicate = buildPredicate(currentOp, currentWindingRule);
  const t0 = performance.now();
  const inspection = inspectPipeline(inputs, predicate, {
    snapTolerance: customSnapTolerance ?? undefined,
    simplifyCollinear,
    windingRule: currentWindingRule,
  });
  const elapsedMs = performance.now() - t0;

  const { complex, diagnostics, result } = inspection;

  let activeVertexCount = 0;
  for (let v = 0; v < complex.vertexCount; v++) {
    if (complex.vAlive[v]) activeVertexCount++;
  }
  let activeEdgeCount = 0;
  for (let e = 0; e < complex.edgeCount; e++) {
    if (complex.eAlive[e]) activeEdgeCount++;
  }

  let totalArea = 0;
  for (const loop of result.loops) {
    totalArea += signedLoopArea(loop);
  }

  return {
    inspection,
    diagnostics,
    result,
    elapsedMs,
    activeVertexCount,
    activeEdgeCount,
    totalArea,
  };
}

function collectAllInputPoints(): Point2D[] {
  const pts: Point2D[] = [];
  for (const body of [bodyA, bodyB, bodyC]) {
    for (const loop of body.loops) {
      for (const p of loop) pts.push(p);
    }
    for (const seg of body.segments) {
      pts.push(seg.p0, seg.p1);
    }
  }
  return pts;
}

function fitViewToGeometry(): void {
  const pts = collectAllInputPoints();
  if (pts.length === 0) {
    view.centerX = 0;
    view.centerY = 0;
    view.scale = 8;
    return;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  view.centerX = 0.5 * (minX + maxX);
  view.centerY = 0.5 * (minY + maxY);
  const spanX = Math.max(maxX - minX, 1e-3);
  const spanY = Math.max(maxY - minY, 1e-3);
  const w = Math.max(canvas.clientWidth, 300);
  const h = Math.max(canvas.clientHeight, 300);
  view.scale = 0.76 * Math.min(w / spanX, h / spanY);
}

function loadScenario(scenario: DemoScenario): void {
  currentScenario = scenario;
  const created = scenario.createBodies();
  bodyA = created.bodyA;
  bodyB = created.bodyB;
  bodyC = created.bodyC;

  currentOp = scenario.defaultOp;
  currentWindingRule = scenario.defaultWindingRule;
  customSnapTolerance = scenario.defaultSnapTolerance;
  simplifyCollinear = scenario.defaultSimplifyCollinear;
  showLayerConsolidated = scenario.defaultShowConsolidated ?? false;
  showLayerRadii = scenario.defaultShowRadii ?? false;

  syncControlsFromState();
  fitViewToGeometry();
  recomputeAndRender();
}

function syncControlsFromState(): void {
  document.getElementById("active-scenario-title")!.textContent =
    activeTab === "fuzzer" && selectedFuzzTrial
      ? `Fuzz Trial #${selectedFuzzTrial.trialNumber} (Seed ${selectedFuzzTrial.seedBefore})`
      : currentScenario.title;
  document.getElementById("scenario-description")!.textContent =
    activeTab === "fuzzer" && selectedFuzzTrial
      ? `Automated Fuzz Trial #${selectedFuzzTrial.trialNumber}: Area error = ${selectedFuzzTrial.areaError.toExponential(2)}, ${selectedFuzzTrial.probes.length} winding oracle probes verified.`
      : currentScenario.description;

  document.querySelectorAll("#op-selector .op-btn").forEach((btn) => {
    const el = btn as HTMLButtonElement;
    el.classList.toggle("active", el.dataset.op === currentOp);
  });

  document.querySelectorAll("#winding-selector .seg-btn").forEach((btn) => {
    const el = btn as HTMLButtonElement;
    el.classList.toggle("active", el.dataset.rule === currentWindingRule);
  });

  const tolSlider = document.getElementById("slider-snap-tol") as HTMLInputElement;
  const tolLabel = document.getElementById("val-snap-tol")!;
  if (customSnapTolerance === null) {
    tolSlider.value = "-9";
    tolLabel.textContent = "Auto (1e-9 L)";
  } else {
    tolSlider.value = String(Math.log10(customSnapTolerance));
    tolLabel.textContent =
      customSnapTolerance >= 1e-2
        ? customSnapTolerance.toFixed(3)
        : customSnapTolerance.toExponential(1);
  }

  (document.getElementById("chk-simplify-collinear") as HTMLInputElement).checked =
    simplifyCollinear;
  (document.getElementById("chk-layer-input") as HTMLInputElement).checked = showLayerInput;
  (document.getElementById("chk-layer-output-fill") as HTMLInputElement).checked =
    showLayerOutputFill;
  (document.getElementById("chk-layer-output-edges") as HTMLInputElement).checked =
    showLayerOutputEdges;
  (document.getElementById("chk-layer-consolidated") as HTMLInputElement).checked =
    showLayerConsolidated;
  (document.getElementById("chk-layer-radii") as HTMLInputElement).checked = showLayerRadii;
  (document.getElementById("chk-layer-samples") as HTMLInputElement).checked = showLayerSamples;

  document.getElementById("btn-tol-auto")!.classList.toggle("active", customSnapTolerance === null);
  document.getElementById("btn-tol-micro")!.classList.toggle("active", customSnapTolerance === 1e-4);
  document.getElementById("btn-tol-coarse")!.classList.toggle("active", customSnapTolerance === 0.25);

  document.querySelectorAll(".example-card").forEach((card) => {
    const el = card as HTMLElement;
    el.classList.toggle("active", el.dataset.id === currentScenario.id);
  });
  (document.getElementById("scenario-select") as HTMLSelectElement).value = currentScenario.id;
}

function setActiveTab(tab: "examples" | "fuzzer"): void {
  activeTab = tab;
  for (const [id, name] of [
    ["tab-examples", "examples"],
    ["tab-fuzzer", "fuzzer"],
  ] as const) {
    const el = document.getElementById(id)!;
    el.classList.toggle("active", name === tab);
    el.setAttribute("aria-selected", String(name === tab));
  }
  document.getElementById("panel-examples")!.classList.toggle("hidden", tab !== "examples");
  document.getElementById("panel-fuzzer")!.classList.toggle("hidden", tab !== "fuzzer");
}

function updateMetricsAndDiagnostics(snap: PipelineRunSnapshot): void {
  document.getElementById("metric-time")!.textContent = `${snap.elapsedMs.toFixed(2)} ms`;
  document.getElementById("metric-ve")!.textContent =
    `${snap.activeVertexCount} / ${snap.activeEdgeCount}`;

  let holeCount = 0;
  for (const p of snap.result.polygons) holeCount += p.holes.length;
  document.getElementById("metric-loops")!.textContent =
    `${snap.result.polygons.length} (${holeCount} holes)`;
  document.getElementById("metric-area")!.textContent = snap.totalArea.toFixed(2);

  const { normalization, cycleCount } = snap.inspection;
  const diagEl = document.getElementById("pipeline-diagnostics")!;
  const keptCycles = snap.diagnostics.filter((d) => d.keep).length;
  diagEl.innerHTML = `
    <div class="diag-row"><span>Centering Offset C:</span><span class="diag-val">(${normalization.cx.toFixed(1)}, ${normalization.cy.toFixed(1)})</span></div>
    <div class="diag-row"><span>BBox Diagonal L:</span><span class="diag-val">${normalization.diagonal.toFixed(3)}</span></div>
    <div class="diag-row"><span>Baseline Tol r₀:</span><span class="diag-val">${normalization.r0.toExponential(2)}</span></div>
    <div class="diag-row"><span>Max Radius Cap r_max:</span><span class="diag-val">${normalization.rMax.toExponential(2)}</span></div>
    <div class="diag-row"><span>Raw Input Segments:</span><span class="diag-val">${normalization.segmentCount}</span></div>
    <div class="diag-row"><span>Active Verts / Edges:</span><span class="diag-val">${snap.activeVertexCount} / ${snap.activeEdgeCount}</span></div>
    <div class="diag-row"><span>Planar Half-Edge Cycles:</span><span class="diag-val">${cycleCount} (${keptCycles} kept)</span></div>
    <div class="diag-row"><span>Output Outer Shells:</span><span class="diag-val">${snap.result.polygons.length}</span></div>
    <div class="diag-row"><span>Output Interior Holes:</span><span class="diag-val">${holeCount}</span></div>
  `;
}

function drawGrid(w: number, h: number): void {
  const rawStep = 90 / view.scale;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  let step = mag;
  if (rawStep / mag > 5) step = 10 * mag;
  else if (rawStep / mag > 2) step = 5 * mag;
  else if (rawStep / mag > 1) step = 2 * mag;

  const topLeft = screenToWorld(0, 0);
  const bottomRight = screenToWorld(w, h);

  const startX = Math.floor(topLeft.x / step) * step;
  const endX = Math.ceil(bottomRight.x / step) * step;
  const startY = Math.floor(bottomRight.y / step) * step;
  const endY = Math.ceil(topLeft.y / step) * step;

  const pal = palette();
  ctx2d.lineWidth = 1;
  ctx2d.font = "10px Inter, sans-serif";

  for (let gx = startX; gx <= endX; gx += step) {
    const sx = worldToScreen(gx, 0).x;
    const isZero = Math.abs(gx) < step * 1e-6;
    ctx2d.strokeStyle = isZero ? pal.axis : pal.grid;
    ctx2d.beginPath();
    ctx2d.moveTo(sx, 0);
    ctx2d.lineTo(sx, h);
    ctx2d.stroke();

    ctx2d.fillStyle = pal.gridLabel;
    const label = Math.abs(gx) >= 1e5 ? gx.toFixed(0) : Number(gx.toPrecision(6)).toString();
    ctx2d.fillText(label, sx + 4, h - 6);
  }

  for (let gy = startY; gy <= endY; gy += step) {
    const sy = worldToScreen(0, gy).y;
    const isZero = Math.abs(gy) < step * 1e-6;
    ctx2d.strokeStyle = isZero ? pal.axis : pal.grid;
    ctx2d.beginPath();
    ctx2d.moveTo(0, sy);
    ctx2d.lineTo(w, sy);
    ctx2d.stroke();

    ctx2d.fillStyle = pal.gridLabel;
    const label = Math.abs(gy) >= 1e5 ? gy.toFixed(0) : Number(gy.toPrecision(6)).toString();
    ctx2d.fillText(label, 6, sy - 4);
  }
}

function drawArrowhead(x0: number, y0: number, x1: number, y1: number, size = 6): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < size * 2.2) return;
  const mx = x0 + 0.58 * dx;
  const my = y0 + 0.58 * dy;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;

  ctx2d.beginPath();
  ctx2d.moveTo(mx + ux * size * 0.5, my + uy * size * 0.5);
  ctx2d.lineTo(mx - ux * size * 0.5 + px * size * 0.42, my - uy * size * 0.5 + py * size * 0.42);
  ctx2d.lineTo(mx - ux * size * 0.5 - px * size * 0.42, my - uy * size * 0.5 - py * size * 0.42);
  ctx2d.closePath();
  ctx2d.fill();
}

function drawEditableBody(body: EditableBody, strokeColor: string, fillColor: string): void {
  ctx2d.save();
  ctx2d.strokeStyle = strokeColor;
  ctx2d.fillStyle = fillColor;
  ctx2d.lineWidth = 1.5;
  ctx2d.setLineDash([5, 4]);

  for (const loop of body.loops) {
    if (loop.length < 2) continue;
    ctx2d.beginPath();
    for (let i = 0; i < loop.length; i++) {
      const s = worldToScreen(loop[i]!.x, loop[i]!.y);
      if (i === 0) ctx2d.moveTo(s.x, s.y);
      else ctx2d.lineTo(s.x, s.y);
    }
    ctx2d.closePath();
    ctx2d.fill();
    ctx2d.stroke();
  }

  for (const seg of body.segments) {
    const s0 = worldToScreen(seg.p0.x, seg.p0.y);
    const s1 = worldToScreen(seg.p1.x, seg.p1.y);
    ctx2d.beginPath();
    ctx2d.moveTo(s0.x, s0.y);
    ctx2d.lineTo(s1.x, s1.y);
    ctx2d.stroke();
  }

  ctx2d.setLineDash([]);
  // Draw vertex handles
  const drawHandle = (p: Point2D) => {
    const s = worldToScreen(p.x, p.y);
    const isHovered = p === hoveredPointRef || (dragTarget?.pointRef === p);
    ctx2d.beginPath();
    ctx2d.arc(s.x, s.y, isHovered ? 6 : 3.6, 0, Math.PI * 2);
    ctx2d.fillStyle = isHovered ? palette().bg : strokeColor;
    ctx2d.fill();
    if (isHovered) {
      ctx2d.lineWidth = 2;
      ctx2d.strokeStyle = strokeColor;
      ctx2d.stroke();
    }
  };

  for (const loop of body.loops) {
    for (const p of loop) drawHandle(p);
  }
  for (const seg of body.segments) {
    drawHandle(seg.p0);
    drawHandle(seg.p1);
  }

  ctx2d.restore();
}

function drawConsolidatedComplex(snap: PipelineRunSnapshot): void {
  const { complex, normalization } = snap.inspection;
  const { vertexCount, edgeCount, bodyCount, vx, vy, vr, vAlive, ev0, ev1, eAlive, eDeltaW } =
    complex;
  const { cx, cy } = normalization;
  const pal = palette();
  ctx2d.save();

  if (showLayerRadii) {
    for (let v = 0; v < vertexCount; v++) {
      if (!vAlive[v]) continue;
      const s = worldToScreen(vx[v]! + cx, vy[v]! + cy);
      const radiusPx = Math.max(4, vr[v]! * view.scale);
      ctx2d.beginPath();
      ctx2d.arc(s.x, s.y, radiusPx, 0, Math.PI * 2);
      ctx2d.fillStyle = alpha(pal.sample, 0.12);
      ctx2d.strokeStyle = pal.radius;
      ctx2d.lineWidth = 1;
      ctx2d.fill();
      ctx2d.stroke();
    }
  }

  if (showLayerConsolidated) {
    ctx2d.font = "10px Inter, sans-serif";
    for (let e = 0; e < edgeCount; e++) {
      if (!eAlive[e]) continue;
      const u = ev0[e]!;
      const v = ev1[e]!;
      const s0 = worldToScreen(vx[u]! + cx, vy[u]! + cy);
      const s1 = worldToScreen(vx[v]! + cx, vy[v]! + cy);

      const base = e * bodyCount;
      let nonZeroDelta = false;
      for (let b = 0; b < bodyCount; b++) {
        if (eDeltaW[base + b] !== 0) {
          nonZeroDelta = true;
          break;
        }
      }
      ctx2d.strokeStyle = nonZeroDelta ? pal.deltaW : pal.edgeNeutral;
      ctx2d.lineWidth = nonZeroDelta ? 1.8 : 1.2;
      ctx2d.beginPath();
      ctx2d.moveTo(s0.x, s0.y);
      ctx2d.lineTo(s1.x, s1.y);
      ctx2d.stroke();

      const mx = 0.5 * (s0.x + s1.x);
      const my = 0.5 * (s0.y + s1.y);
      if (Math.hypot(s1.x - s0.x, s1.y - s0.y) > 28) {
        const d0 = eDeltaW[base] ?? 0;
        const d1 = bodyCount > 1 ? (eDeltaW[base + 1] ?? 0) : 0;
        const label = bodyCount > 1 ? `Δw=[${d0},${d1}]` : `Δw=[${d0}]`;
        ctx2d.fillStyle = pal.deltaW;
        ctx2d.fillText(label, mx + 3, my - 3);
      }
    }
  }

  ctx2d.restore();
}

function drawOutputBRep(result: KernelResult): void {
  const pal = palette();
  ctx2d.save();

  // 1. Fill polygons with holes using Canvas evenodd subpath rule
  if (showLayerOutputFill) {
    for (let pIdx = 0; pIdx < result.polygons.length; pIdx++) {
      const poly = result.polygons[pIdx]!;
      ctx2d.beginPath();

      const traceRing = (ring: Loop2D) => {
        for (let i = 0; i < ring.length; i++) {
          const s = worldToScreen(ring[i]!.x, ring[i]!.y);
          if (i === 0) ctx2d.moveTo(s.x, s.y);
          else ctx2d.lineTo(s.x, s.y);
        }
        ctx2d.closePath();
      };

      traceRing(poly.outer);
      for (const hole of poly.holes) {
        traceRing(hole);
      }

      ctx2d.fillStyle = pal.fills[pIdx % pal.fills.length]!;
      ctx2d.fill("evenodd");
    }
  }

  // 2. Draw oriented boundary edges & vertices
  if (showLayerOutputEdges) {
    for (const loop of result.loops) {
      const area = signedLoopArea(loop);
      const isOuter = area > 0;
      const color = isOuter ? pal.shell : pal.hole;
      ctx2d.strokeStyle = color;
      ctx2d.fillStyle = color;
      ctx2d.lineWidth = 1.75;

      const n = loop.length;
      ctx2d.beginPath();
      for (let i = 0; i < n; i++) {
        const s = worldToScreen(loop[i]!.x, loop[i]!.y);
        if (i === 0) ctx2d.moveTo(s.x, s.y);
        else ctx2d.lineTo(s.x, s.y);
      }
      ctx2d.closePath();
      ctx2d.stroke();

      // Draw directional arrowheads and vertex dots
      for (let i = 0; i < n; i++) {
        const s0 = worldToScreen(loop[i]!.x, loop[i]!.y);
        const s1 = worldToScreen(loop[(i + 1) % n]!.x, loop[(i + 1) % n]!.y);
        drawArrowhead(s0.x, s0.y, s1.x, s1.y, 7);

        ctx2d.beginPath();
        ctx2d.arc(s0.x, s0.y, 2.6, 0, Math.PI * 2);
        ctx2d.fill();
      }
    }
  }

  ctx2d.restore();
}

function drawSamplePoints(snap: PipelineRunSnapshot): void {
  if (!showLayerSamples) return;
  const pal = palette();
  ctx2d.save();
  ctx2d.font = "10px Inter, sans-serif";

  for (const diag of snap.diagnostics) {
    const s = worldToScreen(diag.samplePoint.x, diag.samplePoint.y);
    ctx2d.beginPath();
    ctx2d.arc(s.x, s.y, 3.8, 0, Math.PI * 2);
    ctx2d.fillStyle = diag.keep ? pal.sample : pal.sampleDiscarded;
    ctx2d.fill();
    ctx2d.strokeStyle = pal.bg;
    ctx2d.lineWidth = 1;
    ctx2d.stroke();

    const wText = `w=(${diag.windings.slice(0, 2).join(",")})`;
    ctx2d.fillStyle = diag.keep ? pal.sample : pal.muted;
    ctx2d.fillText(wText, s.x + 6, s.y + 3);
  }

  // If in fuzzer mode with a selected trial, also draw the winding oracle probes
  if (activeTab === "fuzzer" && selectedFuzzTrial) {
    for (const probe of selectedFuzzTrial.probes) {
      const s = worldToScreen(probe.pt.x, probe.pt.y);
      ctx2d.strokeStyle = probe.passed ? alpha(pal.ok, 0.75) : pal.bad;
      ctx2d.lineWidth = 1.4;
      ctx2d.beginPath();
      ctx2d.moveTo(s.x - 3.5, s.y);
      ctx2d.lineTo(s.x + 3.5, s.y);
      ctx2d.moveTo(s.x, s.y - 3.5);
      ctx2d.lineTo(s.x, s.y + 3.5);
      ctx2d.stroke();
    }
  }

  ctx2d.restore();
}

function renderCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }

  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx2d.clearRect(0, 0, w, h);

  drawGrid(w, h);

  if (showLayerInput) {
    const pal = palette();
    drawEditableBody(bodyA, pal.bodyA, alpha(pal.bodyA, 0.06));
    drawEditableBody(bodyB, pal.bodyB, alpha(pal.bodyB, 0.06));
    drawEditableBody(bodyC, pal.bodyC, alpha(pal.bodyC, 0.06));
  }

  if (latestSnapshot) {
    drawConsolidatedComplex(latestSnapshot);
    drawOutputBRep(latestSnapshot.result);
    drawSamplePoints(latestSnapshot);
  }
}

function recomputeAndRender(): void {
  latestSnapshot = runPipeline();
  updateMetricsAndDiagnostics(latestSnapshot);
  renderCanvas();
}

// Hit testing for vertex handles and bodies
function findHitVertex(screenX: number, screenY: number, hitRadiusPx = 9): Point2D | null {
  let bestPt: Point2D | null = null;
  let bestDist = hitRadiusPx;

  const checkPt = (p: Point2D) => {
    const s = worldToScreen(p.x, p.y);
    const d = Math.hypot(s.x - screenX, s.y - screenY);
    if (d <= bestDist) {
      bestDist = d;
      bestPt = p;
    }
  };

  for (const body of [bodyC, bodyB, bodyA]) {
    for (const loop of body.loops) {
      for (const p of loop) checkPt(p);
    }
    for (const seg of body.segments) {
      checkPt(seg.p0);
      checkPt(seg.p1);
    }
  }
  return bestPt;
}

function findHitBody(wx: number, wy: number): EditableBody | null {
  const worldEdgeTol = 8 / view.scale;

  for (const body of [bodyC, bodyB, bodyA]) {
    for (const loop of body.loops) {
      if (Math.abs(rawLoopWindingNumber({ x: wx, y: wy }, loop)) >= 0.5) {
        return body;
      }
    }
    for (const seg of body.segments) {
      const dx = seg.p1.x - seg.p0.x;
      const dy = seg.p1.y - seg.p0.y;
      const lenSq = dx * dx + dy * dy;
      const t = lenSq > 0 ? Math.max(0, Math.min(1, ((wx - seg.p0.x) * dx + (wy - seg.p0.y) * dy) / lenSq)) : 0;
      const d = Math.hypot(wx - (seg.p0.x + t * dx), wy - (seg.p0.y + t * dy));
      if (d <= worldEdgeTol) {
        return body;
      }
    }
  }
  return null;
}

function translateBody(body: EditableBody, dx: number, dy: number): void {
  for (const loop of body.loops) {
    for (const p of loop) {
      p.x += dx;
      p.y += dy;
    }
  }
  for (const seg of body.segments) {
    seg.p0.x += dx;
    seg.p0.y += dy;
    seg.p1.x += dx;
    seg.p1.y += dy;
  }
}

function evaluateBodyWindingAt(body: EditableBody, pt: Point2D): number {
  let w = 0;
  for (const loop of body.loops) {
    w += rawLoopWindingNumber(pt, loop);
  }
  for (const seg of body.segments) {
    const ax = seg.p0.x - pt.x;
    const ay = seg.p0.y - pt.y;
    const bx = seg.p1.x - pt.x;
    const by = seg.p1.y - pt.y;
    w += Math.atan2(ax * by - ay * bx, ax * bx + ay * by) / (2 * Math.PI);
  }
  return w;
}

function updateCursorProbe(wx: number, wy: number): void {
  const pt = { x: wx, y: wy };
  const wA = evaluateBodyWindingAt(bodyA, pt);
  const wB = evaluateBodyWindingAt(bodyB, pt);
  let wOut = 0;
  if (latestSnapshot) {
    for (const loop of latestSnapshot.result.loops) {
      wOut += rawLoopWindingNumber(pt, loop);
    }
  }

  document.getElementById("probe-xy")!.textContent = `(${wx.toFixed(2)}, ${wy.toFixed(2)})`;
  document.getElementById("probe-winding")!.textContent =
    `wA=${wA.toFixed(2)}, wB=${wB.toFixed(2)}`;
  const insideEl = document.getElementById("probe-inside")!;
  const isIn = Math.abs(wOut) >= 0.5;
  insideEl.textContent = isIn ? `true (w=${Math.round(wOut)})` : "false";
  insideEl.classList.toggle("ok", isIn);
}

// Fuzzer Execution & UI
function displayFuzzTrialOnCanvas(record: FuzzTrialRecord): void {
  selectedFuzzTrial = record;
  bodyA = {
    loops: [record.polyA.map((p) => ({ x: p.x, y: p.y }))],
    segments: [],
  };
  bodyB = {
    loops: [record.polyB.map((p) => ({ x: p.x, y: p.y }))],
    segments: [],
  };
  bodyC = { loops: [], segments: [] };
  currentOp = fuzzDisplayOp;
  currentWindingRule = "positive";
  customSnapTolerance = null;
  syncControlsFromState();
  recomputeAndRender();
}

function updateFuzzScorecardUI(): void {
  document.getElementById("score-trials")!.textContent = fuzzStats.trials.toLocaleString();
  document.getElementById("score-ops")!.textContent =
    `${fuzzStats.totalBooleanOps.toLocaleString()} Boolean ops`;

  const setCard = (id: string, pass: number, total: number) => {
    const el = document.getElementById(id)!;
    el.textContent = `${pass.toLocaleString()} / ${total.toLocaleString()}`;
    el.className = `score-num ${pass === total ? "pass" : "fail"}`;
  };

  setCard("score-manifold", fuzzStats.manifoldPass, fuzzStats.trials);
  setCard("score-crossing", fuzzStats.crossingPass, fuzzStats.trials);
  setCard("score-area", fuzzStats.areaPass, fuzzStats.trials);
  setCard("score-winding", fuzzStats.windingPass, fuzzStats.windingChecks);

  const opsPerSec =
    fuzzStats.totalElapsedMs > 0
      ? Math.round((fuzzStats.totalBooleanOps / fuzzStats.totalElapsedMs) * 1000)
      : 0;
  document.getElementById("fuzz-rate")!.textContent = `${opsPerSec.toLocaleString()} ops/s`;

  const listEl = document.getElementById("fuzz-history-list")!;
  listEl.innerHTML = "";
  for (let i = fuzzHistory.length - 1; i >= 0; i--) {
    const item = fuzzHistory[i]!;
    const row = document.createElement("div");
    row.className = `fuzz-item ${selectedFuzzTrial?.trialNumber === item.trialNumber ? "active" : ""}`;
    row.innerHTML = `
      <span>#${item.trialNumber} · V(${item.polyA.length},${item.polyB.length}) · ΔA=${item.areaError.toExponential(1)}</span>
      <span class="${item.allPassed ? "fuzz-pass" : "fuzz-fail"}">${item.allPassed ? "Pass" : "Fail"}</span>
    `;
    row.addEventListener("click", () => {
      displayFuzzTrialOnCanvas(item);
      updateFuzzScorecardUI();
    });
    listEl.appendChild(row);
  }
}

function executeFuzzBatch(count: number): void {
  let lastRecord: FuzzTrialRecord | null = null;
  for (let i = 0; i < count; i++) {
    const trialNum = fuzzStats.trials + 1;
    const rec = runSingleFuzzTrial(fuzzRng, trialNum, fuzzMaxVerts, fuzzDegenRate);
    fuzzStats.trials++;
    fuzzStats.totalBooleanOps += 6;
    if (rec.manifoldPassed) fuzzStats.manifoldPass++;
    if (rec.crossingPassed) fuzzStats.crossingPass++;
    if (rec.areaPassed) fuzzStats.areaPass++;
    fuzzStats.windingChecks += rec.probes.length;
    fuzzStats.windingPass += rec.probes.filter((p) => p.passed).length;
    fuzzStats.totalElapsedMs += rec.elapsedMs;

    fuzzHistory.push(rec);
    if (fuzzHistory.length > 40) {
      fuzzHistory.shift();
    }
    lastRecord = rec;

    if (!rec.allPassed) {
      stopContinuousFuzz();
      break;
    }
  }

  if (lastRecord) {
    (document.getElementById("input-fuzz-seed") as HTMLInputElement).value = String(
      fuzzRng.getSeed(),
    );
    displayFuzzTrialOnCanvas(lastRecord);
    if (fuzzStats.trials <= count) {
      fitViewToGeometry();
      renderCanvas();
    }
  }
  updateFuzzScorecardUI();
}

function stopContinuousFuzz(): void {
  fuzzRunning = false;
  if (fuzzAnimFrame) {
    cancelAnimationFrame(fuzzAnimFrame);
    fuzzAnimFrame = 0;
  }
  const btn = document.getElementById("btn-fuzz-toggle")!;
  btn.textContent = "Run";
  btn.classList.remove("running");
  const badge = document.getElementById("fuzz-status-badge")!;
  badge.textContent = "Idle";
  badge.className = "status-badge idle";
}

function startContinuousFuzz(): void {
  if (fuzzRunning) return;
  fuzzRunning = true;
  const btn = document.getElementById("btn-fuzz-toggle")!;
  btn.textContent = "Pause";
  btn.classList.add("running");
  const badge = document.getElementById("fuzz-status-badge")!;
  badge.textContent = "Running";
  badge.className = "status-badge running";

  const tick = () => {
    if (!fuzzRunning) return;
    executeFuzzBatch(5);
    if (fuzzRunning) {
      fuzzAnimFrame = requestAnimationFrame(tick);
    }
  };
  fuzzAnimFrame = requestAnimationFrame(tick);
}

// Initialize UI & Event Listeners
function initUI(): void {
  // Small screens have no layer toggles, so start with the less cluttered view.
  if (window.matchMedia("(max-width: 860px)").matches) showLayerSamples = false;

  // Populate preset example cards
  const exampleListEl = document.getElementById("example-list")!;
  for (const scenario of DEMO_SCENARIOS) {
    const card = document.createElement("button");
    card.className = "example-card";
    card.dataset.id = scenario.id;
    card.innerHTML = `
      <div class="example-card-top">
        <span class="example-title">${scenario.title}</span>
        <span class="example-tag">${scenario.tag}</span>
      </div>
      <div class="example-summary">${scenario.summary}</div>
    `;
    card.addEventListener("click", () => {
      loadScenario(scenario);
    });
    exampleListEl.appendChild(card);
  }

  // Compact scenario picker (mobile)
  const scenarioSelect = document.getElementById("scenario-select") as HTMLSelectElement;
  for (const scenario of DEMO_SCENARIOS) {
    scenarioSelect.add(new Option(scenario.title, scenario.id));
  }
  const loadScenarioAt = (index: number) => {
    const n = DEMO_SCENARIOS.length;
    if (activeTab !== "examples") setActiveTab("examples");
    loadScenario(DEMO_SCENARIOS[((index % n) + n) % n]!);
  };
  const currentScenarioIndex = () => DEMO_SCENARIOS.indexOf(currentScenario);
  scenarioSelect.addEventListener("change", () => {
    loadScenarioAt(DEMO_SCENARIOS.findIndex((s) => s.id === scenarioSelect.value));
  });
  document.getElementById("btn-scenario-prev")!.addEventListener("click", () => {
    loadScenarioAt(currentScenarioIndex() - 1);
  });
  document.getElementById("btn-scenario-next")!.addEventListener("click", () => {
    loadScenarioAt(currentScenarioIndex() + 1);
  });

  // Mode Tabs
  document.getElementById("tab-examples")!.addEventListener("click", () => {
    stopContinuousFuzz();
    setActiveTab("examples");
    syncControlsFromState();
    recomputeAndRender();
  });

  document.getElementById("tab-fuzzer")!.addEventListener("click", () => {
    setActiveTab("fuzzer");
    if (fuzzHistory.length === 0) {
      executeFuzzBatch(1);
    } else if (selectedFuzzTrial) {
      displayFuzzTrialOnCanvas(selectedFuzzTrial);
    }
  });

  // Operation buttons
  document.querySelectorAll("#op-selector .op-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentOp = (btn as HTMLButtonElement).dataset.op as DemoOp;
      syncControlsFromState();
      recomputeAndRender();
    });
  });

  // Winding rule buttons
  document.querySelectorAll("#winding-selector .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentWindingRule = (btn as HTMLButtonElement).dataset.rule as WindingRule;
      syncControlsFromState();
      recomputeAndRender();
    });
  });

  // Snap Tolerance slider & quick chips
  const tolSlider = document.getElementById("slider-snap-tol") as HTMLInputElement;
  tolSlider.addEventListener("input", () => {
    const exp = parseFloat(tolSlider.value);
    if (exp <= -8.95) {
      customSnapTolerance = null;
    } else {
      customSnapTolerance = Math.pow(10, exp);
    }
    syncControlsFromState();
    recomputeAndRender();
  });

  document.getElementById("btn-tol-auto")!.addEventListener("click", () => {
    customSnapTolerance = null;
    syncControlsFromState();
    recomputeAndRender();
  });
  document.getElementById("btn-tol-micro")!.addEventListener("click", () => {
    customSnapTolerance = 1e-4;
    syncControlsFromState();
    recomputeAndRender();
  });
  document.getElementById("btn-tol-coarse")!.addEventListener("click", () => {
    customSnapTolerance = 0.25;
    syncControlsFromState();
    recomputeAndRender();
  });

  // Checkboxes
  document.getElementById("chk-simplify-collinear")!.addEventListener("change", (e) => {
    simplifyCollinear = (e.target as HTMLInputElement).checked;
    recomputeAndRender();
  });
  document.getElementById("chk-layer-input")!.addEventListener("change", (e) => {
    showLayerInput = (e.target as HTMLInputElement).checked;
    renderCanvas();
  });
  document.getElementById("chk-layer-output-fill")!.addEventListener("change", (e) => {
    showLayerOutputFill = (e.target as HTMLInputElement).checked;
    renderCanvas();
  });
  document.getElementById("chk-layer-output-edges")!.addEventListener("change", (e) => {
    showLayerOutputEdges = (e.target as HTMLInputElement).checked;
    renderCanvas();
  });
  document.getElementById("chk-layer-consolidated")!.addEventListener("change", (e) => {
    showLayerConsolidated = (e.target as HTMLInputElement).checked;
    renderCanvas();
  });
  document.getElementById("chk-layer-radii")!.addEventListener("change", (e) => {
    showLayerRadii = (e.target as HTMLInputElement).checked;
    renderCanvas();
  });
  document.getElementById("chk-layer-samples")!.addEventListener("change", (e) => {
    showLayerSamples = (e.target as HTMLInputElement).checked;
    renderCanvas();
  });

  // Toolbar buttons
  document.getElementById("btn-reset-geometry")!.addEventListener("click", () => {
    if (activeTab === "fuzzer" && selectedFuzzTrial) {
      displayFuzzTrialOnCanvas(selectedFuzzTrial);
      fitViewToGeometry();
      renderCanvas();
    } else {
      loadScenario(currentScenario);
    }
  });
  document.getElementById("btn-fit-view")!.addEventListener("click", () => {
    fitViewToGeometry();
    renderCanvas();
  });

  // Fuzzer Controls
  document.getElementById("btn-fuzz-toggle")!.addEventListener("click", () => {
    if (fuzzRunning) stopContinuousFuzz();
    else startContinuousFuzz();
  });
  document.getElementById("btn-fuzz-step")!.addEventListener("click", () => {
    stopContinuousFuzz();
    executeFuzzBatch(1);
  });
  document.getElementById("btn-fuzz-burst")!.addEventListener("click", () => {
    stopContinuousFuzz();
    executeFuzzBatch(100);
  });
  document.getElementById("btn-fuzz-reset")!.addEventListener("click", () => {
    stopContinuousFuzz();
    fuzzStats.trials = 0;
    fuzzStats.totalBooleanOps = 0;
    fuzzStats.manifoldPass = 0;
    fuzzStats.crossingPass = 0;
    fuzzStats.areaPass = 0;
    fuzzStats.windingChecks = 0;
    fuzzStats.windingPass = 0;
    fuzzStats.totalElapsedMs = 0;
    fuzzHistory.length = 0;
    fuzzRng.setSeed(195939070);
    executeFuzzBatch(1);
  });

  document.getElementById("input-fuzz-seed")!.addEventListener("change", (e) => {
    const val = parseInt((e.target as HTMLInputElement).value, 10);
    if (Number.isFinite(val)) {
      fuzzRng.setSeed(val);
    }
  });

  const vertsSlider = document.getElementById("slider-fuzz-verts") as HTMLInputElement;
  vertsSlider.addEventListener("input", () => {
    fuzzMaxVerts = parseInt(vertsSlider.value, 10);
    document.getElementById("val-fuzz-verts")!.textContent = `3 – ${fuzzMaxVerts}`;
  });

  const degenSlider = document.getElementById("slider-fuzz-degen") as HTMLInputElement;
  degenSlider.addEventListener("input", () => {
    fuzzDegenRate = parseInt(degenSlider.value, 10);
    document.getElementById("val-fuzz-degen")!.textContent = `${fuzzDegenRate}%`;
  });

  document.querySelectorAll("#fuzz-op-selector .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#fuzz-op-selector .seg-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      fuzzDisplayOp = (btn as HTMLButtonElement).dataset.op as typeof fuzzDisplayOp;
      currentOp = fuzzDisplayOp;
      syncControlsFromState();
      recomputeAndRender();
    });
  });

  document.getElementById("btn-load-fuzz-into-editor")!.addEventListener("click", () => {
    stopContinuousFuzz();
    setActiveTab("examples");
    syncControlsFromState();
    recomputeAndRender();
  });

  // Canvas Mouse & Wheel Interactions
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") spacePressed = true;
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") spacePressed = false;
  });

  // Canvas pointer interactions: drag vertices or bodies, pan, and wheel / pinch zoom.
  const activePointers = new Map<number, { x: number; y: number }>();
  let pinch: { dist: number; midX: number; midY: number } | null = null;

  const localPoint = (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top, rect };
  };

  const zoomAt = (sx: number, sy: number, factor: number) => {
    const before = screenToWorld(sx, sy);
    view.scale = Math.max(1e-4, Math.min(1e6, view.scale * factor));
    const after = screenToWorld(sx, sy);
    view.centerX += before.x - after.x;
    view.centerY += before.y - after.y;
  };

  const pinchState = () => {
    const [a, b] = [...activePointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
    return {
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      midX: 0.5 * (a.x + b.x),
      midY: 0.5 * (a.y + b.y),
    };
  };

  canvas.addEventListener("pointerdown", (e) => {
    const { sx, sy } = localPoint(e);
    activePointers.set(e.pointerId, { x: sx, y: sy });
    canvas.setPointerCapture(e.pointerId);

    if (activePointers.size === 2) {
      // A second finger turns any drag into a pinch.
      dragTarget = null;
      pinch = pinchState();
      return;
    }
    if (activePointers.size > 2) return;

    const wPt = screenToWorld(sx, sy);
    const start = { startScreenX: sx, startScreenY: sy, lastWorldX: wPt.x, lastWorldY: wPt.y };

    if (e.button === 1 || spacePressed) {
      dragTarget = { kind: "pan", ...start };
      canvas.style.cursor = "grabbing";
      return;
    }

    const hitVertex = findHitVertex(sx, sy, e.pointerType === "touch" ? 22 : 9);
    if (hitVertex) {
      dragTarget = { kind: "vertex", pointRef: hitVertex, ...start };
      canvas.style.cursor = "grabbing";
      return;
    }

    const hitBody = findHitBody(wPt.x, wPt.y);
    if (hitBody) {
      dragTarget = { kind: "body", bodyRef: hitBody, ...start };
      canvas.style.cursor = "move";
      return;
    }

    dragTarget = { kind: "pan", ...start };
    canvas.style.cursor = "grabbing";
  });

  canvas.addEventListener("pointermove", (e) => {
    const { sx, sy, rect } = localPoint(e);
    if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x: sx, y: sy });

    if (pinch && activePointers.size >= 2) {
      const next = pinchState();
      view.centerX -= (next.midX - pinch.midX) / view.scale;
      view.centerY += (next.midY - pinch.midY) / view.scale;
      zoomAt(next.midX, next.midY, next.dist / pinch.dist);
      pinch = next;
      renderCanvas();
      return;
    }

    const wPt = screenToWorld(sx, sy);

    if (e.pointerType === "mouse" && sx >= 0 && sy >= 0 && sx <= rect.width && sy <= rect.height) {
      updateCursorProbe(wPt.x, wPt.y);
    }

    if (!dragTarget) {
      if (e.pointerType !== "mouse") return;
      const hitV = findHitVertex(sx, sy);
      if (hitV !== hoveredPointRef) {
        hoveredPointRef = hitV;
        canvas.style.cursor = hitV ? "grab" : "crosshair";
        renderCanvas();
      }
      return;
    }

    if (dragTarget.kind === "pan") {
      const dxScreen = sx - dragTarget.startScreenX;
      const dyScreen = sy - dragTarget.startScreenY;
      view.centerX -= dxScreen / view.scale;
      view.centerY += dyScreen / view.scale;
      dragTarget.startScreenX = sx;
      dragTarget.startScreenY = sy;
      renderCanvas();
      return;
    }

    if (dragTarget.kind === "vertex" && dragTarget.pointRef) {
      dragTarget.pointRef.x = wPt.x;
      dragTarget.pointRef.y = wPt.y;
      recomputeAndRender();
      return;
    }

    if (dragTarget.kind === "body" && dragTarget.bodyRef) {
      const dx = wPt.x - dragTarget.lastWorldX;
      const dy = wPt.y - dragTarget.lastWorldY;
      translateBody(dragTarget.bodyRef, dx, dy);
      dragTarget.lastWorldX = wPt.x;
      dragTarget.lastWorldY = wPt.y;
      recomputeAndRender();
    }
  });

  const endPointer = (e: PointerEvent) => {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) pinch = null;
    if (dragTarget) {
      dragTarget = null;
      canvas.style.cursor = hoveredPointRef ? "grab" : "crosshair";
    }
    if (e.pointerType !== "mouse" && hoveredPointRef) {
      hoveredPointRef = null;
      renderCanvas();
    }
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const { sx, sy } = localPoint(e);
      zoomAt(sx, sy, Math.exp(-e.deltaY * 0.0014));
      renderCanvas();
    },
    { passive: false },
  );

  new ResizeObserver(() => renderCanvas()).observe(canvas);
}

initTheme();
onThemeChange(renderCanvas);

void initPolystrata().then(() => {
  initUI();
  loadScenario(DEMO_SCENARIOS[0]!);
});
