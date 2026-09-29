/**
 * The Books tab's side of the comics vault — an Obsidian folder of book
 * notes, read-only (src/main/comicsVault.ts reads it; src/collections/
 * books/vault.ts parses and matches it).
 *
 * - The **Vault** pane: which folder (this PC's), what to read next in each
 *   line, the reading runway and cart candidates as the Cart Planner last
 *   wrote them, carts by month, and the vault's books NIMBUS doesn't have
 *   yet, each added with a click.
 * - A **vault panel** on a book's page: status, prices, ratings, what
 *   covers it, and "Open in Obsidian".
 * - A small **status tag** for rows.
 */
import { VAULT_STATUS_LABELS, bookFromVault, cartsByMonth, matchVault } from "../collections/books/vault";
import type { PlannerTable, VaultBook, VaultStatus } from "../collections/books/vault";
import type { Book } from "../collections/books/types";

export interface VaultSnapshotUI {
  folder: string | null;
  problem: string | null;
  books: VaultBook[];
  planner: PlannerTable[];
  plannerUpdated: string | null;
  readAt: string | null;
}

export interface VaultBridge {
  getComicsVault(): Promise<VaultSnapshotUI>;
  chooseComicsVault(): Promise<VaultSnapshotUI | null>;
  clearComicsVault(): Promise<VaultSnapshotUI>;
  openVaultNote(notePath: string): Promise<boolean>;
  onComicsVaultChanged(callback: () => void): () => void;
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const element = make("button", className, label);
  element.type = "button";
  element.addEventListener("click", onClick);
  return element;
}

