    Archify.view = (function () {
      var container = document.querySelector('.diagram-container');
      var svg = container.querySelector('svg');
      var outBtn = container.querySelector('[data-view="out"]');
      var resetBtn = container.querySelector('[data-view="reset"]');
      var resetDetailLabel = resetBtn.querySelector('[data-view-detail]');
      var resetPercentLabel = resetBtn.querySelector('[data-view-percent]');
      var inBtn = container.querySelector('[data-view="in"]');
      var navigation = container.querySelector('.diagram-nav');
      var MIN_SCALE = 0.25;
      var MAX_SCALE = 4;
      var CAMERA_LIMIT = 1000000;
      var grid = document.createElement('div');
      var state = { scale: 1, x: 0, y: 0, mode: 'overview' };
      var drag = null;
      var cameraTimer = null;
      var cameraFrame = null;
      var cameraGeneration = 0;
      var cameraTransaction = null;
      var clipFrame = 0;
      var interactionFrame = 0;
      var interactionChangesScale = false;
      var keyboardFrame = 0;
      var keyboardStartedAt = 0;
      var keyboardShift = false;
      var keyboardDirections = Object.create(null);
      var resizeFrame = 0;
      var autoScrollUntil = 0;
      var wheelTimer = null;
      var wheelGeometry = null;
      var wheelMode = '';
      var wheelPanFrame = 0;
      var wheelPanTimestamp = 0;
      var wheelPanTarget = null;
      var wheelPanInputEnded = false;
      var deferInterruptApply = false;
      var suppressContextMenuUntil = 0;
      var lastControlKey = '';
      var interactionMetrics = { offsetLeft: 0, offsetTop: 0, width: 1, height: 1 };

      var viewBox = svg.viewBox && svg.viewBox.baseVal;

      grid.className = 'infinite-canvas-grid';
      grid.setAttribute('aria-hidden', 'true');
      container.insertBefore(grid, svg);

      function clampCameraCoordinate(value) {
        return Math.max(-CAMERA_LIMIT, Math.min(CAMERA_LIMIT, Number(value) || 0));
      }
      function boundCamera() {
        state.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number(state.scale) || 1));
        state.x = clampCameraCoordinate(state.x);
        state.y = clampCameraCoordinate(state.y);
      }
      function mobileScrollMode() {
        return window.innerWidth <= 720 && container.hasAttribute('data-wide-diagram');
      }
      function syncPointerGesturePolicy() {
        container.style.touchAction = mobileScrollMode() ? 'pan-x pan-y' : 'none';
      }
      function reducedMotion() {
        return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      }
      function contentMetrics() {
        if (!viewBox || viewBox.width <= 0 || viewBox.height <= 0) return null;
        var width = svg.clientWidth || 1;
        var height = svg.clientHeight || 1;
        var scale = Math.min(width / viewBox.width, height / viewBox.height);
        return {
          width: width,
          height: height,
          scale: scale,
          offsetX: (width - viewBox.width * scale) / 2,
          offsetY: (height - viewBox.height * scale) / 2
        };
      }
      function worldViewport() {
        var metrics = contentMetrics();
        if (!metrics) return null;
        var x;
        var y;
        var width;
        var height;
        if (mobileScrollMode()) {
          x = viewBox.x + container.scrollLeft / metrics.scale;
          y = viewBox.y;
          width = Math.min(viewBox.width, Math.max(1, container.clientWidth / metrics.scale));
          height = viewBox.height;
        } else {
          x = viewBox.x + ((-state.x / state.scale) - metrics.offsetX) / metrics.scale;
          y = viewBox.y + ((-state.y / state.scale) - metrics.offsetY) / metrics.scale;
          width = metrics.width / state.scale / metrics.scale;
          height = metrics.height / state.scale / metrics.scale;
        }
        return { x: x, y: y, width: width, height: height, scale: state.scale };
      }
      function logicalViewport() {
        var world = worldViewport();
        if (!world || !viewBox) return world;
        var left = Math.max(viewBox.x, world.x);
        var top = Math.max(viewBox.y, world.y);
        var right = Math.min(viewBox.x + viewBox.width, world.x + world.width);
        var bottom = Math.min(viewBox.y + viewBox.height, world.y + world.height);
        var intersects = right > left && bottom > top;
        return {
          x: intersects ? left : Math.max(viewBox.x, Math.min(viewBox.x + viewBox.width, world.x + world.width / 2)),
          y: intersects ? top : Math.max(viewBox.y, Math.min(viewBox.y + viewBox.height, world.y + world.height / 2)),
          width: intersects ? right - left : 0,
          height: intersects ? bottom - top : 0,
          scale: state.scale,
          outside: !intersects,
          world: world
        };
      }
      function detailLevel() {
        if (state.mode === 'semantic') return 'full';
        if (state.scale >= 1.75) return 'full';
        if (state.scale >= 1) return 'read';
        return 'map';
      }
      function renderControls() {
        var semantic = state.mode === 'semantic' && state.scale > 1.01;
        var detail = detailLevel();
        var percent = Math.round(state.scale * 100) + '%';
        var controlKey = [state.mode, semantic, detail, percent].join('|');
        if (controlKey === lastControlKey) return;
        lastControlKey = controlKey;
        var levelLabel = viewerText('viewer.nav.level.' + detail);
        var detailHint = detail === 'map'
          ? viewerText('viewer.nav.detail.map')
          : detail === 'read'
            ? viewerText('viewer.nav.detail.read')
            : viewerText('viewer.nav.detail.full');
        var resolvedLevel = semantic ? viewerText('viewer.nav.level.auto') : levelLabel;
        var showDetailLevel = semantic || detail !== 'read';
        if (resetDetailLabel) {
          resetDetailLabel.textContent = resolvedLevel;
          resetDetailLabel.hidden = !showDetailLevel;
        }
        if (resetPercentLabel) resetPercentLabel.textContent = percent;
        resetBtn.toggleAttribute('data-detail-visible', showDetailLevel);
        resetBtn.title = viewerText('viewer.nav.camera.title', {
          semantic: semantic ? viewerText('viewer.nav.camera.semantic') : '',
          hint: detailHint
        });
        resetBtn.setAttribute('aria-label', viewerText('viewer.nav.camera', { hint: detailHint }));
        resetBtn.setAttribute('data-detail-level', detail);
        container.setAttribute('data-detail-level', detail);
        container.setAttribute('data-camera-mode', state.mode);
        container.setAttribute('data-camera-indicator', semantic ? 'true' : 'false');
      }
      function clipToViewport(camera, metrics) {
        camera = camera || state;
        if (camera.scale <= 1.001) {
          if (svg.style.clipPath) svg.style.removeProperty('clip-path');
          return;
        }
        var width = metrics ? metrics.width : (svg.clientWidth || 1);
        var height = metrics ? metrics.height : (svg.clientHeight || 1);
        var scale = camera.scale;
        var top = Math.max(0, Math.min(height, -camera.y / scale));
        var left = Math.max(0, Math.min(width, -camera.x / scale));
        var right = Math.max(0, Math.min(width, width - (width - camera.x) / scale));
        var bottom = Math.max(0, Math.min(height, height - (height - camera.y) / scale));
        var nextClip = 'inset(' + [top, right, bottom, left].map(function (value) {
          return Math.round(value * 1000) / 1000 + 'px';
        }).join(' ') + ')';
        if (svg.style.clipPath !== nextClip) svg.style.clipPath = nextClip;
      }
      function cameraSettled(rendered) {
        return Math.abs(rendered.scale - state.scale) < 0.001 &&
          Math.abs(rendered.x - state.x) < 0.05 &&
          Math.abs(rendered.y - state.y) < 0.05;
      }
      function syncViewportClip() {
        if (clipFrame) cancelAnimationFrame(clipFrame);
        clipFrame = 0;
        function sample() {
          clipFrame = 0;
          var rendered = sampleRenderedState();
          clipToViewport(rendered);
          if (!cameraSettled(rendered)) clipFrame = requestAnimationFrame(sample);
        }
        sample();
      }
      function apply(options) {
        options = options || {};
        boundCamera();
        svg.style.transform = 'translate(' + state.x + 'px,' + state.y + 'px) scale(' + state.scale + ')';
        var offsetLeft = options.interactive === true ? interactionMetrics.offsetLeft : (svg.offsetLeft || 0);
        var offsetTop = options.interactive === true ? interactionMetrics.offsetTop : (svg.offsetTop || 0);
        syncGrid(offsetLeft, offsetTop, options.gridPositionOnly === true);
        if (options.interactive === true && clipFrame) {
          cancelAnimationFrame(clipFrame);
          clipFrame = 0;
        }
        if (options.cameraOnly === true) return;
        if (options.interactive !== true) {
          syncViewportClip();
        }
        renderControls();
        outBtn.disabled = state.scale <= MIN_SCALE;
        inBtn.disabled = state.scale >= MAX_SCALE;
        container.classList.toggle('is-pannable', !mobileScrollMode());
        svg.setAttribute('data-view-scale', String(state.scale));
        if (options.interactive !== true) {
          if (Archify.radar && typeof Archify.radar.sync === 'function') Archify.radar.sync();
          if (Archify.viewerChromeLayout && typeof Archify.viewerChromeLayout.schedule === 'function') {
            Archify.viewerChromeLayout.schedule();
          }
        }
      }
      function syncGrid(offsetLeft, offsetTop, positionOnly) {
        offsetLeft = Number.isFinite(offsetLeft) ? offsetLeft : (svg.offsetLeft || 0);
        offsetTop = Number.isFinite(offsetTop) ? offsetTop : (svg.offsetTop || 0);
        container.style.setProperty('--archify-grid-x', (state.x + offsetLeft) + 'px');
        container.style.setProperty('--archify-grid-y', (state.y + offsetTop) + 'px');
        if (positionOnly) return;
        container.style.setProperty('--archify-grid-minor', (24 * state.scale) + 'px');
        container.style.setProperty('--archify-grid-major', (120 * state.scale) + 'px');
      }
      function scheduleInteractionApply(changesScale) {
        if (changesScale === true) interactionChangesScale = true;
        if (interactionFrame) return;
        interactionFrame = requestAnimationFrame(function () {
          interactionFrame = 0;
          apply({ interactive: true, cameraOnly: true, gridPositionOnly: !interactionChangesScale });
          interactionChangesScale = false;
        });
      }
      function captureInteractionGeometry() {
        interactionMetrics = {
          offsetLeft: svg.offsetLeft || 0,
          offsetTop: svg.offsetTop || 0,
          width: svg.clientWidth || 1,
          height: svg.clientHeight || 1
        };
        return container.getBoundingClientRect();
      }
      function flushInteractionApply() {
        if (!interactionFrame) return;
        cancelAnimationFrame(interactionFrame);
        interactionFrame = 0;
        apply({ interactive: true, cameraOnly: true, gridPositionOnly: !interactionChangesScale });
        interactionChangesScale = false;
      }
      function settleInteraction() {
        flushInteractionApply();
        apply();
      }
      function keyboardDirectionActive() {
        return keyboardDirections.ArrowLeft || keyboardDirections.ArrowRight ||
          keyboardDirections.ArrowUp || keyboardDirections.ArrowDown;
      }
      function stopKeyboardPan() {
        if (keyboardFrame) cancelAnimationFrame(keyboardFrame);
        keyboardFrame = 0;
        keyboardStartedAt = 0;
        keyboardDirections = Object.create(null);
        keyboardShift = false;
        if (!container.classList.contains('is-keyboard-panning')) return;
        settleInteraction();
        container.classList.remove('is-keyboard-panning');
      }
      function stepKeyboardPan(timestamp) {
        keyboardFrame = 0;
        if (!keyboardDirectionActive()) {
          stopKeyboardPan();
          return;
        }
        var elapsed = keyboardStartedAt ? Math.min(32, timestamp - keyboardStartedAt) : 0;
        keyboardStartedAt = timestamp;
        var distance = (keyboardShift ? 1100 : 650) * elapsed / 1000;
        var horizontal = (keyboardDirections.ArrowLeft ? 1 : 0) - (keyboardDirections.ArrowRight ? 1 : 0);
        var vertical = (keyboardDirections.ArrowUp ? 1 : 0) - (keyboardDirections.ArrowDown ? 1 : 0);
        state.x += horizontal * distance;
        state.y += vertical * distance;
        state.mode = 'manual';
        apply({ interactive: true, cameraOnly: true, gridPositionOnly: true });
        keyboardFrame = requestAnimationFrame(stepKeyboardPan);
      }
      function startKeyboardPan() {
        if (container.classList.contains('is-keyboard-panning')) return;
        if (container.classList.contains('is-wheel-moving')) finishWheelGesture(true);
        interruptCamera('keyboard');
        captureInteractionGeometry();
        container.classList.add('is-keyboard-panning');
        keyboardStartedAt = 0;
        keyboardFrame = requestAnimationFrame(stepKeyboardPan);
      }
      function finishWheelGesture(commitPanTarget) {
        if (wheelTimer) clearTimeout(wheelTimer);
        wheelTimer = null;
        if (wheelPanFrame) cancelAnimationFrame(wheelPanFrame);
        wheelPanFrame = 0;
        wheelPanTimestamp = 0;
        if (commitPanTarget && wheelPanTarget) {
          state.x = wheelPanTarget.x;
          state.y = wheelPanTarget.y;
          state.mode = 'manual';
          apply({ interactive: true, cameraOnly: true, gridPositionOnly: true });
          try { getComputedStyle(svg).transform; } catch (_) {}
        }
        settleInteraction();
        container.classList.remove('is-wheel-moving');
        wheelGeometry = null;
        wheelMode = '';
        wheelPanTarget = null;
        wheelPanInputEnded = false;
        if (Archify.focus && Archify.focus.reposition) Archify.focus.reposition();
      }
      function stepWheelPan(timestamp) {
        wheelPanFrame = 0;
        if (!wheelPanTarget || wheelMode !== 'pan') return;
        var elapsed = wheelPanTimestamp ? Math.min(32, timestamp - wheelPanTimestamp) : 16.67;
        wheelPanTimestamp = timestamp;
        var blend = 1 - Math.exp(-elapsed / 35);
        state.x += (wheelPanTarget.x - state.x) * blend;
        state.y += (wheelPanTarget.y - state.y) * blend;
        state.mode = 'manual';
        var remaining = Math.abs(wheelPanTarget.x - state.x) + Math.abs(wheelPanTarget.y - state.y);
        if (wheelPanInputEnded && remaining < 0.25) {
          finishWheelGesture(true);
          return;
        }
        apply({ interactive: true, cameraOnly: true, gridPositionOnly: true });
        wheelPanFrame = requestAnimationFrame(stepWheelPan);
      }
      function scheduleWheelPan() {
        if (!wheelPanFrame) wheelPanFrame = requestAnimationFrame(stepWheelPan);
      }
      function sampleRenderedState() {
        var transform = '';
        try { transform = getComputedStyle(svg).transform || ''; } catch (_) {}
        var match = transform.match(/^matrix\(([^)]+)\)$/);
        if (!match) return { scale: state.scale, x: state.x, y: state.y, mode: state.mode };
        var values = match[1].split(',').map(Number);
        if (values.length !== 6 || !values.every(Number.isFinite)) {
          return { scale: state.scale, x: state.x, y: state.y, mode: state.mode };
        }
        return { scale: values[0], x: values[4], y: values[5], mode: state.mode };
      }
      function finishCameraTransaction(transaction, outcome) {
        if (!transaction || transaction.settled) return false;
        transaction.settled = true;
        transaction.state = outcome || 'complete';
        if (transaction.frame) cancelAnimationFrame(transaction.frame);
        if (transaction.timer) clearTimeout(transaction.timer);
        transaction.frame = null;
        transaction.timer = null;
        if (cameraTransaction === transaction) cameraTransaction = null;
        cameraFrame = null;
        cameraTimer = null;
        container.classList.remove('is-camera-moving');
        container.classList.remove('is-camera-transaction');
        container.removeAttribute('data-camera-transaction');
        if (Archify.focus && Archify.focus.reposition) Archify.focus.reposition();
        transaction.resolve({ id: transaction.id, state: transaction.state });
        return true;
      }
      function cameraReceipt(target, options) {
        var resolver;
        var transaction = {
          id: ++cameraGeneration,
          state: 'running',
          target: target,
          settled: false,
          frame: null,
          timer: null,
          finished: new Promise(function (resolve) { resolver = resolve; }),
          resolve: resolver,
          cancel: function (reason, commitTarget) {
            if (transaction.settled) return false;
            if (commitTarget && transaction.target) {
              if (Object.prototype.hasOwnProperty.call(transaction.target, 'scrollLeft')) {
                container.scrollLeft = transaction.target.scrollLeft;
              } else {
                state = {
                  scale: transaction.target.scale,
                  x: transaction.target.x,
                  y: transaction.target.y,
                  mode: transaction.target.mode
                };
                apply();
              }
            }
            return finishCameraTransaction(transaction, reason || 'cancelled');
          }
        };
        return transaction;
      }
      function stopCameraMotion(reason, commitTarget) {
        if (cameraTransaction && !cameraTransaction.settled) {
          cameraTransaction.cancel(reason || 'cancelled', commitTarget === true);
          return;
        }
        if (cameraTimer) clearTimeout(cameraTimer);
        if (cameraFrame) cancelAnimationFrame(cameraFrame);
        cameraTimer = null;
        cameraFrame = null;
        container.classList.remove('is-camera-moving');
        container.classList.remove('is-camera-transaction');
        container.removeAttribute('data-camera-transaction');
      }
      function interruptCamera(reason) {
        if (Archify.guidedViews && Archify.guidedViews.cancelHandoff) {
          Archify.guidedViews.cancelHandoff(reason || 'manual');
        }
        flushInteractionApply();
        var rendered = sampleRenderedState();
        stopCameraMotion(reason || 'manual', false);
        state = rendered;
        state.mode = 'manual';
        if (!deferInterruptApply) apply();
        if (Archify.guidedViews && Archify.guidedViews.isPlaying && Archify.guidedViews.isPlaying()) {
          Archify.guidedViews.pause();
        }
        if (Archify.routeProbe && Archify.routeProbe.isJourneyPlaying && Archify.routeProbe.isJourneyPlaying()) {
          Archify.routeProbe.pauseJourney({ preserveElapsed: true, reason: reason || 'manual' });
        }
      }
      function interruptCameraWithoutRender(reason) {
        deferInterruptApply = true;
        try { interruptCamera(reason); } finally { deferInterruptApply = false; }
      }
      function zoomAtLocal(next, anchorX, anchorY, options) {
        options = options || {};
        if (options.manual !== false) interruptCamera();
        var previous = state.scale;
        next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number(next) || previous));
        if (options.discrete === true) next = Math.round(next * 4) / 4;
        else next = Math.round(next * 1000) / 1000;
        if (next === previous) return;
        var contentX = (anchorX - state.x) / previous;
        var contentY = (anchorY - state.y) / previous;
        state.scale = next;
        state.x = anchorX - contentX * next;
        state.y = anchorY - contentY * next;
        if (options.defer === true) scheduleInteractionApply(true);
        else apply();
      }
      function zoom(next, options) {
        options = options || {};
        options.discrete = true;
        zoomAtLocal(next, (svg.clientWidth || 1) / 2, (svg.clientHeight || 1) / 2, options);
      }
      function zoomAt(next, clientX, clientY, options) {
        var rect = container.getBoundingClientRect();
        var anchorX = Number(clientX) - rect.left - (svg.offsetLeft || 0);
        var anchorY = Number(clientY) - rect.top - (svg.offsetTop || 0);
        if (!Number.isFinite(anchorX) || !Number.isFinite(anchorY)) return false;
        zoomAtLocal(next, anchorX, anchorY, options);
        return true;
      }
      function panBy(dx, dy, options) {
        options = options || {};
        dx = Number(dx);
        dy = Number(dy);
        if (!Number.isFinite(dx) || !Number.isFinite(dy) || mobileScrollMode()) return false;
        if (options.manual !== false) interruptCamera();
        state.x += dx;
        state.y += dy;
        state.mode = 'manual';
        if (options.defer === true) scheduleInteractionApply(false);
        else apply();
        return true;
      }
      function reset(options) {
        options = options || {};
        if (options.automatic !== true) interruptCamera();
        else stopCameraMotion('reset', false);
        state = { scale: 1, x: 0, y: 0, mode: 'overview' };
        apply();
      }
      function centerAt(logicalX, logicalY, options) {
        options = options || {};
        logicalX = Number(logicalX);
        logicalY = Number(logicalY);
        var metrics = contentMetrics();
        if (!metrics || !Number.isFinite(logicalX) || !Number.isFinite(logicalY)) return false;
        interruptCamera();
        if (mobileScrollMode()) {
          state.scale = 1;
          state.x = 0;
          state.y = 0;
          state.mode = 'manual';
          apply();
          var mobileTarget = (logicalX - viewBox.x) * metrics.scale - container.clientWidth / 2;
          mobileTarget = Math.max(0, Math.min(svg.clientWidth - container.clientWidth, mobileTarget));
          autoScrollUntil = Date.now() + 80;
          try { container.scrollTo({ left: mobileTarget, behavior: options.instant ? 'auto' : 'smooth' }); }
          catch (_) { container.scrollLeft = mobileTarget; }
          return true;
        }
        var minimumScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number(options.minimumScale) || 1));
        var requestedScale = Number(options.scale);
        state.scale = Math.max(minimumScale, Math.min(MAX_SCALE, Number.isFinite(requestedScale) ? requestedScale : state.scale));
        var contentX = metrics.offsetX + (logicalX - viewBox.x) * metrics.scale;
        var contentY = metrics.offsetY + (logicalY - viewBox.y) * metrics.scale;
        state.x = metrics.width / 2 - contentX * state.scale;
        state.y = metrics.height / 2 - contentY * state.scale;
        state.mode = 'manual';
        apply();
        if (Archify.focus && Archify.focus.reposition) Archify.focus.reposition();
        return true;
      }
      function semanticIds(ids, includeNeighbors) {
        var seeds = Object.create(null);
        var wanted = Object.create(null);
        (ids || []).forEach(function (id) { seeds[id] = true; wanted[id] = true; });
        if (includeNeighbors) {
          Array.prototype.forEach.call(svg.querySelectorAll('[data-edge-from][data-edge-to]'), function (edge) {
            var from = edge.getAttribute('data-edge-from');
            var to = edge.getAttribute('data-edge-to');
            if (seeds[from] || seeds[to]) { wanted[from] = true; wanted[to] = true; }
          });
        }
        return wanted;
      }
      function boxesFor(ids, includeNeighbors) {
        var wanted = semanticIds(ids, includeNeighbors);
        return Array.prototype.slice.call(svg.querySelectorAll('[data-node-id]'))
          .filter(function (node) { return wanted[node.getAttribute('data-node-id')]; })
          .map(function (node) {
            try { return node.getBBox(); } catch (_) { return null; }
          })
          .filter(Boolean);
      }
      function frameDesktop(ids, options) {
        options = options || {};
        var boxes = boxesFor(ids, options.includeNeighbors === true);
        if (!boxes.length || !viewBox || viewBox.width <= 0 || viewBox.height <= 0) return false;
        var svgWidth = svg.clientWidth || 1;
        var svgHeight = svg.clientHeight || 1;
        var contentScale = Math.min(svgWidth / viewBox.width, svgHeight / viewBox.height);
        var contentOffsetX = (svgWidth - viewBox.width * contentScale) / 2;
        var contentOffsetY = (svgHeight - viewBox.height * contentScale) / 2;
        var minX = Math.min.apply(Math, boxes.map(function (box) { return box.x; }));
        var minY = Math.min.apply(Math, boxes.map(function (box) { return box.y; }));
        var maxX = Math.max.apply(Math, boxes.map(function (box) { return box.x + box.width; }));
        var maxY = Math.max.apply(Math, boxes.map(function (box) { return box.y + box.height; }));
        var bounds = {
          x: contentOffsetX + minX * contentScale,
          y: contentOffsetY + minY * contentScale,
          width: Math.max(1, (maxX - minX) * contentScale),
          height: Math.max(1, (maxY - minY) * contentScale)
        };
        var padding = options.padding || 48;
        var left = padding;
        var right = svgWidth - padding;
        var top = padding;
        var bottom = svgHeight - Math.max(padding, 72);
        var containerRect = container.getBoundingClientRect();
        var visibleTop = Math.max(0, -containerRect.top);
        var visibleBottom = Math.min(svgHeight, window.innerHeight - containerRect.top);
        if (visibleBottom - visibleTop >= 240) {
          top = Math.max(top, visibleTop + padding);
          bottom = Math.min(bottom, visibleBottom - Math.max(padding, 72));
        }
        var chip = document.getElementById('focus-chip');
        if (chip && !chip.hidden) {
          var lensEnd = chip.offsetLeft + chip.offsetWidth + 24 - (svg.offsetLeft || 0);
          left = Math.max(left, Math.min(svgWidth * 0.42, lensEnd));
        }
        var routeReceipt = document.getElementById('route-probe');
        if (routeReceipt && !routeReceipt.hidden && routeReceipt.hasAttribute('data-route-journey')) {
          var receiptTop = routeReceipt.offsetTop;
          var receiptBottom = receiptTop + routeReceipt.offsetHeight;
          if (receiptTop < svgHeight / 2) top = Math.max(top, receiptBottom + 24);
          else bottom = Math.min(bottom, receiptTop - 24);
        }
        if (right <= left || bottom <= top) return false;
        var maxScale = options.maxScale || (options.includeNeighbors ? 1.9 : 2.15);
        var targetScale = Math.min((right - left) / bounds.width, (bottom - top) / bounds.height) * 0.9;
        targetScale = Math.max(1, Math.min(maxScale, targetScale));
        if (targetScale < 1.08) targetScale = 1;
        var target = {
          scale: Math.round(targetScale * 100) / 100,
          x: 0,
          y: 0,
          mode: 'semantic'
        };
        target.x = (left + right) / 2 - (bounds.x + bounds.width / 2) * target.scale;
        target.y = (top + bottom) / 2 - (bounds.y + bounds.height / 2) * target.scale;
        var start = sampleRenderedState();
        stopCameraMotion('replaced', false);
        var transaction = cameraReceipt(target, options);
        cameraTransaction = transaction;
        var instant = options.instant === true || reducedMotion() || document.hidden;
        if (instant) {
          state = target;
          apply();
          finishCameraTransaction(transaction, reducedMotion() ? 'reduced-motion' : (document.hidden ? 'hidden' : 'complete'));
          return transaction;
        }
        var duration = Math.max(180, Math.min(520, Number(options.duration) || 420));
        var startedAt = 0;
        state = start;
        state.mode = 'semantic';
        apply();
        container.classList.add('is-camera-moving');
        container.classList.add('is-camera-transaction');
        container.setAttribute('data-camera-transaction', String(transaction.id));
        var step = function (timestamp) {
          if (cameraTransaction !== transaction || transaction.settled) return;
          if (!startedAt) startedAt = timestamp;
          var fraction = Math.max(0, Math.min(1, (timestamp - startedAt) / duration));
          var eased = 1 - Math.pow(1 - fraction, 3);
          state = {
            scale: start.scale + (target.scale - start.scale) * eased,
            x: start.x + (target.x - start.x) * eased,
            y: start.y + (target.y - start.y) * eased,
            mode: 'semantic'
          };
          apply();
          if (fraction < 1) {
            transaction.frame = requestAnimationFrame(step);
            cameraFrame = transaction.frame;
          } else {
            state = target;
            apply();
            finishCameraTransaction(transaction, 'complete');
          }
        };
        transaction.frame = requestAnimationFrame(step);
        cameraFrame = transaction.frame;
        return transaction;
      }
      function reveal(ids, options) {
        options = options || {};
        if (window.innerWidth > 720) return frameDesktop(ids, options);
        stopCameraMotion('replaced', false);
        state.scale = 1;
        state.x = 0;
        state.y = 0;
        state.mode = 'semantic';
        apply();
        if (!container.hasAttribute('data-wide-diagram')) {
          var contained = cameraReceipt({ scale: 1, x: 0, y: 0, mode: 'semantic' }, options);
          cameraTransaction = contained;
          finishCameraTransaction(contained, 'complete');
          return contained;
        }
        var boxes = boxesFor(ids, options.includeNeighbors === true);
        if (!boxes.length || !viewBox || viewBox.width <= 0) return false;
        var minX = Math.min.apply(Math, boxes.map(function (box) { return box.x; }));
        var maxX = Math.max.apply(Math, boxes.map(function (box) { return box.x + box.width; }));
        var center = ((minX + maxX) / 2 / viewBox.width) * (svg.clientWidth || 1);
        var target = Math.max(0, Math.min(svg.clientWidth - container.clientWidth, center - container.clientWidth / 2));
        var transaction = cameraReceipt({ scrollLeft: target }, options);
        cameraTransaction = transaction;
        var instant = options.instant === true || reducedMotion() || document.hidden;
        autoScrollUntil = Date.now() + (instant ? 50 : 470);
        try { container.scrollTo({ left: target, behavior: instant ? 'auto' : 'smooth' }); }
        catch (_) { container.scrollLeft = target; }
        if (instant) finishCameraTransaction(transaction, reducedMotion() ? 'reduced-motion' : (document.hidden ? 'hidden' : 'complete'));
        else {
          transaction.timer = setTimeout(function () { finishCameraTransaction(transaction, 'complete'); }, 460);
          cameraTimer = transaction.timer;
          container.classList.add('is-camera-moving');
          container.setAttribute('data-camera-transaction', String(transaction.id));
        }
        return transaction;
      }
      function syncSemantic() {
        var guided = Archify.guidedViews && typeof Archify.guidedViews.focus === 'function'
          ? Archify.guidedViews.focus() : [];
        if (guided && guided.length) return reveal(guided, { reason: 'guided-sync' });
        var active = Archify.focus && typeof Archify.focus.active === 'function' ? Archify.focus.active() : null;
        if (typeof active === 'string') return reveal([active], { includeNeighbors: true, reason: 'focus-sync' });
        if (Array.isArray(active) && active.length) return reveal(active, { reason: 'selection-sync' });
        return false;
      }
      function pinControls() {
        container.style.setProperty('--archify-scroll-x', container.scrollLeft + 'px');
      }
      function syncNavigationDock() {
        syncPointerGesturePolicy();
        if (!navigation) return;
        var rect = container.getBoundingClientRect();
        var margin = window.innerWidth <= 720 ? 8 : 16;
        var viewportEdge = window.innerHeight - margin;
        var wasDocked = navigation.hasAttribute('data-viewport-docked');
        var docked = !mobileScrollMode() && rect.top < viewportEdge &&
          (rect.bottom > viewportEdge || (wasDocked && rect.bottom > 0));
        var changed = wasDocked !== docked;
        navigation.toggleAttribute('data-viewport-docked', docked);
        if (docked) {
          var visibleRight = Math.min(rect.right, window.innerWidth);
          navigation.style.setProperty('--archify-nav-viewport-right', Math.max(margin, window.innerWidth - visibleRight + margin) + 'px');
        } else {
          navigation.style.removeProperty('--archify-nav-viewport-right');
        }
        if (changed && Archify.radar && typeof Archify.radar.sync === 'function') Archify.radar.sync();
      }
      function resetNavigationDockLatch() {
        if (!navigation) return;
        navigation.removeAttribute('data-viewport-docked');
        navigation.style.removeProperty('--archify-nav-viewport-right');
        syncNavigationDock();
      }
      function onScroll() {
        pinControls();
        if (Archify.radar && typeof Archify.radar.sync === 'function') Archify.radar.sync();
        if (window.innerWidth <= 720 && container.hasAttribute('data-wide-diagram') && Date.now() > autoScrollUntil) {
          interruptCamera();
        }
      }
      function onPointerEnd(event) {
        if (!drag) return;
        var moved = drag.moved;
        drag = null;
        try { container.releasePointerCapture(event.pointerId); } catch (_) {}
        if (moved) settleInteraction();
        container.classList.remove('is-panning');
        if (moved) {
          suppressContextMenuUntil = Date.now() + 250;
          container.setAttribute('data-just-panned', 'true');
          setTimeout(function () { container.removeAttribute('data-just-panned'); }, 80);
        }
      }
      function cameraControlTarget(target) {
        return target.closest('.diagram-nav, .focus-chip, .node-finder, .diagram-guide, .overview-map, .route-probe, .semantic-lens');
      }
      function keyboardInputTarget(target) {
        return target && target.closest && target.closest('input, select, textarea, [contenteditable="true"]');
      }
      function diagramInViewport() {
        var rect = container.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
      }

      inBtn.addEventListener('click', function () { zoom(state.scale + 0.25); });
      outBtn.addEventListener('click', function () { zoom(state.scale - 0.25); });
      resetBtn.addEventListener('click', reset);
      if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '0');
      if (!container.hasAttribute('role')) container.setAttribute('role', 'region');
      if (!container.hasAttribute('aria-label')) container.setAttribute('aria-label', viewerText('viewer.camera.surface'));
      syncPointerGesturePolicy();
      container.addEventListener('pointerdown', function (event) {
        var directPointerPan = (event.pointerType === 'touch' || event.pointerType === 'pen') && event.button === 0;
        if (mobileScrollMode() || (event.button !== 2 && !directPointerPan) || cameraControlTarget(event.target)) return;
        event.preventDefault();
        try { container.focus({ preventScroll: true }); } catch (_) { container.focus(); }
        if (container.classList.contains('is-wheel-moving')) finishWheelGesture(true);
        stopKeyboardPan();
        interruptCamera();
        captureInteractionGeometry();
        drag = { startX: event.clientX, startY: event.clientY, x: state.x, y: state.y, moved: false };
        container.classList.add('is-panning');
        try { container.setPointerCapture(event.pointerId); } catch (_) {}
      });
      container.addEventListener('pointermove', function (event) {
        if (!drag) return;
        var dx = event.clientX - drag.startX;
        var dy = event.clientY - drag.startY;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        state.x = drag.x + dx;
        state.y = drag.y + dy;
        scheduleInteractionApply(false);
      });
      container.addEventListener('pointerup', onPointerEnd);
      container.addEventListener('pointercancel', onPointerEnd);
      container.addEventListener('contextmenu', function (event) {
        if (Date.now() < suppressContextMenuUntil && !cameraControlTarget(event.target)) event.preventDefault();
      });
      container.addEventListener('wheel', function (event) {
        if (mobileScrollMode() || cameraControlTarget(event.target)) return;
        event.preventDefault();
        try { container.focus({ preventScroll: true }); } catch (_) { container.focus(); }
        var nextWheelMode = event.ctrlKey || event.metaKey ? 'zoom' : 'pan';
        var startingWheel = !container.classList.contains('is-wheel-moving') || wheelMode !== nextWheelMode;
        if (startingWheel) {
          if (container.classList.contains('is-wheel-moving')) finishWheelGesture(true);
          stopKeyboardPan();
          interruptCameraWithoutRender('wheel');
          var rect = captureInteractionGeometry();
          wheelGeometry = {
            left: rect.left + interactionMetrics.offsetLeft,
            top: rect.top + interactionMetrics.offsetTop
          };
          wheelMode = nextWheelMode;
          if (wheelMode === 'pan') {
            wheelPanTarget = { x: state.x, y: state.y };
            wheelPanTimestamp = 0;
          }
        }
        container.classList.add('is-wheel-moving');
        if (wheelTimer) clearTimeout(wheelTimer);
        if (wheelMode === 'zoom') {
          zoomAtLocal(state.scale * Math.exp(-event.deltaY * 0.002),
            event.clientX - wheelGeometry.left, event.clientY - wheelGeometry.top,
            { manual: false, defer: true });
          wheelTimer = setTimeout(function () { finishWheelGesture(false); }, 120);
        } else {
          var deltaFactor = event.deltaMode === 1 ? 16 : (event.deltaMode === 2 ? container.clientHeight : 1);
          wheelPanTarget.x = clampCameraCoordinate(wheelPanTarget.x - event.deltaX * deltaFactor);
          wheelPanTarget.y = clampCameraCoordinate(wheelPanTarget.y - event.deltaY * deltaFactor);
          wheelPanInputEnded = false;
          scheduleWheelPan();
          wheelTimer = setTimeout(function () {
            wheelTimer = null;
            wheelPanInputEnded = true;
            scheduleWheelPan();
          }, 80);
        }
        if (startingWheel && wheelMode === 'zoom') flushInteractionApply();
      }, { passive: false });
      window.addEventListener('keydown', function (event) {
        var activeTarget = document.activeElement;
        if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || mobileScrollMode() ||
            drag || keyboardInputTarget(event.target) || activeTarget !== container || !diagramInViewport()) return;
        if (!/^Arrow(Left|Right|Up|Down)$/.test(event.key)) return;
        event.preventDefault();
        keyboardDirections[event.key] = true;
        keyboardShift = event.shiftKey;
        startKeyboardPan();
      });
      window.addEventListener('keyup', function (event) {
        if (event.key === 'Shift') keyboardShift = false;
        if (!/^Arrow(Left|Right|Up|Down)$/.test(event.key)) return;
        delete keyboardDirections[event.key];
        keyboardShift = event.shiftKey;
        if (!keyboardDirectionActive()) stopKeyboardPan();
      });
      window.addEventListener('blur', stopKeyboardPan);
      container.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('scroll', syncNavigationDock, { passive: true });
      window.addEventListener('afterprint', function () {
        requestAnimationFrame(function () {
          requestAnimationFrame(resetNavigationDockLatch);
        });
      });
      if (window.ResizeObserver) new ResizeObserver(syncNavigationDock).observe(container);
      window.addEventListener('resize', function () {
        if (resizeFrame) cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(function () {
          resizeFrame = 0;
          if (state.mode === 'semantic') syncSemantic();
          else apply();
        });
      });
      window.addEventListener('hashchange', function () { requestAnimationFrame(syncSemantic); });
      apply();
      pinControls();
      requestAnimationFrame(syncNavigationDock);
      requestAnimationFrame(syncSemantic);

      return {
        zoomIn: function () { zoom(state.scale + 0.25); },
        zoomOut: function () { zoom(state.scale - 0.25); },
        zoomAt: zoomAt,
        panBy: panBy,
        fit: reset,
        reset: reset,
        reveal: reveal,
        centerAt: centerAt,
        logicalViewport: logicalViewport,
        worldViewport: worldViewport,
        sync: syncSemantic,
        state: function () { return { scale: state.scale, x: state.x, y: state.y, mode: state.mode }; }
      };
    })();
