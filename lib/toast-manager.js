/*
  Runtime file: do not modify for normal setup.
  Configure the application via root config.js.
*/

function createToastManager({
  container,
  dedupeWindowMs = 4_000,
  autoHideMs = 3_500,
} = {}) {
  const lastToastAtByKey = new Map();

  function show(message, type = 'info') {
    if (!container || !message) return;

    const toastType = type || 'info';
    const toastKey = `${toastType}::${String(message).trim()}`;
    const now = Date.now();
    const lastShownAt = lastToastAtByKey.get(toastKey) ?? 0;

    if (now - lastShownAt < dedupeWindowMs) {
      return;
    }

    lastToastAtByKey.forEach((shownAt, key) => {
      if (now - shownAt > dedupeWindowMs * 5) {
        lastToastAtByKey.delete(key);
      }
    });
    lastToastAtByKey.set(toastKey, now);

    const toast = document.createElement('div');
    toast.className = `toast toast-${toastType}`;

    const messageEl = document.createElement('span');
    messageEl.className = 'toast-message';
    messageEl.textContent = message;
    toast.appendChild(messageEl);

    if (toastType === 'error') {
      const closeButton = document.createElement('button');
      closeButton.type = 'button';
      closeButton.className = 'toast-close';
      closeButton.textContent = 'Dismiss';
      closeButton.addEventListener('click', () => {
        toast.remove();
      });
      toast.appendChild(closeButton);
    } else {
      setTimeout(() => {
        toast.remove();
      }, autoHideMs);
    }

    container.prepend(toast);
  }

  return {
    show,
  };
}

window.createToastManager = createToastManager;
