import * as fs from "fs";

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
 */
export class IcsCalendarSource {
  constructor(
    private readonly address: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly readFileFn: (path: string) => Promise<string> = (p) =>
      fs.promises.readFile(p, "utf-8")
  ) {}

  async fetchRaw(): Promise<string> {
    if (/^https?:\/\//i.test(this.address)) {
      const response = await this.fetchFn(this.address);
      if (!response.ok) {
        throw new Error(`Calendar feed request failed with status ${response.status}`);
      }
      return response.text();
    }
    return this.readFileFn(this.address);
  }
}
