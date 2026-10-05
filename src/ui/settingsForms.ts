/**
 * Settings: startup, weather location, calendar feeds, email and Todoist
 * accounts, and Spotify.
 */

import { maskAddress } from "./uiFormat";
import type {
  CalendarFeed,
  CalendarSettings,
  EmailAccount,
  EmailSettings,
  SpotifySettings,
  TaskAccount,
  TaskSettings,
} from "./rendererTypes";

export async function initSettings(): Promise<void> {
  const launchCheckbox = document.getElementById("launchWithWindows") as HTMLInputElement;
  const minimizedCheckbox = document.getElementById("startMinimized") as HTMLInputElement;

  try {
    const settings = await window.nimbus.getSettings();
    launchCheckbox.checked = settings.launchWithWindows;
    minimizedCheckbox.checked = settings.startMinimized;
  } catch (err) {
    console.error("Failed to load settings", err);
  }

  launchCheckbox.addEventListener("change", () => {
    window.nimbus.updateSettings({ launchWithWindows: launchCheckbox.checked });
  });

  minimizedCheckbox.addEventListener("change", () => {
    window.nimbus.updateSettings({ startMinimized: minimizedCheckbox.checked });
  });

  const zoomSelect = document.getElementById("uiZoom") as HTMLSelectElement;
  try {
    zoomSelect.value = String(await window.nimbus.getZoom());
  } catch (err) {
    console.error("Failed to load the interface size", err);
  }
  zoomSelect.addEventListener("change", () => {
    void window.nimbus.setZoom(Number(zoomSelect.value));
  });
  // Ctrl+= / Ctrl+- / Ctrl+0 change it too - keep the picker in step.
  window.nimbus.onZoomChanged((percent) => {
    zoomSelect.value = String(percent);
  });
}

export async function initWeatherSettings(): Promise<void> {
  const modeSelect = document.getElementById("locationModeSelect") as HTMLSelectElement;
  const manualFields = document.getElementById("manualLocationFields") as HTMLElement;
  const labelInput = document.getElementById("manualLocationLabel") as HTMLInputElement;
  const latInput = document.getElementById("manualLocationLat") as HTMLInputElement;
  const lonInput = document.getElementById("manualLocationLon") as HTMLInputElement;
  const saveBtn = document.getElementById("saveManualLocationBtn") as HTMLButtonElement;
  const searchInput = document.getElementById("placeSearchInput") as HTMLInputElement;
  const searchBtn = document.getElementById("placeSearchBtn") as HTMLButtonElement;
  const searchResults = document.getElementById("placeSearchResults") as HTMLElement;
  const locationStatus = document.getElementById("manualLocationStatus") as HTMLElement;

  function syncManualFieldsVisibility(): void {
    manualFields.hidden = modeSelect.value !== "manual";
  }

  try {
    const weatherSettings = await window.nimbus.getWeatherSettings();
    modeSelect.value = weatherSettings.locationMode;
    if (weatherSettings.manualLocation) {
      labelInput.value = weatherSettings.manualLocation.label;
      latInput.value = String(weatherSettings.manualLocation.latitude);
      lonInput.value = String(weatherSettings.manualLocation.longitude);
    }
  } catch (err) {
    console.error("Failed to load weather settings", err);
  }

  syncManualFieldsVisibility();

  modeSelect.addEventListener("change", () => {
    syncManualFieldsVisibility();
    window.nimbus.updateWeatherSettings({ locationMode: modeSelect.value as "auto" | "manual" });
  });

  async function saveManualLocation(): Promise<void> {
    const latitude = Number(latInput.value);
    const longitude = Number(lonInput.value);
    if (
      !latInput.value.trim() ||
      !lonInput.value.trim() ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      locationStatus.textContent = "Search for a place, or enter a latitude and longitude.";
      latInput.focus();
      return;
    }
    try {
      const saved = await window.nimbus.updateWeatherSettings({
        manualLocation: {
          latitude,
          longitude,
          label: labelInput.value.trim() || `${latitude}, ${longitude}`,
        },
      });
      locationStatus.textContent = `Saved: ${saved.manualLocation?.label ?? labelInput.value}.`;
    } catch (err) {
      console.error("Failed to save the weather location", err);
      locationStatus.textContent = "Couldn't save the location.";
    }
  }

  saveBtn.addEventListener("click", () => void saveManualLocation());

  async function searchPlaces(): Promise<void> {
    const query = searchInput.value.trim();
    searchResults.replaceChildren();
    if (query.length < 2) {
      locationStatus.textContent = "Type at least two letters of a place name.";
      return;
    }
    searchBtn.disabled = true;
    locationStatus.textContent = "Searching…";
    try {
      const places = await window.nimbus.searchPlaces(query);
      locationStatus.textContent = places.length ? "" : `No places found for "${query}".`;
      for (const place of places) {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "place-search-result";
        option.textContent = place.label;
        const coords = document.createElement("span");
        coords.className = "place-search-coords";
        coords.textContent = `${place.latitude.toFixed(2)}, ${place.longitude.toFixed(2)}`;
        option.appendChild(coords);
        option.addEventListener("click", () => {
          labelInput.value = place.label;
          latInput.value = String(place.latitude);
          lonInput.value = String(place.longitude);
          searchResults.replaceChildren();
          void saveManualLocation();
        });
        searchResults.appendChild(option);
      }
    } catch (err) {
      console.error("Place search failed", err);
      locationStatus.textContent = "Couldn't reach the place search. Check the connection and try again.";
    } finally {
      searchBtn.disabled = false;
    }
  }

  searchBtn.addEventListener("click", () => void searchPlaces());
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void searchPlaces();
    }
  });
}

