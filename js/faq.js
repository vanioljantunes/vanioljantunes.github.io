/* One answer open at a time.
 *
 * A <details> group gives disclosure and keyboard handling for free but no exclusivity,
 * and the native `name` attribute for that is still missing in Safari and older Firefox.
 * So the group is closed here on toggle, which works everywhere and leaves the markup
 * usable with scripting off: without this file every row simply opens independently.
 */

for (const group of document.querySelectorAll('[data-faq]')) {
  const items = [...group.querySelectorAll('details')];

  for (const item of items) {
    item.addEventListener('toggle', () => {
      if (!item.open) return;
      for (const other of items) {
        if (other !== item) other.open = false;
      }
    });
  }
}
