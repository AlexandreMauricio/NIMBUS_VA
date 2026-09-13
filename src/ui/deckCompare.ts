/**
 * "Compare with average decks" on a Magic Commander deck's page: pick up to
 * five of EDHREC's average decks for the commander (the average, budget,
 * expensive, and each popular theme), then see them side by side with
 * yours — card types, mana value, ramp, draw, removal and wipes against the
 * usual Commander guidelines, the curve, the cards they agree on that you
 * don't play (addable), and yours that none of them play.
 *
 * The work is the main process's (nimbus:deck-compare); the comparison is
 * Core's (collections/decks/compare.ts). Kept per deck while the app is
 * open, so adding a card doesn't lose it.
 */
import { curveBuckets } from "../collections/decks/stats";
import { openCardPage } from "./cardPage";
import { curveChart } from "./deckCharts";

interface VariantUI {
  id: string;
  label: string;
  decks: number | null;
}

interface ProfileUI {
  label: string;
  total: number;
  lands: number;
  kinds: Record<string, number>;
  averageCost: number | null;
  curve: number[];
  roles: Record<"ramp" | "draw" | "removal" | "wipe", number>;
}

interface ComparisonUI {
  commander: string;
  totalDecks: number | null;
  references: VariantUI[];
  comparison: {
    profiles: ProfileUI[];
    guidelines: Array<{
      key: string;
      label: string;
      min: number;
      max: number | null;
      why: string;
      values: number[];
      status: "ok" | "low" | "high";
    }>;
    overlap: number[];
    missing: Array<{
      name: string;
      inDecks: number;
      info: { sourceId: string; imageUrl: string | null; kind: string | null; cost: number | null } | null;
    }>;
    onlyMine: string[];
    unknown: number;
  };
}

interface CompareBridge {
  deckCompareOptions(id: string): Promise<{ commander: string; decks: number | null; variants: VariantUI[] }>;
  deckCompare(id: string, variants: string[]): Promise<ComparisonUI>;
  addDeckCard(id: string, sourceId: string, zone: string | null): Promise<unknown>;
}