/** Shortens a feed address for display — it's a credential, not something to show in full in a settings list. */
export async function initCalendarSettings(): Promise<void> {
  const enabledCheckbox = document.getElementById("calendarEnabled") as HTMLInputElement;
  const feedList = document.getElementById("calendarFeedList") as HTMLElement;
  const labelInput = document.getElementById("calendarFeedLabel") as HTMLInputElement;
  const addressInput = document.getElementById("calendarFeedAddress") as HTMLInputElement;
  const addBtn = document.getElementById("addCalendarFeedBtn") as HTMLButtonElement;

  function renderFeeds(settings: CalendarSettings): void {
    feedList.innerHTML = "";
    for (const feed of settings.feeds) {
      const row = document.createElement("div");
      row.className = "calendar-feed-row";

      const info = document.createElement("div");
      const labelEl = document.createElement("span");
      labelEl.className = "calendar-feed-row-label";
      labelEl.textContent = feed.label;
      const addressEl = document.createElement("span");
      addressEl.className = "calendar-feed-row-address";
      addressEl.textContent = maskAddress(feed.address);
      info.appendChild(labelEl);
      info.appendChild(addressEl);
      row.appendChild(info);

      const actions = document.createElement("div");
      actions.className = "calendar-feed-row-actions";

      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = feed.enabled;
      toggle.title = "Enabled";
      toggle.addEventListener("change", async () => {
        const updated = settings.feeds.map((f) => (f.id === feed.id ? { ...f, enabled: toggle.checked } : f));
        const saved = await window.nimbus.updateCalendarSettings({ feeds: updated });
        renderFeeds(saved);
      });
      actions.appendChild(toggle);

      const removeBtn = document.createElement("button");
      removeBtn.className = "calendar-feed-remove";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", async () => {
        const updated = settings.feeds.filter((f) => f.id !== feed.id);
        const saved = await window.nimbus.updateCalendarSettings({ feeds: updated });
        renderFeeds(saved);
      });
      actions.appendChild(removeBtn);

      row.appendChild(actions);
      feedList.appendChild(row);
    }
  }

  try {
    const settings = await window.nimbus.getCalendarSettings();
    enabledCheckbox.checked = settings.enabled;
    renderFeeds(settings);
  } catch (err) {
    console.error("Failed to load calendar settings", err);
  }

  enabledCheckbox.addEventListener("change", () => {
    window.nimbus.updateCalendarSettings({ enabled: enabledCheckbox.checked });
  });

  addBtn.addEventListener("click", async () => {
    const label = labelInput.value.trim();
    const address = addressInput.value.trim();
    if (!label || !address) {
      (label ? addressInput : labelInput).focus();
      return;
    }

    const current = await window.nimbus.getCalendarSettings();
    const newFeed: CalendarFeed = {
      id: `feed-${Date.now()}`,
      label,
      address,
      enabled: true,
    };
    const saved = await window.nimbus.updateCalendarSettings({
      feeds: [...current.feeds, newFeed],
    });
    renderFeeds(saved);
    labelInput.value = "";
    addressInput.value = "";
  });
}

