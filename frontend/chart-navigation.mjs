function priceWindow(lo, span, floor) {
  lo = Math.max(floor, lo);
  const hi = lo + span;
  return Number.isFinite(hi) && hi > lo ? {lo, hi} : null;
}

export function panPriceWindow(view, shift, floor) {
  return priceWindow(view.lo + shift, view.hi - view.lo, floor);
}

export function zoomPriceWindow(view, factor, fraction, floor, tick) {
  const span = view.hi - view.lo;
  const anchor = view.lo + span * fraction;
  const nextSpan = Math.max(tick * 2, span * factor);
  return priceWindow(anchor - nextSpan * fraction, nextSpan, floor);
}

// The surface stays mounted while its SVG changes. Pointer capture keeps a drag
// connected to that surface even when it leaves the plot or redraws the SVG.
export function bindChartNavigation(surface, {getWindow, applyWindow, floor, tick}) {
  let drag = null;
  let suppressClick = false;
  let pending = null;
  let frame = 0;
  let settleTimer;

  function settle() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (surface.isConnected && !drag?.moved && !frame) applyWindow(getWindow(), false);
    }, 160);
  }

  function queueWindow(view) {
    if (!view) return;
    pending = view;
    clearTimeout(settleTimer);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const next = pending;
      pending = null;
      if (!surface.isConnected) return;
      applyWindow(next, true);
      if (!drag?.moved) settle();
    });
  }

  function finishDrag(event) {
    if (drag?.id !== event.pointerId) return;
    const moved = drag.moved;
    drag = null;
    if (!moved) return;
    suppressClick = true;
    surface.removeAttribute('data-dragging');
    if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
    settle();
  }

  surface.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    suppressClick = false;
    if (event.pointerType === 'touch' || !event.target.matches('[data-probe-hit]')) return;
    const width = event.target.getBoundingClientRect().width;
    if (width <= 0) return;
    drag = {id: event.pointerId, x: event.clientX, width, view: pending ?? getWindow(), moved: false};
  });
  surface.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    if (!drag.moved) {
      if (Math.abs(dx) < 5) return;
      drag.moved = true;
      surface.setPointerCapture(event.pointerId);
      surface.setAttribute('data-dragging', '');
    }
    event.preventDefault();
    const shift = -dx / drag.width * (drag.view.hi - drag.view.lo);
    queueWindow(panPriceWindow(drag.view, shift, floor));
  });
  surface.addEventListener('pointerup', finishDrag);
  surface.addEventListener('pointercancel', finishDrag);
  surface.addEventListener('lostpointercapture', finishDrag);
  surface.addEventListener('pointerleave', () => { if (drag && !drag.moved) drag = null; });
  surface.addEventListener('click', event => {
    if (!suppressClick || !event.detail) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  surface.addEventListener('wheel', event => {
    if (drag || event.ctrlKey || event.metaKey || !event.deltaY || !event.target.matches('[data-probe-hit]')) return;
    const bounds = event.target.getBoundingClientRect();
    if (bounds.width <= 0) return;
    event.preventDefault();
    const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1);
    const factor = Math.exp(Math.max(-.5, Math.min(.5, pixels * .002)));
    queueWindow(zoomPriceWindow(pending ?? getWindow(), factor, fraction, floor, tick));
  }, {passive: false});

  surface.addEventListener('keydown', event => {
    if (!event.target.matches('.reading-chart-scroll') || event.ctrlKey || event.metaKey || event.altKey) return;
    const view = pending ?? getWindow();
    let next;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const shift = (view.hi - view.lo) * (event.key === 'ArrowLeft' ? -.2 : .2);
      next = panPriceWindow(view, shift, floor);
    } else if (['+', '=', '-'].includes(event.key)) {
      next = zoomPriceWindow(view, event.key === '-' ? 1.25 : .8, .5, floor, tick);
    }
    if (!next) return;
    event.preventDefault();
    queueWindow(next);
  });

  return {isPressing: () => !!drag};
}
