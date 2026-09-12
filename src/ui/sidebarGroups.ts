/**
 * Collapsible groups in the sidebar ("Admin"). Which groups are folded is
 * a per-viewer convenience kept in localStorage; a group opens by itself
 * whenever one of its tabs becomes the active one, so a link from
 * elsewhere (a briefing item, "make it an activity?") never lands on a tab
 * whose place in the sidebar is hidden.
 */

const STORAGE_KEY = "nimbus.sidebar.collapsedGroups";

function readCollapsed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(collapsed: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...collapsed]));
  } catch {
    // A convenience only — folding still works for this session.
  }
}

export function initSidebarGroups(): void {
  const collapsed = readCollapsed();

  document.querySelectorAll<HTMLElement>(".sidebar-group").forEach((group) => {
    const id = group.dataset.group ?? "";
    const toggle = group.querySelector<HTMLButtonElement>(".sidebar-group-toggle");
    const links = group.querySelector<HTMLElement>(".sidebar-group-links");
    if (!id || !toggle || !links) return;

    const setOpen = (open: boolean): void => {
      links.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      group.classList.toggle("sidebar-group-collapsed", !open);
      if (open) collapsed.delete(id);
      else collapsed.add(id);
      writeCollapsed(collapsed);
    };

    // Never start folded over the tab that's showing.
    setOpen(!collapsed.has(id) || links.querySelector(".side-link.active") !== null);
    toggle.addEventListener("click", () => setOpen(links.hidden));
    links.querySelectorAll<HTMLButtonElement>(".side-link").forEach((link) => {
      link.addEventListener("click", () => {
        if (links.hidden) setOpen(true);
      });
    });
  });
}
