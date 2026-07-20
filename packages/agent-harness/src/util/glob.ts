export function matchGlob(pathValue: string, pattern: string): boolean {
  const normalizedPath = pathValue.replace(/\\/g, "/");
  const normalizedPattern = pattern.replace(/\\/g, "/");
  const regex = globToRegExp(normalizedPattern);
  return regex.test(normalizedPath);
}

export function anyGlobMatches(pathValue: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchGlob(pathValue, pattern));
}

function globToRegExp(pattern: string): RegExp {
  let regex = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      const next = pattern[i + 1];
      if (next === "*") {
        const after = pattern[i + 2];
        if (after === "/") {
          regex += "(?:.*/)?";
          i += 2;
        } else {
          regex += ".*";
          i += 1;
        }
      } else {
        regex += "[^/]*";
      }
    } else if (char === "?") {
      regex += "[^/]";
    } else if (".$^+()[]{}|\\".includes(char!)) {
      regex += `\\${char}`;
    } else {
      regex += char;
    }
  }
  regex += "$";
  return new RegExp(regex);
}
