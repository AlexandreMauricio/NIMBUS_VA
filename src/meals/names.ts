/**
 * How food names are compared — shared by the service (one ingredient per
 * food) and the recipe editor (showing which food a line will be).
 */

/** Names match loosely — case, accents and a trailing plural "s" don't make a new food. */
export function ingredientKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .replace(/s$/, "");
}

/** The known food a typed name means, by name or alias, or undefined. */
export function matchIngredient<T extends { name: string; aliases: string[] }>(
  name: string,
  ingredients: T[]
): T | undefined {
  const key = ingredientKey(name);
  if (!key) return undefined;
  return ingredients.find(
    (ingredient) =>
      ingredientKey(ingredient.name) === key ||
      ingredient.aliases.some((alias) => ingredientKey(alias) === key)
  );
}
