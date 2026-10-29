for (const container of document.querySelectorAll('[data-media-grid]')) {
  const button = document.querySelector(`[data-media-toggle][aria-controls="${container.id}"]`);
  let collapsed = false;
  let frame;
  function update() {
    if (!container.getClientRects().length) return;
    const children = [...container.children];
    const rows = [];
    for (const child of children) {
      const top = child.offsetTop;
      let row = rows.find(row => Math.abs(row.top - top) < 1);
      if (!row) rows.push(row = { top, bottom: top });
      row.bottom = Math.max(row.bottom, top + child.offsetHeight);
    }
    rows.sort((a, b) => a.top - b.top);
    button.hidden = rows.length < 2;
    const limit = collapsed ? 1 : 4;
    const last = rows[limit - 1];
    const style = getComputedStyle(container);
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    // Rounded layout offsets need a pixel of slack to avoid clipping the last row.
    container.style.maxHeight = rows.length > limit ? `${Math.ceil(last.bottom - rows[0].top + padding + border) + 1}px` : '';
    for (const child of children) child.inert = collapsed && child.offsetTop > rows[0].top + 1;
  }
  function schedule() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(update);
  }
  button.addEventListener('click', () => {
    collapsed = !collapsed;
    container.toggleAttribute('data-collapsed', collapsed);
    container.scrollTop = 0;
    button.setAttribute('aria-expanded', String(!collapsed));
    button.textContent = collapsed ? '展开素材' : '折叠为单行';
    update();
  });
  const resize = new ResizeObserver(schedule);
  resize.observe(container);
  function observeCards() {
    resize.disconnect();
    resize.observe(container);
    for (const child of container.children) resize.observe(child);
    schedule();
  }
  new MutationObserver(observeCards).observe(container, { childList: true, subtree: true, characterData: true });
  observeCards();
}
