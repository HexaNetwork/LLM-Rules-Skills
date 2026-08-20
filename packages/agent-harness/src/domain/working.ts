export type RunWorking = {
  summary: string;
  phase?: string;
  role?: string;
  startedAt: string;
};

export function workingOn(
  summary: string,
  extras: { phase?: string; role?: string } = {},
): RunWorking {
  return {
    summary,
    phase: extras.phase,
    role: extras.role,
    startedAt: new Date().toISOString(),
  };
}

export function formatWorkingLine(working: RunWorking): string {
  const bits = [working.summary];
  if (working.role) bits.push(`role ${working.role}`);
  if (working.phase) bits.push(`${working.phase} phase`);
  return bits.join(" · ");
}
