const markup = new WeakMap();

export function setStableMarkup(element, html) {
  // Compare source strings, not browser-normalized innerHTML (which can differ on every poll).
  if (markup.get(element) === html) return false;
  element.innerHTML = html;
  markup.set(element, html);
  return true;
}

export function renderVideoCards(container, cards) {
  const existing = new Map([...container.children].map(element => [element.dataset.videoTaskId, element]));
  cards.forEach((card, index) => {
    let element = existing.get(card.id);
    if (!element) {
      element = container.ownerDocument.createElement('article');
      element.className = 'video-result';
      element.dataset.videoTaskId = card.id;
    }
    setStableMarkup(element, card.html);
    // Insert new cards without detaching unchanged players or resetting playback/focus.
    if (container.children[index] !== element) container.insertBefore(element, container.children[index] || null);
    existing.delete(card.id);
  });
  for (const element of existing.values()) element.remove();
}
