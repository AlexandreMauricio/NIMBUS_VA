/**
 * A deck's shape, drawn: the curve as columns (with an optional target
 * marker per column, which the deck builder uses for the playstyle's
 * recommended curve), and the kinds and game counts as labelled numbers.
 * Data comes from Core's deckStats (src/collections/decks/stats.ts).
 */

export interface StatBarUI {
  label: string;
  count: number;
}

export interface DeckStatsUI {
  curveTitle: string | null;
  curve: StatBarUI[];
  averageCost: number | null;
  kinds: StatBarUI[];
  highlights: StatBarUI[];
  unknown: number;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/**
 * The curve as columns. `targets`, when given, is the recommended count
 * per column in the same order; a column under its target is marked.
 */
export function curveChart(title: string, bars: StatBarUI[], targets?: number[]): HTMLElement {
  const wrap = el("figure", "deck-curve");
  wrap.appendChild(el("figcaption", "collection-meta", title));
  const chart = el("div", "deck-curve-bars");
  const peak = Math.max(1, ...bars.map((b) => b.count), ...(targets ?? []));
  bars.forEach((bar, i) => {
    const target = targets?.[i];
    const column = el("div", "deck-curve-col");
    const label =
      target === undefined
        ? `${bar.label}: ${bar.count}`
        : `${bar.label}: ${bar.count} (aim for about ${target})`;
    column.title = label;
    column.setAttribute("aria-label", label);
    const area = el("div", "deck-curve-area");
    const fill = el("div", "deck-curve-fill");
    fill.style.height = `${(bar.count / peak) * 100}%`;
    if (target !== undefined) {
      const diff = bar.count - target;
      if (diff < -1) fill.classList.add("deck-curve-under");
      else if (diff > 1) fill.classList.add("deck-curve-over");
      const marker = el("div", "deck-curve-target");
      marker.style.bottom = `${(target / peak) * 100}%`;
      area.appendChild(marker);
    }
    area.appendChild(fill);
    column.append(
      el("span", "deck-curve-count", target === undefined ? String(bar.count) : `${bar.count}/${target}`),
      area,
      el("span", "deck-curve-label", bar.label)
    );
    chart.appendChild(column);
  });
  wrap.appendChild(chart);
  return wrap;
}

/** "Creatures 18 · Lands 24" as a row of labelled numbers. */
export function countRow(bars: StatBarUI[], targets?: Map<string, number>): HTMLElement {
  const row = el("div", "deck-counts");
  for (const bar of bars) {
    const target = targets?.get(bar.label);
    const item = el("span", "deck-count");
    item.append(
      el("strong", undefined, target === undefined ? String(bar.count) : `${bar.count}/${target}`),
      document.createTextNode(` ${bar.label}`)
    );
    row.appendChild(item);
  }
  return row;
}

/** The deck page's "Shape" block. `onRefresh` is offered when some cards have no saved card data. */
export function deckShape(stats: DeckStatsUI, onRefresh?: (button: HTMLButtonElement) => void): HTMLElement {
  const block = el("section", "deck-shape");
  const total = stats.kinds.reduce((sum, k) => sum + k.count, 0) + stats.unknown;
  if (!total) return block;
  if (stats.curveTitle && stats.curve.some((b) => b.count > 0)) {
    const title =
      stats.averageCost !== null ? `${stats.curveTitle} — average ${stats.averageCost}` : stats.curveTitle;
    block.appendChild(curveChart(title, stats.curve));
  }
  const side = el("div", "deck-shape-side");
  if (stats.kinds.length) side.appendChild(countRow(stats.kinds));
  if (stats.highlights.length) side.appendChild(countRow(stats.highlights));
  if (stats.unknown > 0) {
    const note = el(
      "p",
      "collection-meta",
      `${stats.unknown} card${stats.unknown === 1 ? "" : "s"} were added before NIMBUS kept costs and card types, so they're not counted above.`
    );
    side.appendChild(note);
    if (onRefresh) {
      const button = el("button", "btn btn-secondary", "Update card data");
      button.type = "button";
      button.addEventListener("click", () => onRefresh(button));
      side.appendChild(button);
    }
  }
  block.appendChild(side);
  return block;
}