const bridge = (): CompareBridge => (window as unknown as { nimbus: CompareBridge }).nimbus;

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = make("button", className, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

const errorText = (err: unknown): string => String(err).replace(/^.*Error: /, "");

interface CompareState {
  open: boolean;
  options: { commander: string; decks: number | null; variants: VariantUI[] } | null;
  selected: Set<string> | null;
  result: ComparisonUI | null;
  added: Set<string>;
  message: string;
}

const states = new Map<string, CompareState>();

const MAX_SELECTED = 5;

/** The section for one deck. `onChanged` redraws the deck page after a card is added. */
export function deckCompareSection(deckId: string, onChanged: () => void): HTMLElement {
  const state =
    states.get(deckId) ??
    ({
      open: false,
      options: null,
      selected: null,
      result: null,
      added: new Set(),
      message: "",
    } as CompareState);
  states.set(deckId, state);

  const section = make("details", "deck-compare");
  section.open = state.open;
  section.appendChild(
    make("summary", "deck-compare-summary", "Compare with average decks for this commander (EDHREC)")
  );
  const body = make("div", "deck-compare-body");
  section.appendChild(body);

  const redraw = () => {
    body.replaceChildren();
    if (state.message) body.appendChild(make("p", "collection-meta", state.message));
    if (!state.options) return;
    body.appendChild(chooser());
    if (state.result) body.appendChild(results(state.result));
  };

  const loadOptions = async () => {
    state.message = "Asking EDHREC about this commander…";
    redraw();
    try {
      state.options = await bridge().deckCompareOptions(deckId);
      // The average, the budget build and the most popular theme, to start with.
      const v = state.options.variants;
      state.selected ??= new Set([v[0], v[1], v[3]].filter((x) => x !== undefined).map((x) => x.id));
      state.message = "";
    } catch (err) {
      state.message = errorText(err);
    }
    redraw();
  };

  section.addEventListener("toggle", () => {
    state.open = section.open;
    if (section.open && !state.options) void loadOptions();
  });

  function chooser(): HTMLElement {
    const box = make("div", "deck-compare-chooser");
    const options = state.options!;
    const selected = state.selected!;
    box.appendChild(
      make(
        "p",
        "collection-meta",
        `${options.commander}${options.decks ? ` — ${options.decks.toLocaleString()} decklists on EDHREC` : ""}. Choose up to ${MAX_SELECTED} average decks to put beside yours:`
      )
    );
    const list = make("div", "deck-compare-variants");
    for (const variant of options.variants) {
      const label = make("label", "deck-compare-variant");
      const check = make("input");
      check.type = "checkbox";
      check.checked = selected.has(variant.id);
      check.disabled = !check.checked && selected.size >= MAX_SELECTED;
      check.addEventListener("change", () => {
        if (check.checked) selected.add(variant.id);
        else selected.delete(variant.id);
        redraw();
      });
      label.append(
        check,
        document.createTextNode(
          ` ${variant.label}${variant.decks ? ` (${variant.decks.toLocaleString()} decks)` : ""}`
        )
      );
      list.appendChild(label);
    }
    box.appendChild(list);
    const go = button(state.result ? "Compare again" : "Compare", "btn btn-secondary", async () => {
      go.disabled = true;
      go.textContent = "Fetching the decks and their cards…";
      try {
        state.result = await bridge().deckCompare(deckId, [...selected]);
        state.added.clear();
        state.message = "";
      } catch (err) {
        state.message = errorText(err);
      }
      redraw();
    });
    go.disabled = selected.size === 0;
    box.appendChild(go);
    return box;
  }

  function results(result: ComparisonUI): HTMLElement {
    const wrap = make("div", "deck-compare-results");
    const { comparison } = result;
    const profiles = comparison.profiles;

    // Side by side.
    const table = make("table", "deck-compare-table");
    const head = make("tr");
    head.appendChild(make("th", undefined, ""));
    head.appendChild(make("th", undefined, "Guideline"));
    for (const p of profiles) head.appendChild(make("th", undefined, p.label));
    table.appendChild(head);
    const row = (label: string, values: Array<string | number>, guideline = "", statuses: string[] = []) => {
      const tr = make("tr");
      tr.appendChild(make("th", "deck-compare-row-label", label));
      tr.appendChild(make("td", "deck-compare-guideline", guideline));
      values.forEach((value, i) =>
        tr.appendChild(make("td", statuses[i] ? `deck-compare-${statuses[i]}` : undefined, String(value)))
      );
      table.appendChild(tr);
    };
    row(
      "Cards (without the commander)",
      profiles.map((p) => p.total),
      "99"
    );
    for (const g of comparison.guidelines) {
      const range = g.max === null ? `${g.min}+` : `${g.min}–${g.max}`;
      const statuses = g.values.map((v) => (v < g.min ? "low" : g.max !== null && v > g.max ? "high" : "ok"));
      row(g.label, g.values, range, statuses);
    }
    const kinds: Array<[string, string]> = [
      ["creature", "Creatures"],
      ["instant", "Instants"],
      ["sorcery", "Sorceries"],
      ["artifact", "Artifacts"],
      ["enchantment", "Enchantments"],
      ["planeswalker", "Planeswalkers"],
    ];
    for (const [kind, label] of kinds) {
      if (profiles.some((p) => p.kinds[kind]))
        row(
          label,
          profiles.map((p) => p.kinds[kind] ?? 0)
        );
    }
    row(
      "Average mana value",
      profiles.map((p) => (p.averageCost === null ? "—" : p.averageCost.toFixed(2)))
    );
    row("Plays your cards", ["—", ...comparison.overlap.map((o) => `${o}%`)]);
    const scroll = make("div", "deck-compare-scroll");
    scroll.appendChild(table);
    wrap.appendChild(scroll);
    wrap.appendChild(
      make(
        "p",
        "builder-footnote",
        `Ramp, card draw, removal and wipes are estimated from each card's rules text.${comparison.unknown ? ` ${comparison.unknown} of your cards couldn't be looked up and aren't counted.` : ""} Average decks are EDHREC's, built from the decklists players upload.`
      )
    );

    // The guidelines, explained.
    const rules = make("div", "deck-compare-rules");
    rules.appendChild(make("h6", "kicker collection-heading", "Commander deckbuilding guidelines"));
    for (const g of comparison.guidelines) {
      const item = make("div", `deck-compare-rule deck-compare-rule-${g.status}`);
      const range = g.max === null ? `${g.min} or more` : `${g.min} to ${g.max}`;
      const verdict =
        g.status === "ok"
          ? `You have ${g.values[0]} — on target.`
          : g.status === "low"
            ? `You have ${g.values[0]} — ${g.min - g.values[0]} short.`
            : `You have ${g.values[0]} — ${g.values[0] - (g.max ?? 0)} more than usual.`;
      item.append(
        make("strong", undefined, `${g.label}: ${range}. `),
        document.createTextNode(`${g.why} `),
        make("span", "deck-compare-verdict", verdict)
      );
      rules.appendChild(item);
    }
    wrap.appendChild(rules);

    // The curve, against the first average deck.
    const reference = profiles[1];
    if (reference) {
      const buckets = curveBuckets("mtg");
      wrap.appendChild(
        curveChart(
          `Your mana curve — dashed: ${reference.label}`,
          buckets.map((b, i) => ({ label: b.label, count: profiles[0].curve[i] })),
          reference.curve
        )
      );
    }

    // Cards they agree on that you don't play.
    const missingTitle =
      result.references.length > 1
        ? `In at least half of these average decks, not in yours (${comparison.missing.length})`
        : `In the ${result.references[0]?.label.toLowerCase() ?? "average deck"}, not in yours (${comparison.missing.length})`;
    wrap.appendChild(make("h6", "kicker collection-heading", missingTitle));
    const missing = make("div", "deck-compare-missing");
    for (const card of comparison.missing.slice(0, 60)) {
      const item = make("div", "deck-compare-card");
      const open = button(card.name, "btn btn-ghost deck-card-name", () => {
        if (card.info) void openCardPage("mtg", card.info.sourceId);
      });
      item.append(
        open,
        make(
          "span",
          "collection-meta",
          [
            `in ${card.inDecks} of ${result.references.length}`,
            card.info?.kind,
            card.info?.cost !== null && card.info?.cost !== undefined ? `MV ${card.info.cost}` : null,
          ]
            .filter(Boolean)
            .join(" · ")
        )
      );
      if (card.info) {
        const added = state.added.has(card.name);
        const add = button(added ? "Added" : "Add", "btn btn-ghost", async () => {
          add.disabled = true;
          try {
            await bridge().addDeckCard(deckId, card.info!.sourceId, "main");
            state.added.add(card.name);
            onChanged();
          } catch (err) {
            add.disabled = false;
            add.textContent = errorText(err);
          }
        });
        add.disabled = added;
        item.appendChild(add);
      }
      missing.appendChild(item);
    }
    if (!comparison.missing.length)
      missing.appendChild(make("p", "collection-meta", "Nothing — you play everything they agree on."));
    wrap.appendChild(missing);

    wrap.appendChild(
      make("h6", "kicker collection-heading", `Only in yours (${comparison.onlyMine.length})`)
    );
    wrap.appendChild(
      make(
        "p",
        "collection-meta deck-compare-only",
        comparison.onlyMine.length
          ? comparison.onlyMine.join(" · ")
          : "Every card you play appears in at least one of these average decks."
      )
    );
    return wrap;
  }

  redraw();
  if (state.open && !state.options) void loadOptions();
  return section;
}
