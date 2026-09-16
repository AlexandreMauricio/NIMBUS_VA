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

export interface ColourLineUI {
  colour: string;
  label: string;
  symbols: number;
  share: number;
  sources: number;
  needed: number;
  hardest: string | null;
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
 * `pick`, when given, makes each column a button: clicking one calls
 * `onPick` with its index (or null to clear the column already `selected`).
 */
export function curveChart(
  title: string,
  bars: StatBarUI[],
  targets?: number[],
  pick?: { selected: number | null; onPick: (index: number | null) => void }
): HTMLElement {
  const wrap = el("figure", "deck-curve");
  wrap.appendChild(el("figcaption", "collection-meta", title));
  const chart = el("div", "deck-curve-bars");
  const peak = Math.max(1, ...bars.map((b) => b.count), ...(targets ?? []));
  bars.forEach((bar, i) => {
    const target = targets?.[i];
    const column = pick ? el("button", "deck-curve-col deck-curve-pick") : el("div", "deck-curve-col");
    if (pick && column instanceof HTMLButtonElement) {
      column.type = "button";
      const selected = pick.selected === i;
      column.classList.toggle("is-selected", selected);
      column.setAttribute("aria-pressed", String(selected));
      column.addEventListener("click", () => pick.onPick(selected ? null : i));
    }
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
export function deckShape(
  stats: DeckStatsUI,
  onRefresh?: (button: HTMLButtonElement) => void,
  colours?: ColourLineUI[] | null,
  staleCards = stats.unknown
): HTMLElement {
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
  if (colours?.length) side.appendChild(colourBalanceBlock(colours));
  if (staleCards > 0) {
    const note = el(
      "p",
      "collection-meta",
      stats.unknown > 0
        ? `${stats.unknown} card${stats.unknown === 1 ? "" : "s"} were added before NIMBUS kept costs and card types, so they're not counted above.`
        : `${staleCards} card${staleCards === 1 ? " was" : "s were"} added before NIMBUS kept mana symbols, so colour balance leaves them out.`
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

/** Magic: each colour's share of the mana symbols, and its lands against what its hardest spell needs (Core's mana.ts). */
export function colourBalanceBlock(lines: ColourLineUI[]): HTMLElement {
  const block = el("div", "builder-colours");
  block.appendChild(
    el("div", "collection-meta", "Colour balance — mana symbols, and lands that make each colour")
  );
  for (const line of lines) {
    const row = el("div", `builder-colour-row${line.needed > line.sources ? " builder-colour-short" : ""}`);
    const bar = el("span", "builder-colour-bar");
    const fill = el("span", `builder-colour-fill builder-colour-${line.colour.toLowerCase()}`);
    fill.style.width = `${line.share}%`;
    bar.appendChild(fill);
    const detail = line.symbols
      ? `${line.share}% of symbols · ${line.sources} lands${line.needed ? ` — ${line.hardest} wants about ${line.needed}` : ""}`
      : `no cards need it yet · ${line.sources} lands`;
    row.append(el("span", "builder-colour-name", line.label), bar, el("span", "collection-meta", detail));
    block.appendChild(row);
  }
  block.appendChild(
    el(
      "p",
      "builder-footnote",
      "Lands needed are Frank Karsten's counts for casting a spell on curve about 90% of the time. Dual lands count for both colours."
    )
  );
  return block;
}
