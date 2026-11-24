/* Ползунок поверх списка задач; нативный скроллбар остаётся fallback без JS. */
(function () {
  function init() {
    const scroller = document.getElementById('taskList');
    const viewport = document.getElementById('taskViewport');
    const overlay = document.getElementById('taskScrollbar');
    const thumb = overlay?.querySelector('.task-scrollbar-thumb');
    if (!scroller || !viewport || !overlay || !thumb) return;

    const minThumbHeight = 28;
    const idleDelay = 800;
    const lineStep = 40;
    let hideTimer = 0;
    let frame = 0;
    let revealPending = false;
    let dragging = null;
    let geometry = { maxScroll: 0, travel: 0 };

    function clearHideTimer() {
      if (!hideTimer) return;
      clearTimeout(hideTimer);
      hideTimer = 0;
    }

    function show() {
      if (overlay.hidden) return;
      clearHideTimer();
      overlay.classList.add('is-visible');
    }

    function scheduleHide() {
      clearHideTimer();
      if (dragging || thumb.matches(':hover') || overlay.matches(':focus-within')) return;
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
        overlay.tabIndex = -1;
        overlay.classList.remove('is-visible', 'is-dragging');
        overlay.setAttribute('aria-valuenow', '0');
        revealPending = false;
        geometry = { maxScroll: 0, travel: 0 };
        return;
      }

      overlay.hidden = false;
      overlay.tabIndex = 0;
      const thumbHeight = Math.min(trackHeight, Math.max(minThumbHeight,
        trackHeight * viewportHeight / contentHeight));
      const travel = Math.max(0, trackHeight - thumbHeight);
      const progress = Math.min(1, Math.max(0, scroller.scrollTop / maxScroll));

      thumb.style.height = `${thumbHeight}px`;
      thumb.style.transform = `translateY(${progress * travel}px)`;
      overlay.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
      geometry = { maxScroll, travel };
      if (revealPending) {
        revealPending = false;
        show();
        scheduleHide();
      }
    }

    function requestUpdate(shouldShow = false) {
      if (shouldShow) revealPending = true;
      if (!frame) frame = requestAnimationFrame(update);
    }

    function onKeyDown(event) {
      let next = null;
      if (event.key === 'ArrowUp') next = scroller.scrollTop - lineStep;
      else if (event.key === 'ArrowDown') next = scroller.scrollTop + lineStep;
      else if (event.key === 'PageUp') next = scroller.scrollTop - scroller.clientHeight * 0.85;
      else if (event.key === 'PageDown') next = scroller.scrollTop + scroller.clientHeight * 0.85;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = geometry.maxScroll;
      if (next === null) return;
      event.preventDefault();
      scroller.scrollTop = Math.min(geometry.maxScroll, Math.max(0, next));
      requestUpdate(true);
    }

    function finishDrag(event) {
      if (!dragging || (event.pointerId !== undefined && event.pointerId !== dragging.pointerId)) return;
      if (thumb.hasPointerCapture?.(dragging.pointerId)) thumb.releasePointerCapture(dragging.pointerId);
      dragging = null;
      overlay.classList.remove('is-dragging');
      requestUpdate(true);
    }

    thumb.addEventListener('pointerdown', event => {
      if (event.button !== 0 || geometry.travel <= 0) return;
      event.preventDefault();
      dragging = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startScrollTop: scroller.scrollTop,
      };
      thumb.setPointerCapture(event.pointerId);
      overlay.classList.add('is-dragging');
      show();
    });
    thumb.addEventListener('pointermove', event => {
      if (!dragging || event.pointerId !== dragging.pointerId) return;
      const delta = event.clientY - dragging.startY;
      scroller.scrollTop = dragging.startScrollTop + delta * geometry.maxScroll / geometry.travel;
    });
    thumb.addEventListener('pointerup', finishDrag);
    thumb.addEventListener('pointercancel', finishDrag);

    scroller.addEventListener('scroll', () => requestUpdate(true), { passive: true });
    thumb.addEventListener('mouseenter', show);
    thumb.addEventListener('mouseleave', scheduleHide);
    overlay.addEventListener('focusin', show);
    overlay.addEventListener('focusout', scheduleHide);
    overlay.addEventListener('keydown', onKeyDown);
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
