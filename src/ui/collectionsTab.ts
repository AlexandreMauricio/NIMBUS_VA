/**
 * The Collections tab — search a card game's database, add what you own
 * or want, and keep counts. Storage and the lookups live in Core
 * (src/collections/); this only asks the preload bridge. Every image
 * shown here comes from a catalog's own image host, which the page's
 * Content Security Policy lists by name.
 */

type TcgGameId = "mtg" | "pokemon" | "yugioh" | "lorcana" | "onepiece";

interface CardPriceUI {
  value: number;
  currency: "USD" | "EUR";
}

interface CatalogCardUI {
  game: TcgGameId;
  sourceId: string;
  name: string;
  setCode: string | null;
  setName: string | null;
  number: string | null;
  rarity: string | null;
  imageUrl: string | null;
  price: CardPriceUI | null;
}

interface CollectionCardUI extends CatalogCardUI {
  id: string;
  status: "owned" | "wishlist";
  quantity: number;
  foil: boolean;
  notes: string | null;
}

interface CollectionView {
  games: Array<{ id: TcgGameId; name: string; source: string; available: boolean }>;
  cards: CollectionCardUI[];
  stats: {
    ownedCopies: number;
    ownedEntries: number;
    wishlistEntries: number;
  };
}

interface CollectionsBridge {
  getCollection(filter: Record<string, unknown>): Promise<CollectionView>;
  searchCardCatalog(game: TcgGameId, query: string): Promise<CatalogCardUI[]>;
  addToCollection(
    game: TcgGameId,
    sourceId: string,
    options: { status: "owned" | "wishlist"; foil: boolean }
  ): Promise<CollectionCardUI>;
  updateCollectionCard(id: string, changes: Record<string, unknown>): Promise<CollectionCardUI | null>;
  removeCollectionCard(id: string): Promise<boolean>;
  onCollectionChanged(callback: () => void): () => void;
}