const euro = (value: number | null) =>
  value === null
    ? "—"
    : `${value.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

const STATUS_TAG: Record<VaultStatus, string> = {
  owned: "tag",
  covered: "tag tag-outline",
  incoming: "tag books-vault-incoming",
  planned: "tag books-vault-planned",
  wanted: "tag tag-outline",
  oop: "tag books-vault-oop",
  unreleased: "tag tag-outline",
  parked: "tag tag-outline",
};

/** The vault's status as a tag, e.g. "Incoming". */
export function vaultTag(note: VaultBook): HTMLElement | null {
  if (!note.status) return null;
  const tag = make("span", STATUS_TAG[note.status], VAULT_STATUS_LABELS[note.status]);
  tag.title = "From your comics vault";
  return tag;
}

/** Vault note by NIMBUS book id, worked out once per render. */
export function vaultByBook(vault: VaultSnapshotUI | null, books: Book[]): Map<string, VaultBook> {
  const out = new Map<string, VaultBook>();
  if (!vault?.books.length) return out;
  const matched = matchVault(vault.books, books);
  for (const note of vault.books) {
    const id = matched.get(note.path);
    if (id) out.set(id, note);
  }
  return out;
}

/** "Open in Obsidian" for a note. */
function openButton(bridge: VaultBridge, note: VaultBook, label = "Open in Obsidian"): HTMLButtonElement {
  return button(label, "btn btn-ghost", () => void bridge.openVaultNote(note.path));
}

/** The vault's side of one book, for its page. */
export function vaultPanel(note: VaultBook, bridge: VaultBridge): HTMLElement {
  const box = make("section", "books-vault-panel");
  const head = make("div", "books-vault-head");
  head.append(make("h6", "kicker", "From your vault"));
  const tag = vaultTag(note);
  if (tag) head.appendChild(tag);
  if (note.read) head.appendChild(make("span", "tag", "Read"));
  if (note.nextRead) head.appendChild(make("span", "tag books-vault-planned", "Next to read"));
  head.appendChild(openButton(bridge, note));
  box.appendChild(head);
  const facts = make("dl", "books-vault-facts");
  const fact = (label: string, value: string | null | undefined) => {
    if (!value) return;
    facts.append(make("dt", undefined, label), make("dd", undefined, value));
  };
  fact("Collects", note.issues);
  fact("Creators", [note.writers, note.artists].filter(Boolean).join(" · ") || null);
  fact("Years", note.years);
  fact("Era", note.era);
  fact("Release", note.releaseDate);
  fact("Paid", note.pricePaid === null ? null : euro(note.pricePaid));
  fact(
    "Seen at",
    note.priceSeen === null ? null : `${euro(note.priceSeen)}${note.store ? ` · ${note.store}` : ""}`
  );
  if (note.pricePaid !== null && note.store) fact("Store", note.store);
  fact("Price note", note.priceNote);
  fact("Cart", note.cart ? `${note.cart}${note.budget ? ` · ${note.budget}` : ""}` : null);
  fact(
    "Urgency",
    note.urgency ? `${note.urgency}${note.urgencyReason ? ` — ${note.urgencyReason}` : ""}` : null
  );
  fact("My rating", note.myRating);
  fact(
    "Ranking",
    [note.storyRating, note.tier ? `tier ${note.tier}` : null, note.ratingReason]
      .filter(Boolean)
      .join(" · ") || null
  );
  fact("Highlights", note.highlight);
  fact(
    "Goodreads",
    note.goodreads
      ? `${note.goodreads.rating.toFixed(2)}${note.goodreads.votes !== null ? ` from ${note.goodreads.votes} ratings` : ""}`
      : null
  );
  fact("Covered by", note.coveredBy.join(", ") || null);
  fact("Covers", note.covers.join(", ") || null);
  fact(
    "Purpose",
    note.purpose
      ? `${note.purpose}${note.missingBefore ? ` · ${note.missingBefore} missing before it` : ""}`
      : null
  );
  box.appendChild(facts);
  if (!note.verified)
    box.appendChild(make("p", "books-small", "Not verified in the vault yet — the details may be off."));
  return box;
}

/** A Cart Planner table, drawn as a plain table. */
function plannerTable(table: PlannerTable): HTMLElement {
  const wrap = make("div", "books-vault-table-wrap");
  const element = make("table", "table books-vault-table");
  const head = make("tr");
  for (const column of table.columns) head.appendChild(make("th", undefined, column));
  element.appendChild(make("thead")).appendChild(head);
  const body = make("tbody");
  for (const row of table.rows) {
    const tr = make("tr");
    for (const cell of row) tr.appendChild(make("td", undefined, cell));
    body.appendChild(tr);
  }
  element.appendChild(body);
  wrap.appendChild(element);
  return wrap;
}

/**
 * The Vault pane. `onAdd` opens NIMBUS's add form filled from a note;
 * `onOpenBook` goes to a matched book's page.
 */
export function vaultPane(
  vault: VaultSnapshotUI | null,
  books: Book[],
  bridge: VaultBridge,
  handlers: {
    onAdd: (note: VaultBook) => void;
    onOpenBook: (id: string) => void;
    onError: (message: string) => void;
    onChanged: (vault: VaultSnapshotUI) => void;
  }
): HTMLElement {
  const wrap = make("div", "books-vault");

  // Where the vault is — this PC's own choice.
  const where = make("div", "books-vault-folder");
  where.appendChild(make("h6", "kicker", "Comics vault"));
  where.appendChild(
    make(
      "p",
      "books-small",
      vault?.folder
        ? `Reading ${vault.folder} — this PC's folder; another PC keeps its own. NIMBUS only reads it.`
        : "Point NIMBUS at your Obsidian comics vault (the folder with Books/ in it). The folder is remembered on this PC only, so your laptop and desktop can each use their own copy. NIMBUS only reads it."
    )
  );
  const choose = async () => {
    try {
      const next = await bridge.chooseComicsVault();
      if (next) handlers.onChanged(next);
    } catch (err) {
      handlers.onError(String(err).replace(/^.*Error: /, ""));
    }
  };
  const actions = make("div", "books-vault-actions");
  actions.appendChild(
    button(vault?.folder ? "Change folder" : "Choose folder", "btn btn-secondary", () => void choose())
  );
  if (vault?.folder)
    actions.appendChild(
      button("Disconnect", "btn btn-ghost", () => void bridge.clearComicsVault().then(handlers.onChanged))
    );
  where.appendChild(actions);
  if (vault?.problem) where.appendChild(make("p", "form-error", vault.problem));
  wrap.appendChild(where);
  if (!vault?.folder || !vault.books.length) {
    if (vault?.folder && !vault.problem)
      wrap.appendChild(make("p", "feed-empty", "No book notes with properties found under Books/."));
    return wrap;
  }

  const matched = matchVault(vault.books, books);
  const bookOf = (note: VaultBook) => {
    const id = matched.get(note.path);
    return id ? books.find((b) => b.id === id) : undefined;
  };
  const noteRow = (note: VaultBook, extra: Array<string | null>) => {
    const row = make("div", "books-vault-row");
    const name = make("div", "books-vault-name");
    name.append(
      make("strong", undefined, note.name),
      make("span", "books-small", extra.filter(Boolean).join(" · "))
    );
    row.appendChild(name);
    const tag = vaultTag(note);
    if (tag) row.appendChild(tag);
    const book = bookOf(note);
    if (book) row.appendChild(button("Open", "btn btn-ghost", () => handlers.onOpenBook(book.id)));
    row.appendChild(openButton(bridge, note, "Obsidian"));
    return row;
  };

  // Next up in each line.
  const next = vault.books
    .filter((note) => note.nextRead)
    .sort((a, b) => (a.line ?? "").localeCompare(b.line ?? ""));
  if (next.length) {
    wrap.appendChild(make("h6", "kicker books-section", "Next to read"));
    for (const note of next) wrap.appendChild(noteRow(note, [note.line, note.issues]));
  }

  // The Cart Planner, as refresh.py last wrote it.
  if (vault.planner.length) {
    wrap.appendChild(make("h6", "kicker books-section", "Cart Planner"));
    wrap.appendChild(
      make(
        "p",
        "books-small",
        `As Tools/refresh.py last wrote it${vault.plannerUpdated ? ` (${new Date(vault.plannerUpdated).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })})` : ""}. Ask Claude to run it after orders, arrivals or finished books.`
      )
    );
    for (const table of vault.planner) {
      wrap.appendChild(make("p", "books-vault-table-title", table.heading));
      wrap.appendChild(plannerTable(table));
    }
  }

  // Carts by month, worked out from the notes' `cart` property.
  const carts = cartsByMonth(vault.books);
  if (carts.length) {
    wrap.appendChild(make("h6", "kicker books-section", "Carts"));
    for (const cart of carts) {
      wrap.appendChild(
        make(
          "p",
          "books-vault-table-title",
          `${cart.month} · ${cart.books.length} book${cart.books.length === 1 ? "" : "s"} · ${euro(cart.total)}${cart.unpriced ? ` (+${cart.unpriced} without a price)` : ""}`
        )
      );
      for (const note of cart.books)
        wrap.appendChild(
          noteRow(note, [
            note.line,
            euro(note.pricePaid ?? note.priceSeen),
            note.store,
            note.budget,
            note.urgency ? `urgency ${note.urgency}` : null,
          ])
        );
    }
  }

  // In the vault, not in NIMBUS yet — added with a click. Covered Epics are
  // content you own through an omnibus, not a book to add.
  const missing = vault.books
    .filter((note) => !matched.has(note.path))
    .sort((a, b) => (a.line ?? "").localeCompare(b.line ?? "") || (a.seq ?? 9999) - (b.seq ?? 9999));
  wrap.appendChild(make("h6", "kicker books-section", `Not in NIMBUS yet (${missing.length})`));
  if (!missing.length) wrap.appendChild(make("p", "books-small", "Every book note is on your NIMBUS shelf."));
  let line: string | null | undefined;
  for (const note of missing) {
    if (note.line !== line) {
      line = note.line;
      wrap.appendChild(make("p", "books-vault-table-title", line ?? "No line"));
    }
    const row = noteRow(note, [
      note.issues,
      note.priceSeen !== null ? euro(note.priceSeen) : null,
      note.store,
    ]);
    if (note.status === "covered")
      row.appendChild(
        make("span", "books-small", note.coveredBy.length ? `in ${note.coveredBy.join(", ")}` : "covered")
      );
    else {
      const target = bookFromVault(note);
      row.appendChild(
        button(target.status === "owned" ? "Add to shelf" : "Add to wishlist", "btn btn-secondary", () =>
          handlers.onAdd(note)
        )
      );
    }
    wrap.appendChild(row);
  }
  return wrap;
}
