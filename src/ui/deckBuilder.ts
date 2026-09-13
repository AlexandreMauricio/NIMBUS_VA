/**
 * The deck builder helper, in the Decks tab: choose a game, then what the
 * deck is built around (colours, inks, a leader, energy types or an
 * archetype), then a playstyle — ranked by how well it suits that choice —
 * and build: browse cards that fit, add each at full copies, then lower the
 * less important ones (4, 3, 2, 1), watching the curve and the card mix
 * against the playstyle's targets. Creating the deck hands the plan to the
 * main process by card id only.
 *
 * The guidance itself is Core (src/collections/decks/builder.ts), run here
 * so every change redraws at once.
 */
import {
  BuilderGuide,
  PlanCard,
  Playstyle,
  builderGuide,
  planSummary,
  planZone,
  recommendPlaystyles,
} from "../collections/decks/builder";
import { curveBuckets } from "../collections/decks/stats";
import { DECK_FORMATS } from "../collections/decks/types";
import type { CardRulesInfo, TcgGame } from "../collections/types";
import { openCardPage } from "./cardPage";
import { countRow, curveChart } from "./deckCharts";

interface Candidate {
  sourceId: string;
  name: string;
  imageUrl: string | null;
  setName: string | null;
  typeLine: string | null;
  text: string | null;
  rules: CardRulesInfo;
  owned: number;
}

interface BuilderBridge {
  builderBrowse(
    game: TcgGame,
    filter: Record<string, unknown>
  ): Promise<{ cards: Candidate[]; hasMore: boolean; total: number | null }>;
  builderArchetypes(): Promise<string[]>;
  builderCreateDeck(input: Record<string, unknown>): Promise<{ id: string; failed: string[] }>;
}

export interface DeckBuilderOptions {
  games: Array<{ id: TcgGame; name: string }>;
  onCreated(deckId: string, failed: string[]): void;
  onCancel(): void;
}

type Step = "game" | "identity" | "style" | "build";

interface PlanEntry {
  card: Candidate;
  quantity: number;
  zone?: "leader";
}

