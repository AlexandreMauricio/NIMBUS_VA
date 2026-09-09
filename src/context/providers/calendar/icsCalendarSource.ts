import * as fs from "fs";
import { httpTimeoutSignal } from "../../../common/timeout";

/**
 * Fetches the raw text of one ICS ("iCalendar") feed. This is the
 * external-integration boundary for calendar data — see
 * ARCHITECTURE.md's "External integrations" layer, same role as
 * OpenMeteoClient/IpGeolocationClient play for weather.
 *
 * ICS is a deliberately low-friction choice for a first calendar
 * integration: Google Calendar, Outlook/Office 365, iCloud, and most
 * other calendar providers can all publish a private "secret address in
 * iCal format" URL for a calendar, with no OAuth app registration, no
 * client secret, and no token refresh logic required. The URL itself is
 * the credential — treat it exactly like one (never logged, never sent
 * anywhere but to fetch this feed). See README.md for how a user obtains
 * one, and ARCHITECTURE.md for how a future OAuth-based source (Google/
 * Microsoft Graph) would plug in alongside this one without the
 * CalendarProvider needing to change.
 *
 * A `http(s)://` address is fetched over the network; anything else is
 * treated as a local file path — useful for testing with a fixture
 * file, or for a user who exports/syncs a `.ics` file locally rather
 * than publishing one.
 *
 * A local path must actually name a calendar file (see
 * CALENDAR_FILE_EXTENSIONS). Without that check, "anything that is not
 * a URL is a file path" quietly makes this a read-any-file-on-disk
 * capability whose contents get parsed and surfaced in the briefing —
 * far broader than "read a calendar feed", and reachable by a typo (a
 * half-typed address, a bare Windows path) as easily as on purpose. The
 * restriction costs the real use case nothing: an exported calendar is
 * a `.ics` file by definition.
 */

/** Extensions a local calendar file is allowed to have. `.ifb` is the free/busy variant of the same format. */
const CALENDAR_FILE_EXTENSIONS = [".ics", ".ical", ".ifb"];
export class IcsCalendarSource {
  constructor(
    private readonly address: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly readFileFn: (path: string) => Promise<string> = (p) => fs.promises.readFile(p, "utf-8")
  ) {}

  async fetchRaw(): Promise<string> {
    if (/^https?:\/\//i.test(this.address)) {
      const response = await this.fetchFn(this.address, { signal: httpTimeoutSignal() });
      if (!response.ok) {
        throw new Error(`Calendar feed request failed with status ${response.status}`);
      }
      return response.text();
    }
    if (!isCalendarFilePath(this.address)) {
      throw new Error("Calendar feed address must be an http(s):// URL or a path to a .ics file");
    }
    return this.readFileFn(this.address);
  }
}

/** True when `address` names a local calendar file NIMBUS is willing to read. */
function isCalendarFilePath(address: string): boolean {
  // Compared against the path with any query/fragment ignored — a local
  // path has none, and stripping them keeps a stray "?" from defeating
  // the extension check.
  const withoutSuffix = address.split(/[?#]/)[0].trim().toLowerCase();
  return CALENDAR_FILE_EXTENSIONS.some((ext) => withoutSuffix.endsWith(ext));
}
