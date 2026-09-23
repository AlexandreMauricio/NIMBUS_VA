import { formatAmount, scaleAmount } from "../../meals/units";
import { RecipeUI, make } from "./common";

// ---------- The servings slider ----------

/**
 * How much to cook, as a slider: the recipe as written is where it starts,
 * and every ingredient line follows as it moves — rounded to amounts you'd
 * actually measure (whole pieces, sensible grams), so there's never 0.1 g
 * of meat. Says how many portions are left over for later.
 */
export function servingsSlider(
  recipe: RecipeUI,
  value: number,
  eating: () => number,
  onChange: (servings: number) => void
): { box: HTMLElement; set: (servings: number) => void } {
  const box = make("div", "meals-servings");
  const head = make("div", "meals-servings-head");
  const label = make("strong", "meals-servings-value");
  const note = make("span", "meals-line-meta");
  head.append(label, note);
  const range = document.createElement("input");
  range.type = "range";
  range.className = "meals-servings-range";
  range.min = "1";
  range.step = "1";
  const list = make("ul", "meals-servings-lines");
  box.append(head, range, list);

  let current = value;
  const draw = () => {
    range.max = String(Math.max(12, recipe.servings * 3, eating(), current));
    range.value = String(current);
    label.textContent = `Cook ${current} serving${current === 1 ? "" : "s"}`;
    const extra = current - eating();
    note.textContent = [
      current === recipe.servings ? "as the recipe is written" : `recipe makes ${recipe.servings}`,
      extra > 0
        ? `${extra} left over for later`
        : extra < 0
          ? `${-extra} short of everyone eating`
          : "just enough for everyone",
    ].join(" · ");
    note.classList.toggle("is-warn", extra < 0);
    list.replaceChildren();
    for (const line of recipe.ingredients) {
      const amount = scaleAmount({ quantity: line.quantity, unit: line.unit }, recipe.servings, current);
      const item = make("li");
      item.append(make("span", undefined, line.text), make("strong", undefined, formatAmount(amount)));
      if (line.optional) item.classList.add("is-optional");
      list.appendChild(item);
    }
  };
  range.addEventListener("input", () => {
    current = Number(range.value) || 1;
    draw();
    onChange(current);
  });
  draw();
  return {
    box,
    set: (servings: number) => {
      current = Math.max(1, Math.round(servings));
      draw();
    },
  };
}
