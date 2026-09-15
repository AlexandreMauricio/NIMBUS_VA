/**
 * A card's page — opened from Cards, Decks or the deck builder. The large
 * image, rules text, stats and legality from the card's database, how many
 * you own, which decks use it, the ways to add it, and cards that work well
 * with it (catalogs/synergy.ts) — each opening its own page. Everything shown comes from the
 * main process (nimbus:get-card-detail); images come from the catalogs'
 * own hosts, named in the page's Content Security Policy.
 */

import { ROLE_DESCRIPTIONS, ROLE_LABELS, cardRoles } from "../collections/decks/compare";

type Game = "mtg" | "pokemon" | "yugioh" | "lorcana" | "onepiece";

interface CardPageView {
  detail: {
    game: Game;
    sourceId: string;
    name: string;
    setName: string | null;
    setCode: string | null;
    number: string | null;
    rarity: string | null;
    largeImageUrl: string | null;
    imageUrl: string | null;
    price: { value: number; currency: "USD" | "EUR" } | null;
    typeLine: string | null;
    text: string | null;
    flavor: string | null;
    stats: Array<{ label: string; value: string }>;
    legalities: Array<{ format: string; status: string }>;
    artist: string | null;
    rules: CardRules;
  };
  owned: number;
  inDecks: Array<{ deckId: string; name: string; quantity: number }>;
  decks: Array<{ id: string; name: string }>;
}

/** The card facts the deck builder plans with (collections/types.ts CardRulesInfo). */
interface CardRules {
  copyKey: string;
  unlimitedCopies: boolean;
  zone: "main" | "extra" | "leader";
  colors: string[];
  banLimit: number | null;
  cost: number | null;
  kind: string | null;
  traits: string[];
  pips?: Record<string, number>;
  produces?: string[];
}

/** A card as the deck builder holds it — what "Add to deck plan" hands over. */
export interface PlannableCard {
  sourceId: string;
  name: string;
  imageUrl: string | null;
  setName: string | null;
  typeLine: string | null;
  text: string | null;
  rules: CardRules;
  owned: number;
}

interface SynergyView {
  source: string;
  cards: Array<PlannableCard & { reason: string }>;
}

export interface CardPageOptions {
  /** The deck builder's colours and legality, so suggestions fit the plan. */
  synergyContext?: { identity: string[]; legality: string };
  /** Offered as "Add to deck plan" on the card and on each suggestion. */
  onAdd?(card: PlannableCard): void;
  /** Whether a card is already in the plan. */
  isAdded?(sourceId: string): boolean;
}

