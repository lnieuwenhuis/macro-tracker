export const APP_VERSION = "2.10.0";
export const APP_VERSION_LABEL = formatAppVersionLabel(APP_VERSION);

export function formatAppVersionLabel(version: string) {
  const [major, minor] = version.split(".");

  if (!major || !minor) {
    return `v${version}`;
  }

  return `v${major}.${minor.padStart(2, "0")}`;
}
