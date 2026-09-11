import { DesktopPlatform, MediaKey, PathInfo, WindowCommand } from "../desktopPlatform";

/**
 * A recording DesktopPlatform for tests: no OS calls, just a list of what
 * would have happened. Paths and open windows are declared up front.
 */
export class FakeDesktop implements DesktopPlatform {
  readonly calls: string[] = [];
  readonly paths = new Map<string, PathInfo>();
  readonly windows = new Map<string, number>();
  /** When set, every operation throws this instead of recording. */
  failWith: Error | null = null;

  addFile(p: string): void {
    this.paths.set(p, { exists: true, isFile: true, isDirectory: false });
  }

  addFolder(p: string): void {
    this.paths.set(p, { exists: true, isFile: false, isDirectory: true });
  }

  async pathInfo(p: string): Promise<PathInfo> {
    return this.paths.get(p) ?? { exists: false, isFile: false, isDirectory: false };
  }

  async openPath(p: string): Promise<void> {
    this.record(`open ${p}`);
  }

  async launchApplication(p: string): Promise<void> {
    this.record(`launch ${p}`);
  }

  async windowCommand(processName: string, command: WindowCommand): Promise<{ windows: number }> {
    this.record(`${command} ${processName}`);
    return { windows: this.windows.get(processName) ?? 0 };
  }

  async sendMediaKey(key: MediaKey): Promise<void> {
    this.record(`key ${key}`);
  }

  async setVolume(percent: number): Promise<void> {
    this.record(`volume ${percent}`);
  }

  async setMuted(muted: boolean): Promise<void> {
    this.record(`muted ${muted}`);
  }

  async lockScreen(): Promise<void> {
    this.record("lock");
  }

  private record(call: string): void {
    if (this.failWith) throw this.failWith;
    this.calls.push(call);
  }
}
