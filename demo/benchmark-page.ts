import { LIBRARY_ADAPTERS } from "../bench/adapters.js";
import { initManifoldWasm } from "../bench/manifold-wasm.js";
import {
  type FullBenchmarkReport,
  runFullBenchmarkSuite,
} from "../bench/runner.js";
import { initPolystrataWasm } from "../src/index.js";
import { initTheme } from "./theme.js";

const LIB_COLORS: Record<string, string> = {
  polystrata: "#3f6f9f",
  "manifold-2d": "#b4607a",
  "clipper2-js": "#8b5a8f",
  "polygon-clipping": "#6f8a3c",
  martinez: "#c39130",
  polybool: "#c0643a",
};

const statusEl = document.getElementById("bench-status")!;
const cardsEl = document.getElementById("lib-cards")!;
const fuzzTbody = document.getElementById("fuzz-tbody")!;
const workloadTbody = document.getElementById("workload-tbody")!;

const btnRunAll = document.getElementById("btn-run-all") as HTMLButtonElement;
const btnRunQuick = document.getElementById("btn-run-quick") as HTMLButtonElement;

/** Milliseconds with 3 decimals, or 3 significant digits below 1 ms (sub-microsecond ops). */
function formatMs(ms: number): string {
  return ms >= 1 ? ms.toFixed(3) : ms.toPrecision(3);
}

function renderReport2D(report: FullBenchmarkReport): void {
  cardsEl.innerHTML = "";
  for (const lib of LIBRARY_ADAPTERS) {
    const workloadPassCount = report.workloadSummaries.filter((ws) => {
      const r = ws.results.find((x) => x.libraryId === lib.id);
      return r?.succeeded;
    }).length;
    const fuzz = report.fuzzSummaries.find((f) => f.libraryId === lib.id);
    const fuzzRate = fuzz
      ? `${fuzz.areaIdentityPass}/${fuzz.trials} (${((fuzz.areaIdentityPass / fuzz.trials) * 100).toFixed(0)}%)`
      : "—";

    const card = document.createElement("div");
    card.className = `lib-card ${lib.id === "polystrata" ? "highlight" : ""}`;
    card.innerHTML = `
      <div class="lib-card-header">
        <span class="lib-card-name" style="color: ${LIB_COLORS[lib.id] ?? "inherit"}">${lib.name}</span>
        <span class="lib-card-ver">v${lib.version}</span>
      </div>
      <div class="lib-card-algo">${lib.algorithm}</div>
      <div class="lib-card-stats">
        <span>Workloads: <strong>${workloadPassCount}/${report.workloadSummaries.length} PASS</strong></span>
        <span>Fuzz: <strong>${fuzzRate}</strong></span>
      </div>
    `;
    cardsEl.appendChild(card);
  }

  fuzzTbody.innerHTML = "";
  for (const fuzz of report.fuzzSummaries) {
    const passPct = (fuzz.areaIdentityPass / fuzz.trials) * 100;
    let verdictBadge = `<span class="badge-pass">100% ROBUST</span>`;
    if (fuzz.crashes > 0 || passPct < 90) {
      verdictBadge = `<span class="badge-fail">${fuzz.areaIdentityFail} AREA FAILS / ${fuzz.crashes} CRASH</span>`;
    } else if (passPct < 100) {
      verdictBadge = `<span class="badge-warn">${passPct.toFixed(1)}% (${fuzz.areaIdentityFail} DRIFT)</span>`;
    }

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong style="color: ${LIB_COLORS[fuzz.libraryId] ?? "#fff"}">${fuzz.libraryName}</strong></td>
      <td class="num">${Math.round(fuzz.opsPerSec).toLocaleString()} op/s</td>
      <td class="num">${fuzz.totalMs.toFixed(1)} ms</td>
      <td class="num">${fuzz.areaIdentityPass} / ${fuzz.trials} (${passPct.toFixed(1)}%)</td>
      <td class="num">${fuzz.crashes}</td>
      <td class="num">${fuzz.areaIdentityFail}</td>
      <td>${verdictBadge}</td>
    `;
    fuzzTbody.appendChild(tr);
  }

  workloadTbody.innerHTML = "";
  for (const summary of report.workloadSummaries) {
    const w = summary.workload;
    const maxOps = Math.max(...summary.results.map((r) => r.opsPerSec), 1);

    const headerTr = document.createElement("tr");
    headerTr.className = "workload-header-row";
    headerTr.innerHTML = `
      <td colspan="8">
        ${w.name} <span style="color: var(--text-muted); font-weight: 400; margin-left: 8px;">[${w.category.toUpperCase()} &bull; ${w.vertexCount} vertices] &mdash; ${w.description}</span>
      </td>
    `;
    workloadTbody.appendChild(headerTr);

    for (const r of summary.results) {
      const pct = Math.max(2, Math.min(100, (r.opsPerSec / maxOps) * 100));
      const color = LIB_COLORS[r.libraryId] ?? "#3f6f9f";
      const statusBadge = r.succeeded
        ? `<span class="badge-pass">PASS</span>`
        : r.errorMessage
          ? `<span class="badge-fail" title="${r.errorMessage}">CRASH</span>`
          : `<span class="badge-fail">AREA-FAIL</span>`;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><strong style="color: ${color}">${r.libraryName}</strong></td>
        <td class="num">${r.errorMessage ? "ERR" : Math.round(r.opsPerSec).toLocaleString()}</td>
        <td class="bar-cell">
          <div class="bar-track">
            <div class="bar-fill" style="width: ${pct.toFixed(1)}%; background: ${color};"></div>
          </div>
        </td>
        <td class="num">${Number.isFinite(r.meanMs) ? formatMs(r.meanMs) : "—"}</td>
        <td class="num">${Number.isFinite(r.p50Ms) ? formatMs(r.p50Ms) : "—"}</td>
        <td class="num">${Number.isFinite(r.p95Ms) ? formatMs(r.p95Ms) : "—"}</td>
        <td class="num">${Number.isFinite(r.areaIdentityError) ? r.areaIdentityError.toExponential(1) : "NaN"}</td>
        <td>${statusBadge}</td>
      `;
      workloadTbody.appendChild(tr);
    }
  }
}

async function executeSuite(durationMs: number, fuzzCount: number): Promise<void> {
  btnRunAll.disabled = true;
  btnRunQuick.disabled = true;
  statusEl.textContent = "Running 2D benchmark suite...";

  await new Promise((r) => setTimeout(r, 30));

  const t0 = performance.now();
  const report2D = runFullBenchmarkSuite(durationMs, fuzzCount, (msg) => {
    statusEl.textContent = msg;
  });
  renderReport2D(report2D);

  const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
  statusEl.textContent = `Completed 2D benchmark suite in ${elapsed}s`;
  btnRunAll.disabled = false;
  btnRunQuick.disabled = false;
}

btnRunAll.addEventListener("click", () => executeSuite(55, 120));
btnRunQuick.addEventListener("click", () => executeSuite(20, 60));

async function initPage(): Promise<void> {
  try {
    statusEl.textContent = "Loading polystrata & manifold-3d WASM...";
    await Promise.all([initPolystrataWasm(), initManifoldWasm()]);
    await executeSuite(20, 60);
  } catch (err) {
    statusEl.textContent = `Error initializing benchmarks: ${err instanceof Error ? err.message : String(err)}`;
  }
}

initTheme();
initPage();