function bridge(): BuilderBridge {
  return (window as unknown as { nimbus: BuilderBridge }).nimbus;
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

function button(label: string, className = "btn btn-ghost", onClick?: () => void): HTMLButtonElement {
  const b = make("button", className, label);
  b.type = "button";
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

const errorText = (err: unknown): string => String(err).replace(/^.*Error: /, "");

/** "Mana value 3", "Level 8", "Cost 2" — what a card's cost is called in its game. */
function costLabel(game: TcgGame, cost: number | null): string | null {
  if (cost === null) return null;
  const word = game === "mtg" ? "Mana value" : game === "yugioh" ? "Level" : "Cost";
  return `${word} ${cost}`;
}

/** Draws the builder into `root`; returns nothing — the builder owns `root` until it calls onCreated or onCancel. */
export function openDeckBuilder(root: HTMLElement, options: DeckBuilderOptions): void {
  let step: Step = "game";
  let game: TcgGame = options.games[0]?.id ?? "mtg";
  let format = DECK_FORMATS[game][0].id;
  let legality = "standard";
  let identity: string[] = [];
  let playstyle: string | null = null;
  let deckName = "";
  let basicsOverride: number | null = null;
  const plan = new Map<string, PlanEntry>();

  // Browsing.
  let role = "any";
  let bucket: number | null = null;
  let text = "";
  let ownedOnly = false;
  let page = 0;
  let results: Candidate[] = [];
  let hasMore = false;
  let total: number | null = null;
  let loading = false;
  let browseError = "";
  let browseRun = 0;

  const guide = (): BuilderGuide => builderGuide(game, format);
  const style = (): Playstyle => guide().playstyles.find((p) => p.id === playstyle) ?? guide().playstyles[0];

  function render(): void {
    root.replaceChildren();
    const shell = make("div", "builder");
    shell.appendChild(header());
    if (step === "game") shell.appendChild(gameStep());
    if (step === "identity") shell.appendChild(identityStep());
    if (step === "style") shell.appendChild(styleStep());
    if (step === "build") shell.appendChild(buildStep());
    root.appendChild(shell);
  }

  function header(): HTMLElement {
    const head = make("div", "builder-head");
    const steps: Array<[Step, string]> = [
      ["game", "Game"],
      ["identity", guide().identity.label],
      ["style", "Playstyle"],
      ["build", "Build"],
    ];
    const order = steps.map(([s]) => s);
    const nav = make("ol", "builder-steps");
    for (const [s, label] of steps) {
      const item = make("li", s === step ? "builder-step-current" : "");
      const reachable = order.indexOf(s) < order.indexOf(step);
      if (reachable) {
        item.appendChild(
          button(label, "btn btn-ghost builder-step-link", () => {
            step = s;
            render();
          })
        );
      } else {
        item.textContent = label;
        if (s === step) item.setAttribute("aria-current", "step");
      }
      nav.appendChild(item);
    }
    head.append(
      make("h3", "builder-title", "Deck builder"),
      nav,
      button("Build by hand instead", "btn btn-ghost", () => options.onCancel())
    );
    return head;
  }

  // ------------------------------------------------------------- 1. game

  function gameStep(): HTMLElement {
    const box = make("div", "builder-body");
    box.appendChild(make("p", "collection-meta", "Which game is this deck for?"));
    const grid = make("div", "builder-choices");
    for (const g of options.games) {
      const choice = button(
        g.name,
        `btn btn-ghost builder-choice${g.id === game ? " builder-choice-on" : ""}`,
        () => {
          if (g.id !== game) {
            game = g.id;
            format = DECK_FORMATS[game][0].id;
            identity = [];
            playstyle = null;
            plan.clear();
          }
          render();
        }
      );
      choice.setAttribute("aria-pressed", String(g.id === game));
      grid.appendChild(choice);
    }
    box.appendChild(grid);

    const row = make("div", "builder-row");
    const formatSelect = make("select", "select");
    for (const f of DECK_FORMATS[game]) formatSelect.appendChild(new Option(f.label, f.id));
    formatSelect.value = format;
    formatSelect.addEventListener("change", () => {
      format = formatSelect.value;
      legality = guide().legalities[0]?.id ?? "any";
      identity = [];
      playstyle = null;
      plan.clear();
      render();
    });
    row.appendChild(formatSelect);
    if (guide().legalities.length > 1) {
      const legal = make("select", "select");
      for (const l of guide().legalities) legal.appendChild(new Option(`Cards legal in ${l.label}`, l.id));
      if (!guide().legalities.some((l) => l.id === legality)) legality = guide().legalities[0].id;
      legal.value = legality;
      legal.addEventListener("change", () => (legality = legal.value));
      row.appendChild(legal);
    } else {
      legality = guide().legalities[0]?.id ?? "any";
    }
    box.appendChild(row);
    box.appendChild(
      button("Next", "btn btn-secondary", () => {
        step = "identity";
        render();
      })
    );
    return box;
  }

  // --------------------------------------------------------- 2. identity

  function identityStep(): HTMLElement {
    const g = guide();
    const box = make("div", "builder-body");
    const next = button("Next", "btn btn-secondary", () => {
      step = "style";
      render();
    });
    // A leader is one card, however many colours it has.
    const canGo = () =>
      g.identity.kind === "leader"
        ? [...plan.values()].some((e) => e.card.rules.zone === "leader")
        : identity.length >= g.identity.min && identity.length <= g.identity.max;

    if (g.identity.kind === "colors") {
      box.appendChild(
        make(
          "p",
          "collection-meta",
          g.identity.min === g.identity.max
            ? `Choose ${g.identity.min} ${g.identity.label.toLowerCase()}.`
            : `Choose ${g.identity.min} to ${g.identity.max} ${g.identity.label.toLowerCase()}.`
        )
      );
      const grid = make("div", "builder-choices");
      for (const choice of g.identity.choices) {
        const on = identity.includes(choice.id);
        const b = button(
          choice.label,
          `btn btn-ghost builder-choice builder-colour-${choice.id.toLowerCase()}${on ? " builder-choice-on" : ""}`,
          () => {
            if (on) identity = identity.filter((c) => c !== choice.id);
            else if (identity.length < g.identity.max) identity = [...identity, choice.id];
            else if (g.identity.max === 1) identity = [choice.id];
            render();
          }
        );
        b.setAttribute("aria-pressed", String(on));
        grid.appendChild(b);
      }
      box.appendChild(grid);
    }

    if (g.identity.kind === "leader") {
      box.appendChild(
        make(
          "p",
          "collection-meta",
          "A One Piece deck is built around its leader: its colours decide which cards can join."
        )
      );
      const leader = [...plan.values()].find((e) => e.card.rules.zone === "leader");
      if (leader)
        box.appendChild(
          make("p", "builder-picked", `Leader: ${leader.card.name} (${leader.card.rules.colors.join("/")})`)
        );
      const search = make("div", "collection-search");
      const input = make("input", "input");
      input.type = "search";
      input.placeholder = "Search leaders by name, or leave empty to list them all";
      input.maxLength = 60;
      const list = make("div", "builder-leaders");
      const find = async () => {
        list.replaceChildren(make("p", "collection-meta", "Looking…"));
        try {
          const found = await bridge().builderBrowse(game, { role: "leader", text: input.value });
          list.replaceChildren();
          if (!found.cards.length) list.appendChild(make("p", "collection-meta", "No leaders matched."));
          for (const card of found.cards) {
            list.appendChild(
              candidateTile(card, "Choose", () => {
                for (const [id, e] of plan) if (e.card.rules.zone === "leader") plan.delete(id);
                plan.set(card.sourceId, { card, quantity: 1 });
                identity = [...card.rules.colors];
                render();
              })
            );
          }
        } catch (err) {
          list.replaceChildren(make("p", "form-error", errorText(err)));
        }
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void find();
      });
      search.append(
        input,
        button("Search", "btn btn-secondary", () => void find())
      );
      box.append(search, list);
      if (!leader) void find();
    }

    if (g.identity.kind === "archetype") {
      box.appendChild(
        make(
          "p",
          "collection-meta",
          "Build around an archetype, or leave it empty to start from staples and name searches."
        )
      );
      const input = make("input", "input");
      input.placeholder = "e.g. Blue-Eyes";
      input.maxLength = 60;
      input.value = identity[0] ?? "";
      const listId = "builderArchetypeList";
      input.setAttribute("list", listId);
      const datalist = make("datalist");
      datalist.id = listId;
      void bridge()
        .builderArchetypes()
        .then((names) => {
          for (const name of names) datalist.appendChild(new Option(name));
        })
        .catch(() => undefined);
      input.addEventListener("input", () => {
        identity = input.value.trim() ? [input.value.trim()] : [];
        next.disabled = !canGo();
      });
      box.append(input, datalist);
    }

    next.disabled = !canGo();
    box.appendChild(next);
    return box;
  }

  // ------------------------------------------------------------ 3. style

  function styleStep(): HTMLElement {
    const g = guide();
    const box = make("div", "builder-body");
    const recs = recommendPlaystyles(game, format, identity);
    box.appendChild(
      make(
        "p",
        "collection-meta",
        recs[0]?.reason
          ? "Ranked by how well each style suits your choice — any of them can work."
          : "Pick the style you want to play."
      )
    );
    const list = make("div", "builder-styles");
    recs.forEach((rec, index) => {
      const p = g.playstyles.find((s) => s.id === rec.id);
      if (!p) return;
      const card = make("article", `builder-style${p.id === playstyle ? " builder-choice-on" : ""}`);
      const title = make("h4", "builder-style-name", p.name);
      if (index === 0 && rec.reason)
        title.appendChild(make("span", "tag tag-accent builder-badge", "Recommended"));
      card.appendChild(title);
      if (rec.reason) card.appendChild(make("p", "collection-meta", rec.reason));
      card.appendChild(make("p", "builder-style-summary", p.summary));
      const buckets = curveBuckets(game);
      if (p.curve.length && buckets.length) {
        card.appendChild(
          curveChart(
            "Typical curve",
            buckets.map((b, i) => ({ label: b.label, count: p.curve[i] }))
          )
        );
      }
      const targets = [
        ...p.kinds.map((k) => ({ label: k.label, count: k.count })),
        ...(p.basics && g.basicsLabel ? [{ label: g.basicsLabel, count: p.basics }] : []),
        ...p.highlights.map((h) => ({
          label: `${h.label}${h.atLeast ? " (at least)" : ""}`,
          count: h.count,
        })),
      ];
      card.appendChild(countRow(targets));
      const tips = make("ul", "builder-tips");
      for (const tip of p.tips) tips.appendChild(make("li", undefined, tip));
      card.appendChild(tips);
      card.appendChild(
        button(`Build ${p.name}`, "btn btn-secondary", () => {
          if (playstyle !== p.id) {
            playstyle = p.id;
            role = p.roles[0] ?? "any";
            bucket = null;
            basicsOverride = null;
            startBrowse();
          }
          step = "build";
          render();
        })
      );
      list.appendChild(card);
    });
    box.appendChild(list);
    return box;
  }

  // ------------------------------------------------------------ 4. build

  function planCards(): PlanCard[] {
    return [...plan.values()].map((e) => ({
      sourceId: e.card.sourceId,
      name: e.card.name,
      quantity: e.quantity,
      zone: e.zone,
      rules: e.card.rules,
    }));
  }

  function startBrowse(append = false): void {
    if (!append) {
      page = 0;
      results = [];
    }
    const run = ++browseRun;
    loading = true;
    browseError = "";
    const buckets = curveBuckets(game);
    const b = bucket !== null ? buckets[bucket] : null;
    void bridge()
      .builderBrowse(game, {
        identity,
        role,
        text,
        legality,
        page,
        costMin: b ? b.min : null,
        costMax: b ? b.max : null,
      })
      .then((found) => {
        if (run !== browseRun) return;
        results = append ? [...results, ...found.cards] : found.cards;
        hasMore = found.hasMore;
        total = found.total;
      })
      .catch((err) => {
        if (run === browseRun) browseError = errorText(err);
      })
      .finally(() => {
        if (run !== browseRun) return;
        loading = false;
        if (step === "build") render();
      });
  }

  function addToPlan(card: Candidate): void {
    const g = guide();
    plan.set(card.sourceId, { card, quantity: card.rules.zone === "leader" ? 1 : g.maxCopies });
    render();
  }

  function candidateTile(
    card: Candidate,
    action: string,
    onAction: () => void,
    disabled = false
  ): HTMLElement {
    const tile = make("div", "builder-card");
    if (card.imageUrl) {
      const img = make("img", "builder-card-image");
      img.src = card.imageUrl;
      img.alt = "";
      img.loading = "lazy";
      tile.appendChild(img);
    }
    const body = make("div", "builder-card-body");
    const name = button(
      card.name,
      "btn btn-ghost deck-card-name",
      () => void openCardPage(game, card.sourceId)
    );
    if (card.text) name.title = card.text;
    body.appendChild(name);
    const facts = [
      costLabel(game, card.rules.cost),
      card.typeLine,
      card.owned ? `You own ${card.owned}` : null,
    ].filter(Boolean);
    body.appendChild(make("span", "collection-meta", facts.join(" · ")));
    const act = button(action, "btn btn-secondary", onAction);
    act.disabled = disabled;
    body.appendChild(act);
    tile.appendChild(body);
    return tile;
  }

  function buildStep(): HTMLElement {
    const g = guide();
    const p = style();
    const layout = make("div", "builder-build");

    // Left: find cards.
    const browse = make("section", "builder-browse");
    browse.appendChild(make("h4", "builder-section-title", "Find cards"));
    const roles = make("div", "builder-chips");
    const orderedRoles = [
      ...p.roles.map((id) => g.roles.find((r) => r.id === id)).filter((r): r is NonNullable<typeof r> => !!r),
      ...g.roles.filter((r) => !p.roles.includes(r.id)),
    ];
    if (game === "mtg" && format === "commander" && !orderedRoles.some((r) => r.id === "commander")) {
      orderedRoles.unshift({ id: "commander", label: "Commanders" });
    }
    for (const r of orderedRoles) {
      const chip = button(
        r.label,
        `btn btn-ghost builder-chip${r.id === role ? " builder-choice-on" : ""}`,
        () => {
          role = r.id;
          startBrowse();
          render();
        }
      );
      chip.setAttribute("aria-pressed", String(r.id === role));
      roles.appendChild(chip);
    }
    browse.appendChild(roles);

    const buckets = curveBuckets(game);
    if (buckets.length) {
      const costs = make("div", "builder-chips");
      costs.appendChild(make("span", "collection-meta", "Cost"));
      const costChip = (label: string, value: number | null) => {
        const chip = button(
          label,
          `btn btn-ghost builder-chip${bucket === value ? " builder-choice-on" : ""}`,
          () => {
            bucket = value;
            startBrowse();
            render();
          }
        );
        chip.setAttribute("aria-pressed", String(bucket === value));
        costs.appendChild(chip);
      };
      costChip("Any", null);
      buckets.forEach((b, i) => costChip(b.label.replace(/ \(.*\)$/, ""), i));
      browse.appendChild(costs);
    }

    const search = make("div", "collection-search");
    const input = make("input", "input");
    input.type = "search";
    input.placeholder = game === "yugioh" && !identity.length ? "Search by name" : "Filter by name";
    input.maxLength = 60;
    input.value = text;
    const go = () => {
      text = input.value.trim();
      startBrowse();
      render();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go();
    });
    const owned = make("label", "builder-owned");
    const ownedBox = make("input");
    ownedBox.type = "checkbox";
    ownedBox.checked = ownedOnly;
    ownedBox.addEventListener("change", () => {
      ownedOnly = ownedBox.checked;
      render();
    });
    owned.append(ownedBox, document.createTextNode(" Only cards I own"));
    search.append(input, button("Search", "btn btn-secondary", go), owned);
    browse.appendChild(search);

    const shown = results.filter((c) => !ownedOnly || c.owned > 0);
    if (browseError) browse.appendChild(make("p", "form-error", browseError));
    else if (total !== null && !loading)
      browse.appendChild(
        make(
          "p",
          "collection-meta",
          `${total} card${total === 1 ? "" : "s"} match${game === "mtg" ? ", most played first" : ""}.`
        )
      );
    const grid = make("div", "builder-results");
    for (const card of shown) {
      const inPlan = plan.has(card.sourceId);
      grid.appendChild(candidateTile(card, inPlan ? "In the deck" : "Add", () => addToPlan(card), inPlan));
    }
    browse.appendChild(grid);
    if (loading) browse.appendChild(make("p", "collection-meta", "Looking the cards up…"));
    else if (!shown.length && !browseError)
      browse.appendChild(make("p", "collection-meta", "No cards here — try another filter."));
    if (hasMore && !loading) {
      browse.appendChild(
        button("Show more", "btn btn-ghost", () => {
          page++;
          startBrowse(true);
          render();
        })
      );
    }

    // Right: the plan.
    layout.append(browse, planPanel());
    return layout;
  }

  function planPanel(): HTMLElement {
    const g = guide();
    const p = style();
    const summary = planSummary(game, format, p.id, identity, planCards(), basicsOverride);
    const panel = make("section", "builder-plan");
    panel.appendChild(make("h4", "builder-section-title", `Your deck — ${p.name}`));

    const name = make("input", "input");
    name.placeholder = "Deck name";
    name.maxLength = 100;
    name.value = deckName;
    name.addEventListener("input", () => (deckName = name.value));
    panel.appendChild(name);

    const distinct = [...plan.values()].filter((e) => e.card.rules.zone !== "leader").length;
    panel.appendChild(
      make(
        "p",
        "collection-meta",
        g.tiers.length
          ? `${distinct} different card${distinct === 1 ? "" : "s"} — about ${summary.suggestedPicks} suits this style. Each is added at ${g.maxCopies}; lower the ones that matter less.`
          : `${distinct} different card${distinct === 1 ? "" : "s"} — one copy each; about ${summary.suggestedPicks} before lands.`
      )
    );

    const totalLine = make(
      "div",
      `builder-total${summary.total === summary.deckSize ? " builder-total-ok" : ""}`
    );
    totalLine.append(
      make("strong", undefined, `${summary.total}`),
      document.createTextNode(` / ${summary.deckSize} cards`)
    );
    panel.appendChild(totalLine);

    if (summary.stats.curveTitle && summary.curveTargets.length) {
      panel.appendChild(
        curveChart(
          `${summary.stats.curveTitle}${summary.stats.averageCost !== null ? ` — average ${summary.stats.averageCost}` : ""}`,
          summary.stats.curve,
          summary.curveTargets
        )
      );
    }
    const kindTargets = new Map(summary.kinds.map((k) => [k.label, k.target]));
    const kindBars = [
      ...summary.kinds.map((k) => ({ label: k.label, count: k.count })),
      ...summary.stats.kinds.filter((k) => !kindTargets.has(k.label)),
    ];
    if (kindBars.length) panel.appendChild(countRow(kindBars, kindTargets));
    if (summary.highlights.length) {
      panel.appendChild(
        countRow(
          summary.highlights.map((h) => ({ label: h.label, count: h.count })),
          new Map(summary.highlights.map((h) => [h.label, h.target]))
        )
      );
    }

    if (summary.advice.length) {
      const advice = make("ul", "builder-advice");
      for (const line of summary.advice) advice.appendChild(make("li", undefined, line));
      panel.appendChild(advice);
    }

    // The cards, cheapest first, each with its importance.
    const list = make("div", "builder-plan-list");
    const entries = [...plan.values()].sort(
      (a, b) =>
        Number(b.card.rules.zone === "leader") - Number(a.card.rules.zone === "leader") ||
        (a.card.rules.cost ?? 99) - (b.card.rules.cost ?? 99) ||
        a.card.name.localeCompare(b.card.name)
    );
    for (const entry of entries) {
      const row = make("div", "builder-plan-row");
      const isLeader = entry.card.rules.zone === "leader" || entry.zone === "leader";
      if (isLeader || !g.tiers.length) {
        row.appendChild(make("span", "collection-quantity", String(entry.quantity)));
      } else {
        const tier = make("select", "select builder-tier");
        for (const t of g.tiers) tier.appendChild(new Option(`${t.copies} — ${t.label}`, String(t.copies)));
        tier.value = String(entry.quantity);
        tier.setAttribute("aria-label", `Copies of ${entry.card.name}`);
        tier.addEventListener("change", () => {
          entry.quantity = Number(tier.value);
          render();
        });
        row.appendChild(tier);
      }
      const label = make("span", "builder-plan-name", entry.card.name);
      const meta = [
        isLeader ? (game === "mtg" ? "Commander" : "Leader") : null,
        costLabel(game, entry.card.rules.cost)?.toLowerCase() ?? null,
        entry.card.rules.kind,
        planZone({ zone: entry.zone, rules: entry.card.rules }) === "extra" ? "extra deck" : null,
      ].filter(Boolean);
      row.append(label, make("span", "collection-meta", meta.join(" · ")));
      if (game === "mtg" && format === "commander" && entry.card.rules.kind === "creature") {
        row.appendChild(
          button(entry.zone === "leader" ? "Commander ✓" : "Make commander", "btn btn-ghost", () => {
            const was = entry.zone === "leader";
            for (const e of plan.values()) delete e.zone;
            if (!was) {
              entry.zone = "leader";
              identity = identity.length ? identity : [...entry.card.rules.colors];
            }
            render();
          })
        );
      }
      row.appendChild(
        button("Remove", "btn btn-ghost", () => {
          plan.delete(entry.card.sourceId);
          render();
        })
      );
      list.appendChild(row);
    }
    if (!entries.length) list.appendChild(make("p", "collection-meta", "Add cards from the left."));
    panel.appendChild(list);

    if (g.basicsLabel) {
      const basicsRow = make("div", "builder-basics");
      const count = Object.values(summary.basics).reduce((a, b) => a + b, 0);
      const inputBasics = make("input", "input builder-basics-count");
      inputBasics.type = "number";
      inputBasics.min = "0";
      inputBasics.max = "60";
      inputBasics.value = String(count);
      inputBasics.setAttribute("aria-label", g.basicsLabel);
      inputBasics.addEventListener("change", () => {
        const n = Number(inputBasics.value);
        basicsOverride = Number.isInteger(n) && n >= 0 && n <= 60 ? n : null;
        render();
      });
      basicsRow.append(
        make("span", "setting-title", g.basicsLabel),
        inputBasics,
        make(
          "span",
          "collection-meta",
          Object.entries(summary.basics)
            .map(([n, q]) => `${q} ${n}`)
            .join(", ") || "none"
        )
      );
      if (basicsOverride !== null) {
        basicsRow.appendChild(
          button("Use the suggestion", "btn btn-ghost", () => {
            basicsOverride = null;
            render();
          })
        );
      }
      panel.appendChild(basicsRow);
    }

    const create = button("Create deck", "btn btn-primary", async () => {
      const cards = planCards();
      if (!cards.length) return;
      create.disabled = true;
      create.textContent = "Creating…";
      try {
        const result = await bridge().builderCreateDeck({
          name: deckName.trim() || `${p.name} (${identity.join("/") || "new"})`,
          game,
          format,
          cards: cards.map((c) => ({
            sourceId: c.sourceId,
            name: c.name,
            quantity: c.quantity,
            zone: c.zone ?? null,
          })),
          basics: summary.basics,
        });
        options.onCreated(result.id, result.failed);
      } catch (err) {
        create.disabled = false;
        create.textContent = "Create deck";
        panel.appendChild(make("p", "form-error", errorText(err)));
      }
    });
    create.disabled = plan.size === 0;
    panel.appendChild(create);
    return panel;
  }

  render();
}
