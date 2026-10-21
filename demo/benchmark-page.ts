import { LIBRARY_ADAPTERS } from "../bench/adapters.js";
import {
  type FullBenchmarkReport,
  runFullBenchmarkSuite,
} from "../bench/runner.js";
import { initPolystrataWasm } from "../src/index.js";

const LIB_COLORS: Record<string, string> = {
  polystrata: "#38bdf8",
  "clipper2-js": "#a78bfa",
  "polygon-clipping": "#34d399",
  martinez: "#fbbf24",
  polybool: "#fb7185",
};

const statusEl = document.getElementById("bench-status")!;
const cardsEl = document.getElementById("lib-cards")!;
const fuzzTbody = document.getElementById("fuzz-tbody")!;
const workloadTbody = document.getElementById("workload-tbody")!;
const btnRunAll = document.getElementById("btn-run-all") as HTMLButtonElement;
const btnRunQuick = document.getElementById("btn-run-quick") as HTMLButtonElement;

function renderReport(report: FullBenchmarkReport): void {
  // 1. Render Library Summary Cards
  cardsEl.innerHTML = "";
  for (const lib of LIBRARY_ADAPTERS) {
    const workloadPassCount = report.workloadSummaries.filter((ws) => {
      const r = ws.results.find((x) => x.libraryId === lib.id);
      return r?.succeeded;
    }).length;
    const fuzz = report.fuzzSummaries.find((f) => f.libraryId === lib.id);
    const fuzzRate = fuzz
      ? `${((fuzz.areaIdentityPass / fuzz.trials) * 100).toFixed(1)}%`
      : "—";

    const card = document.createElement("div");
    card.className = `lib-card ${lib.id.startsWith("polystrata") ? "highlight" : ""}`;
    card.innerHTML = `
      <div class="lib-card-header">
        <span class="lib-card-name" style="color: ${LIB_COLORS[lib.id] ?? "#f1f5f9"}">${lib.name}</span>
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

  // 2. Render Fuzz Torture Table
  fuzzTbody.innerHTML = "";
  for (const f of report.fuzzSummaries) {
    const passPct = (f.areaIdentityPass / f.trials) * 100;
    const isPerfect = f.areaIdentityFail === 0 && f.crashes === 0;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="font-weight: 600; color: ${LIB_COLORS[f.libraryId] ?? "#f1f5f9"}">${f.libraryName}</td>
      <td class="num">${Math.round(f.opsPerSec).toLocaleString()} op/s</td>
      <td class="num">${f.totalMs.toFixed(1)} ms</td>
      <td class="num">${f.areaIdentityPass} / ${f.trials} (${passPct.toFixed(1)}%)</td>
      <td class="num">${f.crashes}</td>
      <td class="num">${f.areaIdentityFail}</td>
      <td>
        <span class="${isPerfect ? "badge-pass" : "badge-fail"}">
          ${isPerfect ? "100% ROBUST" : f.crashes > 0 ? "CRASH + SILENT ERR" : "SILENT AREA ERR"}
        </span>
      </td>
    `;
    fuzzTbody.appendChild(tr);
  }

  // 3. Render Per-Workload Breakdown
  workloadTbody.innerHTML = "";
  for (const ws of report.workloadSummaries) {
    const headerTr = document.createElement("tr");
    headerTr.className = "workload-header-row";
    headerTr.innerHTML = `
      <td colspan="8">
        [${ws.workload.category.toUpperCase()}] ${ws.workload.name}
        <span style="font-weight: 400; color: var(--text-secondary); margin-left: 8px;">
          (${ws.workload.vertexCount} vertices &mdash; ${ws.workload.description})
        </span>
      </td>
    `;
    workloadTbody.appendChild(headerTr);

    const maxOps = Math.max(...ws.results.map((r) => (Number.isFinite(r.opsPerSec) ? r.opsPerSec : 0)), 1);

    for (const r of ws.results) {
      const pct = Math.min(100, Math.max(2, (r.opsPerSec / maxOps) * 100));
      const color = LIB_COLORS[r.libraryId] ?? "#38bdf8";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td style="font-weight: ${r.libraryId.startsWith("polystrata") ? "700" : "500"}; color: ${color}">
          ${r.libraryName}
        </td>
        <td class="num">${Math.round(r.opsPerSec).toLocaleString()}</td>
        <td class="bar-cell">
          <div class="bar-track">
            <div class="bar-fill" style="width: ${pct.toFixed(1)}%; background: ${color}"></div>
          </div>
        </td>
        <td class="num">${r.meanMs.toFixed(3)}</td>
        <td class="num">${r.p50Ms.toFixed(3)}</td>
        <td class="num">${r.p95Ms.toFixed(3)}</td>
        <td class="num">${r.areaIdentityError.toExponential(1)}</td>
        <td>
          <span class="${r.succeeded ? "badge-pass" : "badge-fail"}">
            ${r.succeeded ? "PASS" : r.errorMessage ? "CRASH" : "ACCURACY-FAIL"}
          </span>
        </td>
      `;
      workloadTbody.appendChild(tr);
    }
  }
}

async function triggerBenchmark(durationMs: number, fuzzTrials: number): Promise<void> {
  btnRunAll.disabled = true;
  btnRunQuick.disabled = true;
  statusEl.textContent = "Initializing WASM & running benchmark suite in browser...";

  await initPolystrataWasm();
  await new Promise((r) => setTimeout(r, 30));
  const t0 = performance.now();
  const report = runFullBenchmarkSuite(durationMs, fuzzTrials, (msg) => {
    statusEl.textContent = msg;
  });
  const totalSec = ((performance.now() - t0) / 1000).toFixed(2);
  renderReport(report);
  statusEl.textContent = `Completed full benchmark suite in ${totalSec}s`;
  btnRunAll.disabled = false;
  btnRunQuick.disabled = false;
}

btnRunAll.addEventListener("click", () => {
  void triggerBenchmark(80, 120);
});

btnRunQuick.addEventListener("click", () => {
  void triggerBenchmark(25, 60);
});

// Run a quick initial pass on page load so the table is populated immediately
void triggerBenchmark(20, 60);
