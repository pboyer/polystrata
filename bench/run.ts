import { LIBRARY_ADAPTERS } from "./adapters.js";
import { runFullBenchmarkSuite } from "./runner.js";

function pad(str: string, width: number, rightAlign = false): string {
  if (str.length >= width) return str.slice(0, width);
  const spaces = " ".repeat(width - str.length);
  return rightAlign ? spaces + str : str + spaces;
}

function main(): void {
  console.log("================================================================================================");
  console.log("  2D POLYGON CLIPPING & BOOLEAN KERNEL BENCHMARK SUITE");
  console.log("  Comparing polystrata vs. clipper2-js, polygon-clipping, martinez-polygon-clipping, @velipso/polybool");
  console.log("================================================================================================\n");

  console.log("Libraries under test:");
  for (const lib of LIBRARY_ADAPTERS) {
    console.log(`  - ${pad(lib.name, 26)} v${pad(lib.version, 8)} (${lib.algorithm})`);
  }
  console.log("");

  const report = runFullBenchmarkSuite(60, 120, (msg) => {
    if (process.stderr.isTTY) {
      process.stderr.write(`\r${msg.padEnd(60)}`);
    } else {
      console.error(msg);
    }
  });

  for (const summary of report.workloadSummaries) {
    const w = summary.workload;
    console.log(`------------------------------------------------------------------------------------------------`);
    console.log(`Workload: ${w.name} [${w.category.toUpperCase()}] (Vertices: ${w.vertexCount})`);
    console.log(`          ${w.description}`);
    console.log(`------------------------------------------------------------------------------------------------`);
    console.log(
      `${pad("Library", 27)} | ${pad("Ops/sec", 11, true)} | ${pad("Mean (ms)", 10, true)} | ${pad("p50 (ms)", 9, true)} | ${pad("p95 (ms)", 9, true)} | ${pad("Area Err", 10, true)} | Status`,
    );
    console.log(
      `${"-".repeat(27)}-+-${"-".repeat(11)}-+-${"-".repeat(10)}-+-${"-".repeat(9)}-+-${"-".repeat(9)}-+-${"-".repeat(10)}+--------`,
    );

    for (const r of summary.results) {
      const opsStr = r.opsPerSec > 0 ? Math.round(r.opsPerSec).toLocaleString() : "ERR";
      const meanStr = Number.isFinite(r.meanMs) ? r.meanMs.toFixed(3) : "ERR";
      const p50Str = Number.isFinite(r.p50Ms) ? r.p50Ms.toFixed(3) : "ERR";
      const p95Str = Number.isFinite(r.p95Ms) ? r.p95Ms.toFixed(3) : "ERR";
      const errStr = Number.isFinite(r.areaIdentityError)
        ? r.areaIdentityError.toExponential(1)
        : "NaN";
      const status = r.succeeded ? "PASS" : r.errorMessage ? "CRASH" : "ACCURACY-FAIL";
      console.log(
        `${pad(r.libraryName, 27)} | ${pad(opsStr, 11, true)} | ${pad(meanStr, 10, true)} | ${pad(p50Str, 9, true)} | ${pad(p95Str, 9, true)} | ${pad(errStr, 10, true)} | ${status}`,
      );
    }
    console.log("");
  }

  console.log("================================================================================================");
  console.log("  ADVERSARIAL FUZZ TORTURE BENCHMARK (120 Random Degenerate Polygon Pairs x 4 Boolean Ops = 480 Ops)");
  console.log("================================================================================================");
  console.log(
    `${pad("Library", 27)} | ${pad("Throughput", 13, true)} | ${pad("Total Time", 11, true)} | ${pad("Pass Rate", 13, true)} | ${pad("Crashes", 8, true)} | ${pad("Area Fails", 10, true)}`,
  );
  console.log(
    `${"-".repeat(27)}-+-${"-".repeat(13)}-+-${"-".repeat(11)}-+-${"-".repeat(13)}-+-${"-".repeat(8)}-+-${"-".repeat(10)}`,
  );

  for (const f of report.fuzzSummaries) {
    const passPct = ((f.areaIdentityPass / f.trials) * 100).toFixed(1) + "%";
    const passStr = `${f.areaIdentityPass}/${f.trials} (${passPct})`;
    const opsStr = `${Math.round(f.opsPerSec).toLocaleString()} op/s`;
    const timeStr = `${f.totalMs.toFixed(1)} ms`;
    console.log(
      `${pad(f.libraryName, 27)} | ${pad(opsStr, 13, true)} | ${pad(timeStr, 11, true)} | ${pad(passStr, 13, true)} | ${pad(String(f.crashes), 8, true)} | ${pad(String(f.areaIdentityFail), 10, true)}`,
    );
  }
  console.log("================================================================================================\n");

  if (process.argv.includes("--json")) {
    console.log("JSON_REPORT_START");
    console.log(JSON.stringify(report, null, 2));
    console.log("JSON_REPORT_END");
  }
}

main();