export async function initEmailSettings(): Promise<void> {
  const enabledCheckbox = document.getElementById("emailEnabled") as HTMLInputElement;
  const accountList = document.getElementById("emailAccountList") as HTMLElement;
  const labelInput = document.getElementById("emailAccountLabel") as HTMLInputElement;
  const hostInput = document.getElementById("emailAccountHost") as HTMLInputElement;
  const portInput = document.getElementById("emailAccountPort") as HTMLInputElement;
  const secureInput = document.getElementById("emailAccountSecure") as HTMLInputElement;
  const usernameInput = document.getElementById("emailAccountUsername") as HTMLInputElement;
  const passwordInput = document.getElementById("emailAccountPassword") as HTMLInputElement;
  const addBtn = document.getElementById("addEmailAccountBtn") as HTMLButtonElement;

  // The password never comes back from getEmailSettings() — every update
  // must resubmit every account so we don't accidentally drop one, and
  // must never include a password unless the user is actually changing it.
  function toUpdatePayload(account: EmailAccount): Omit<EmailAccount, "hasPassword"> {
    const { hasPassword: _hasPassword, ...rest } = account;
    return rest;
  }

  function renderAccounts(settings: EmailSettings): void {
    accountList.innerHTML = "";
    for (const account of settings.accounts) {
      const row = document.createElement("div");
      row.className = "calendar-feed-row";

      const info = document.createElement("div");
      const labelEl = document.createElement("span");
      labelEl.className = "calendar-feed-row-label";
      labelEl.textContent = account.label;
      const metaEl = document.createElement("span");
      metaEl.className = "calendar-feed-row-address";
      metaEl.textContent = `${account.username} · ${account.host}:${account.port}${account.hasPassword ? "" : " · no password saved"}`;
      info.appendChild(labelEl);
      info.appendChild(metaEl);
      row.appendChild(info);

      const actions = document.createElement("div");
      actions.className = "calendar-feed-row-actions";

      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = account.enabled;
      toggle.title = "Enabled";
      toggle.addEventListener("change", async () => {
        const updated = settings.accounts.map((a) =>
          a.id === account.id ? toUpdatePayload({ ...a, enabled: toggle.checked }) : toUpdatePayload(a)
        );
        const saved = await window.nimbus.updateEmailSettings({ accounts: updated });
        renderAccounts(saved);
      });
      actions.appendChild(toggle);

      const removeBtn = document.createElement("button");
      removeBtn.className = "calendar-feed-remove";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", async () => {
        const updated = settings.accounts.filter((a) => a.id !== account.id).map(toUpdatePayload);
        const saved = await window.nimbus.updateEmailSettings({ accounts: updated });
        renderAccounts(saved);
      });
      actions.appendChild(removeBtn);

      row.appendChild(actions);
      accountList.appendChild(row);
    }
  }

  try {
    const settings = await window.nimbus.getEmailSettings();
    enabledCheckbox.checked = settings.enabled;
    renderAccounts(settings);
  } catch (err) {
    console.error("Failed to load email settings", err);
  }

  enabledCheckbox.addEventListener("change", () => {
    window.nimbus.updateEmailSettings({ enabled: enabledCheckbox.checked });
  });

  addBtn.addEventListener("click", async () => {
    const label = labelInput.value.trim();
    const host = hostInput.value.trim();
    const username = usernameInput.value.trim();
    const password = passwordInput.value; // not trimmed — a password could legitimately have leading/trailing spaces
    const port = Number(portInput.value) || 993;

    if (!label || !host || !username || !password) {
      (label ? (host ? (username ? passwordInput : usernameInput) : hostInput) : labelInput).focus();
      return;
    }

    const current = await window.nimbus.getEmailSettings();
    const newAccount = {
      id: `account-${Date.now()}`,
      label,
      host,
      port,
      secure: secureInput.checked,
      username,
      sinceDays: 0,
      enabled: true,
      newPassword: password,
    };
    const saved = await window.nimbus.updateEmailSettings({
      accounts: [...current.accounts.map(toUpdatePayload), newAccount],
    });
    renderAccounts(saved);
    labelInput.value = "";
    hostInput.value = "";
    usernameInput.value = "";
    passwordInput.value = "";
    portInput.value = "993";
    secureInput.checked = true;
  });
}

