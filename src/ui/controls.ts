/**
 * Small controls built the same way wherever the main window uses them.
 */

/**
 * Wraps a checkbox in the pill switch markup the rest of the UI uses
 * (`.toggle` + `.track`). Built rather than written out at each call
 * site so a row's switch cannot drift from the ones in the forms.
 */
export function buildSwitch(input: HTMLInputElement): HTMLElement {
  const wrapper = document.createElement("span");
  wrapper.className = "toggle";
  wrapper.appendChild(input);
  const track = document.createElement("span");
  track.className = "track";
  wrapper.appendChild(track);
  return wrapper;
}
