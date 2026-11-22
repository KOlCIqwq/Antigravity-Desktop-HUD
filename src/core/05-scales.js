  function getLvlForRange(value, kind = 'day', maxInWindow = 0) {
    const v = Number(value) || 0;
    if (v <= 0) return 0;
    if (kind === 'day') {
      if (v < 3e6) return 1;
      if (v < 15e6) return 2;
      if (v < 60e6) return 3;
      return 4;
    }
    const max = Number(maxInWindow) || 0;
    if (max <= 0) return 1;
    const ratio = v / max;
    if (ratio <= 0.25) return 1;
    if (ratio <= 0.50) return 2;
    if (ratio <= 0.75) return 3;
    return 4;
  }

  /**
   * Compute PDF v0.8.8 recommended hybrid nonlinear response f(V, V_anchor) ∈ [0, 1]
   * Formula: f(V) = 0.35 * ((log10(max(c, 10)) - 1) / (log10(Va) - 1)) + 0.65 * (c / Va)^0.42
   * where c = min(V, Va)
   */
  function computeMixedScaleResponse(value, anchor = 100e6) {
    const v = Number(value);
    const va = Number(anchor);
    if (!Number.isFinite(v) || v <= 0 || !Number.isFinite(va) || va <= 10) return 0;
    const c = Math.min(v, va);
    const denom = Math.log10(va) - 1;
    if (denom <= 0) return 0;
    const logTerm = Math.max(0, (Math.log10(Math.max(c, 10)) - 1) / denom);
    const powTerm = Math.pow(c / va, 0.42);
    const f = 0.35 * logTerm + 0.65 * powTerm;
    if (!Number.isFinite(f)) return 0;
    return Math.max(0, Math.min(1, f));
  }

  const YEARLY_BUBBLE_ANCHORS = [
    { anchor: 100e3, sizePx: 24 },
    { anchor: 1e6, sizePx: 32 },
    { anchor: 10e6, sizePx: 40 },
    { anchor: 100e6, sizePx: 49 },
    { anchor: 1e9, sizePx: 58 }
  ];

  const DAILY_BAR_ANCHORS = [
    { anchor: 100e3, ratio: 0.38 },
    { anchor: 1e6, ratio: 0.52 },
    { anchor: 10e6, ratio: 0.68 },
    { anchor: 100e6, ratio: 0.84 },
    { anchor: 500e6, ratio: 1.0 }
  ];

  const WEEKLY_BAR_ANCHORS = [
    { anchor: 400e3, ratio: 0.38 },
    { anchor: 4e6, ratio: 0.52 },
    { anchor: 40e6, ratio: 0.68 },
    { anchor: 400e6, ratio: 0.84 },
    { anchor: 2e9, ratio: 1.0 }
  ];

  /**
   * Core monotonic cross-tier piecewise-anchor continuous interpolation:
   * preserves the 35% log + 65% power-law (exponent 0.42) blend; each segment starts smoothly from the previous anchor size,
   * never shrinks existing or equal-value points when the window crosses into a higher envelope, and caps at the physical limit with overflow marked.
   */
  function computePiecewiseAnchorScale(value, anchors, minPx, zeroPx = 0) {
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) {
      return { size: zeroPx, response: 0, overflow: false };
    }
    const list = Array.isArray(anchors) && anchors.length ? anchors : [{ anchor: 1e9, size: 58 }];
    const topItem = list[list.length - 1];
    const topAnchor = topItem.anchor;
    const topSize = topItem.size;
    const overflow = v > topAnchor;
    const clamped = Math.min(v, topAnchor);

    let outSize = topSize;
    for (let i = 0; i < list.length; i++) {
      const curr = list[i];
      if (clamped <= curr.anchor) {
        const prevA = i === 0 ? 0 : list[i - 1].anchor;
        const prevY = i === 0 ? minPx : list[i - 1].size;
        let t = 0;
        if (i === 0) {
          const denom = Math.log10(curr.anchor) - 1;
          const lt = (clamped <= 10 || denom <= 0)
            ? 0
            : Math.max(0, (Math.log10(clamped) - 1) / denom);
          const pt = Math.pow(clamped / curr.anchor, 0.42);
          t = 0.35 * lt + 0.65 * pt;
        } else {
          const lt = (Math.log10(clamped) - Math.log10(prevA)) / (Math.log10(curr.anchor) - Math.log10(prevA));
          const pPrev = Math.pow(prevA, 0.42);
          const pCurr = Math.pow(curr.anchor, 0.42);
          const pt = (Math.pow(clamped, 0.42) - pPrev) / (pCurr - pPrev);
          t = 0.35 * lt + 0.65 * pt;
        }
        t = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
        outSize = prevY + (curr.size - prevY) * t;
        break;
      }
    }
    const span = Math.max(1e-6, topSize - minPx);
    return {
      size: outSize,
      response: Math.max(0, Math.min(1, (outSize - minPx) / span)),
      overflow
    };
  }

  /**
   * Fixed color interpolation response f ∈ [0, 1] (never fades or shifts down as the current window max envelope changes)
   */
  function computeColorScaleResponse(value, mode = 'heat') {
    const v = Number(value) || 0;
    if (v <= 0) return 0;
    if (mode === 'yearly') {
      const anchors = YEARLY_BUBBLE_ANCHORS.map((x) => ({ anchor: x.anchor, size: x.sizePx }));
      return computePiecewiseAnchorScale(v, anchors, 8.0, 5.0).response;
    }
    if (mode === 'weekly') {
      const anchors = WEEKLY_BAR_ANCHORS.map((x) => ({ anchor: x.anchor, size: x.ratio * 96 }));
      return computePiecewiseAnchorScale(v, anchors, 3.0, 0).response;
    }
    return computeMixedScaleResponse(v, 100e6);
  }

  /**
   * Return scale envelope parameters for the current window maximum:
   * the envelope determines reference circles, right-side tick marks, and overflow indicators; shape sizes and tick coordinates share the same continuous piecewise-anchor mapping.
   * mode: 'yearly' | 'dailyBar' | 'weekly' | 'heat'
   */
  function resolveScaleEnvelope(windowMax, mode = 'yearly') {
    const maxVal = Math.max(0, Number(windowMax) || 0);
    if (mode === 'heat') {
      return {
        mode: 'heat',
        tier: 'heat-100M',
        label: '100M',
        anchor: 100e6,
        dCap: 58,
        hCap: 1.0,
        overflow: maxVal > 100e6,
        overflowThreshold: 100e6,
        refTicks: [100e3, 1e6, 10e6, 100e6]
      };
    }

    if (mode === 'weekly') {
      if (maxVal <= 400e3) {
        return { mode: 'weekly', tier: '400K', label: '400K', anchor: 400e3, hCap: 0.38, overflow: false, overflowThreshold: 2e9, refTicks: [40e3, 400e3] };
      }
      if (maxVal <= 4e6) {
        return { mode: 'weekly', tier: '4M', label: '4M', anchor: 4e6, hCap: 0.52, overflow: false, overflowThreshold: 2e9, refTicks: [400e3, 4e6] };
      }
      if (maxVal <= 40e6) {
        return { mode: 'weekly', tier: '40M', label: '40M', anchor: 40e6, hCap: 0.68, overflow: false, overflowThreshold: 2e9, refTicks: [4e6, 40e6] };
      }
      if (maxVal <= 400e6) {
        return { mode: 'weekly', tier: '400M', label: '400M', anchor: 400e6, hCap: 0.84, overflow: false, overflowThreshold: 2e9, refTicks: [4e6, 40e6, 400e6] };
      }
      if (maxVal <= 2e9) {
        return { mode: 'weekly', tier: '2B', label: '2B', anchor: 2e9, hCap: 1.0, overflow: false, overflowThreshold: 2e9, refTicks: [4e6, 40e6, 400e6, 2e9] };
      }
      return { mode: 'weekly', tier: '2B+', label: '2B+', anchor: 2e9, hCap: 1.0, overflow: true, overflowThreshold: 2e9, refTicks: [4e6, 40e6, 400e6, 2e9] };
    }

    if (mode === 'dailyBar') {
      if (maxVal <= 100e3) {
        return { mode: 'dailyBar', tier: '100K', label: '100K', anchor: 100e3, hCap: 0.38, overflow: false, overflowThreshold: 500e6, refTicks: [10e3, 100e3] };
      }
      if (maxVal <= 1e6) {
        return { mode: 'dailyBar', tier: '1M', label: '1M', anchor: 1e6, hCap: 0.52, overflow: false, overflowThreshold: 500e6, refTicks: [10e3, 100e3, 1e6] };
      }
      if (maxVal <= 10e6) {
        return { mode: 'dailyBar', tier: '10M', label: '10M', anchor: 10e6, hCap: 0.68, overflow: false, overflowThreshold: 500e6, refTicks: [100e3, 1e6, 10e6] };
      }
      if (maxVal <= 100e6) {
        return { mode: 'dailyBar', tier: '100M', label: '100M', anchor: 100e6, hCap: 0.84, overflow: false, overflowThreshold: 500e6, refTicks: [1e6, 10e6, 100e6] };
      }
      if (maxVal <= 500e6) {
        return { mode: 'dailyBar', tier: '500M', label: '500M', anchor: 500e6, hCap: 1.0, overflow: false, overflowThreshold: 500e6, refTicks: [1e6, 10e6, 100e6, 500e6] };
      }
      return { mode: 'dailyBar', tier: '500M+', label: '500M+', anchor: 500e6, hCap: 1.0, overflow: true, overflowThreshold: 500e6, refTicks: [1e6, 10e6, 100e6, 500e6] };
    }

    // Default 'yearly'
    if (maxVal <= 100e3) {
      return { mode: 'yearly', tier: '100K', label: '100K', anchor: 100e3, dCap: 24, hCap: 0.38, overflow: false, overflowThreshold: 1e9, refRings: [100e3] };
    }
    if (maxVal <= 1e6) {
      return { mode: 'yearly', tier: '1M', label: '1M', anchor: 1e6, dCap: 32, hCap: 0.52, overflow: false, overflowThreshold: 1e9, refRings: [100e3, 1e6] };
    }
    if (maxVal <= 10e6) {
      return { mode: 'yearly', tier: '10M', label: '10M', anchor: 10e6, dCap: 40, hCap: 0.68, overflow: false, overflowThreshold: 1e9, refRings: [1e6, 10e6] };
    }
    if (maxVal <= 100e6) {
      return { mode: 'yearly', tier: '100M', label: '100M', anchor: 100e6, dCap: 49, hCap: 0.84, overflow: false, overflowThreshold: 1e9, refRings: [1e6, 10e6, 100e6] };
    }
    if (maxVal <= 1e9) {
      return { mode: 'yearly', tier: '1B', label: '1B', anchor: 1e9, dCap: 58, hCap: 1.0, overflow: false, overflowThreshold: 1e9, refRings: [1e6, 10e6, 100e6, 1e9] };
    }
    return { mode: 'yearly', tier: '1B+', label: '1B+', anchor: 1e9, dCap: 58, hCap: 1.0, overflow: true, overflowThreshold: 1e9, refRings: [1e6, 10e6, 100e6, 1e9] };
  }

  /**
   * Map yearly monthly bubble diameter (preserves float precision, shares continuous piecewise-anchor mapping, never shrinks across envelopes)
   * Returns D = 5.0px (R = 2.5px) for V <= 0; caps at D = 58.0px with overflow marked for V > 1B
   */
  function mapBubbleDiameter(value, _envelope) {
    const v = Number(value) || 0;
    if (v <= 0) {
      return { diameter: 5.0, radius: 2.5, response: 0, overflow: false };
    }
    const anchors = YEARLY_BUBBLE_ANCHORS.map((x) => ({ anchor: x.anchor, size: x.sizePx }));
    const res = computePiecewiseAnchorScale(v, anchors, 8.0, 5.0);
    return {
      diameter: res.size,
      radius: res.size / 2,
      response: res.response,
      overflow: res.overflow
    };
  }

  /**
   * Map total pixel height for daily/weekly bar charts (preserves float precision, shares continuous piecewise-anchor mapping, never shrinks across envelopes)
   * linear mode: V > 0 -> minPx + (chartHeightPx - minPx) * clamp(V / linearMax, 0, 1)
   */
  function mapBarHeightPx(value, envelope, chartHeightPx = 140, options = {}) {
    const v = Number(value) || 0;
    const heightPx = Math.max(1, Number(chartHeightPx) || 140);
    const minPx = Number.isFinite(Number(options.minPx)) ? Number(options.minPx) : 4.0;
    const mode = options.mode === 'linear' ? 'linear' : 'mixed';
    if (v <= 0) {
      return { height: 0, response: 0, overflow: false };
    }
    if (mode === 'linear') {
      const linearMax = Math.max(1, Number(options.linearMax) || (envelope && envelope.anchor) || v);
      const response = Math.max(0, Math.min(1, v / linearMax));
      return {
        height: minPx + (heightPx - minPx) * response,
        response,
        overflow: false
      };
    }
    const isWeekly = options.scaleKind === 'weekly'
      || (envelope && envelope.mode === 'weekly')
      || (envelope && /^(400K|4M|40M|400M|2B\+?)$/.test(String(envelope.tier || '')));
    const rawAnchors = isWeekly ? WEEKLY_BAR_ANCHORS : DAILY_BAR_ANCHORS;
    const anchors = rawAnchors.map((x) => ({
      anchor: x.anchor,
      size: Math.max(minPx, x.ratio * heightPx)
    }));
    const res = computePiecewiseAnchorScale(v, anchors, minPx, 0);
    return {
      height: res.size,
      response: res.response,
      overflow: res.overflow
    };
  }

  /**
   * Compute heights of non-zero segments inside a stacked bar:
   * enforces minimum non-zero height minSegPx (default 1.5px) and strictly guarantees sum(heightPx) === totalHeightPx;
   * rawRatio is always computed from true value / sum.
   */
  function allocateStackedSegmentHeights(segments, totalHeightPx, minSegPx = 1.5) {
    const list = Array.isArray(segments) ? segments : [];
    const targetH = Math.max(0, Number(totalHeightPx) || 0);
    const rawSum = list.reduce((acc, item) => acc + Math.max(0, Number(item && item.value) || 0), 0);
    if (rawSum <= 0 || targetH <= 0) {
      return list.map((item) => ({ ...item, heightPx: 0, rawRatio: 0, floored: false }));
    }

    const activeIdx = [];
    for (let i = 0; i < list.length; i++) {
      if ((Number(list[i] && list[i].value) || 0) > 0) activeIdx.push(i);
    }
    const n = activeIdx.length;
    const heights = new Array(list.length).fill(0);
    const flooredFlags = new Array(list.length).fill(false);

    if (n === 1) {
      heights[activeIdx[0]] = targetH;
    } else if (n > 1) {
      const effFloor = Math.min(Math.max(0, Number(minSegPx) || 0), targetH / n);
      const locked = new Set();
      let remPx = targetH;
      let remValSum = rawSum;
      let changed = true;

      while (changed) {
        changed = false;
        if (remValSum <= 0) break;
        for (const idx of activeIdx) {
          if (locked.has(idx)) continue;
          const v = Math.max(0, Number(list[idx].value) || 0);
          const est = (v / remValSum) * remPx;
          if (est < effFloor) {
            locked.add(idx);
            heights[idx] = effFloor;
            flooredFlags[idx] = true;
            remPx -= effFloor;
            remValSum -= v;
            changed = true;
          }
        }
      }

      if (remValSum > 0 && remPx > 0) {
        for (const idx of activeIdx) {
          if (locked.has(idx)) continue;
          const v = Math.max(0, Number(list[idx].value) || 0);
          heights[idx] = (v / remValSum) * remPx;
        }
      } else {
        const unlocked = activeIdx.filter((idx) => !locked.has(idx));
        if (unlocked.length > 0) {
          const share = Math.max(0, remPx) / unlocked.length;
          for (const idx of unlocked) heights[idx] = share;
        }
      }

      // Adjust floating-point rounding error back into the tallest segment so sum === targetH
      const sumH = heights.reduce((a, b) => a + b, 0);
      const diff = targetH - sumH;
      if (Math.abs(diff) > 1e-12) {
        let maxIdx = activeIdx[0];
        for (const idx of activeIdx) {
          if (heights[idx] > heights[maxIdx]) maxIdx = idx;
        }
        heights[maxIdx] = Math.max(0, heights[maxIdx] + diff);
      }
    }

    return list.map((item, idx) => {
      const v = Math.max(0, Number(item && item.value) || 0);
      return {
        ...item,
        heightPx: heights[idx],
        rawRatio: v > 0 ? v / rawSum : 0,
        floored: flooredFlags[idx]
      };
    });
  }

  function _hexToRgbNorm(hex) {
    const clean = String(hex || '').trim().replace(/^#/, '');
    let full = clean;
    if (clean.length === 3) {
      full = clean.split('').map((c) => c + c).join('');
    }
    if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
    const n = parseInt(full, 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
  }

  function _rgbNormToHsl({ r, g, b }) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: h * 60, s, l };
  }

  function _hslToHex({ h, s, l }) {
    const hh = (((Number(h) || 0) % 360) + 360) % 360;
    const ss = Math.max(0, Math.min(1, Number(s) || 0));
    const ll = Math.max(0, Math.min(1, Number(l) || 0));
    const c = (1 - Math.abs(2 * ll - 1)) * ss;
    const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
    const m = ll - c / 2;
    let r1 = 0, g1 = 0, b1 = 0;
    if (hh < 60) { r1 = c; g1 = x; }
    else if (hh < 120) { r1 = x; g1 = c; }
    else if (hh < 180) { g1 = c; b1 = x; }
    else if (hh < 240) { g1 = x; b1 = c; }
    else if (hh < 300) { r1 = x; b1 = c; }
    else { r1 = c; b1 = x; }
    const toByte = (v) => Math.max(0, Math.min(255, Math.round((v + m) * 255))).toString(16).padStart(2, '0');
    return `#${toByte(r1)}${toByte(g1)}${toByte(b1)}`;
  }

  /**
   * Shortest-arc interpolation between two points in HSL color space
   */
  function interpolateHslHex(hexA, hexB, t) {
    const rgbA = _hexToRgbNorm(hexA);
    const rgbB = _hexToRgbNorm(hexB);
    if (!rgbA) return String(hexB || '#9333ea');
    if (!rgbB) return String(hexA || '#2e1a47');
    const ratio = Math.max(0, Math.min(1, Number(t) || 0));
    const hslA = _rgbNormToHsl(rgbA);
    const hslB = _rgbNormToHsl(rgbB);
    let hA = hslA.h;
    let hB = hslB.h;
    if (hslA.s < 0.01) hA = hB;
    else if (hslB.s < 0.01) hB = hA;
    let dh = hB - hA;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
    return _hslToHex({
      h: hA + dh * ratio,
      s: hslA.s + (hslB.s - hslA.s) * ratio,
      l: hslA.l + (hslB.l - hslA.l) * ratio
    });
  }

  /**
   * Continuous HSL color mapping from normalized response f ∈ [0, 1] and a list of color stops
   */
  function interpolateScaleColorHsl(response, nonZeroStops) {
    const stops = Array.isArray(nonZeroStops) ? nonZeroStops.filter(Boolean) : [];
    if (stops.length === 0) return '#9333ea';
    if (stops.length === 1) return stops[0];
    const r = Math.max(0, Math.min(1, Number(response) || 0));
    const maxIdx = stops.length - 1;
    const pos = r * maxIdx;
    const idx = Math.min(maxIdx - 1, Math.floor(pos));
    const localT = pos - idx;
    return interpolateHslHex(stops[idx], stops[idx + 1], localT);
  }

  /**
   * Dual-threshold check for yearly chart "Peak" highlight ring (PDF pp. 14, 29):
   * show the Peak ring only when the year has at least 2 non-zero non-future months and the max non-future month usage is >= 10M
   */
  function shouldShowYearlyPeakBadge(nonFutureMonthTokens) {
    const arr = Array.isArray(nonFutureMonthTokens) ? nonFutureMonthTokens : [];
    let nonZeroCount = 0;
    let maxVal = 0;
    for (const raw of arr) {
      const v = Number(raw) || 0;
      if (v > 0) {
        nonZeroCount += 1;
        if (v > maxVal) maxVal = v;
      }
    }
    return nonZeroCount >= 2 && maxVal >= 10e6;
  }

  /**
   * Cross-account logarithmic scale position calculation ([10M, 100B])
   * status: 'zero' | 'below_min' | 'in_range' | 'above_max'
   */
  function computeLogRulerPosition(totalTokens) {
    const v = Math.max(0, Number(totalTokens) || 0);
    const ticks = [
      { value: 10e6, label: '10M', pct: 0 },
      { value: 100e6, label: '100M', pct: 25 },
      { value: 1e9, label: '1B', pct: 50 },
      { value: 10e9, label: '10B', pct: 75 },
      { value: 100e9, label: '100B', pct: 100 }
    ];
    if (v <= 0) {
      return { status: 'zero', pct: 0, value: 0, ticks };
    }
    if (v < 10e6) {
      return { status: 'below_min', pct: 0, value: v, ticks };
    }
    if (v > 100e9) {
      return { status: 'above_max', pct: 100, value: v, ticks };
    }
    const pct = Math.max(0, Math.min(100, ((Math.log10(v) - 7) / 4) * 100));
    return { status: 'in_range', pct, value: v, ticks };
  }

  function _parseYmdUtcMs(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    if (!m) return NaN;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function _formatUtcMsYmd(ms) {
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /**
   * Compute full "Cumulative Total" A+C view summary:
   * - Exact range days, active days, zero-usage days, daily share, and running cumulative total
   * - Group into 7-day weeks from start when > 90 days, with expanded daily list in details
   * - Top 3 peaks and merging of adjacent peaks
   * - Shortest contiguous date range covering >= 50% of usage (earliest on ties; omitted if < 7 days or total is 0)
   */
  function computeCumulativeStripSummary(dailyMap, startYmd, endYmd) {
    const map = dailyMap || {};
    const startMs = _parseYmdUtcMs(startYmd);
    const endMs = _parseYmdUtcMs(endYmd);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
      return {
        startDate: startYmd || '',
        endDate: endYmd || '',
        totalDays: 0,
        activeDays: 0,
        zeroDays: 0,
        intervalTotal: 0,
        grouping: 'daily',
        dailyEntries: [],
        segments: [],
        topPeaks: [],
        mergedPeakSpans: [],
        peakDay: null,
        peakWeek: null,
        concentration: null,
        concentrationOmittedReason: 'empty',
        ruler: computeLogRulerPosition(0)
      };
    }

    const totalDays = Math.floor((endMs - startMs) / 86400000) + 1;
    const dailyEntries = [];
    let intervalTotal = 0;
    let activeDays = 0;

    for (let i = 0; i < totalDays; i++) {
      const dateStr = _formatUtcMsYmd(startMs + i * 86400000);
      const rec = map[dateStr];
      const tokens = Math.max(0, Number(rec && rec.total) || 0);
      const input = Math.max(0, Number(rec && rec.input) || 0);
      const cache = Math.max(0, Number(rec && rec.cache) || 0);
      const output = Math.max(0, Number(rec && rec.output) || 0);
      intervalTotal += tokens;
      if (tokens > 0) activeDays += 1;
      dailyEntries.push({
        idx: i,
        key: dateStr,
        date: dateStr,
        dayNumber: i + 1,
        tokens,
        input,
        cache,
        output,
        isZero: tokens === 0,
        cumulativeTokens: intervalTotal,
        sharePct: 0
      });
    }

    let peakDay = null;
    dailyEntries.forEach((d) => {
      d.sharePct = intervalTotal > 0 ? (d.tokens / intervalTotal) * 100 : 0;
      if (d.tokens > 0 && (!peakDay || d.tokens > peakDay.tokens)) {
        peakDay = { date: d.date, tokens: d.tokens, sharePct: d.sharePct, dayNumber: d.dayNumber };
      }
    });

    const zeroDays = totalDays - activeDays;
    const grouping = totalDays > 90 ? 'weekly' : 'daily';

    const rawItems = [];
    if (grouping === 'daily') {
      dailyEntries.forEach((d, idx) => {
        rawItems.push({
          idx,
          key: d.date,
          startDate: d.date,
          endDate: d.date,
          daysCount: 1,
          dayNumber: d.dayNumber,
          tokens: d.tokens,
          cumulativeTokens: d.cumulativeTokens,
          sharePct: d.sharePct,
          isZero: d.isZero,
          weekIdx: Math.floor(idx / 7),
          days: [d]
        });
      });
    } else {
      const weekCount = Math.ceil(totalDays / 7);
      for (let w = 0; w < weekCount; w++) {
        const slice = dailyEntries.slice(w * 7, Math.min((w + 1) * 7, totalDays));
        const weekTokens = slice.reduce((sum, x) => sum + x.tokens, 0);
        const lastDay = slice[slice.length - 1];
        const sharePct = intervalTotal > 0 ? (weekTokens / intervalTotal) * 100 : 0;
        rawItems.push({
          idx: w,
          key: slice[0].date,
          startDate: slice[0].date,
          endDate: lastDay.date,
          daysCount: slice.length,
          dayNumber: w + 1,
          tokens: weekTokens,
          cumulativeTokens: lastDay.cumulativeTokens,
          sharePct,
          isZero: weekTokens === 0,
          weekIdx: w,
          days: slice
        });
      }
    }

    let peakWeek = null;
    if (grouping === 'weekly') {
      rawItems.forEach((wItem) => {
        if (wItem.tokens > 0 && (!peakWeek || wItem.tokens > peakWeek.tokens)) {
          peakWeek = {
            startDate: wItem.startDate,
            endDate: wItem.endDate,
            tokens: wItem.tokens,
            sharePct: wItem.sharePct
          };
        }
      });
    }

    // Assign proportional band start/end percentages and equidistant axis position percentages
    const itemCount = rawItems.length;
    let accPct = 0;
    const segments = rawItems.map((item, idx) => {
      const equidistantPct = itemCount <= 1 ? 50 : ((idx + 0.5) / itemCount) * 100;
      const widthPct = intervalTotal > 0 && item.tokens > 0 ? (item.tokens / intervalTotal) * 100 : 0;
      const startPct = accPct;
      accPct += widthPct;
      const endPct = accPct;
      const centerPct = widthPct > 0 ? startPct + widthPct / 2 : equidistantPct;
      return {
        ...item,
        equidistantPct,
        stripWidthPct: widthPct,
        stripStartPct: startPct,
        stripEndPct: endPct,
        stripCenterPct: centerPct,
        isPeak: false,
        peakRank: 0
      };
    });

    // Select and mark top 3 peaks; merge adjacent peaks in chronological order
    const activeSorted = segments
      .filter((s) => s.tokens > 0)
      .slice()
      .sort((a, b) => (b.tokens - a.tokens) || (a.idx - b.idx));
    const topPeaks = activeSorted.slice(0, 3);
    topPeaks.forEach((p, rankIdx) => {
      segments[p.idx].isPeak = true;
      segments[p.idx].peakRank = rankIdx + 1;
    });

    const topChronological = topPeaks.slice().sort((a, b) => a.idx - b.idx);
    const mergedPeakSpans = [];
    for (const seg of topChronological) {
      const last = mergedPeakSpans[mergedPeakSpans.length - 1];
      if (last && seg.idx === last._lastIdx + 1) {
        last.endDate = seg.endDate;
        last.tokens += seg.tokens;
        last.sharePct = intervalTotal > 0 ? (last.tokens / intervalTotal) * 100 : 0;
        last.count += 1;
        last.isMerged = true;
        last.itemKeys.push(seg.key);
        last._lastIdx = seg.idx;
      } else {
        mergedPeakSpans.push({
          startDate: seg.startDate,
          endDate: seg.endDate,
          tokens: seg.tokens,
          sharePct: seg.sharePct,
          count: 1,
          isMerged: false,
          itemKeys: [seg.key],
          _lastIdx: seg.idx
        });
      }
    }
    mergedPeakSpans.forEach((sp) => delete sp._lastIdx);

    // Find shortest contiguous date range reaching >= 50% of range total (earliest on ties; omitted if < 7 days)
    let concentration = null;
    let concentrationOmittedReason = null;
    if (intervalTotal <= 0) {
      concentrationOmittedReason = 'empty';
    } else if (totalDays < 7) {
      concentrationOmittedReason = 'insufficient_days';
    } else {
      const target = intervalTotal * 0.5;
      const eps = Math.max(1e-6, intervalTotal * 1e-12);
      let bestL = -1;
      let bestR = -1;
      let bestLen = Infinity;
      let bestSum = 0;
      let left = 0;
      let curSum = 0;

      for (let right = 0; right < dailyEntries.length; right++) {
        curSum += dailyEntries[right].tokens;
        while (left <= right && curSum + eps >= target) {
          const len = right - left + 1;
          if (len < bestLen) {
            bestLen = len;
            bestL = left;
            bestR = right;
            bestSum = curSum;
          }
          if (curSum - dailyEntries[left].tokens + eps >= target) {
            curSum -= dailyEntries[left].tokens;
            left += 1;
          } else {
            break;
          }
        }
      }

      if (bestL >= 0) {
        concentration = {
          startDate: dailyEntries[bestL].date,
          endDate: dailyEntries[bestR].date,
          daysCount: bestLen,
          tokens: bestSum,
          sharePct: (bestSum / intervalTotal) * 100
        };
      }
    }

    return {
      startDate: _formatUtcMsYmd(startMs),
      endDate: _formatUtcMsYmd(endMs),
      totalDays,
      activeDays,
      zeroDays,
      intervalTotal,
      grouping,
      dailyEntries,
      segments,
      topPeaks: topPeaks.map((p) => ({
        key: p.key,
        startDate: p.startDate,
        endDate: p.endDate,
        tokens: p.tokens,
        sharePct: p.sharePct,
        rank: p.peakRank
      })),
      mergedPeakSpans,
      peakDay,
      peakWeek,
      concentration,
      concentrationOmittedReason,
      ruler: computeLogRulerPosition(intervalTotal)
    };
  }

  const _dailyCostCache = new Map();

  function clearDailyCostCache() {
    _dailyCostCache.clear();
  }

  function getDailyModelCost(dayRecord, dateKey, modelKey = 'gemini-3.8-flash', options = {}) {
    if (!dayRecord || (!dayRecord.total && !dayRecord.input && !dayRecord.output && !dayRecord.cache)) {
      return { costUSD: 0, inputCost: 0, cacheCost: 0, outputCost: 0 };
    }
    const mode = options.mode || 'ref';
    const pricingDate = options.pricingDate ? String(options.pricingDate).slice(0, 10) : '2026-11-08';
    const cacheKey = `${dateKey}:${modelKey}:${mode}:${pricingDate}:${dayRecord.input || 0}:${dayRecord.cache || 0}:${dayRecord.output || 0}:${dayRecord.total || 0}`;
    if (_dailyCostCache.has(cacheKey)) {
      return _dailyCostCache.get(cacheKey);
    }

    const calc = calculateReferenceModelCost({
      inputTokens: dayRecord.input || 0,
      cacheTokens: dayRecord.cache || 0,
      outputTokens: dayRecord.output || 0,
      totalTokens: dayRecord.total || 0
    }, modelKey, {
      pricingDate,
      mode: mode === 'hybrid' ? 'unpriced_only' : undefined
    });

    const res = {
      costUSD: calc.totalCostUSD || 0,
      inputCost: calc.inputCostUSD ?? calc.breakdownCostUSD?.input ?? 0,
      cacheCost: calc.cacheCostUSD ?? calc.breakdownCostUSD?.cache ?? 0,
      outputCost: calc.outputCostUSD ?? calc.breakdownCostUSD?.output ?? 0
    };
    _dailyCostCache.set(cacheKey, res);
    return res;
  }

  /**
   * Compute aggregated cost and metrics for a given set of dates
   * @param {Object} dailyMap - Daily records map
   * @param {string[]} dateKeys - Date keys to aggregate (YYYY-MM-DD)
   * @param {string} [modelKey='gemini-3.8-flash'] - Reference model identifier
   * @param {Object} [options={}] - Options (mode, pricingDate, todayStr)
   */
  function calculateIntervalCost(dailyMap = {}, dateKeys = [], modelKey = 'gemini-3.8-flash', options = {}) {
    const todayStr = options.todayStr || (new Date().toISOString().slice(0, 10));
    let totalTokens = 0;
    let inputTokens = 0;
    let cacheTokens = 0;
    let outputTokens = 0;
    let totalCostUSD = 0;
    let pastDays = 0;
    let activeDays = 0;

    for (const key of dateKeys) {
      const isFuture = key > todayStr;
      if (!isFuture) {
        pastDays++;
      }
      const rec = dailyMap[key];
      if (rec && rec.total > 0) {
        activeDays++;
        totalTokens += rec.total;
        inputTokens += (rec.input || 0);
        cacheTokens += (rec.cache || 0);
        outputTokens += (rec.output || 0);

        const cost = getDailyModelCost(rec, key, modelKey, options);
        totalCostUSD += cost.costUSD;
      }
    }

    const safePastDays = Math.max(1, pastDays);
    const dailyAverageUSD = Number((totalCostUSD / safePastDays).toFixed(4));
    const activeDailyAverageUSD = activeDays > 0 ? Number((totalCostUSD / activeDays).toFixed(4)) : 0;

    return {
      totalTokens,
      inputTokens,
      cacheTokens,
      outputTokens,
      totalCostUSD: Number(totalCostUSD.toFixed(4)),
      pastDays,
      activeDays,
      dailyAverageUSD,
      activeDailyAverageUSD
    };
  }

  /**
   * Parse strict v0.x.x semantic version
   * Defensive requirement: only accepts ^v0\.\d+\.\d+$; any v2.x or other prefix returns null
   */
  function parseSemver(tag) {
    if (!tag || typeof tag !== 'string') return null;
    const m = tag.trim().match(/^v?0\.(\d+)\.(\d+)$/);
    if (!m) return null;
    return { major: 0, minor: parseInt(m[1], 10), patch: parseInt(m[2], 10) };
  }

  /**
   * Compare semantic versions
   * @returns {number} 1 (vA > vB), -1 (vA < vB), 0 (equal or incomparable)
   */
  function compareVersions(vA, vB) {
    const a = parseSemver(vA);
    const b = parseSemver(vB);
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
    if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
    return 0;
  }

  /**
   * Filter and select eligible update releases
   */
  function filterReleases(releasesList, currentVersion = '0.8.8') {
    if (!Array.isArray(releasesList)) return [];
    const valid = [];
    for (const rel of releasesList) {
      if (!rel || rel.draft || rel.prerelease) continue;
      const parsed = parseSemver(rel.tag_name);
      if (!parsed) continue; // Ignore non-v0.x tags
      const verStr = `0.${parsed.minor}.${parsed.patch}`;
      if (compareVersions(verStr, currentVersion) > 0) {
        valid.push({
          tagName: rel.tag_name,
          version: verStr,
          htmlUrl: rel.html_url,
          body: rel.body || '',
          publishedAt: rel.published_at || '',
          assets: Array.isArray(rel.assets) ? rel.assets : []
        });
      }
    }
    valid.sort((a, b) => compareVersions(b.version, a.version));
    return valid;
  }

  /**
   * Find the matching ZIP and checksum files in release assets for the current platform and architecture
   */
  function findReleaseAsset(assets, platform, arch) {
    if (!Array.isArray(assets)) return { packageAsset: null, checksumAsset: null, targetOs: 'windows', targetArch: 'amd64' };
    const p = String(platform || '').toLowerCase();
    const a = String(arch || '').toLowerCase();
    const targetOs = (p === 'win32' || p === 'windows') ? 'windows' : ((p === 'darwin' || p === 'macos') ? 'darwin' : 'linux');
    const targetArch = (a === 'x64' || a === 'amd64') ? 'amd64' : 'arm64';

    let checksumAsset = null;
    let packageAsset = null;

    for (const item of assets) {
      const name = item.name || '';
      if (name === 'checksums.txt') {
        checksumAsset = item;
      } else if (name.endsWith('.zip') && name.includes(`_${targetOs}_${targetArch}`)) {
        packageAsset = item;
      }
    }

    return { packageAsset, checksumAsset, targetOs, targetArch };
  }
