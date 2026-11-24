/* Ненажимаемый индикатор положения в списке; нативный скроллбар — fallback без JS. */
(function () {
  function init() {
    const scroller = document.getElementById('taskList');
    const viewport = document.getElementById('taskViewport');
    const overlay = document.getElementById('taskScrollbar');
    const thumb = overlay?.querySelector('.task-scrollbar-thumb');
    if (!scroller || !viewport || !overlay || !thumb) return;

    const minThumbHeight = 28;
    const idleDelay = 800;
    let hideTimer = 0;
    let frame = 0;
    let revealPending = false;

    function showTemporarily() {
      if (overlay.hidden) return;
      if (hideTimer) clearTimeout(hideTimer);
      overlay.classList.add('is-visible');
      hideTimer = setTimeout(() => {
        overlay.classList.remove('is-visible');
        hideTimer = 0;
      }, idleDelay);
    }

    function update() {
      frame = 0;
      const trackHeight = viewport.clientHeight;
      const viewportHeight = scroller.clientHeight;
      const contentHeight = scroller.scrollHeight;
      const maxScroll = Math.max(0, contentHeight - viewportHeight);

      if (trackHeight <= 0 || maxScroll <= 1) {
        overlay.hidden = true;
        overlay.classList.remove('is-visible');
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = 0;
        revealPending = false;
        return;
      }

      overlay.hidden = false;
      const thumbHeight = Math.min(trackHeight, Math.max(minThumbHeight,
        trackHeight * viewportHeight / contentHeight));
      const travel = Math.max(0, trackHeight - thumbHeight);
      const progress = Math.min(1, Math.max(0, scroller.scrollTop / maxScroll));
      thumb.style.height = `${thumbHeight}px`;
      thumb.style.transform = `translateY(${progress * travel}px)`;
      if (revealPending) {
        revealPending = false;
        showTemporarily();
      }
    }

    function requestUpdate(reveal = false) {
      if (reveal) revealPending = true;
      if (!frame) frame = requestAnimationFrame(update);
    }

    scroller.addEventListener('scroll', () => requestUpdate(true), { passive: true });
    window.addEventListener('resize', () => requestUpdate(), { passive: true });
    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => requestUpdate()) : null;
    resizeObserver?.observe(viewport);
    resizeObserver?.observe(scroller);
    const mutationObserver = new MutationObserver(() => requestUpdate());
    mutationObserver.observe(scroller, { childList: true, subtree: true,
      attributes: true, attributeFilter: ['open'] });

    update();
    viewport.classList.add('overlay-scrollbar-ready');
    requestUpdate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
