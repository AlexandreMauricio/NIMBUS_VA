/**
 * A card's page — opened from Cards or Decks. The large image, rules text,
 * stats and legality from the card's database, how many you own, which
 * decks use it, and the ways to add it. Everything shown comes from the
 * main process (nimbus:get-card-detail); images come from the catalogs'
 * own hosts, named in the page's Content Security Policy.
 */

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
  };
  owned: number;
  inDecks: Array<{ deckId: string; name: string; quantity: number }>;
  decks: Array<{ id: string; name: string }>;
}

interface CardPageBridge {
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

export async function openCardPage(game: Game, sourceId: string): Promise<void> {
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
  actions.appendChild(status);
  body.appendChild(actions);
  layout.appendChild(body);
  panel.appendChild(layout);
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
