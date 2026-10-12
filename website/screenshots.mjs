const dialog = document.querySelector('.screenshot-dialog');

if (dialog instanceof HTMLDialogElement && typeof dialog.showModal === 'function') {
  const image = dialog.querySelector('.screenshot-expanded');
  const title = dialog.querySelector('#screenshot-title');
  const caption = dialog.querySelector('#screenshot-caption');
  let opener;

  for (const link of document.querySelectorAll('[data-screenshot]')) {
    link.setAttribute('aria-haspopup', 'dialog');
    link.addEventListener('click', (event) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
        return;
      const thumbnail = link.querySelector('img');
      if (!thumbnail || dialog.open) return;
      event.preventDefault();
      opener = link;
      image.src = link.href;
      image.alt = thumbnail.alt;
      title.textContent = `${link.dataset.screenshot} in Modatro`;
      caption.textContent = thumbnail.alt;
      document.body.classList.add('screenshot-open');
      dialog.showModal();
    });
  }

  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      dialog.close();
  });
  dialog.addEventListener('close', () => {
    document.body.classList.remove('screenshot-open');
    image.removeAttribute('src');
    opener?.focus({ preventScroll: true });
  });
}
