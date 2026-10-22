#!/usr/bin/env node
// Runs the test suite with V8 coverage and reports the JavaScript sources.
// (src/template.html is markup + CSS and is not measured here.)
//
// Node's built-in coverage table lists ranges (hard to act on), so this script
// collects `NODE_V8_COVERAGE` data and prints:
//   - a per-file summary
//   - app methods/functions sorted by how much uncovered code they contain
//
// Outputs coverage/index.html (annotated source) and coverage/coverage.json.
// COVERAGE_FUNCS=foo,bar prints the coverage of specific functions.
//
// Usage: node tools/coverage.mjs [minLineCoverage]
// Exit code: 1 when line coverage is below the minimum (default: no minimum).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const minLine = Number(process.argv[2] ?? 0);
const dir = mkdtempSync(join(tmpdir(), 'pocketedit-cov-'));

try {
  const res = spawnSync(
    process.execPath,
    ['--experimental-vm-modules', '--test', 'tools/tests/*.test.mjs'],
    { cwd: root, env: { ...process.env, NODE_V8_COVERAGE: dir }, encoding: 'utf8' },
  );
  const tests = (res.stdout || '').match(/^# (tests|pass|fail) \d+$/gm) || [];
  console.log(tests.join('\n') || '(test output unavailable)');

  // Each test file runs in its own process, so the same code is reported several
  // times (once covered, several times not). A byte counts as covered when any
  // report executed it: merge with OR, never with AND.
  const urlOf = (abs) => decodeURIComponent(pathToFileURL(abs).href.replace(/^file:\/\//, ''));
  const sources = {
    'src/app.js': readFileSync(join(root, 'src', 'app.js'), 'utf8'),
    'src/shell.js': readFileSync(join(root, 'src', 'shell.js'), 'utf8'),
  };
  const coveredBy = {};
  const scriptsBy = {};
  const reports = [];
  for (const file of readdirSync(dir)) {
    try { reports.push(JSON.parse(readFileSync(join(dir, file), 'utf8'))); } catch { /* partial file */ }
  }
  for (const rel of Object.keys(sources)) {
    const covered = new Uint8Array(sources[rel].length);
    const scripts = [];
    for (const report of reports) {
      for (const script of report.result) {
        if (script.url.replace(/^file:\/\//, '') !== urlOf(join(root, rel))) continue;
        scripts.push(script);
        // Nested ranges come after their parent: fill a scratch buffer per report so
        // finer ranges override coarser ones, then OR it into the total.
        const scratch = new Uint8Array(sources[rel].length);
        for (const fn of script.functions) {
          for (const r of fn.ranges) scratch.fill(r.count > 0 ? 1 : 0, r.startOffset, r.endOffset);
        }
        for (let i = 0; i < scratch.length; i++) if (scratch[i]) covered[i] = 1;
      }
    }
    coveredBy[rel] = covered;
    scriptsBy[rel] = scripts;
  }
  if (!scriptsBy['src/app.js'].length) {
    console.error('coverage: src/app.js was never executed (did the tests load it?).');
    process.exit(1);
  }

  const summaries = [];
  let totalLines = 0, hitLines = 0;
  let totalFns = 0, coveredFns = 0;
  const pct = (a, b) => (b === 0 ? 100 : (a / b) * 100);
  for (const rel of Object.keys(sources)) {
    const source = sources[rel];
    const covered = coveredBy[rel];
    const lineStarts = [0];
    for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1);
    const lineOf = (offset) => {
      let lo = 0, hi = lineStarts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; }
      return lo + 1;
    };
    const isCode = (line) => !/^\s*(\/\/|\*|\/\*|\*\/)/.test(line) && line.trim() !== '';
    const lines = source.split('\n');
    let total = 0, hit = 0;
    const uncoveredLines = [];
    for (let i = 0; i < lines.length; i++) {
      if (!isCode(lines[i])) continue;
      total++;
      if (covered[lineStarts[i]]) hit++; else uncoveredLines.push(i + 1);
    }
    const fns = new Map();
    for (const script of scriptsBy[rel]) {
      for (const fn of script.functions) {
        const ranges = fn.ranges.filter((r) => r.endOffset > r.startOffset);
        if (!ranges.length) continue;
        const size = ranges.reduce((a, r) => a + (r.endOffset - r.startOffset), 0);
        const miss = ranges.reduce((a, r) => a + (r.count === 0 ? r.endOffset - r.startOffset : 0), 0);
        const key = `${fn.functionName || '(anonymous)'}@${lineOf(fn.ranges[0].startOffset)}`;
        const prev = fns.get(key);
        if (!prev) fns.set(key, { name: fn.functionName || '(anonymous)', line: lineOf(fn.ranges[0].startOffset), size, miss });
        else { prev.size = Math.max(prev.size, size); prev.miss = Math.min(prev.miss, miss); }
      }
    }
    const allFns = [...fns.values()];
    totalLines += total; hitLines += hit;
    totalFns += allFns.length; coveredFns += allFns.filter((f) => f.miss === 0).length;
    summaries.push({ rel, total, hit, uncoveredLines, allFns, worst: allFns.filter((f) => f.miss > 0).sort((a, b) => b.miss - a.miss).slice(0, 25), lines, lineStarts, covered, isCode });
  }
  for (const sum of summaries) {
    console.log(`\n## ${sum.rel}`);
    console.log(`line coverage: ${pct(sum.hit, sum.total).toFixed(2)}% (${sum.hit}/${sum.total} executable lines)`);
    console.log(`functions fully covered: ${sum.allFns.filter((f) => f.miss === 0).length}/${sum.allFns.length}`);
    console.log(`uncovered lines (first 40): ${sum.uncoveredLines.slice(0, 40).join(', ') || '-'}`);
    if (sum.worst.length) {
      console.log('\n### Largest uncovered functions');
      console.log('| line | function | uncovered bytes |');
      console.log('| ---: | --- | ---: |');
      for (const f of sum.worst) console.log(`| ${f.line} | \`${f.name}\` | ${f.miss} |`);
    }
    if (process.env.COVERAGE_FUNCS) {
      console.log('\n### Selected functions');
      for (const name of process.env.COVERAGE_FUNCS.split(',')) {
        const matches = sum.allFns.filter((f) => f.name === name);
        for (const f of matches) console.log(`- \`${f.name}\` @${f.line}: ${pct(f.size - f.miss, f.size).toFixed(1)}% covered`);
      }
    }
  }

  const overall = pct(hitLines, totalLines);
  console.log(`\n== TOTAL: ${overall.toFixed(2)}% of ${totalLines} executable lines, ${coveredFns}/${totalFns} functions fully covered ==`);

  // Machine-readable artifacts (ignored by git).
  const outDir = join(root, 'coverage');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'coverage.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    overall: { percent: Number(overall.toFixed(2)), coveredLines: hitLines, totalLines, functionsFullyCovered: coveredFns, functions: totalFns },
    files: summaries.map((sum) => ({
      file: sum.rel,
      lines: { percent: Number(pct(sum.hit, sum.total).toFixed(2)), covered: sum.hit, total: sum.total, uncovered: sum.uncoveredLines },
      largestUncovered: sum.worst.map(({ name, line, miss }) => ({ name, line, uncoveredBytes: miss })),
    })),
  }, null, 2));
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  for (const sum of summaries) {
    const rows = sum.lines.map((line, i) => {
      const n = i + 1;
      if (!sum.isCode(line)) return `<tr><td class="n">${n}</td><td>${esc(line)}</td></tr>`;
      const cls = sum.covered[sum.lineStarts[i]] ? 'hit' : 'miss';
      return `<tr class="${cls}"><td class="n">${n}</td><td>${esc(line) || ' '}</td></tr>`;
    }).join('\n');
    writeFileSync(join(outDir, `${sum.rel.replace(/[\/.]/g, '-')}.html`), `<!doctype html><meta charset="utf-8"><title>Coverage - ${sum.rel}</title>
<style>body{font:12px/1.4 ui-monospace,monospace;background:#111;color:#ddd;margin:16px}
table{border-collapse:collapse}td{padding:0 8px;white-space:pre-wrap}td.n{color:#888;text-align:right;user-select:none}
tr.miss td:last-child{background:#4a1d1d}tr.hit td:last-child{background:#14351d}h1{font-size:15px}</style>
<h1>${sum.rel} - line coverage ${pct(sum.hit, sum.total).toFixed(2)}% (${sum.hit}/${sum.total})</h1>
<table>${rows}</table>`);
  }
  console.log(`reports: coverage/*.html, coverage/coverage.json`);

  if (minLine > 0 && overall < minLine) {
    console.error(`\ncoverage: line coverage ${overall.toFixed(2)}% is below the required ${minLine}%.`);
    process.exit(1);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
