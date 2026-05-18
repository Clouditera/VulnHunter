export type VersionCompatibility = { ok: true } | { ok: false; reason: "version_mismatch" };

function parseVersion(version: string): { major: string; minor?: string; patch?: string } | null {
  const raw = version.trim();
  const match = raw.match(/^(\d+)(?:\.(\d+|x))?(?:\.(\d+|x))?$/i);
  if (!match) return null;
  return { major: match[1], minor: match[2]?.toLowerCase(), patch: match[3]?.toLowerCase() };
}

export function isLicenseVersionCompatible(licensedVersion: string | undefined, currentVersion: string): boolean {
  if (!licensedVersion) return false;
  const licensed = parseVersion(licensedVersion);
  const current = parseVersion(currentVersion);
  if (!licensed || !current) return false;
  if (licensed.major !== current.major) return false;
  if (!licensed.minor || licensed.minor === "x") return true;
  if (licensed.minor !== current.minor) return false;
  if (!licensed.patch || licensed.patch === "x") return true;
  return licensed.patch === current.patch;
}

export function checkLicenseVersion(licensedVersion: string | undefined, currentVersion: string): VersionCompatibility {
  return isLicenseVersionCompatible(licensedVersion, currentVersion)
    ? { ok: true }
    : { ok: false, reason: "version_mismatch" };
}
