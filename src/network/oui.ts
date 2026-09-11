import { isRandomizedMac, macPrefix } from "./mac";

/**
 * Manufacturer names from the IEEE MA-L registry CSV ("oui.csv":
 * Registry,Assignment,Organization Name,Organization Address).
 *
 * NIMBUS ships no copy and never downloads one: a partial, hand-kept list
 * would be wrong more often than right. If the user places the official
 * file in NIMBUS's data folder, it is read from there (see docs/network.md).
 */
export function parseOuiCsv(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const fields = parseCsvLine(line);
    if (fields.length < 3) continue;
    const assignment = fields[1].trim().toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(assignment)) continue;
    const organization = fields[2].trim();
    if (organization) map.set(assignment, organization);
  }
  return map;
}

/** A lookup function; a randomized (private) address has no manufacturer to find. */
export function vendorLookup(map: Map<string, string>): (mac: string) => string | null {
  return (mac) => (isRandomizedMac(mac) ? null : (map.get(macPrefix(mac)) ?? null));
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        current += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      fields.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  fields.push(current);
  return fields;
}
