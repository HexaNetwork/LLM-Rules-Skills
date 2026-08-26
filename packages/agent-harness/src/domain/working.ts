export type RunWorking = {
  summary: string;
  phase?: string;
  role?: string;
  status?: "working" | "stalled" | "reconciling";
  /** Host process that owns the in-flight operation, for startup recovery. */
  ownerPid?: number;
  startedAt: string;
};

export function workingOn(
  summary: string,
  extras: {
    phase?: string;
    role?: string;
    status?: RunWorking["status"];
  } = {},
): RunWorking {
  return {
    summary,
    phase: extras.phase,
    role: extras.role,
    status: extras.status ?? "working",
    ownerPid: process.pid,
    startedAt: new Date().toISOString(),
  };
}

export function formatWorkingLine(working: RunWorking): string {
  const bits = [working.summary];
  if (working.role) bits.push(`role ${working.role}`);
  if (working.phase) bits.push(`${working.phase} phase`);
  return bits.join(" · ");
}