export async function initTaskSettings(): Promise<void> {
  const enabledCheckbox = document.getElementById("tasksEnabled") as HTMLInputElement;
  const accountList = document.getElementById("taskAccountList") as HTMLElement;
  const labelInput = document.getElementById("taskAccountLabel") as HTMLInputElement;
  const tokenInput = document.getElementById("taskAccountToken") as HTMLInputElement;
  const addBtn = document.getElementById("addTaskAccountBtn") as HTMLButtonElement;

  // The API token never comes back from getTaskSettings() — every update
  // must resubmit every account so we don't accidentally drop one, and
  // must never include a token unless the user is actually changing it.
  function toUpdatePayload(account: TaskAccount): Omit<TaskAccount, "hasApiToken"> {
    const { hasApiToken: _hasApiToken, ...rest } = account;
    return rest;
  }

  function renderAccounts(settings: TaskSettings): void {
    accountList.innerHTML = "";
    for (const account of settings.accounts) {
      const row = document.createElement("div");
      row.className = "calendar-feed-row";

      const info = document.createElement("div");
      const labelEl = document.createElement("span");
      labelEl.className = "calendar-feed-row-label";
      labelEl.textContent = account.label;
      const metaEl = document.createElement("span");
      metaEl.className = "calendar-feed-row-address";
      metaEl.textContent = `Todoist${account.hasApiToken ? "" : " · no API token saved"}`;
      info.appendChild(labelEl);
      info.appendChild(metaEl);
      row.appendChild(info);

      const actions = document.createElement("div");
      actions.className = "calendar-feed-row-actions";

      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = account.enabled;
      toggle.title = "Enabled";
      toggle.addEventListener("change", async () => {
        const updated = settings.accounts.map((a) =>
          a.id === account.id ? toUpdatePayload({ ...a, enabled: toggle.checked }) : toUpdatePayload(a)
        );
        const saved = await window.nimbus.updateTaskSettings({ accounts: updated });
        renderAccounts(saved);
      });
      actions.appendChild(toggle);

      const removeBtn = document.createElement("button");
      removeBtn.className = "calendar-feed-remove";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", async () => {
        const updated = settings.accounts.filter((a) => a.id !== account.id).map(toUpdatePayload);
        const saved = await window.nimbus.updateTaskSettings({ accounts: updated });
        renderAccounts(saved);
      });
      actions.appendChild(removeBtn);

      row.appendChild(actions);
      accountList.appendChild(row);
    }
  }

  try {
    const settings = await window.nimbus.getTaskSettings();
    enabledCheckbox.checked = settings.enabled;
    renderAccounts(settings);
  } catch (err) {
    console.error("Failed to load task settings", err);
  }

  enabledCheckbox.addEventListener("change", () => {
    window.nimbus.updateTaskSettings({ enabled: enabledCheckbox.checked });
  });

  addBtn.addEventListener("click", async () => {
    const label = labelInput.value.trim();
    const apiToken = tokenInput.value.trim();

    if (!label || !apiToken) {
      (label ? tokenInput : labelInput).focus();
      return;
    }

    const current = await window.nimbus.getTaskSettings();
    const newAccount = {
      id: `task-account-${Date.now()}`,
      label,
      provider: "todoist" as const,
      enabled: true,
      newApiToken: apiToken,
    };
    const saved = await window.nimbus.updateTaskSettings({
      accounts: [...current.accounts.map(toUpdatePayload), newAccount],
    });
    renderAccounts(saved);
    labelInput.value = "";
    tokenInput.value = "";
  });
}

export async function initSpotifySettings(): Promise<void> {
  const enabledCheckbox = document.getElementById("spotifyEnabled") as HTMLInputElement;
  const statusEl = document.getElementById("spotifyStatus") as HTMLElement;
  const connectBtn = document.getElementById("spotifyConnectBtn") as HTMLButtonElement;
  const disconnectBtn = document.getElementById("spotifyDisconnectBtn") as HTMLButtonElement;

  function renderConnectionState(settings: SpotifySettings): void {
    statusEl.textContent = settings.connected ? "Connected" : "Not connected";
    connectBtn.hidden = settings.connected;
    disconnectBtn.hidden = !settings.connected;
  }

  try {
    const settings = await window.nimbus.getSpotifySettings();
    enabledCheckbox.checked = settings.enabled;
    renderConnectionState(settings);
  } catch (err) {
    console.error("Failed to load Spotify settings", err);
  }

  enabledCheckbox.addEventListener("change", async () => {
    const settings = await window.nimbus.updateSpotifySettings({ enabled: enabledCheckbox.checked });
    renderConnectionState(settings);
  });

  connectBtn.addEventListener("click", async () => {
    connectBtn.disabled = true;
    statusEl.textContent = "Connecting… complete sign-in in your browser";
    try {
      const result = await window.nimbus.connectSpotify();
      const settings = await window.nimbus.getSpotifySettings();
      renderConnectionState(settings);
      if (result.error) statusEl.textContent = result.error;
    } finally {
      connectBtn.disabled = false;
    }
  });

  disconnectBtn.addEventListener("click", async () => {
    await window.nimbus.disconnectSpotify();
    const settings = await window.nimbus.getSpotifySettings();
    renderConnectionState(settings);
  });
}
