/**
 * The Decks tab — decks per game, checked against that game's rules, with
 * what you're missing from your collection, text import and export, and
 * a card search that adds straight into the deck. Rules and data live in
 * Core (src/collections/decks/); this only asks the preload bridge.
 */
import { openCardPage } from "./cardPage";
import { ColourLineUI, DeckStatsUI, deckShape } from "./deckCharts";
import { openDeckBuilder } from "./deckBuilder";
import { deckCompareSection } from "./deckCompare";

type Game = "mtg" | "pokemon" | "yugioh" | "lorcana" | "onepiece";
type Zone = "main" | "side" | "extra" | "leader";

interface DeckCardUI {
  sourceId: string;
  name: string;
  zone: Zone;
  quantity: number;
  setCode: string | null;
  number: string | null;
  imageUrl: string | null;
  typeLine: string | null;
}

interface DeckView {
  deck: { id: string; game: Game; name: string; format: string; notes: string | null; cards: DeckCardUI[] };
  check: {
    counts: Partial<Record<Zone, number>>;
    total: number;
    legal: boolean;
    issues: Array<{ level: string; message: string }>;
  };
  zones: Array<{ zone: Zone; label: string }>;
  collection: {
    lines: Array<{ name: string; needed: number; owned: number; missing: number }>;
    missingTotal: number;
    ownedTotal: number;
  };
  decklist: string;
  stats: DeckStatsUI;
  colours: ColourLineUI[] | null;
  staleCards: number;
}

interface DecksBridge {
  getDecks(): Promise<{
    decks: Array<{ id: string; name: string; game: Game; format: string; total: number; legal: boolean }>;
    formats: Record<Game, Array<{ id: string; label: string }>>;
    games: Array<{ id: Game; name: string }>;
  }>;
  getDeck(id: string): Promise<DeckView>;
  createDeck(input: Record<string, unknown>): Promise<{ id: string }>;
  updateDeck(id: string, changes: Record<string, unknown>): Promise<unknown>;
  removeDeck(id: string): Promise<boolean>;
  addDeckCard(id: string, sourceId: string, zone: Zone | null): Promise<unknown>;
  setDeckCardQuantity(id: string, sourceId: string, zone: Zone, quantity: number): Promise<unknown>;
  moveDeckCard(id: string, sourceId: string, from: Zone, to: Zone): Promise<unknown>;
  refreshDeckCards(id: string): Promise<{ updated: number; failed: number }>;
  importDecklist(
    id: string,
    text: string
  ): Promise<{ added: number; notFound: string[]; failed: string[]; retry: string; unread: string[] }>;
  searchCardCatalog(
    game: Game,
    query: string
  ): Promise<
    Array<{
      sourceId: string;
      name: string;
      setName: string | null;
      setCode: string | null;
      number: string | null;
      imageUrl: string | null;
    }>
  >;
  onDecksChanged(callback: () => void): () => void;
  onCollectionChanged(callback: () => void): () => void;
}

