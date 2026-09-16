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
import {
  CardRole,
  CompareGrouping,
  CompareSorting,
  ROLE_LABELS,
  costGroupKey,
  groupCompareCards,
} from "../collections/decks/compare";
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
  references: Array<VariantUI & { builtFrom: string[] | null }>;
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
      roles: CardRole[];
    }>;
    onlyMine: string[];
    yourCards: Array<{
      name: string;
      quantity: number;
      inDecks: number;
      sourceId: string | null;
      kind: string | null;
      cost: number | null;
      roles: CardRole[];
    }>;
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

type CompareListView = "mine" | "missing";

/** A row in either card list; `quantity` is null for a card you don't play. */
interface CompareRow {
  name: string;
  quantity: number | null;
  inDecks: number;
  kind: string | null;
  cost: number | null;
  roles: CardRole[];
  sourceId: string | null;
}

interface CompareState {
  open: boolean;
  /** The card lists under the comparison: which one, how grouped and sorted, and a curve column ("mv6"). */
  list: { view: CompareListView; groupBy: CompareGrouping; sortBy: CompareSorting; cost: string | null };
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
      list: { view: "mine", groupBy: "cost", sortBy: "agreement", cost: null },
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
    make(
      "summary",
      "deck-compare-summary",
      "Compare with average decks for this commander and similar ones (EDHREC)"
    )
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

