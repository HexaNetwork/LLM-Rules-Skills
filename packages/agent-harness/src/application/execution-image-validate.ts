import { isDigestPinnedImageRef } from "./execution-image-generator.js";

export type DockerfileValidationIssue = {
  code:
    | "from-not-allowlisted"
    | "from-not-digest-pinned"
    | "secret-arg"
    | "secret-env"
    | "remote-add"
    | "privileged"
    | "docker-socket"
    | "oversized"
    | "unstructured-build-arg"
    | "copies-project-source";
  message: string;
  line?: number;
};

export type DockerfileValidationReport = {
  ok: boolean;
  issues: DockerfileValidationIssue[];
  fromImages: string[];
};

const SECRET_NAME =
  /^(?:.*_)?(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|CREDENTIALS?|PRIVATE[_-]?KEY)$/i;
const MAX_DOCKERFILE_BYTES = 64 * 1024;

/**
 * Validate a generated Dockerfile against the exact image allowlist and
 * hardening rules (no secret ARG/ENV, no remote ADD, no privileged setup).
 */
export function validateExecutionDockerfile(
  dockerfile: string,
  options: {
    /** Exact allowlisted image refs (worker + approved bases). */
    allowlist: readonly string[];
  },
): DockerfileValidationReport {
  const issues: DockerfileValidationIssue[] = [];
  const fromImages: string[] = [];

  if (Buffer.byteLength(dockerfile, "utf8") > MAX_DOCKERFILE_BYTES) {
    issues.push({
      code: "oversized",
      message: `Dockerfile exceeds ${MAX_DOCKERFILE_BYTES} bytes.`,
    });
  }

  const allow = new Set(options.allowlist.map((item) => item.trim()).filter(Boolean));
  const lines = dockerfile.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const lineNumber = i + 1;
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const upper = trimmed.toUpperCase();

    if (upper.startsWith("FROM ")) {
      const rest = trimmed.slice(4).trim();
      // FROM image AS name  |  FROM image
      const withoutPlatform = rest.replace(/^--platform=\S+\s+/i, "");
      const imageToken = withoutPlatform.split(/\s+/)[0] ?? "";
      const image = imageToken.trim();
      fromImages.push(image);
      if (!isDigestPinnedImageRef(image)) {
        issues.push({
          code: "from-not-digest-pinned",
          message: `FROM must be digest-pinned: ${image}`,
          line: lineNumber,
        });
      }
      if (!allow.has(image)) {
        issues.push({
          code: "from-not-allowlisted",
          message: `FROM image is not on the exact allowlist: ${image}`,
          line: lineNumber,
        });
      }
      continue;
    }

    if (upper.startsWith("ARG ")) {
      const argBody = trimmed.slice(4).trim();
      const name = argBody.split("=")[0]?.trim() ?? "";
      if (SECRET_NAME.test(name)) {
        issues.push({
          code: "secret-arg",
          message: `Secret-bearing ARG is forbidden: ${name}`,
          line: lineNumber,
        });
      }
      // Unstructured / free-form build args beyond known empty declarations
      if (argBody.includes("=") && argBody.split("=")[1]?.trim()) {
        issues.push({
          code: "unstructured-build-arg",
          message: `Build ARG default values are forbidden in generated Dockerfiles: ${name}`,
          line: lineNumber,
        });
      }
      continue;
    }

    if (upper.startsWith("ENV ")) {
      const envBody = trimmed.slice(4).trim();
      const name = envBody.split(/[=\s]/)[0]?.trim() ?? "";
      if (SECRET_NAME.test(name)) {
        issues.push({
          code: "secret-env",
          message: `Secret-bearing ENV is forbidden: ${name}`,
          line: lineNumber,
        });
      }
      continue;
    }

    if (upper.startsWith("ADD ")) {
      const addBody = trimmed.slice(4).trim();
      if (/^https?:\/\//i.test(addBody) || /\shttps?:\/\//i.test(addBody)) {
        issues.push({
          code: "remote-add",
          message: "Remote ADD is forbidden.",
          line: lineNumber,
        });
      }
      continue;
    }

    if (
      /--privileged|docker\.sock|\/var\/run\/docker\.sock|cap-add\s+sys_admin/i.test(trimmed)
    ) {
      issues.push({
        code: "privileged",
        message: "Privileged setup / Docker socket references are forbidden.",
        line: lineNumber,
      });
    }

    // COPY project source into image (anything not --from=)
    if (upper.startsWith("COPY ") && !/COPY\s+--from=/i.test(trimmed)) {
      issues.push({
        code: "copies-project-source",
        message: "COPY without --from= would bake build-context files; project source must not enter the image.",
        line: lineNumber,
      });
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    fromImages,
  };
}