interface CardPageBridge {
  cardSynergy(game: Game, sourceId: string, context: Record<string, unknown> | null): Promise<SynergyView>;
  getCardDetail(game: Game, sourceId: string): Promise<CardPageView>;
  addToCollection(
    game: Game,
    sourceId: string,
    options: { status: "owned" | "wishlist"; foil: boolean }
  ): Promise<unknown>;
  addDeckCard(deckId: string, sourceId: string, zone: string | null): Promise<unknown>;
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

function bridge(): CardPageBridge {
  return (window as unknown as { nimbus: CardPageBridge }).nimbus;
}

function close(): void {
  const overlay = document.getElementById("cardPage");
  if (overlay) {
    overlay.hidden = true;
    overlay.replaceChildren();
  }
}

export async function openCardPage(
  game: Game,
  sourceId: string,
  options: CardPageOptions = {}
): Promise<void> {
  const overlay = document.getElementById("cardPage") as HTMLElement;
  overlay.replaceChildren();
  overlay.hidden = false;
  const panel = make("div", "card-page");
  overlay.appendChild(panel);
  panel.appendChild(make("p", "setting-note", "Loading the card…"));

  let view: CardPageView;
  try {
    view = await bridge().getCardDetail(game, sourceId);
  } catch (err) {
    panel.replaceChildren(make("p", "form-error", String(err).replace(/^.*Error: /, "")));
    const back = make("button", "btn btn-ghost", "Close");
    back.type = "button";
    back.addEventListener("click", close);
    panel.appendChild(back);
    return;
  }

  const d = view.detail;
  panel.replaceChildren();
  const closeBtn = make("button", "btn btn-ghost card-page-close", "Close");
  closeBtn.type = "button";
  closeBtn.addEventListener("click", close);
  panel.appendChild(closeBtn);

  const layout = make("div", "card-page-layout");
  const imageCol = make("div", "card-page-image");
  const src = d.largeImageUrl ?? d.imageUrl;
  if (src) {
    const img = make("img");
    img.src = src;
    img.alt = d.name;
    img.referrerPolicy = "no-referrer";
    imageCol.appendChild(img);
  }
  layout.appendChild(imageCol);

  const body = make("div", "card-page-body");
  body.appendChild(make("h2", "card-page-name", d.name));
  if (d.typeLine) body.appendChild(make("div", "card-page-type", d.typeLine));
  const printing = [d.setName ?? d.setCode, d.number ? `#${d.number}` : null, d.rarity]
    .filter(Boolean)
    .join(" · ");
  if (printing) body.appendChild(make("div", "collection-meta", printing));

  if (d.stats.length) {
    const stats = make("div", "card-page-stats");
    for (const stat of d.stats) {
      const item = make("div", "card-page-stat");
      item.appendChild(make("span", "card-page-stat-label", stat.label));
      item.appendChild(make("span", "card-page-stat-value", stat.value));
      stats.appendChild(item);
    }
    body.appendChild(stats);
  }
  if (d.text) body.appendChild(make("div", "card-page-text", d.text));
  if (d.flavor) body.appendChild(make("div", "card-page-flavor", d.flavor));
  if (d.legalities.length) {
    const legal = make("div", "card-page-legal");
    for (const entry of d.legalities) {
      const ok = /^(legal|unlimited)$/i.test(entry.status);
      legal.appendChild(
        make("span", `tag tag-neutral${ok ? "" : " card-page-not-legal"}`, `${entry.format}: ${entry.status}`)
      );
    }
    body.appendChild(legal);
  }

  const facts = [
    d.price
      ? new Intl.NumberFormat(undefined, { style: "currency", currency: d.price.currency }).format(
          d.price.value
        )
      : null,
    d.artist ? `Art: ${d.artist}` : null,
    `You own ${view.owned}`,
    view.inDecks.length ? `In ${view.inDecks.map((x) => `${x.name} (×${x.quantity})`).join(", ")}` : null,
  ].filter(Boolean);
  body.appendChild(make("div", "collection-meta card-page-facts", facts.join(" · ")));

  const actions = make("div", "memory-actions");
  const status = make("span", "collection-meta");
  for (const [label, kind] of [
    ["Add to collection", "owned"],
    ["Wishlist", "wishlist"],
  ] as const) {
    const button = make("button", kind === "owned" ? "btn btn-secondary" : "btn btn-ghost", label);
    button.type = "button";
    button.addEventListener("click", async () => {
      try {
        await bridge().addToCollection(d.game, d.sourceId, { status: kind, foil: false });
        status.textContent = kind === "owned" ? "Added to your collection." : "Added to your wishlist.";
      } catch (err) {
        status.textContent = String(err).replace(/^.*Error: /, "");
      }
    });
    actions.appendChild(button);
  }
  if (view.decks.length) {
    const select = make("select", "select");
    for (const deck of view.decks) select.appendChild(new Option(deck.name, deck.id));
    const addToDeck = make("button", "btn btn-ghost", "Add to deck");
    addToDeck.type = "button";
    addToDeck.addEventListener("click", async () => {
      try {
        await bridge().addDeckCard(select.value, d.sourceId, null);
        status.textContent = `Added to ${select.options[select.selectedIndex].text}.`;
      } catch (err) {
        status.textContent = String(err).replace(/^.*Error: /, "");
      }
    });
    actions.append(select, addToDeck);
  }
  if (options.onAdd) {
    const onAdd = options.onAdd;
    const inPlan = options.isAdded?.(d.sourceId) ?? false;
    const plan = make("button", "btn btn-primary", inPlan ? "In the deck plan" : "Add to deck plan");
    plan.type = "button";
    plan.disabled = inPlan;
    plan.addEventListener("click", () => {
      onAdd({
        sourceId: d.sourceId,
        name: d.name,
        imageUrl: d.imageUrl,
        setName: d.setName,
        typeLine: d.typeLine,
        text: d.text,
        rules: d.rules,
        owned: view.owned,
      });
      plan.disabled = true;
      plan.textContent = "In the deck plan";
    });
    actions.prepend(plan);
  }
  actions.appendChild(status);
  body.appendChild(actions);
  layout.appendChild(body);
  panel.appendChild(layout);
  if (d.game === "mtg") panel.appendChild(roleSection(d.rules.kind, d.text));
  panel.appendChild(synergySection(d.game, d.sourceId, d.name, options));
}

/**
 * A Magic card's job in a deck — ramp, card draw, targeted removal, board
 * wipe, or several — read from its rules text the same way the Commander
 * comparison counts them (collections/decks/compare.ts).
 */
function roleSection(kind: string | null, text: string | null): HTMLElement {
  const section = make("section", "card-roles");
  section.appendChild(make("h3", "card-synergy-title", "Role in a deck"));
  const roles = cardRoles({ kind, text });
  if (roles.length) {
    const list = make("div", "card-roles-list");
    for (const role of roles) {
      const item = make("div", "card-role");
      item.append(
        make("span", "tag tag-accent", ROLE_LABELS[role]),
        make("span", "books-small", ROLE_DESCRIPTIONS[role])
      );
      list.appendChild(item);
    }
    section.appendChild(list);
  } else {
    section.appendChild(
      make(
        "p",
        "books-small",
        kind === "land"
          ? "A land — it counts towards your lands, not ramp."
          : "Not ramp, card draw, removal or a board wipe — likely a threat or a piece of the deck's own plan."
      )
    );
  }
  section.appendChild(
    make(
      "p",
      "builder-footnote",
      "Read from the card's rules text, so it's an estimate — a card can do more than its words match."
    )
  );
  return section;
}

/** "Works well with": loads after the page shows, so a slow lookup never holds the card up. */
function synergySection(game: Game, sourceId: string, name: string, options: CardPageOptions): HTMLElement {
  const section = make("section", "card-synergy");
  section.appendChild(make("h3", "card-synergy-title", `Works well with ${name}`));
  const status = make("p", "collection-meta", "Looking for cards that work with it…");
  section.appendChild(status);
  const grid = make("div", "card-synergy-grid");
  section.appendChild(grid);
  void bridge()
    .cardSynergy(game, sourceId, options.synergyContext ?? null)
    .then((result) => {
      status.textContent = result.cards.length
        ? result.source
        : "No clear synergies found for this card — it may simply be good on its own.";
      for (const card of result.cards) {
        const tile = make("div", "card-synergy-card");
        if (card.imageUrl) {
          const img = make("img", "card-synergy-image");
          img.src = card.imageUrl;
          img.alt = "";
          img.loading = "lazy";
          img.referrerPolicy = "no-referrer";
          tile.appendChild(img);
        }
        const info = make("div", "card-synergy-info");
        const open = make("button", "btn btn-ghost deck-card-name", card.name);
        open.type = "button";
        if (card.text) open.title = card.text;
        open.addEventListener("click", () => void openCardPage(game, card.sourceId, options));
        info.append(open, make("span", "card-synergy-reason", card.reason));
        if (card.owned) info.appendChild(make("span", "collection-meta", `You own ${card.owned}`));
        if (options.onAdd) {
          const onAdd = options.onAdd;
          const added = options.isAdded?.(card.sourceId) ?? false;
          const add = make("button", "btn btn-secondary", added ? "In the plan" : "Add");
          add.type = "button";
          add.disabled = added;
          add.addEventListener("click", () => {
            onAdd(card);
            add.disabled = true;
            add.textContent = "In the plan";
          });
          info.appendChild(add);
        }
        tile.appendChild(info);
        grid.appendChild(tile);
      }
    })
    .catch((err) => {
      status.textContent = String(err).replace(/^.*Error: /, "");
    });
  return section;
}

export function initCardPage(): void {
  const overlay = document.getElementById("cardPage") as HTMLElement;
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !overlay.hidden) close();
  });
}