function bridge(): DecksBridge {
  return (window as unknown as { nimbus: DecksBridge }).nimbus;
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

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const errorText = (err: unknown): string => String(err).replace(/^.*Error: /, "");

export function initDecksTab(): void {
  const list = byId<HTMLElement>("deckList");
  const newName = byId<HTMLInputElement>("deckNewName");
  const newGame = byId<HTMLSelectElement>("deckNewGame");
  const newFormat = byId<HTMLSelectElement>("deckNewFormat");
  const createBtn = byId<HTMLButtonElement>("deckCreateBtn");
  const editor = byId<HTMLElement>("deckEditor");
  const empty = byId<HTMLElement>("deckEditorEmpty");
  const errorEl = byId<HTMLElement>("deckError");
  const builderBtn = byId<HTMLButtonElement>("deckBuilderBtn");

  let formats: Record<Game, Array<{ id: string; label: string }>> | null = null;
  let selectedId: string | null = null;
  let gamesFilled = false;
  let renderCount = 0;
  // While the builder is open it owns the editor area; refreshes leave it alone.
  let building = false;
  let games: Array<{ id: Game; name: string }> = [];
  // The last import's result, kept across redraws (each added card redraws the deck).
  let importMessage = "";
  // What's in the import box, kept across redraws — after an import, the lines to try again.
  let importDraft = "";

  const showError = (message: string | null): void => {
    errorEl.textContent = message ?? "";
    errorEl.hidden = !message;
  };

  const fillFormats = (select: HTMLSelectElement, game: Game, value?: string): void => {
    select.replaceChildren();
    for (const format of formats?.[game] ?? []) select.appendChild(new Option(format.label, format.id));
    if (value) select.value = value;
  };

  async function loadList(): Promise<void> {
    const view = await bridge().getDecks();
    formats = view.formats;
    games = view.games;
    if (!gamesFilled) {
      gamesFilled = true;
      for (const game of view.games) newGame.appendChild(new Option(game.name, game.id));
      fillFormats(newFormat, newGame.value as Game);
    }
    list.replaceChildren();
    for (const deck of view.decks) {
      const item = make(
        "button",
        `btn btn-ghost deck-list-item${deck.id === selectedId ? " deck-list-active" : ""}`
      );
      item.type = "button";
      item.appendChild(make("span", "collection-name", deck.name));
      item.appendChild(
        make(
          "span",
          "collection-meta",
          `${view.games.find((g) => g.id === deck.game)?.name ?? deck.game} · ${deck.total} cards · ${deck.legal ? "legal" : "not legal yet"}`
        )
      );
      item.addEventListener("click", () => {
        building = false;
        selectedId = deck.id;
        importMessage = "";
        importDraft = "";
        void refresh();
      });
      list.appendChild(item);
    }
    if (!view.decks.length) list.appendChild(make("p", "feed-empty", "No decks yet."));
    if (selectedId && !view.decks.some((d) => d.id === selectedId)) selectedId = null;
  }

  async function loadDeck(): Promise<void> {
    const render = ++renderCount;
    if (building) return;
    empty.hidden = selectedId !== null;
    editor.hidden = selectedId === null;
    if (!selectedId) {
      editor.replaceChildren();
      return;
    }
    const id = selectedId;
    let view: DeckView;
    try {
      view = await bridge().getDeck(id);
    } catch (err) {
      showError(errorText(err));
      return;
    }
    // Refreshes overlap (an import changes the deck many times); only the newest draws.
    if (render !== renderCount) return;
    editor.replaceChildren();
    const { deck, check } = view;

    // Header: name, format, remove.
    const head = make("div", "deck-head");
    const name = make("input", "input deck-name");
    name.value = deck.name;
    name.maxLength = 100;
    name.addEventListener("change", () => void act(() => bridge().updateDeck(id, { name: name.value })));
    const format = make("select", "select");
    fillFormats(format, deck.game, deck.format);
    format.addEventListener(
      "change",
      () => void act(() => bridge().updateDeck(id, { format: format.value }))
    );
    const remove = make("button", "btn btn-ghost", "Delete deck");
    remove.type = "button";
    let armed = false;
    remove.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        remove.textContent = "Click again to delete";
        setTimeout(() => {
          armed = false;
          remove.textContent = "Delete deck";
        }, 4000);
        return;
      }
      selectedId = null;
      void act(() => bridge().removeDeck(id));
    });
    head.append(name, format, remove);
    editor.appendChild(head);

    // The check.
    const summary = make("div", `deck-check ${check.legal ? "deck-check-ok" : "deck-check-bad"}`);
    const counts = view.zones.map((z) => `${z.label}: ${check.counts[z.zone] ?? 0}`).join(" · ");
    summary.appendChild(
      make("div", "collection-name", `${check.legal ? "Legal" : "Not legal yet"} — ${counts}`)
    );
    for (const issue of check.issues) {
      summary.appendChild(
        make("div", issue.level === "error" ? "deck-issue-error" : "deck-issue-warning", issue.message)
      );
    }
    editor.appendChild(summary);

    // The deck's shape: curve, kinds, the counts this game's players check.
    editor.appendChild(
      deckShape(
        view.stats,
        (button) => {
          button.disabled = true;
          button.textContent = "Looking the cards up…";
          void act(async () => {
            const result = await bridge().refreshDeckCards(id);
            if (result.failed)
              showError(
                `Couldn't reach the card database for ${result.failed} card${result.failed === 1 ? "" : "s"} — try again in a moment.`
              );
          });
        },
        view.colours,
        view.staleCards
      )
    );

    // A Commander deck beside EDHREC's average decks for its commander.
    if (deck.game === "mtg" && deck.format === "commander") {
      editor.appendChild(deckCompareSection(id, () => void refresh()));
    }

    // Against the collection.
    const owned = make("div", "deck-owned");
    const needed = view.collection.lines.reduce((s, l) => s + l.needed, 0);
    owned.appendChild(
      make(
        "div",
        "collection-meta",
        needed
          ? view.collection.missingTotal
            ? `You own ${view.collection.ownedTotal} of ${needed} — missing ${view.collection.missingTotal}:`
            : `You own every card in this deck.`
          : "Add cards to see what you own."
      )
    );
    const missingLines = view.collection.lines.filter((l) => l.missing > 0);
    if (missingLines.length) {
      owned.appendChild(
        make("div", "deck-missing", missingLines.map((l) => `${l.missing} ${l.name}`).join(" · "))
      );
    }
    editor.appendChild(owned);

    // Add cards.
    const addRow = make("div", "collection-search");
    const query = make("input", "input");
    query.type = "search";
    query.placeholder = "Find a card to add";
    query.maxLength = 100;
    const searchBtn = make("button", "btn btn-secondary", "Search");
    searchBtn.type = "button";
    addRow.append(query, searchBtn);
    const results = make("div", "deck-results");
    const search = async (): Promise<void> => {
      results.replaceChildren(make("p", "collection-meta", "Searching…"));
      try {
        const found = await bridge().searchCardCatalog(deck.game, query.value);
        results.replaceChildren();
        if (!found.length) results.appendChild(make("p", "collection-meta", "No cards matched."));
        for (const card of found.slice(0, 30)) {
          const row = make("div", "deck-result");
          const label = make("button", "btn btn-ghost deck-card-name", card.name);
          label.type = "button";
          label.addEventListener("click", () => void openCardPage(deck.game, card.sourceId));
          row.appendChild(label);
          row.appendChild(
            make(
              "span",
              "collection-meta",
              [card.setName ?? card.setCode, card.number ? `#${card.number}` : null]
                .filter(Boolean)
                .join(" · ")
            )
          );
          for (const z of view.zones) {
            const add = make("button", "btn btn-ghost", `+ ${z.label}`);
            add.type = "button";
            add.addEventListener(
              "click",
              () => void act(() => bridge().addDeckCard(id, card.sourceId, z.zone))
            );
            row.appendChild(add);
          }
          results.appendChild(row);
        }
      } catch (err) {
        results.replaceChildren(make("p", "form-error", errorText(err)));
      }
    };
    searchBtn.addEventListener("click", () => void search());
    query.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void search();
    });
    editor.append(addRow, results);

    // The cards, by zone.
    for (const z of view.zones) {
      const cards = deck.cards.filter((c) => c.zone === z.zone).sort((a, b) => a.name.localeCompare(b.name));
      editor.appendChild(
        make("h6", "kicker collection-heading", `${z.label} (${check.counts[z.zone] ?? 0})`)
      );
      if (!cards.length) {
        editor.appendChild(make("p", "collection-meta", "Empty."));
        continue;
      }
      for (const card of cards) {
        const row = make("div", "deck-card");
        const minus = make("button", "btn btn-ghost", "−");
        minus.type = "button";
        minus.addEventListener(
          "click",
          () => void act(() => bridge().setDeckCardQuantity(id, card.sourceId, z.zone, card.quantity - 1))
        );
        const plus = make("button", "btn btn-ghost", "+");
        plus.type = "button";
        plus.addEventListener(
          "click",
          () => void act(() => bridge().setDeckCardQuantity(id, card.sourceId, z.zone, card.quantity + 1))
        );
        const nameBtn = make("button", "btn btn-ghost deck-card-name", card.name);
        nameBtn.type = "button";
        nameBtn.addEventListener("click", () => void openCardPage(deck.game, card.sourceId));
        row.append(minus, make("span", "collection-quantity", `${card.quantity}`), plus, nameBtn);
        row.appendChild(make("span", "collection-meta", card.typeLine ?? ""));
        const others = view.zones.filter((other) => other.zone !== z.zone);
        if (others.length) {
          const move = make("select", "select deck-move");
          move.appendChild(new Option("Move to…", ""));
          for (const other of others) move.appendChild(new Option(other.label, other.zone));
          move.addEventListener("change", () => {
            if (move.value)
              void act(() => bridge().moveDeckCard(id, card.sourceId, z.zone, move.value as Zone));
          });
          row.appendChild(move);
        }
        editor.appendChild(row);
      }
    }

    // Import and export.
    editor.appendChild(make("h6", "kicker collection-heading", "Decklist"));
    const io = make("div", "deck-io");
    const exportBox = make("textarea", "input deck-text");
    exportBox.readOnly = true;
    exportBox.value = view.decklist;
    const copy = make("button", "btn btn-ghost", "Copy");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(exportBox.value);
      copy.textContent = "Copied";
    });
    const importBox = make("textarea", "input deck-text");
    importBox.value = importDraft;
    importBox.addEventListener("input", () => (importDraft = importBox.value));
    importBox.placeholder =
      "Paste a decklist — e.g.\n4 Lightning Bolt\n20 Mountain\n\nSideboard\n2 Pyroblast";
    const importBtn = make("button", "btn btn-secondary", "Import into this deck");
    importBtn.type = "button";
    const importStatus = make("p", "collection-meta", importMessage);
    importBtn.addEventListener("click", async () => {
      importBtn.disabled = true;
      importMessage = "Looking the cards up…";
      importStatus.textContent = importMessage;
      try {
        const result = await bridge().importDecklist(id, importBox.value);
        importMessage =
          `Added ${result.added} card${result.added === 1 ? "" : "s"}.` +
          (result.notFound.length ? ` Not found: ${result.notFound.join(", ")}.` : "") +
          (result.unread.length ? ` Couldn't read: ${result.unread.join(", ")}.` : "") +
          (result.failed.length
            ? ` Couldn't reach the card database for ${result.failed.length} — they're left in the box; import again in a moment.`
            : "");
        importDraft = result.retry;
        importBox.value = importDraft;
        await refresh(false);
      } catch (err) {
        importMessage = errorText(err);
        importStatus.textContent = importMessage;
      } finally {
        importBtn.disabled = false;
      }
    });
    const exportCol = make("div");
    exportCol.append(make("div", "collection-meta", "This deck as text"), exportBox, copy);
    const importCol = make("div");
    importCol.append(make("div", "collection-meta", "Add from text"), importBox, importBtn, importStatus);
    io.append(exportCol, importCol);
    editor.appendChild(io);
  }

  async function refresh(showErrors = true): Promise<void> {
    try {
      await loadList();
      await loadDeck();
      if (showErrors) showError(null);
    } catch (err) {
      showError(errorText(err));
    }
  }

  async function act(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
      await refresh();
    } catch (err) {
      showError(errorText(err));
    }
  }

  builderBtn.addEventListener("click", async () => {
    if (!games.length) await refresh();
    building = true;
    selectedId = null;
    showError(null);
    empty.hidden = true;
    editor.hidden = false;
    await loadList();
    openDeckBuilder(editor, {
      games,
      onCreated: (deckId, failed) => {
        building = false;
        selectedId = deckId;
        void refresh().then(() => {
          if (failed.length) {
            showError(
              `The deck was created, but these couldn't be added: ${failed.join(", ")}. Add them from the search below.`
            );
          }
        });
      },
      onCancel: () => {
        building = false;
        void refresh();
      },
    });
  });

  newGame.addEventListener("change", () => fillFormats(newFormat, newGame.value as Game));
  createBtn.addEventListener("click", async () => {
    try {
      const deck = await bridge().createDeck({
        name: newName.value,
        game: newGame.value,
        format: newFormat.value,
      });
      building = false;
      selectedId = deck.id;
      newName.value = "";
      await refresh();
    } catch (err) {
      showError(errorText(err));
    }
  });

  document.querySelector('.side-link[data-tab="decks"]')?.addEventListener("click", () => void refresh());
  bridge().onDecksChanged(() => void refresh(false));
  bridge().onCollectionChanged(() => {
    if (selectedId) void loadDeck();
  });
  void refresh();
}