  function variantList(variants: VariantUI[]): HTMLElement {
    const selected = state.selected!;
    const list = make("div", "deck-compare-variants");
    for (const variant of variants) {
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
          ` ${variant.label.replace(/^Similar: top/, "Top")}${variant.decks ? ` (${variant.decks.toLocaleString()} decks)` : ""}`
        )
      );
      list.appendChild(label);
    }
    return list;
  }

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
    // Two groups: this commander's own average decks, and similar commanders' —
    // the top ones of the same colours, overall or with one of this commander's themes.
    const own = options.variants.filter((v) => !v.id.startsWith("similar"));
    const similar = options.variants.filter((v) => v.id.startsWith("similar"));
    const groups: Array<[string, string | null, VariantUI[]]> = [
      [`${options.commander}'s decks`, null, own],
      [
        "Similar commanders",
        similar.length
          ? "Each is averaged from the most played commanders of the same colours — with a theme, only commanders' decks built for that theme."
          : null,
        similar,
      ],
    ];
    for (const [title, note, variants] of groups) {
      if (!variants.length) continue;
      box.appendChild(make("h6", "kicker deck-compare-group", title));
      if (note) box.appendChild(make("p", "builder-footnote", note));
      box.appendChild(variantList(variants));
    }
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
        `Ramp, card draw, removal and wipes are estimated from each card's rules text.${comparison.unknown ? ` ${comparison.unknown} of your cards couldn't be looked up and aren't counted.` : ""} Average decks are EDHREC's, built from the decklists players upload.${result.references
          .filter((r) => r.builtFrom)
          .map((r) => ` ${r.label.replace(/^Similar: /, "")}: ${r.builtFrom!.join(", ")}.`)
          .join("")}`
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

    // The curve, against the first average deck. A column picks the mana
    // value the lists below show, so "too many at 6+" leads to the cards.
    const buckets = curveBuckets("mtg");
    const reference = profiles[1];
    if (reference) {
      const selectedBucket = state.list.cost?.startsWith("mv") ? Number(state.list.cost.slice(2)) : null;
      wrap.appendChild(
        curveChart(
          `Your mana curve — dashed: ${reference.label}. Click a column to see those cards.`,
          buckets.map((b, i) => ({ label: b.label, count: profiles[0].curve[i] })),
          reference.curve,
          {
            selected: selectedBucket,
            onPick: (index) => {
              state.list.cost = index === null ? null : `mv${index}`;
              redraw();
            },
          }
        )
      );
    }

    wrap.appendChild(
      cardLists(
        result,
        buckets.map((b) => b.label)
      )
    );
    return wrap;
  }

  /** Your cards and the ones they agree on, filtered by a curve column, grouped and sorted as chosen. */
  function cardLists(result: ComparisonUI, bucketLabels: string[]): HTMLElement {
    const { comparison } = result;
    const references = result.references.length;
    const list = state.list;
    const box = make("div", "deck-compare-lists");

    const missingTitle =
      references > 1
        ? `In at least half of these average decks, not in yours`
        : `In the ${result.references[0]?.label.toLowerCase() ?? "average deck"}, not in yours`;
    const views: Array<[CompareListView, string, number]> = [
      ["mine", "Your cards", comparison.yourCards.length],
      ["missing", missingTitle, comparison.missing.length],
    ];

    const controls = make("div", "books-sort-row deck-compare-controls");
    const tabs = make("div", "deck-compare-views");
    tabs.setAttribute("role", "group");
    tabs.setAttribute("aria-label", "Which cards");
    for (const [view, label, count] of views) {
      const tab = button(
        `${label} (${count})`,
        `btn ${list.view === view ? "btn-secondary" : "btn-ghost"}`,
        () => {
          list.view = view;
          redraw();
        }
      );
      tab.setAttribute("aria-pressed", String(list.view === view));
      tabs.appendChild(tab);
    }
    controls.appendChild(tabs);
    const select = <T extends string>(
      label: string,
      options: Array<[T, string]>,
      value: T,
      onChange: (v: T) => void
    ) => {
      const s = make("select", "select");
      s.setAttribute("aria-label", label);
      for (const [id, text] of options) s.appendChild(new Option(`${label}: ${text}`, id));
      s.value = value;
      s.addEventListener("change", () => {
        onChange(s.value as T);
        redraw();
      });
      controls.appendChild(s);
    };
    select<CompareGrouping>(
      "Group",
      [
        ["none", "none"],
        ["cost", "mana value"],
        ["kind", "card type"],
        ["role", "role"],
        ["agreement", "average decks playing it"],
      ],
      list.groupBy,
      (v) => (list.groupBy = v)
    );
    select<CompareSorting>(
      "Sort",
      [
        ["name", "name"],
        ["cost", "mana value"],
        ["agreement", "average decks playing it"],
      ],
      list.sortBy,
      (v) => (list.sortBy = v)
    );
    box.appendChild(controls);

    if (list.cost) {
      const i = list.cost.startsWith("mv") ? Number(list.cost.slice(2)) : -1;
      const filter = make("p", "collection-meta deck-compare-filter");
      const mine = comparison.profiles[0]?.curve[i];
      const theirs = comparison.profiles[1]?.curve[i];
      filter.append(
        document.createTextNode(
          `Only mana value ${bucketLabels[i] ?? "?"}` +
            (mine !== undefined && theirs !== undefined
              ? ` — you play ${mine}, the average ${theirs}. `
              : ". ")
        ),
        button("Show all", "btn btn-ghost", () => {
          list.cost = null;
          redraw();
        })
      );
      box.appendChild(filter);
    }

    // Both lists as one row shape, so they share grouping, sorting and drawing.
    const rows: CompareRow[] =
      list.view === "mine"
        ? comparison.yourCards.map((c) => ({
            name: c.name,
            quantity: c.quantity,
            inDecks: c.inDecks,
            kind: c.kind,
            cost: c.cost,
            roles: c.roles,
            sourceId: c.sourceId,
          }))
        : comparison.missing.map((c) => ({
            name: c.name,
            quantity: null,
            inDecks: c.inDecks,
            kind: c.info?.kind ?? null,
            cost: c.info?.cost ?? null,
            roles: c.roles,
            sourceId: c.info?.sourceId ?? null,
          }));
    const shown = list.cost ? rows.filter((r) => costGroupKey(r) === list.cost) : rows;

    if (!shown.length) {
      box.appendChild(
        make(
          "p",
          "collection-meta",
          list.view === "missing"
            ? list.cost
              ? "Nothing they agree on at this mana value."
              : "Nothing — you play everything they agree on."
            : "None of your cards here."
        )
      );
      return box;
    }

    if (list.view === "mine") {
      const onlyMine = shown.filter((r) => r.inDecks === 0).length;
      box.appendChild(
        make(
          "p",
          "builder-footnote",
          onlyMine
            ? `Marked: ${onlyMine} card${onlyMine === 1 ? "" : "s"} none of these average decks play — the first to question when a column is too tall.`
            : "Every card here appears in at least one of these average decks."
        )
      );
    }

    for (const group of groupCompareCards(shown, list.groupBy, list.sortBy, references)) {
      if (group.label) {
        const copies = group.cards.reduce((sum, c) => sum + (c.quantity ?? 1), 0);
        box.appendChild(make("h6", "kicker deck-compare-group", `${group.label} (${copies})`));
      }
      const grid = make("div", "deck-compare-missing");
      for (const card of group.cards) grid.appendChild(cardRow(card, references));
      box.appendChild(grid);
    }
    return box;
  }

  function cardRow(card: CompareRow, references: number): HTMLElement {
    const mine = card.quantity !== null;
    const item = make(
      "div",
      `deck-compare-card${mine && card.inDecks === 0 ? " deck-compare-only-mine" : ""}`
    );
    const sourceId = card.sourceId;
    item.appendChild(
      button(card.name, "btn btn-ghost deck-card-name", () => {
        if (sourceId) void openCardPage("mtg", sourceId);
      })
    );
    item.appendChild(
      make(
        "span",
        "collection-meta",
        [
          mine && card.quantity! > 1 ? `×${card.quantity}` : null,
          mine && card.inDecks === 0 ? "in none" : `in ${card.inDecks} of ${references}`,
          card.kind,
          card.cost !== null ? `MV ${card.cost}` : null,
          ...card.roles.map((r) => ROLE_LABELS[r].toLowerCase()),
        ]
          .filter(Boolean)
          .join(" · ")
      )
    );
    if (!mine && sourceId) {
      const added = state.added.has(card.name);
      const add = button(added ? "Added" : "Add", "btn btn-ghost", async () => {
        add.disabled = true;
        try {
          await bridge().addDeckCard(deckId, sourceId, "main");
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
    return item;
  }

  redraw();
  if (state.open && !state.options) void loadOptions();
  return section;
}