function bridge(): CollectionsBridge {
  return (window as unknown as { nimbus: CollectionsBridge }).nimbus;
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

function formatPrice(price: CardPriceUI | null): string | null {
  if (!price) return null;
  return new Intl.NumberFormat(undefined, { style: "currency", currency: price.currency }).format(
    price.value
  );
}

function describePrinting(card: CatalogCardUI): string {
  const where = [card.setName ?? card.setCode, card.number ? `#${card.number}` : null].filter(Boolean);
  return [where.join(" · "), card.rarity].filter(Boolean).join(" — ");
}

/** A card image, or a quiet placeholder with the card's initial when there is none or it fails. */
function cardImage(card: CatalogCardUI, className: string): HTMLElement {
  const holder = make("div", className);
  const placeholder = (): void => {
    holder.replaceChildren(make("span", "collection-image-placeholder", card.name.charAt(0)));
  };
  if (!card.imageUrl) {
    placeholder();
    return holder;
  }
  const img = make("img");
  img.src = card.imageUrl;
  img.alt = card.name;
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  img.addEventListener("error", placeholder, { once: true });
  holder.appendChild(img);
  return holder;
}

export function initCollectionsTab(): void {
  const summary = document.getElementById("collectionSummary") as HTMLElement;
  const gameSelect = document.getElementById("collectionSearchGame") as HTMLSelectElement;
  const queryInput = document.getElementById("collectionSearchQuery") as HTMLInputElement;
  const searchBtn = document.getElementById("collectionSearchBtn") as HTMLButtonElement;
  const foilInput = document.getElementById("collectionAddFoil") as HTMLInputElement;
  const searchStatus = document.getElementById("collectionSearchStatus") as HTMLElement;
  const results = document.getElementById("collectionResults") as HTMLElement;
  const filterGame = document.getElementById("collectionFilterGame") as HTMLSelectElement;
  const filterStatus = document.getElementById("collectionFilterStatus") as HTMLSelectElement;
  const filterText = document.getElementById("collectionFilterText") as HTMLInputElement;
  const list = document.getElementById("collectionList") as HTMLElement;
  const empty = document.getElementById("collectionEmpty") as HTMLElement;
  const errorEl = document.getElementById("collectionError") as HTMLElement;

  let gameNames = new Map<TcgGameId, string>();
  let gamesFilled = false;

  function showError(message: string | null): void {
    errorEl.textContent = message ?? "";
    errorEl.hidden = !message;
  }

  function errorText(err: unknown): string {
    return String(err).replace(/^.*Error: /, "");
  }

  function fillGames(games: CollectionView["games"]): void {
    if (gamesFilled) return;
    gamesFilled = true;
    gameNames = new Map(games.map((game) => [game.id, game.name]));
    for (const game of games) {
      const searchOption = make("option", undefined, `${game.name} (${game.source})`);
      searchOption.value = game.id;
      searchOption.disabled = !game.available;
      gameSelect.appendChild(searchOption);

      const filterOption = make("option", undefined, game.name);
      filterOption.value = game.id;
      filterGame.appendChild(filterOption);
    }
  }

  async function load(): Promise<void> {
    try {
      const view = await bridge().getCollection({
        ...(filterGame.value ? { game: filterGame.value } : {}),
        ...(filterStatus.value ? { status: filterStatus.value } : {}),
        ...(filterText.value.trim() ? { text: filterText.value.trim() } : {}),
      });
      fillGames(view.games);
      const { ownedCopies, ownedEntries, wishlistEntries } = view.stats;
      summary.textContent =
        `${ownedCopies} card${ownedCopies === 1 ? "" : "s"} owned` +
        ` (${ownedEntries} different) · ${wishlistEntries} on the wishlist`;
      renderCollection(view.cards);
      showError(null);
    } catch (err) {
      showError(`Couldn't load the collection: ${errorText(err)}`);
    }
  }

  async function act(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
      await load();
    } catch (err) {
      showError(errorText(err));
    }
  }

  function renderCollection(cards: CollectionCardUI[]): void {
    list.replaceChildren();
    empty.hidden = cards.length > 0;
    for (const card of cards) {
      const row = make("div", "collection-row");
      row.appendChild(cardImage(card, "collection-thumb"));

      const body = make("div", "collection-row-body");
      const head = make("div", "collection-row-head");
      head.appendChild(make("span", "collection-name", card.name));
      head.appendChild(make("span", "tag tag-neutral", gameNames.get(card.game) ?? card.game));
      if (card.status === "wishlist") head.appendChild(make("span", "tag tag-neutral", "Wishlist"));
      if (card.foil) head.appendChild(make("span", "tag tag-neutral", "Foil"));
      body.appendChild(head);
      const detail = [describePrinting(card), formatPrice(card.price)].filter(Boolean).join(" · ");
      if (detail) body.appendChild(make("div", "collection-meta", detail));
      row.appendChild(body);

      const actions = make("div", "collection-row-actions");
      const minus = make("button", "btn btn-ghost", "−");
      minus.type = "button";
      minus.title = card.quantity === 1 ? "Remove the last copy" : "One fewer";
      minus.addEventListener(
        "click",
        () => void act(() => bridge().updateCollectionCard(card.id, { quantity: card.quantity - 1 }))
      );
      const count = make("span", "collection-quantity", `×${card.quantity}`);
      const plus = make("button", "btn btn-ghost", "+");
      plus.type = "button";
      plus.title = "One more";
      plus.addEventListener(
        "click",
        () => void act(() => bridge().updateCollectionCard(card.id, { quantity: card.quantity + 1 }))
      );

      const move = make("button", "btn btn-ghost", card.status === "wishlist" ? "Got it" : "To wishlist");
      move.type = "button";
      move.addEventListener(
        "click",
        () =>
          void act(() =>
            bridge().updateCollectionCard(card.id, {
              status: card.status === "wishlist" ? "owned" : "wishlist",
            })
          )
      );

      const remove = make("button", "btn btn-ghost", "Remove");
      remove.type = "button";
      let armed: ReturnType<typeof setTimeout> | null = null;
      remove.addEventListener("click", () => {
        if (!armed) {
          remove.textContent = "Click again to remove";
          armed = setTimeout(() => {
            armed = null;
            remove.textContent = "Remove";
          }, 4000);
          return;
        }
        clearTimeout(armed);
        armed = null;
        void act(() => bridge().removeCollectionCard(card.id));
      });

      actions.append(minus, count, plus, move, remove);
      row.appendChild(actions);
      list.appendChild(row);
    }
  }

  function renderResults(cards: CatalogCardUI[]): void {
    results.replaceChildren();
    for (const card of cards) {
      const tile = make("div", "collection-result");
      tile.appendChild(cardImage(card, "collection-result-image"));
      tile.appendChild(make("div", "collection-name", card.name));
      const detail = [describePrinting(card), formatPrice(card.price)].filter(Boolean).join(" · ");
      if (detail) tile.appendChild(make("div", "collection-meta", detail));

      const buttons = make("div", "collection-result-actions");
      for (const [label, status] of [
        ["Add", "owned"],
        ["Wishlist", "wishlist"],
      ] as const) {
        const button = make("button", status === "owned" ? "btn btn-secondary" : "btn btn-ghost", label);
        button.type = "button";
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            const added = await bridge().addToCollection(card.game, card.sourceId, {
              status,
              foil: foilInput.checked,
            });
            button.textContent = status === "owned" ? `Added ×${added.quantity}` : "Wishlisted";
            await load();
          } catch (err) {
            showError(errorText(err));
          } finally {
            button.disabled = false;
          }
        });
        buttons.appendChild(button);
      }
      tile.appendChild(buttons);
      results.appendChild(tile);
    }
  }

  async function search(): Promise<void> {
    const query = queryInput.value.trim();
    if (!gameSelect.value) return;
    searchBtn.disabled = true;
    searchStatus.hidden = false;
    searchStatus.textContent = "Searching…";
    results.replaceChildren();
    try {
      const found = await bridge().searchCardCatalog(gameSelect.value as TcgGameId, query);
      searchStatus.textContent =
        found.length === 0
          ? "No cards matched."
          : `${found.length} printing${found.length === 1 ? "" : "s"} found${found.length >= 60 ? " — narrow the search to see more" : ""}.`;
      renderResults(found);
    } catch (err) {
      searchStatus.textContent = errorText(err);
    } finally {
      searchBtn.disabled = false;
    }
  }

  searchBtn.addEventListener("click", () => void search());
  queryInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void search();
  });

  let filterTimer: ReturnType<typeof setTimeout> | null = null;
  filterText.addEventListener("input", () => {
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(() => void load(), 200);
  });
  filterGame.addEventListener("change", () => void load());
  filterStatus.addEventListener("change", () => void load());

  document.querySelector('.side-link[data-tab="cards"]')?.addEventListener("click", () => void load());
  bridge().onCollectionChanged(() => void load());
  void load();
}
