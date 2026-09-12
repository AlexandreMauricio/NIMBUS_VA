/**
 * The Weather tab — now, and the days ahead, from the same weather result
 * the briefing and Attention use (the context snapshot). It adds no
 * request of its own beyond reading the snapshot.
 */

interface DailyForecastUI {
  date: string;
  highC: number;
  lowC: number;
  condition: string;
  precipitationProbabilityPercent: number | null;
}

interface WeatherUI {
  location: { label: string; source: "auto" | "manual" };
  temperatureC: number;
  apparentTemperatureC: number | null;
  condition: string;
  precipitationProbabilityPercent: number | null;
  todayHighC: number | null;
  todayLowC: number | null;
  forecast: DailyForecastUI[];
  retrievedAt: string;
}

interface ProviderResultUI {
  status: "ok" | "error" | "unavailable";
  data: unknown;
  stale: boolean;
  error?: string;
}

interface WeatherBridge {
  getContext(): Promise<{ providers: Record<string, ProviderResultUI | undefined> }>;
}

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const degrees = (value: number | null): string => (value === null ? "—" : `${Math.round(value)}°`);

/** "Today", "Tomorrow", or the weekday — from an ISO date, read as a local calendar date. */
function dayLabel(isoDate: string, today: Date): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((date.getTime() - midnight.getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" });
}

function render(container: HTMLElement, result: ProviderResultUI | undefined): void {
  container.replaceChildren();

  if (!result || result.status === "unavailable" || !result.data) {
    container.appendChild(
      make(
        "p",
        "calendar-empty",
        result?.status === "error"
          ? "The weather service couldn't be reached. Check the Context tab for details."
          : "Weather has no location yet — set one in Settings."
      )
    );
    return;
  }

  const weather = result.data as WeatherUI;
  const now = make("div", "weather-now");
  now.appendChild(make("div", "weather-now-temp", degrees(weather.temperatureC)));
  const nowText = make("div", "weather-now-text");
  nowText.appendChild(make("div", "weather-now-condition", weather.condition));
  const details = [
    weather.apparentTemperatureC !== null ? `Feels like ${degrees(weather.apparentTemperatureC)}` : null,
    weather.todayHighC !== null && weather.todayLowC !== null
      ? `${degrees(weather.todayHighC)} / ${degrees(weather.todayLowC)} today`
      : null,
    weather.precipitationProbabilityPercent !== null
      ? `${weather.precipitationProbabilityPercent}% chance of rain`
      : null,
  ].filter(Boolean);
  nowText.appendChild(make("div", "weather-now-details", details.join(" · ")));
  const updated = new Date(weather.retrievedAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  nowText.appendChild(
    make(
      "div",
      "weather-now-meta",
      `${weather.location.label}${weather.location.source === "auto" ? " (approximate)" : ""} · updated ${updated}`
    )
  );
  now.appendChild(nowText);
  container.appendChild(now);

  const today = new Date();
  const days = make("div", "weather-days");
  for (const day of weather.forecast) {
    const card = make("div", "weather-day");
    card.appendChild(make("div", "weather-day-label", dayLabel(day.date, today)));
    card.appendChild(make("div", "weather-day-condition", day.condition));
    card.appendChild(make("div", "weather-day-temps", `${degrees(day.highC)} / ${degrees(day.lowC)}`));
    if (day.precipitationProbabilityPercent !== null) {
      const rain = make("div", "weather-day-rain", `${day.precipitationProbabilityPercent}% rain`);
      if (day.precipitationProbabilityPercent >= 50) rain.classList.add("weather-day-rain-likely");
      card.appendChild(rain);
    }
    days.appendChild(card);
  }
  container.appendChild(days);

  if (result.stale) {
    container.appendChild(make("p", "calendar-empty", "Showing the last forecast that loaded."));
  }
}

export function initWeatherTab(): void {
  const container = document.getElementById("weatherTabContent") as HTMLElement;
  const bridge = (window as unknown as { nimbus: WeatherBridge }).nimbus;

  const load = async (): Promise<void> => {
    try {
      const snapshot = await bridge.getContext();
      render(container, snapshot.providers.weather);
    } catch (err) {
      console.error("Failed to load weather", err);
    }
  };

  document.getElementById("refreshWeatherBtn")?.addEventListener("click", () => void load());
  document.querySelector('.side-link[data-tab="weather"]')?.addEventListener("click", () => void load());
  void load();
}
