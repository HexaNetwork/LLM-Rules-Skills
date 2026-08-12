import { isTestPath } from "../domain.js";

export type CoverageFileStat = { covered: number; total: number };

export type CoverageReport = {
  files: Map<string, CoverageFileStat>;
  covered: number;
  total: number;
  percentage: number;
};

export type CoverageMeasureResult = CoverageReport & {
  scope: "changed" | "all";
  fallback: boolean;
};

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function emptyReport(): CoverageReport {
  return { files: new Map(), covered: 0, total: 0, percentage: 0 };
}

function finalize(files: Map<string, CoverageFileStat>): CoverageReport {
  let covered = 0;
  let total = 0;
  for (const stat of files.values()) {
    covered += stat.covered;
    total += stat.total;
  }
  return {
    files,
    covered,
    total,
    percentage: total === 0 ? 0 : covered / total,
  };
}

/** Parse lcov.info-style coverage into per-file line totals. */
export function parseLcov(content: string): CoverageReport {
  const files = new Map<string, CoverageFileStat>();
  let current: string | undefined;
  let covered = 0;
  let total = 0;
  const flush = () => {
    if (!current) return;
    files.set(current, { covered, total });
    current = undefined;
    covered = 0;
    total = 0;
  };
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      flush();
      current = normalizePath(line.slice(3));
    } else if (line.startsWith("DA:") && current) {
      const [, hits] = line.slice(3).split(",");
      total += 1;
      if (Number(hits) > 0) covered += 1;
    } else if (line === "end_of_record") {
      flush();
    }
  }
  flush();
  return finalize(files);
}

/** Parse Cobertura XML coverage (minimal line-rate extraction). */
export function parseCobertura(content: string): CoverageReport {
  const files = new Map<string, CoverageFileStat>();
  const classRe =
    /<class[^>]*filename="([^"]+)"[^>]*>([\s\S]*?)<\/class>/gi;
  for (const match of content.matchAll(classRe)) {
    const filePath = normalizePath(match[1]!);
    const body = match[2] ?? "";
    let covered = 0;
    let total = 0;
    for (const lineMatch of body.matchAll(/<line[^>]*hits="(\d+)"/gi)) {
      total += 1;
      if (Number(lineMatch[1]) > 0) covered += 1;
    }
    if (total === 0) {
      const rate = body.match(/line-rate="([0-9.]+)"/i)?.[1];
      const lines = body.match(/lines-valid="(\d+)"/i)?.[1];
      const hit = body.match(/lines-covered="(\d+)"/i)?.[1];
      if (lines != null && hit != null) {
        total = Number(lines);
        covered = Number(hit);
      } else if (rate != null) {
        // No line detail — synthesize a 100-line bucket from the rate.
        total = 100;
        covered = Math.round(Number(rate) * 100);
      }
    }
    const existing = files.get(filePath) ?? { covered: 0, total: 0 };
    files.set(filePath, {
      covered: existing.covered + covered,
      total: existing.total + total,
    });
  }
  return files.size === 0 ? emptyReport() : finalize(files);
}

/** Parse Clover XML coverage. */
export function parseClover(content: string): CoverageReport {
  const files = new Map<string, CoverageFileStat>();
  const fileRe = /<file[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/file>/gi;
  for (const match of content.matchAll(fileRe)) {
    const filePath = normalizePath(match[1]!);
    const body = match[2] ?? "";
    let covered = 0;
    let total = 0;
    for (const lineMatch of body.matchAll(/<line[^>]*count="(\d+)"/gi)) {
      total += 1;
      if (Number(lineMatch[1]) > 0) covered += 1;
    }
    if (total === 0) {
      const metrics = body.match(
        /<metrics[^>]*statements="(\d+)"[^>]*coveredstatements="(\d+)"/i,
      );
      if (metrics) {
        total = Number(metrics[1]);
        covered = Number(metrics[2]);
      }
    }
    files.set(filePath, { covered, total });
  }
  return files.size === 0 ? emptyReport() : finalize(files);
}

export function parseCoverageReport(
  content: string,
  format: "lcov" | "cobertura" | "clover",
): CoverageReport {
  switch (format) {
    case "lcov":
      return parseLcov(content);
    case "cobertura":
      return parseCobertura(content);
    case "clover":
      return parseClover(content);
  }
}

/**
 * Apply coverage scope. When `changed` yields no matching production files,
 * fall back to global totals and mark `fallback: true`.
 */
export function measureCoverage(args: {
  report: CoverageReport;
  scope: "changed" | "all";
  changedFiles: string[];
  testPathPatterns: readonly string[];
}): CoverageMeasureResult {
  if (args.scope === "all") {
    return { ...args.report, scope: "all", fallback: false };
  }
  const changedProduction = new Set(
    args.changedFiles
      .map(normalizePath)
      .filter((filePath) => !isTestPath(filePath, args.testPathPatterns)),
  );
  if (changedProduction.size === 0) {
    return { ...args.report, scope: "changed", fallback: true };
  }
  const scoped = new Map<string, CoverageFileStat>();
  for (const [filePath, stat] of args.report.files) {
    const normalized = normalizePath(filePath);
    if (
      changedProduction.has(normalized) ||
      [...changedProduction].some(
        (changed) => normalized.endsWith(changed) || changed.endsWith(normalized),
      )
    ) {
      scoped.set(normalized, stat);
    }
  }
  if (scoped.size === 0) {
    return { ...args.report, scope: "changed", fallback: true };
  }
  const report = finalize(scoped);
  return { ...report, scope: "changed", fallback: false };
}
