  // =========================================================================
  // ELV-41 / ELV-43: 官方模型选择器识别与多通道请求拦截注入器
  // 支持：主世界 LS 客户端装饰器、WebSocket (Lcc JSON)、Fetch/XHR (JSON / Envelope / Protobuf)
  // 严格过滤 StartCascade，仅拦截 SendUserCascadeMessage；不从面板配置卡猜测模型
  // =========================================================================
  const CTX_CONFIRM_TIMEOUT_MS = budgetEngine.DEFAULT_CONFIRM_TIMEOUT_MS || 45000;
  const budgetTracker = typeof budgetEngine.createContextBudgetTracker === 'function'
    ? budgetEngine.createContextBudgetTracker({ confirmTimeoutMs: CTX_CONFIRM_TIMEOUT_MS })
    : null;
  let lastDecoratorDispatchHint = null;
  const pendingConfirmTimers = new Set();

  function scheduleConfirmTimeoutCheck(delayMs = CTX_CONFIRM_TIMEOUT_MS + 100) {
    if (typeof setTimeout !== 'function' || state.disposed) return;
    const tId = setTimeout(() => {
      pendingConfirmTimers.delete(tId);
      if (state.disposed) return;
      try {
        renderCompactSessionCard();
        if (!isContextSettingsView && activeContextTab === 'models') {
          renderModelSettingsTab();
        }
      } catch { }
    }, delayMs);
    pendingConfirmTimers.add(tId);
  }

  function refreshBudgetUiAfterDispatch() {
    try {
      renderCompactSessionCard();
      const prod = getSelectedProductObj();
      if (prod) renderModelDetailCard(prod);
    } catch { }
  }

  /**
   * 仅从宿主真实输入框选择器读取当前选中模型（严格排除插件自身 #ag-context-meter DOM）
   */
  function extractHostSelectedModel() {
    if (typeof document === 'undefined') return null;
    const triggers = typeof document.querySelectorAll === 'function'
      ? Array.from(document.querySelectorAll('[data-testid="model-selector-trigger"]'))
      : (typeof document.querySelector === 'function' ? [document.querySelector('[data-testid="model-selector-trigger"]')].filter(Boolean) : []);
    if (!triggers.length) return null;

    let trigger = null;
    for (const candidate of triggers) {
      if (!candidate) continue;
      if (host && typeof host.contains === 'function' && host.contains(candidate)) continue;
      if (typeof candidate.closest === 'function' && candidate.closest('#ag-context-meter')) continue;
      if (typeof candidate.getBoundingClientRect === 'function') {
        const rect = candidate.getBoundingClientRect();
        if (rect && rect.width === 0 && rect.height === 0) continue;
      }
      trigger = candidate;
      break;
    }
    if (!trigger) return null;

    let effort = null;
    const effortEl = trigger.querySelector?.('[data-testid="model-selector-effort-option"]')
      || trigger.querySelector?.('[data-effort]');
    if (effortEl) {
      effort = effortEl.getAttribute?.('data-effort') || effortEl.textContent?.trim() || null;
    }

    const clone = trigger.cloneNode ? trigger.cloneNode(true) : trigger;
    const svgs = clone.querySelectorAll ? clone.querySelectorAll('svg, [aria-hidden="true"]') : [];
    if (svgs && svgs.forEach) svgs.forEach(s => s.remove());
    const rawText = (clone.textContent || '').trim();
    if (!rawText) return null;

    const effortCaseMap = {
      'extra high': 'Extra High',
      xhigh: 'XHigh',
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      extra: 'Extra',
      minimal: 'Minimal',
      max: 'Max'
    };
    let baseText = rawText;
    const mParen = rawText.match(/^(.*?)\s*\((Extra High|XHigh|Low|Medium|High|Extra|Minimal|Max)\)\s*$/i);
    if (mParen) {
      baseText = mParen[1].trim() || rawText;
      if (!effort) effort = mParen[2];
    } else {
      const mTrail = rawText.match(/^(.*?)\s+(Extra High|XHigh|Low|Medium|High|Minimal|Max)\s*$/i);
      if (mTrail) {
        baseText = mTrail[1].trim() || rawText;
        if (!effort) effort = mTrail[2];
      }
    }
    const normEffort = effort ? (effortCaseMap[String(effort).trim().toLowerCase()] || effort) : null;
    const parenLabel = (normEffort && baseText && !baseText.includes('(')) ? `${baseText} (${normEffort})` : rawText;

    const configs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
    const resolveCand = (cand) => cand
      ? (resolveStableModelKeyClient(cand) || (typeof resolveStableModelId === 'function' ? resolveStableModelId(cand, configs) : null))
      : null;
    const stableId = resolveCand(parenLabel) || resolveCand(rawText) || resolveCand(baseText);
    const g = groupProductSafe({
      modelId: stableId || parenLabel,
      label: parenLabel,
      effort: normEffort
    });

    return {
      rawText,
      modelId: stableId || parenLabel,
      productKey: g.productKey,
      productLabel: g.productLabel || baseText,
      effort: normEffort || g.effort || null,
      source: 'dom_trigger'
    };
  }

  function buildInterceptorContext(channel, urlOrProcedure = '', contentType = '') {
    return {
      channel,
      urlOrProcedure,
      contentType,
      scopeMode: getContextScopeMode(),
      unifiedPreference: getContextUnifiedPreference(),
      contextPreferencesMap: contextPreferencesMap || (typeof window !== 'undefined' ? window.__AGContextPreferences : null) || {},
      knownConfigs: state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [],
      verifiedConversationBindings: budgetTracker?.verifiedConversationBindings || {},
      groupProduct: groupProductSafe,
      resolveStableModelId: resolveStableModelKeyClient,
      minTokens: CTX_MIN_ENGINEERING_TOKENS,
      maxTokens: CTX_MAX_ENGINEERING_TOKENS
    };
  }

  function recordBudgetTransformDispatch(txResult) {
    if (!txResult || !txResult.handled || !budgetTracker) return null;
    if (txResult.uninjectable) {
      const rec = budgetTracker.beginDispatch({
        cascadeId: txResult.cascadeId || null,
        productKey: txResult.productKey || null,
        modelId: txResult.modelId || null,
        scopeMode: txResult.scopeMode,
        targetMode: txResult.targetMode || 'default',
        targetLimitTokens: txResult.targetLimitTokens ?? null,
        sentMode: 'passthrough',
        sentLimitTokens: null,
        channel: txResult.channel || 'http',
        status: 'uninjectable',
        reason: txResult.reason || 'uninjectable'
      });
      refreshBudgetUiAfterDispatch();
      return rec;
    }

    const rec = budgetTracker.beginDispatch({
      cascadeId: txResult.cascadeId || null,
      productKey: txResult.productKey || null,
      productLabel: txResult.productLabel || null,
      modelId: txResult.modelId || null,
      scopeMode: txResult.scopeMode,
      prefSnapshot: {
        mode: txResult.targetMode || 'default',
        limitTokens: txResult.targetLimitTokens ?? null
      },
      targetMode: txResult.targetMode,
      targetLimitTokens: txResult.targetLimitTokens,
      sentMode: txResult.sentMode,
      sentLimitTokens: txResult.sentLimitTokens,
      channel: txResult.channel || 'http',
      status: 'dispatched'
    });
    if (txResult.targetMode === 'fixed' || txResult.targetMode === 'dynamic' || txResult.targetMode === 'default') {
      scheduleConfirmTimeoutCheck();
    }
    if (state.route && (!txResult.cascadeId || txResult.cascadeId === state.route)) {
      startLivePendingRequestWait(txResult.cascadeId || state.route);
    }
    refreshBudgetUiAfterDispatch();
    return rec;
  }

  function finishDispatchOutcome(dispatchId, ok, err) {
    if (!ok) {
      clearLivePendingRequestWait();
    }
    if (!dispatchId || !budgetTracker) return;
    if (!ok) {
      const errMsg = String(err?.message || err || '');
      const isAbort = err?.name === 'AbortError' || /abort|cancel/i.test(errMsg);
      budgetTracker.updateDispatchStatus(dispatchId, {
        status: isAbort ? 'aborted' : 'send_failed',
        errorMessage: errMsg || (isAbort ? '请求已取消' : '发送失败')
      });
      refreshBudgetUiAfterDispatch();
    }
  }

  function installRequestInterceptor() {
    if (typeof window === 'undefined') return;
    if (window.__agRequestInterceptorInstalled) return;

    // 0. 绑定主世界冷启动客户端装饰器回调（序列化前修改真实请求对象）
    globalThis.__AG_METER_ON_SEND_MESSAGE__ = function (req, channel = 'client_object') {
      try {
        if (!req || typeof req !== 'object' || typeof budgetEngine.transformOutgoingSendRequest !== 'function') return null;
        const tx = budgetEngine.transformOutgoingSendRequest(req, buildInterceptorContext(channel, 'SendUserCascadeMessage'));
        if (!tx || !tx.handled) return null;
        const rec = recordBudgetTransformDispatch(tx);
        lastDecoratorDispatchHint = {
          ts: Date.now(),
          cascadeId: tx.cascadeId || null,
          productKey: tx.productKey || null,
          sentMode: tx.sentMode,
          sentLimitTokens: tx.sentLimitTokens ?? null,
          dispatchId: rec?.dispatchId || null
        };
        return rec ? { dispatchId: rec.dispatchId } : null;
      } catch (err) {
        console.warn('[ContextMeter] Client decorator hook error:', err);
        return null;
      }
    };
    globalThis.__AG_METER_ON_SEND_RESULT__ = function (dispatchId, ok, err) {
      finishDispatchOutcome(dispatchId, ok, err);
    };

    const isCoveredByRecentDecorator = (tx) => {
      if (!lastDecoratorDispatchHint) return false;
      const age = Date.now() - lastDecoratorDispatchHint.ts;
      if (age < 0 || age > 400) return false;
      const sameConv = (lastDecoratorDispatchHint.cascadeId || null) === (tx.cascadeId || null);
      const sameMode = lastDecoratorDispatchHint.sentMode === tx.sentMode
        && (lastDecoratorDispatchHint.sentLimitTokens ?? null) === (tx.sentLimitTokens ?? null);
      return sameConv && sameMode;
    };

    // 1. WebSocket.prototype.send interceptor (覆盖 Lcc ws://<host>/connect-websocket JSON 帧)
    if (typeof window.WebSocket === 'function' && window.WebSocket.prototype && typeof window.WebSocket.prototype.send === 'function') {
      const origWsSend = window.WebSocket.prototype.send;
      window.__agOrigWsSend = origWsSend;
      window.WebSocket.prototype.send = function (data) {
        let nextData = data;
        let rec = null;
        try {
          if (typeof budgetEngine.transformOutgoingSendRequest === 'function') {
            const tx = budgetEngine.transformOutgoingSendRequest(data, buildInterceptorContext('ws_frame', this?.url || ''));
            if (tx && tx.handled) {
              if (tx.modified && tx.output !== undefined) {
                nextData = tx.output;
              }
              if (!isCoveredByRecentDecorator(tx)) {
                rec = recordBudgetTransformDispatch(tx);
              }
            }
          }
        } catch (err) {
          console.warn('[ContextMeter] WebSocket interceptor error:', err);
        }
        try {
          return origWsSend.call(this, nextData);
        } catch (wsErr) {
          if (rec) finishDispatchOutcome(rec.dispatchId, false, wsErr);
          throw wsErr;
        }
      };
    }

    // 2. window.fetch interceptor (仅处理 SendUserCascadeMessage；严禁猜测 StartCascade)
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.__agOrigFetch = origFetch;
      window.fetch = async function (resource, init) {
        let rec = null;
        try {
          const urlStr = typeof resource === 'string'
            ? resource
            : (resource && resource.url ? resource.url : String(resource || ''));
          if (typeof budgetEngine.isTargetBudgetRpc === 'function' && budgetEngine.isTargetBudgetRpc(urlStr) && init?.body) {
            const headersObj = init?.headers;
            let contentType = '';
            if (headersObj) {
              if (typeof headersObj.get === 'function') {
                contentType = headersObj.get('content-type') || headersObj.get('Content-Type') || '';
              } else if (typeof headersObj === 'object') {
                contentType = headersObj['content-type'] || headersObj['Content-Type'] || '';
              }
            }
            const tx = budgetEngine.transformOutgoingSendRequest(init.body, buildInterceptorContext('fetch', urlStr, contentType));
            if (tx && tx.handled) {
              if (tx.modified && tx.output !== undefined) {
                init = { ...init, body: tx.output };
              }
              if (!isCoveredByRecentDecorator(tx)) {
                rec = recordBudgetTransformDispatch(tx);
              }
            }
          }
        } catch (err) {
          console.warn('[ContextMeter] Fetch request interceptor error:', err);
        }
        try {
          const response = await origFetch.call(this, resource, init);
          if (rec && response && response.ok === false) {
            finishDispatchOutcome(rec.dispatchId, false, new Error(`HTTP ${response.status || 'error'}`));

          }
          return response;
        } catch (fetchErr) {
          if (rec) finishDispatchOutcome(rec.dispatchId, false, fetchErr);
          throw fetchErr;
        }
      };
    }

    // 3. window.XMLHttpRequest interceptor
    if (typeof window.XMLHttpRequest === 'function') {
      const origOpen = window.XMLHttpRequest.prototype.open;
      const origSetHdr = window.XMLHttpRequest.prototype.setRequestHeader;
      const origSend = window.XMLHttpRequest.prototype.send;
      window.__agOrigXhrOpen = origOpen;
      window.__agOrigXhrSetHdr = origSetHdr;
      window.__agOrigXhrSend = origSend;

      window.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        try {
          this.__agRequestUrl = typeof url === 'string' ? url : String(url || '');
          this.__agRequestHeaders = {};
        } catch { }
        return origOpen.call(this, method, url, ...rest);
      };

      if (typeof origSetHdr === 'function') {
        window.XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
          try {
            if (this.__agRequestHeaders && typeof name === 'string') {
              this.__agRequestHeaders[name.toLowerCase()] = String(value || '');
            }
          } catch { }
          return origSetHdr.call(this, name, value);
        };
      }

      window.XMLHttpRequest.prototype.send = function (body) {
        let rec = null;
        try {
          const urlStr = this.__agRequestUrl || '';
          if (body && typeof budgetEngine.isTargetBudgetRpc === 'function' && budgetEngine.isTargetBudgetRpc(urlStr)) {
            const contentType = this.__agRequestHeaders?.['content-type'] || '';
            const tx = budgetEngine.transformOutgoingSendRequest(body, buildInterceptorContext('xhr', urlStr, contentType));
            if (tx && tx.handled) {
              if (tx.modified && tx.output !== undefined) {
                body = tx.output;
              }
              if (!isCoveredByRecentDecorator(tx)) {
                rec = recordBudgetTransformDispatch(tx);
              }
            }
          }
        } catch (err) {
          console.warn('[ContextMeter] XHR request interceptor error:', err);
        }
        if (rec && typeof this.addEventListener === 'function') {
          const dId = rec.dispatchId;
          this.addEventListener('error', () => finishDispatchOutcome(dId, false, new Error('XHR network error')), { once: true });
          this.addEventListener('abort', () => finishDispatchOutcome(dId, false, Object.assign(new Error('XHR aborted'), { name: 'AbortError' })), { once: true });
          this.addEventListener('load', () => {
            if (typeof this.status === 'number' && this.status >= 400) {
              finishDispatchOutcome(dId, false, new Error(`HTTP ${this.status}`));
            }
          }, { once: true });
        }
        try {
          return origSend.call(this, body);
        } catch (xhrErr) {
          if (rec) finishDispatchOutcome(rec.dispatchId, false, xhrErr);
          throw xhrErr;
        }
      };
    }

    window.__agRequestInterceptorInstalled = true;
  }

  function uninstallRequestInterceptor() {
    if (typeof window === 'undefined') return;
    delete globalThis.__AG_METER_ON_SEND_MESSAGE__;
    delete globalThis.__AG_METER_ON_SEND_RESULT__;
    for (const tId of pendingConfirmTimers) clearTimeout(tId);
    pendingConfirmTimers.clear();
    if (window.__agOrigWsSend && window.WebSocket?.prototype) {
      window.WebSocket.prototype.send = window.__agOrigWsSend;
      delete window.__agOrigWsSend;
    }
    if (window.__agOrigFetch) {
      window.fetch = window.__agOrigFetch;
      delete window.__agOrigFetch;
    }
    if (window.__agOrigXhrOpen && window.XMLHttpRequest?.prototype) {
      window.XMLHttpRequest.prototype.open = window.__agOrigXhrOpen;
      delete window.__agOrigXhrOpen;
    }
    if (window.__agOrigXhrSetHdr && window.XMLHttpRequest?.prototype) {
      window.XMLHttpRequest.prototype.setRequestHeader = window.__agOrigXhrSetHdr;
      delete window.__agOrigXhrSetHdr;
    }
    if (window.__agOrigXhrSend && window.XMLHttpRequest?.prototype) {
      window.XMLHttpRequest.prototype.send = window.__agOrigXhrSend;
      delete window.__agOrigXhrSend;
    }
    window.__agRequestInterceptorInstalled = false;
  }

  function resolveRuntimeUnlockPolicyClient() {
    if (typeof budgetEngine.resolveRuntimeUnlockPolicy === 'function') {
      return budgetEngine.resolveRuntimeUnlockPolicy(currentUnlockStatus);
    }
    return null;
  }

  function formatDiskPolicyText(policy) {
    if (!policy) return '未知';
    if (policy.diskMode === 'dynamic') return 'Dynamic 动态跟随';
    if (policy.diskMode === 'fixed' && policy.diskLimitTokens) return `固定 ${fmt(policy.diskLimitTokens)} tokens`;
    if (policy.diskMode === 'default') return '默认 256,000 tokens';
    if (policy.diskMode === 'partial') return '部分异常';
    return '未知';
  }

  function getProductCapabilitySummary(product) {
    if (!product) return null;
    if (typeof budgetEngine.deriveModelCapabilitySummary === 'function') {
      return budgetEngine.deriveModelCapabilitySummary(product, currentUnlockStatus, state.modelCapabilitiesById || null);
    }
    return null;
  }

  let modelCapabilitiesVersion = 1;

  function mergeCapabilitiesMapClient(incomingMap) {
    if (!incomingMap || typeof incomingMap !== 'object') return;
    if (!state.modelCapabilitiesById || typeof state.modelCapabilitiesById !== 'object') {
      state.modelCapabilitiesById = {};
    }
    let updated = false;
    for (const [rawKey, rawVal] of Object.entries(incomingMap)) {
      if (!rawVal || typeof rawVal !== 'object') continue;
      const k = String(rawKey).trim().toLowerCase().replace(/^model_/, '');
      if (!k) continue;
      state.modelCapabilitiesById[k] = {
        ...(state.modelCapabilitiesById[k] || {}),
        ...rawVal
      };
      updated = true;
    }
    if (updated) modelCapabilitiesVersion++;
  }

  function validateCustomLimitClient(rawInput, modeOverride = ctxDraft.mode, productOverride = null) {
    if (modeOverride === 'dynamic') {
      return { ok: true, mode: 'dynamic', limitTokens: null, warnings: [] };
    }
    if (modeOverride === 'default') {
      return { ok: true, mode: 'default', limitTokens: CTX_DEFAULT_TOKENS, warnings: [] };
    }
    const targetProd = productOverride || (contextScopeMode === 'per_model' ? getSelectedProductObj() : null);
    const capSummary = targetProd ? getProductCapabilitySummary(targetProd) : null;
    if (modeOverride === 'model_max') {
      if (contextScopeMode === 'unified') {
        return { ok: false, error: '统一模式下各模型容量不同，请改为具体整数或切回“按模型分别设置”后选择最大可用。' };
      }
      if (!capSummary || capSummary.modelTheoreticalMaxTokens == null) {
        return { ok: false, error: '尚未获取到当前模型的上下文窗口与最大输出元数据，暂无法自动计算最大可用预算。' };
      }
      if (!capSummary.runtimePolicy?.policyKnown || capSummary.maxAdjustableTokens == null) {
        return {
          ok: false,
          error: `当前客户端运行策略未知或待重启确认，暂无法计算当前环境最大可用上限（模型理论输入上限 ${fmt(capSummary.modelTheoreticalMaxTokens)} tokens）。`
        };
      }
      rawInput = capSummary.maxAdjustableTokens;
    }

    if (typeof budgetEngine.evaluateLimitInput === 'function') {
      const ev = budgetEngine.evaluateLimitInput(rawInput, capSummary, currentUnlockStatus, state.latest?.serviceLimit);
      if (!ev.ok) {
        if (ev.reasonCode === 'out_of_engineering_range') {
          return {
            ok: false,
            error: t('models.validation.outOfRange', { min: fmt(CTX_MIN_ENGINEERING_TOKENS), max: fmt(CTX_MAX_ENGINEERING_TOKENS) })
          };
        }
        return { ok: false, error: t('models.custom.placeholder') };
      }
      const warnings = [];
      for (const w of ev.warnings) {
        if (w.code === 'exceeds_model_limit') {
          if (w.adoptableTokens != null) {
            warnings.push(`超出当前模型理论输入上限 ${fmt(w.maxAllowed)} tokens（依据元数据：总窗口 - 最大输出）；若仍保存 ${fmt(w.limitTokens)}，当前环境预计最高仅可采用 ${fmt(w.adoptableTokens)} tokens。`);
          } else {
            warnings.push(`超出当前模型理论输入上限 ${fmt(w.maxAllowed)} tokens（依据元数据：总窗口 - 最大输出）；当前客户端运行策略未确认，实际可采用上限未知。`);
          }
        } else if (w.code === 'requires_dynamic_unlock') {
          const cap = w.stockCap || 256000;
          warnings.push(`目标 ${fmt(w.limitTokens)} 超过当前默认限制 ${fmt(cap)}：未开启 Dynamic 动态模式且未实机证实前，语言服务仍可能将其限制在 ${fmt(cap)} tokens（请点击“保存并应用”）。`);
        } else if (w.code === 'exceeds_fixed_client_limit') {
          warnings.push(`目标 ${fmt(w.limitTokens)} 超过当前客户端固定限制 ${fmt(w.fixedCap)} tokens：未调整为更高固定值或启用 Dynamic 动态模式前，预计仍将被限制在 ${fmt(w.fixedCap)} tokens。`);
        } else if (w.code === 'unconfirmed_runtime_policy') {
          if (w.runtimeState === 'pending_restart') {
            warnings.push(`磁盘配置（${formatDiskPolicyText({ diskMode: w.diskMode, diskLimitTokens: w.diskLimitTokens })}）已变更但客户端尚未重启，运行中实际策略待确认，无法预测 ${fmt(w.limitTokens)} 是否会被采用。`);
          } else if (w.runtimeState === 'runtime_unconfirmed') {
            warnings.push(`仅读取到磁盘配置，尚未确认运行中进程已加载该策略；${fmt(w.limitTokens)} 实际能否采用需等待进程验证或实机请求确认。`);
          } else if (w.runtimeState === 'partial') {
            warnings.push(`检测到客户端处于部分异常状态，运行限制未知，无法预测 ${fmt(w.limitTokens)} 的实际采用结果。`);
          } else {
            warnings.push(`当前客户端运行策略未知，暂无法预测 ${fmt(w.limitTokens)} 在本机的实际采用上限（需先读取运行策略或实机发送验证）。`);
          }
        } else if (w.code === 'exceeds_service_limit') {
          warnings.push(t('models.validation.aboveService', { val: formatKShort(w.serviceLimit) }));
        } else if (w.code === 'below_recommended_floor') {
          warnings.push(t('models.validation.tooSmall', { val: fmt(w.limitTokens) }));
        }
      }
      return {
        ok: true,
        mode: 'fixed',
        limitTokens: ev.limitTokens,
        exceedsModelLimit: ev.exceedsModelLimit,
        exceedsClientPolicy: ev.exceedsClientPolicy,
        clientPolicyLimit: ev.clientPolicyLimit,
        runtimeState: ev.runtimeState,
        policyKnown: ev.policyKnown,
        adoptableTokens: ev.adoptableTokens,
        requiresDynamicUnlock: ev.requiresDynamicUnlock,
        warnings
      };
    }

    const rawStr = typeof rawInput === 'number' ? String(rawInput) : String(rawInput || '').trim().replace(/[,\s_]/g, '');
    if (!/^\d+$/.test(rawStr)) {
      return { ok: false, error: t('models.custom.placeholder') };
    }
    const num = Number(rawStr);
    if (!Number.isSafeInteger(num) || num <= 0) {
      return { ok: false, error: t('models.custom.placeholder') };
    }
    if (num < CTX_MIN_ENGINEERING_TOKENS || num > CTX_MAX_ENGINEERING_TOKENS) {
      return {
        ok: false,
        error: t('models.validation.outOfRange', { min: fmt(CTX_MIN_ENGINEERING_TOKENS), max: fmt(CTX_MAX_ENGINEERING_TOKENS) })
      };
    }
    const warnings = [];
    if (num < 65536) {
      warnings.push(t('models.validation.tooSmall', { val: fmt(num) }));
    }
    const sLimit = Number(state.latest?.serviceLimit || 0);
    if (sLimit > 0 && num > sLimit) {
      warnings.push(t('models.validation.aboveService', { val: formatKShort(sLimit) }));
    }
    return { ok: true, mode: 'fixed', limitTokens: num, warnings };
  }

  let cachedKnownProductsSnapshot = null;

  /** 将所有已知模型、当前会话和历史调用按产品维度分组（带签名缓存与调用模型去重，避免每次渲染重复全量分组） */
  function getKnownModelProducts() {
    const configs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
    const speedRecords = ANTIGRAVITY_TOKEN_DATA.speedRecords || [];
    const sessionCalls = state.sessionCalls || [];
    const latest = state.latest || null;
    const capsMap = state.modelCapabilitiesById || null;
    const prefsMap = contextPreferencesMap || {};

    let configsSig = '';
    if (Array.isArray(configs) && configs.length) {
      for (let i = 0; i < configs.length; i++) {
        const c = configs[i];
        configsSig += `${c?.modelId || c?.modelOrAlias?.model || ''}:${c?.maxTokens ?? ''}:${c?.maxOutputTokens ?? ''}:${c?.disabled ? 1 : 0}:${c?.unavailable ? 1 : 0}:${c?.isHistorical ? 1 : 0}:${c?.capabilitySource || ''};`;
      }
    }
    let prefsSig = '';
    for (const k of Object.keys(prefsMap)) {
      const p = prefsMap[k];
      prefsSig += `${k}:${p?.scope || ''}:${p?.productKey || ''}:${p?.label || ''};`;
    }
    const latestSig = latest ? `${latest.modelId || ''}|${latest.modelRaw || ''}|${latest.model || ''}|${latest.effort || ''}` : '';
    const capsLen = capsMap ? Object.keys(capsMap).length : 0;
    const speedLen = Array.isArray(speedRecords) ? speedRecords.length : 0;
    const sessLen = Array.isArray(sessionCalls) ? sessionCalls.length : 0;
    const speedEdge = speedLen ? `${speedRecords[0]?.modelExactId || speedRecords[0]?.model || ''}|${speedRecords[speedLen - 1]?.callId || speedRecords[speedLen - 1]?.modelExactId || ''}` : '';
    const sessEdge = sessLen ? `${sessionCalls[0]?.modelExactId || sessionCalls[0]?.model || ''}|${sessionCalls[sessLen - 1]?.callId || sessionCalls[sessLen - 1]?.model || ''}` : '';

    if (
      cachedKnownProductsSnapshot
      && cachedKnownProductsSnapshot.configsRef === configs
      && cachedKnownProductsSnapshot.configsSig === configsSig
      && cachedKnownProductsSnapshot.speedRef === speedRecords
      && cachedKnownProductsSnapshot.speedLen === speedLen
      && cachedKnownProductsSnapshot.speedEdge === speedEdge
      && cachedKnownProductsSnapshot.sessRef === sessionCalls
      && cachedKnownProductsSnapshot.sessLen === sessLen
      && cachedKnownProductsSnapshot.sessEdge === sessEdge
      && cachedKnownProductsSnapshot.latestSig === latestSig
      && cachedKnownProductsSnapshot.prefsSig === prefsSig
      && cachedKnownProductsSnapshot.capsVer === modelCapabilitiesVersion
      && cachedKnownProductsSnapshot.capsLen === capsLen
    ) {
      return cachedKnownProductsSnapshot.result.map(p => ({ ...p, members: p.members.slice() }));
    }

    const productMap = new Map();
    const slugToKey = new Map();
    const ensureProduct = (meta, fromAccountCatalog = false) => {
      const g = groupProductSafe(meta);
      if (!g.productKey) return null;
      const keyParts = g.productKey.split(':');
      const keySlug = keyParts.length >= 3 ? keyParts.slice(2).join(':') : '';
      let targetKey = g.productKey;
      // 若同一产品 slug 在列表里既有明确厂商又有"其他"厂商，合并到明确厂商条目下（不合并不同前缀或代际）
      if (keySlug && !productMap.has(targetKey) && slugToKey.has(keySlug)) {
        const existingKey = slugToKey.get(keySlug);
        const existingProd = productMap.get(existingKey);
        if (existingProd && (g.vendor === '其他' || existingProd.vendor === '其他')) {
          if (existingProd.vendor === '其他' && g.vendor !== '其他') {
            productMap.delete(existingKey);
            existingProd.productKey = targetKey;
            existingProd.vendor = g.vendor;
            productMap.set(targetKey, existingProd);
            slugToKey.set(keySlug, targetKey);
          } else {
            targetKey = existingKey;
          }
        }
      }
      let prod = productMap.get(targetKey);
      if (!prod) {
        prod = {
          productKey: targetKey,
          productLabel: g.productLabel,
          vendor: g.vendor || '其他',
          inAccountCatalog: Boolean(fromAccountCatalog),
          unavailable: Boolean(meta.unavailable),
          unavailabilityReason: meta.unavailabilityReason || null,
          notice: meta.notice || null,
          isHistorical: Boolean(meta.isHistorical),
          members: new Map()
        };
        productMap.set(targetKey, prod);
        if (keySlug && (!slugToKey.has(keySlug) || g.vendor !== '其他')) {
          slugToKey.set(keySlug, targetKey);
        }
      } else if (fromAccountCatalog) {
        prod.inAccountCatalog = true;
        if (meta.notice && !prod.notice) prod.notice = meta.notice;
        if (meta.isHistorical !== undefined) prod.isHistorical = prod.isHistorical && Boolean(meta.isHistorical);
      }
      if (meta.modelId) {
        const mid = String(meta.modelId).trim().toLowerCase();
        const prev = prod.members.get(mid);
        const capEntry = state.modelCapabilitiesById?.[mid.replace(/^model_/, '')]
          || state.modelCapabilitiesById?.[String(meta.modelOrAlias?.model || '').trim().toLowerCase().replace(/^model_/, '')]
          || null;
        prod.members.set(mid, {
          modelId: mid,
          label: meta.label || prev?.label || mid,
          effort: g.effort || prev?.effort || null,
          maxTokens: meta.maxTokens ?? capEntry?.maxTokens ?? prev?.maxTokens ?? null,
          maxOutputTokens: meta.maxOutputTokens ?? capEntry?.maxOutputTokens ?? prev?.maxOutputTokens ?? null,
          thinkingBudget: meta.thinkingBudget ?? capEntry?.thinkingBudget ?? prev?.thinkingBudget ?? null,
          minThinkingBudget: meta.minThinkingBudget ?? capEntry?.minThinkingBudget ?? prev?.minThinkingBudget ?? null,
          thinkingLevel: meta.thinkingLevel || capEntry?.thinkingLevel || prev?.thinkingLevel || null,
          supportsModelInfoOverride: meta.supportsModelInfoOverride ?? capEntry?.supportsModelInfoOverride ?? prev?.supportsModelInfoOverride ?? null,
          capabilitySource: meta.capabilitySource || capEntry?.capabilitySource || prev?.capabilitySource || null,
          unavailable: meta.unavailable !== undefined ? Boolean(meta.unavailable) : (prev?.unavailable || false),
          unavailabilityReason: meta.unavailabilityReason || prev?.unavailabilityReason || null,
          notice: meta.notice || prev?.notice || null,
          isHistorical: meta.isHistorical !== undefined ? Boolean(meta.isHistorical) : (prev?.isHistorical || false)
        });
      }
      return prod;
    };

    if (Array.isArray(configs)) {
      for (const c of configs) {
        const stableId = resolveStableModelKeyClient(c) || c?.modelId || c?.modelOrAlias?.model;
        ensureProduct({
          modelId: stableId,
          label: c?.label || c?.modelId || stableId,
          modelOrAlias: c?.modelOrAlias,
          effort: c?.effort,
          maxTokens: c?.maxTokens,
          maxOutputTokens: c?.maxOutputTokens,
          thinkingBudget: c?.thinkingBudget,
          minThinkingBudget: c?.minThinkingBudget,
          thinkingLevel: c?.thinkingLevel,
          supportsModelInfoOverride: c?.supportsModelInfoOverride,
          capabilitySource: c?.capabilitySource,
          unavailable: Boolean(c?.unavailable || c?.disabled),
          unavailabilityReason: c?.unavailabilityReason || c?.tagDescription || null,
          notice: c?.notice,
          isHistorical: c?.isHistorical
        }, true);
      }
    }

    if (latest?.modelId || latest?.modelRaw || latest?.model) {
      const stableId = resolveStableModelKeyClient(latest);
      ensureProduct({
        modelId: stableId,
        label: latest.model || stableId,
        modelOrAlias: latest.modelOrAlias,
        effort: latest.effort
      }, false);
    }

    // 先按 (modelId, label, effort) 去重，避免成百上千条同模型历史/会话调用重复执行产品分组
    const seenCallModels = new Set();
    const processCallList = (list) => {
      if (!Array.isArray(list)) return;
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (!c) continue;
        const mid = c.modelExactId || c.modelId || c.model;
        if (!mid) continue;
        const lbl = c.modelLabel || c.model || mid;
        const eff = c.effort || '';
        const sig = `${mid}\0${lbl}\0${eff}`;
        if (seenCallModels.has(sig)) continue;
        seenCallModels.add(sig);
        ensureProduct({
          modelId: mid,
          label: lbl,
          effort: eff || undefined
        }, false);
      }
    };
    processCallList(speedRecords);
    processCallList(sessionCalls);

    for (const [k, pref] of Object.entries(prefsMap)) {
      if (!pref) continue;
      const g = groupProductSafe({
        modelId: pref.productKey || k,
        label: pref.label || k
      });
      if (pref.scope === 'product' || k === g.productKey) {
        ensureProduct({
          modelId: pref.productKey || k,
          label: pref.label || g.productLabel
        }, false);
      } else {
        ensureProduct({
          modelId: k,
          label: pref.label || k
        }, false);
      }
    }

    const rankEffort = { Minimal: 1, Low: 2, Medium: 3, High: 4, XHigh: 5, Extra: 6, 'Extra High': 7, Max: 8 };
    const result = Array.from(productMap.values()).map(p => {
      const members = Array.from(p.members.values()).sort((a, b) => (rankEffort[a.effort] || 99) - (rankEffort[b.effort] || 99));
      const allUnavailable = members.length > 0 && members.every(m => m.unavailable);
      const partialUnavailable = members.length > 0 && !allUnavailable && members.some(m => m.unavailable);
      const isUnavailable = members.length > 0 ? allUnavailable : Boolean(p.unavailable);
      const isHistorical = members.length > 0 ? (members.every(m => m.isHistorical) || !p.inAccountCatalog) : (p.isHistorical || (!p.inAccountCatalog));
      const notice = p.notice || members.find(m => m.notice)?.notice || null;
      const reason = isUnavailable
        ? (p.unavailabilityReason || members.find(m => m.unavailable && m.unavailabilityReason)?.unavailabilityReason || null)
        : (partialUnavailable ? (members.find(m => m.unavailable && m.unavailabilityReason)?.unavailabilityReason || null) : null);
      return {
        productKey: p.productKey,
        productLabel: p.productLabel,
        vendor: p.vendor,
        inAccountCatalog: p.inAccountCatalog,
        unavailable: isUnavailable,
        partialUnavailable,
        unavailabilityReason: reason,
        notice,
        isHistorical,
        members
      };
    });
    result.sort((a, b) => {
      const va = VENDOR_ORDER.indexOf(a.vendor);
      const vb = VENDOR_ORDER.indexOf(b.vendor);
      if (va !== vb) return (va === -1 ? 99 : va) - (vb === -1 ? 99 : vb);
      return a.productLabel.localeCompare(b.productLabel);
    });

    cachedKnownProductsSnapshot = {
      configsRef: configs,
      configsSig,
      speedRef: speedRecords,
      speedLen,
      speedEdge,
      sessRef: sessionCalls,
      sessLen,
      sessEdge,
      latestSig,
      prefsSig,
      capsVer: modelCapabilitiesVersion,
      capsLen,
      result
    };
    return result.map(p => ({ ...p, members: p.members.slice() }));
  }

  function formatSavedPrefLabel(pref) {
    if (!pref || pref.mode === 'default') return t('status.savedDefault');
    if (pref.mode === 'dynamic') return t('models.preset.dynamic');
    if (pref.mode === 'fixed' && pref.limitTokens) {
      const num = Number(pref.limitTokens);
      if (num === 512000) return '512K';
      return t('models.card.savedCustom', { val: `${formatKShort(num)}（${fmt(num)}）` });
    }
    return t('status.savedDefault');
  }

  function formatPrefShortPill(pref) {
    if (!pref || pref.mode === 'default') return t('status.savedShortDefault');
    if (pref.mode === 'dynamic') return t('models.preset.dynamic');
    if (pref.mode === 'fixed' && pref.limitTokens) return formatKShort(pref.limitTokens);
    return t('status.savedShortDefault');
  }

  /** 解析当前产品的设置状态与旧档位迁移/冲突检测 */
  function resolveProductPreferenceState(product) {
    if (!product) {
      return { status: 'none', pref: null, displayText: t('status.savedDefault'), shortText: t('status.savedShortDefault'), legacyKeys: [], conflictEntries: [] };
    }
    const pKey = product.productKey;
    const direct = contextPreferencesMap?.[pKey];
    if (direct && (direct.scope === 'product' || (direct.productKey && direct.productKey === pKey))) {
      return {
        status: 'product',
        pref: direct,
        displayText: formatSavedPrefLabel(direct),
        shortText: formatPrefShortPill(direct),
        legacyKeys: [],
        conflictEntries: []
      };
    }

    const legacyEntries = [];
    const seenKeys = new Set();
    const memberIds = new Set((product.members || []).map(m => m.modelId));
    for (const [k, rawPref] of Object.entries(contextPreferencesMap || {})) {
      if (!rawPref) continue;
      if (k === pKey && rawPref.scope === 'product') continue;
      const belonged = memberIds.has(k) || groupProductSafe({ modelId: k, label: rawPref.label || k }).productKey === pKey;
      if (!belonged) continue;
      if (seenKeys.has(k)) continue;
      seenKeys.add(k);
      const memberMeta = (product.members || []).find(m => m.modelId === k);
      const effortName = memberMeta?.effort || groupProductSafe({ modelId: k, label: rawPref.label || k }).effort;
      legacyEntries.push({
        legacyKey: k,
        effort: effortName,
        effortLabel: effortName ? formatEffortZh(effortName) : (rawPref.label || k),
        mode: rawPref.mode || 'default',
        limitTokens: rawPref.mode === 'fixed' ? Number(rawPref.limitTokens) : null,
        updatedAt: rawPref.updatedAt || null,
        label: rawPref.label || product.productLabel
      });
    }

    if (legacyEntries.length === 0) {
      if (direct) {
        return {
          status: 'product',
          pref: direct,
          displayText: formatSavedPrefLabel(direct),
          shortText: formatPrefShortPill(direct),
          legacyKeys: [],
          conflictEntries: []
        };
      }
      return { status: 'none', pref: null, displayText: t('models.pref.none'), shortText: t('models.pref.noneShort'), legacyKeys: [], conflictEntries: [] };
    }

    const sigs = new Map();
    for (const entry of legacyEntries) {
      const sig = `${entry.mode}:${entry.mode === 'fixed' ? (entry.limitTokens || 0) : ''}`;
      if (!sigs.has(sig)) sigs.set(sig, entry);
    }

    if (sigs.size === 1) {
      const unified = legacyEntries[0];
      const syntheticPref = {
        scope: 'product',
        productKey: pKey,
        modelId: pKey,
        label: product.productLabel,
        mode: unified.mode,
        limitTokens: unified.limitTokens,
        updatedAt: unified.updatedAt
      };
      return {
        status: 'legacy_uniform',
        pref: syntheticPref,
        displayText: formatSavedPrefLabel(syntheticPref),
        shortText: formatPrefShortPill(syntheticPref),
        legacyKeys: legacyEntries.map(e => e.legacyKey),
        conflictEntries: []
      };
    }

    return {
      status: 'conflict',
      pref: null,
      displayText: t('models.pref.inconsistent'),
      shortText: t('models.pref.inconsistent'),
      legacyKeys: legacyEntries.map(e => e.legacyKey),
      conflictEntries: legacyEntries
    };
  }

  function describeClientModeValue(data) {
    if (!data) return t('models.preset.default');
    if (data.configuredMode === 'dynamic') return t('models.preset.dynamic');
    if (data.configuredMode === 'fixed' && data.configuredLimitTokens) {
      return formatKShort(data.configuredLimitTokens);
    }
    return t('models.preset.default');
  }

  function doesClientMatchVerification(data, ver) {
    if (!data || !ver) return false;
    const mode = data.configuredMode || 'unknown';
    if (ver.mode === 'dynamic') return mode === 'dynamic';
    if (ver.mode === 'default') return mode === 'default' || data.status === 'not_patched';
    if (ver.mode === 'fixed') return mode === 'fixed' && Number(data.configuredLimitTokens) === Number(ver.limitTokens);
    return false;
  }

  /** 将状态 strictly 映射为规定的 5 个普通视图标签之一 */
  function mapUnlockDisplayStatus(data) {
    if (unlockStatusFetchError) {
      return { badge: t('status.badge.unavailable'), pillClass: 'pill-danger', effectiveLoaded: false };
    }
    if (!data) {
      return { badge: t('status.badge.reading'), pillClass: 'pill-muted', effectiveLoaded: false };
    }
    const raw = data.status;
    const restarted = data.runtimeEvidence?.restartDetected === true;

    if (raw === 'patched_pending_restart') {
      return { badge: t('status.badge.pendingRestart'), pillClass: 'pill-warn', effectiveLoaded: false };
    }
    if (raw === 'not_patched') {
      return { badge: t('status.badge.notPatched'), pillClass: 'pill-muted', effectiveLoaded: false };
    }
    if (raw === 'patched_loaded') {
      if (!restarted) {
        return { badge: t('status.badge.unconfirmed'), pillClass: 'pill-info', effectiveLoaded: false };
      }
      if ((pendingRestartVerification && !doesClientMatchVerification(data, pendingRestartVerification)) || restartMismatchNotice) {
        return { badge: t('status.badge.unconfirmed'), pillClass: 'pill-warn', effectiveLoaded: false };
      }
      return { badge: t('status.badge.loaded'), pillClass: 'pill-ok', effectiveLoaded: true };
    }
    if (raw === 'patched_runtime_unconfirmed') {
      return { badge: t('status.badge.unconfirmed'), pillClass: 'pill-info', effectiveLoaded: false };
    }
    if (raw === 'partial_match') {
      return { badge: t('status.badge.partialMatch'), pillClass: 'pill-danger', effectiveLoaded: false };
    }
    return { badge: t('status.badge.failed'), pillClass: 'pill-danger', effectiveLoaded: false };
  }

  function buildFriendlyWriteError(rawErr) {
    const msg = String(rawErr || '');
    if (/EBUSY|EPERM|EACCES|占用|lock|locked|in use/i.test(msg)) {
      return t('msg.writeBusy');
    }
    return t('msg.writeFail', { err: translateBackendText(msg) || t('msg.unknownErr') });
  }

  function applyContextViewVisibility() {
    if (ctxTabsBar) ctxTabsBar.hidden = false;
    if (paneSettings) paneSettings.hidden = activeContextTab !== 'settings';
    if (paneSession) paneSession.hidden = activeContextTab !== 'session';
    if (paneModels) paneModels.hidden = activeContextTab !== 'models';
    if (paneSpeed) paneSpeed.hidden = activeContextTab !== 'speed';

    setPillActive(btnTabSession, activeContextTab === 'session');
    setPillActive(btnTabModels, activeContextTab === 'models');
    setPillActive(btnTabSpeed, activeContextTab === 'speed');
    setPillActive(btnTabSettings, activeContextTab === 'settings');
    btnTabSession?.setAttribute('aria-selected', String(activeContextTab === 'session'));
    btnTabModels?.setAttribute('aria-selected', String(activeContextTab === 'models'));
    btnTabSpeed?.setAttribute('aria-selected', String(activeContextTab === 'speed'));
    btnTabSettings?.setAttribute('aria-selected', String(activeContextTab === 'settings'));
  }

  let prevTabBeforeSettings = 'models';

  function switchContextTab(tabName) {
    if (tabName !== 'session' && tabName !== 'models' && tabName !== 'speed' && tabName !== 'settings') return;
    if (activeContextTab !== 'settings') {
      prevTabBeforeSettings = activeContextTab;
    }
    activeContextTab = tabName;
    isContextSettingsView = tabName === 'settings';
    try { localStorage?.setItem(CTX_ACTIVE_TAB_KEY, tabName); } catch { }
    applyContextViewVisibility();
    if (tabName === 'models') {
      renderModelSettingsTab();
      if (!currentUnlockStatus && !unlockStatusFetchError) {
        void refreshUnlockStatus();
      }
    } else if (tabName === 'speed') {
      // 速度对比页只读取已有本地记录，绝不发起任何请求或 IPC
      renderSpeedComparisonTab();
    } else if (tabName === 'settings') {
      void refreshModulesDisplay();
      if (!currentUnlockStatus && !unlockStatusFetchError && typeof refreshUnlockStatus === 'function') {
        void refreshUnlockStatus();
      }
      if (typeof refreshEnhanceStatus === 'function') void refreshEnhanceStatus();
    }
    positionFloatingPanels();
  }

  function openContextSettings(opts = {}) {
    if (el('panel')?.hidden) showPanel('context');
    switchContextTab('settings');
    if (opts.openColors) {
      toggleColorsDrawer(true);
    }
    positionFloatingPanels();
  }

  function closeContextSettings() {
    switchContextTab(prevTabBeforeSettings || 'models');
    positionFloatingPanels();
  }

  btnTabSession?.addEventListener('click', () => switchContextTab('session'));
  btnTabModels?.addEventListener('click', () => switchContextTab('models'));
  btnTabSpeed?.addEventListener('click', () => switchContextTab('speed'));
  btnTabSettings?.addEventListener('click', () => switchContextTab('settings'));
  btnCtxSettings?.addEventListener('click', () => switchContextTab('settings'));
  btnCtxSettingsBack?.addEventListener('click', () => closeContextSettings());

  btnGotoModelSettings?.addEventListener('click', () => {
    if (activeSessionProductKey) {
      selectedProductKey = activeSessionProductKey;
      selectedEditModelKey = activeSessionModelKey || activeSessionProductKey;
      manualModelSelection = false;
      ctxDraftDirty = false;
    }
    switchContextTab('models');
  });

  btnCardGotoSpeed?.addEventListener('click', () => {
    const products = getKnownModelProducts();
    const curProd = products.find(p => p.productKey === selectedProductKey) || products[0];
    if (curProd) {
      const mergedCalls = mergeAvailableSpeedCalls();
      const targetMember = curProd.members.find(m => m.modelId === activeSessionModelKey)
        || curProd.members.find(m => mergedCalls.some(c => c.modelExactId === m.modelId && isValidSpeedSampleSafe(c)))
        || curProd.members[0];
      if (targetMember) selectedSpeedExactModelId = targetMember.modelId;
    }
    switchContextTab('speed');
  });

  btnCtxBackCurrent?.addEventListener('click', () => {
    const hostSelected = extractHostSelectedModel();
    if (hostSelected && hostSelected.productKey) {
      activeSessionModelKey = hostSelected.modelId;
      activeSessionProductKey = hostSelected.productKey;
      activeSessionEffort = hostSelected.effort;
      activeSessionModelConfirmed = true;
    } else if (activeSessionProductKey) {
      const curProd = getKnownModelProducts().find(p => p.productKey === activeSessionProductKey);
      if (curProd && curProd.isHistorical) {
        activeSessionModelConfirmed = false;
        activeSessionProductKey = null;
        activeSessionModelKey = null;
      }
    }
    if (!activeSessionModelConfirmed || !activeSessionProductKey) {
      if (typeof showToastNotification === 'function') {
        showToastNotification(t('panel.ctx.currentModelUnconfirmed') || '当前会话模型待确认，未获取到可靠选择');
      } else {
        showUnlockResultBox(false, t('panel.ctx.currentModelUnconfirmed') || '当前会话模型待确认，未获取到可靠选择');
      }
      return;
    }
    manualModelSelection = false;
    selectedProductKey = activeSessionProductKey;
    selectedEditModelKey = activeSessionModelKey || activeSessionProductKey;
    ctxDraftDirty = false;
    loadDraftFromSelectedModel(true);
    renderHeaderModelDropdown();
    renderModelSettingsTab();
  });

  function toggleUnlockDrawer(forceOpen) {
    if (!unlockDrawerBody) return;
    const isHidden = unlockDrawerBody.style.display === 'none' || !unlockDrawerBody.style.display;
    const nextOpen = forceOpen === undefined ? isHidden : Boolean(forceOpen);
    unlockDrawerBody.style.display = nextOpen ? 'block' : 'none';
    if (unlockDrawerArrow) unlockDrawerArrow.textContent = nextOpen ? t('drawer.shortCollapse') : t('drawer.shortExpand');
    btnToggleUnlockDetails?.setAttribute('aria-expanded', String(nextOpen));
    if (nextOpen && !currentUnlockStatus) void refreshUnlockStatus();
  }

  btnToggleUnlockDetails?.addEventListener('click', () => toggleUnlockDrawer());

  function getSelectedProductObj() {
    const products = getKnownModelProducts();
    if (!products.length) return null;
    if (selectedProductKey) {
      const found = products.find(p => p.productKey === selectedProductKey);
      if (found) return found;
    }
    if (activeSessionProductKey) {
      const activeFound = products.find(p => p.productKey === activeSessionProductKey);
      if (activeFound) return activeFound;
    }
    return products[0];
  }

  const MINI_QUOTA_RING_RADIUS = 5.5;
  const MINI_QUOTA_RING_CIRC = 2 * Math.PI * MINI_QUOTA_RING_RADIUS;
  const modelListChipByProductKey = new Map();
  let lastModelQuotaSyncSig = '';
  let quotaStateInitialized = false;

  /**
   * 安全获取额度视图（防止初始化阶段提前触发时出现 TDZ 异常）。
   */
  function getSafeQuotaViewForModelList(nowMs = Date.now()) {
    if (!quotaStateInitialized || typeof computeEffectiveQuotaView !== 'function') return null;
    try {
      return computeEffectiveQuotaView(nowMs);
    } catch {
      return null;
    }
  }

  /**
   * 兼容浏览器与精简测试环境的 SVG 节点创建函数。
   */
  function createQuotaSvgEl(tag) {
    if (typeof document === 'undefined') return null;
    if (typeof document.createElementNS === 'function') {
      return document.createElementNS('http://www.w3.org/2000/svg', tag);
    }
    return typeof document.createElement === 'function' ? document.createElement(tag) : null;
  }


  /**
   * 将模型产品对象映射到共享额度池并生成小圆环展示摘要。
   */
  function resolveProductQuotaSummary(product, quotaView = null, nowMs = Date.now()) {
    const core = typeof __AGContextMeterCore !== 'undefined'
      ? __AGContextMeterCore
      : (globalThis.__AGContextMeterCore || null);
    const view = quotaView || getSafeQuotaViewForModelList(nowMs);
    const unknownText = t('quota.short.unknown');
    if (!product) {
      return {
        status: 'unknown',
        statusLabel: getQuotaStatusLabelText('unknown'),
        shortText: unknownText,
        fraction: null,
        poolKey: '',
        poolTitle: '',
        tooltip: '',
        ariaLabel: unknownText
      };
    }

    const pools = Array.isArray(view?.pools) ? view.pools : [];
    const membersList = Array.isArray(product.members)
      ? product.members
      : Array.from(product.members?.values?.() || []);
    const candidateIds = new Set();
    const candidateLabels = new Set();
    const pKeyLower = String(product.productKey || '').trim().toLowerCase();
    const pLabelLower = String(product.productLabel || '').trim().toLowerCase();
    if (pLabelLower) candidateLabels.add(pLabelLower);
    for (const m of membersList) {
      if (m?.modelId) candidateIds.add(String(m.modelId).trim().toLowerCase());
      if (m?.label) candidateLabels.add(String(m.label).trim().toLowerCase());
    }

    let matchedPool = null;
    let matchedModel = null;
    const isHistoryOnly = Boolean(product.isHistorical || !product.inAccountCatalog);

    // 1. 优先通过 productKey / modelIds / aliases 精确命中账号额度池模型（仅历史记录模型不借用当前活跃额度池）
    if (!isHistoryOnly) {
      for (const pool of pools) {
        for (const m of (pool.models || [])) {
          const mProdKey = String(m.productKey || '').trim().toLowerCase();
          const mLabel = String(m.productLabel || '').trim().toLowerCase();
          const mIds = Array.isArray(m.modelIds) ? m.modelIds.map(x => String(x || '').trim().toLowerCase()) : [];
          const mAliases = Array.isArray(m.aliases) ? m.aliases.map(x => String(x || '').trim().toLowerCase()) : [];
          const hit =
            (pKeyLower && mProdKey && mProdKey === pKeyLower) ||
            mIds.some(id => candidateIds.has(id)) ||
            mAliases.some(a => candidateIds.has(a) || candidateLabels.has(a)) ||
            (mLabel && candidateLabels.has(mLabel));
          if (hit) {
            matchedPool = pool;
            matchedModel = m;
            break;
          }
        }
        if (matchedPool) break;
      }

      // 2. 次级按共享额度池键归并当前账号目录内的模型
      if (!matchedPool && core?.getSharedQuotaGroupKey) {
        const probeInput = {
          modelId: membersList[0]?.modelId || product.productKey,
          label: product.productLabel || membersList[0]?.label || ''
        };
        const gKey = core.getSharedQuotaGroupKey(probeInput);
        if (gKey) {
          matchedPool = pools.find(p => p.poolKey === gKey) || null;
        }
      }
    }

    const syncState = view?.syncState || 'unknown';
    const isNoPerm = Boolean(matchedModel?.noPermission || matchedPool?.noPermission || product.unavailable);
    let status = 'unknown';
    let shortText = unknownText;
    let fraction = null;

    if (isNoPerm) {
      status = 'no_permission';
      shortText = t('quota.short.no_permission');
    } else if (syncState === 'error' && !matchedPool) {
      status = 'error';
      shortText = t('quota.short.error');
    } else if (matchedPool) {
      fraction = matchedPool.remainingFraction;
      if (fraction === null || fraction === undefined) {
        status = syncState === 'stale' ? 'stale' : 'unknown';
        shortText = t(`quota.short.${status}`);
      } else if (matchedPool.isExhausted || fraction === 0) {
        status = syncState === 'stale' ? 'stale' : 'exhausted';
        shortText = t('quota.short.exhausted');
      } else {
        status = syncState === 'stale' ? 'stale' : (fraction <= 0.2 ? 'low' : 'available');
        shortText = core?.formatQuotaPercentText
          ? core.formatQuotaPercentText(fraction)
          : (matchedPool.percentText || `${Math.round(fraction * 100)}%`);
      }
    } else if (product.isHistorical || !product.inAccountCatalog) {
      status = 'unknown';
      shortText = unknownText;
    } else {
      status = syncState === 'stale' ? 'stale' : 'unknown';
      shortText = t(`quota.short.${status}`);
    }

    const statusLabel = typeof getQuotaStatusLabelText === 'function'
      ? getQuotaStatusLabelText(status)
      : status;
    const poolName = matchedPool?.title || (product.isHistorical ? t('quota.modelChip.historyHint') : t('quota.modelChip.unpooled'));
    const tipParts = [
      t('quota.modelChip.tooltip', {
        model: product.productLabel,
        pool: poolName,
        status: statusLabel,
        value: shortText
      })
    ];
    if (matchedPool?.hasResetTime && matchedPool.resetTimeText) {
      const cdStr = Number.isFinite(matchedPool.resetAtMs)
        ? ` (${formatCountdownMsCompact((matchedPool.resetAtMs || 0) - nowMs)})`
        : '';
      tipParts.push(t('quota.modelChip.resetPart', { reset: `${matchedPool.resetTimeText}${cdStr}` }));
    }
    const reason = matchedModel?.unavailabilityReason || product.unavailabilityReason;
    if (isNoPerm && reason) tipParts.push(String(reason));
    if (matchedModel?.noticeText) tipParts.push(String(matchedModel.noticeText));
    if (syncState === 'error' && view?.lastError && !matchedPool && !isNoPerm) {
      tipParts.push(String(view.lastError));
    }
    const tooltip = tipParts.join(' · ');

    return {
      status,
      statusLabel,
      shortText,
      fraction,
      poolKey: matchedPool?.poolKey || '',
      poolTitle: matchedPool?.title || '',
      tooltip,
      ariaLabel: tooltip
    };
  }

  /**
   * 更新小额度圆环芯片的圆弧进度、语义状态、数值文本与悬浮说明。
   */
  function updateMiniQuotaChipElement(chip, summary) {
    if (!chip || !summary) return;
    setQuotaAttrIfChanged(chip, 'data-quota-state', summary.status || 'unknown');
    setQuotaAttrIfChanged(chip, 'data-pool-key', summary.poolKey || '');
    setQuotaAttrIfChanged(chip, 'aria-label', summary.ariaLabel || summary.shortText);
    if (chip.title !== summary.tooltip) chip.title = summary.tooltip;
    if (chip._valNode && chip._valNode.textContent !== summary.shortText) {
      chip._valNode.textContent = summary.shortText;
    }
    const fill = chip._ringFill;
    if (!fill) return;
    if (summary.status === 'unknown' || (summary.fraction == null && summary.status === 'stale')) {
      setQuotaAttrIfChanged(fill, 'stroke-dasharray', '8 26.56');
      setQuotaAttrIfChanged(fill, 'stroke-dashoffset', '0');
    } else if (
      summary.fraction == null ||
      summary.status === 'exhausted' ||
      summary.status === 'no_permission' ||
      summary.status === 'error'
    ) {
      setQuotaAttrIfChanged(fill, 'stroke-dasharray', `0 ${MINI_QUOTA_RING_CIRC.toFixed(2)}`);
      setQuotaAttrIfChanged(fill, 'stroke-dashoffset', '0');
    } else {
      const clamped = Math.max(0, Math.min(1, Number(summary.fraction) || 0));
      const arcLen = clamped > 0 ? Math.max(1.6, clamped * MINI_QUOTA_RING_CIRC) : 0;
      const dashStr = `${MINI_QUOTA_RING_CIRC.toFixed(2)} ${MINI_QUOTA_RING_CIRC.toFixed(2)}`;
      const offsetStr = (MINI_QUOTA_RING_CIRC - arcLen).toFixed(2);
      setQuotaAttrIfChanged(fill, 'stroke-dasharray', dashStr);
      setQuotaAttrIfChanged(fill, 'stroke-dashoffset', offsetStr);
    }
  }

  /**
   * 创建贴近原生 UI 的小额度圆环进度与状态芯片节点。
   */
  function createMiniQuotaChipElement(summary, opts = {}) {
    const chip = document.createElement('span');
    chip.className = `ctx-model-quota-chip${opts.variant ? ` is-${opts.variant}` : ''}`;
    const svg = createQuotaSvgEl('svg');
    let fill = null;
    if (svg) {
      svg.setAttribute?.('class', 'ctx-quota-ring-svg');
      svg.setAttribute?.('width', '13');
      svg.setAttribute?.('height', '13');
      svg.setAttribute?.('viewBox', '0 0 16 16');
      svg.setAttribute?.('aria-hidden', 'true');
      const track = createQuotaSvgEl('circle');
      if (track) {
        track.setAttribute?.('class', 'ctx-quota-ring-track');
        track.setAttribute?.('cx', '8');
        track.setAttribute?.('cy', '8');
        track.setAttribute?.('r', String(MINI_QUOTA_RING_RADIUS));
        track.setAttribute?.('fill', 'none');
        track.setAttribute?.('stroke-width', '2');
        svg.appendChild(track);
      }
      fill = createQuotaSvgEl('circle');
      if (fill) {
        fill.setAttribute?.('class', 'ctx-quota-ring-fill');
        fill.setAttribute?.('cx', '8');
        fill.setAttribute?.('cy', '8');
        fill.setAttribute?.('r', String(MINI_QUOTA_RING_RADIUS));
        fill.setAttribute?.('fill', 'none');
        fill.setAttribute?.('stroke-width', '2');
        fill.setAttribute?.('stroke-linecap', 'round');
        fill.setAttribute?.('transform', 'rotate(-90 8 8)');
        svg.appendChild(fill);
      }
      chip.appendChild(svg);
    }
    const valNode = document.createElement('span');
    valNode.className = 'ctx-model-quota-val';
    chip.appendChild(valNode);
    chip._ringFill = fill;
    chip._valNode = valNode;
    updateMiniQuotaChipElement(chip, summary);
    return chip;
  }

  /**
   * 原地同步模型列表、下拉选择器与选中模型卡片中的小额度圆环状态，避免重建闪烁。
   */
  function syncModelListQuotaIndicators(quotaView = null, nowMs = Date.now(), force = false) {
    const view = quotaView || getSafeQuotaViewForModelList(nowMs);
    if (!view) return;
    const poolSig = (view.pools || [])
      .map(p => `${p.poolKey}:${p.remainingFraction ?? 'n'}:${p.noPermission ? 1 : 0}:${p.hasResetTime ? Math.floor(((p.resetAtMs || 0) - nowMs) / 60000) : 'x'}`)
      .join('|');
    const sig = `${view.syncState || ''}|${currentPanelLanguage}|${selectedProductKey || ''}|${poolSig}`;
    if (!force && sig === lastModelQuotaSyncSig) return;
    lastModelQuotaSyncSig = sig;

    const products = getKnownModelProducts();
    const byKey = new Map(products.map(p => [p.productKey, p]));
    const summaryCache = new Map();
    const getSummary = (prod) => {
      if (!prod) return null;
      if (!summaryCache.has(prod.productKey)) {
        summaryCache.set(prod.productKey, resolveProductQuotaSummary(prod, view, nowMs));
      }
      return summaryCache.get(prod.productKey);
    };

    for (const [pKey, entry] of modelListChipByProductKey.entries()) {
      const prod = byKey.get(pKey);
      if (!prod || !entry?.chipEl) continue;
      const summary = getSummary(prod);
      updateMiniQuotaChipElement(entry.chipEl, summary);
      if (entry.rowEl && entry.rowEl.title !== summary.tooltip) {
        entry.rowEl.title = summary.tooltip;
      }
    }

    if (ctxHeaderDropdownCtrl && typeof ctxHeaderDropdownCtrl.updateItemsInPlace === 'function') {
      ctxHeaderDropdownCtrl.updateItemsInPlace((val, itemEl, extraEl) => {
        const prod = byKey.get(val);
        if (!prod) return;
        const summary = getSummary(prod);
        if (extraEl) updateMiniQuotaChipElement(extraEl, summary);
        if (itemEl && itemEl.title !== summary.tooltip) itemEl.title = summary.tooltip;
      });
    }

    if (ctxCardQuotaSlot) {
      const currentProd = getSelectedProductObj();
      if (!currentProd) {
        ctxCardQuotaSlot.hidden = true;
      } else {
        const summary = getSummary(currentProd);
        ctxCardQuotaSlot.hidden = false;
        if (!ctxCardQuotaSlot._chipEl) {
          ctxCardQuotaSlot._chipEl = createMiniQuotaChipElement(summary, { variant: 'card' });
          if (typeof ctxCardQuotaSlot.replaceChildren === 'function') {
            ctxCardQuotaSlot.replaceChildren(ctxCardQuotaSlot._chipEl);
          } else {
            ctxCardQuotaSlot.appendChild(ctxCardQuotaSlot._chipEl);
          }
        } else {
          updateMiniQuotaChipElement(ctxCardQuotaSlot._chipEl, summary);
        }
      }
    }
  }

  function renderHeaderModelDropdown() {
    const products = getKnownModelProducts();
    if (!selectedProductKey && products.length) {
      selectedProductKey = activeSessionProductKey || products[0].productKey;
    }
    const currentProd = products.find(p => p.productKey === selectedProductKey) || products[0] || null;
    if (currentProd) {
      selectedProductKey = currentProd.productKey;
      selectedEditModelKey = (activeSessionProductKey === currentProd.productKey && activeSessionModelKey)
        ? activeSessionModelKey
        : (currentProd.members[0]?.modelId || currentProd.productKey);
    }

    if (ctxModelSelectorRoleEl) {
      ctxModelSelectorRoleEl.textContent = t('panel.ctx.viewModel');
    }
    if (btnCtxBackCurrent) {
      btnCtxBackCurrent.hidden = !(manualModelSelection && activeSessionModelConfirmed && activeSessionProductKey && selectedProductKey && selectedProductKey !== activeSessionProductKey);
    }

    if (ctxModelSelect && typeof document !== 'undefined' && typeof document.createElement === 'function') {
      if (typeof ctxModelSelect.replaceChildren === 'function') {
        const optionEntries = products.map((p) => {
          const pState = resolveProductPreferenceState(p);
          const optText = `${p.productLabel} (${pState.shortText})${p.productKey === activeSessionProductKey ? ` [${t('models.list.currentTag')}]` : ''}`;
          return { value: p.productKey, text: optText };
        });
        const optsSig = `${currentPanelLanguage}|${optionEntries.map(o => `${o.value}=${o.text}`).join('|')}`;
        if (ctxModelSelect._lastOptionsSig !== optsSig) {
          ctxModelSelect._lastOptionsSig = optsSig;
          const opts = optionEntries.map((entry) => {
            const opt = document.createElement('option');
            opt.value = entry.value;
            opt.textContent = entry.text;
            return opt;
          });
          ctxModelSelect.replaceChildren(...opts);
        }
        if (selectedProductKey && ctxModelSelect.value !== selectedProductKey) {
          ctxModelSelect.value = selectedProductKey;
        }
      }
    }

    const nextDropdownLabel = currentProd ? currentProd.productLabel : t('models.dropdown.empty');
    if (ctxModelDropdownLabelEl && ctxModelDropdownLabelEl.textContent !== nextDropdownLabel) {
      ctxModelDropdownLabelEl.textContent = nextDropdownLabel;
    }

    if (!ctxHeaderDropdownCtrl && typeof initDropdownController === 'function' && el('ctx-model-dropdown-wrap')) {
      ctxHeaderDropdownCtrl = initDropdownController({
        wrapId: 'ctx-model-dropdown-wrap',
        triggerId: 'ctx-model-dropdown-trigger',
        labelId: 'ctx-model-dropdown-label',
        menuId: 'ctx-model-dropdown-menu',
        selectId: 'ctx-model-select',
        emptyLabel: () => t('models.dropdown.empty'),
        searchPlaceholder: () => t('dropdown.modelSearch'),
        emptyText: () => t('dropdown.modelEmpty'),
        getSelectedValue: () => selectedProductKey || '',
        renderOptionExtras: (opt) => opt?.quotaSummary ? createMiniQuotaChipElement(opt.quotaSummary, { variant: 'dropdown' }) : null,
        onSelect: (opt) => {
          const val = opt?.value || '';
          if (!val) return;
          manualModelSelection = Boolean(activeSessionProductKey && val !== activeSessionProductKey);
          selectedProductKey = val;
          ctxDraftDirty = false;
          loadDraftFromSelectedModel(true);
          renderHeaderModelDropdown();
          renderModelSettingsTab();
        },
        getOptions: () => {
          const list = getKnownModelProducts();
          const nowMs = Date.now();
          const qView = getSafeQuotaViewForModelList(nowMs);
          const items = [];
          const activeList = list.filter(p => p.inAccountCatalog);
          const historyList = list.filter(p => !p.inAccountCatalog);
          let lastVendor = '';
          for (const p of activeList) {
            if (p.vendor !== lastVendor) {
              lastVendor = p.vendor;
              items.push({
                value: `__group_${p.vendor}`,
                label: formatVendorLabel(p.vendor),
                isGroupHeader: true,
                dotColor: VENDOR_DOT_COLORS[p.vendor] || VENDOR_DOT_COLORS['其他']
              });
            }
            const pState = resolveProductPreferenceState(p);
            const qSummary = resolveProductQuotaSummary(p, qView, nowMs);
            items.push({
              value: p.productKey,
              label: p.productLabel,
              displayRight: pState.shortText,
              quotaSummary: qSummary,
              tooltip: qSummary.tooltip,
              badgeText: p.productKey === activeSessionProductKey ? t('models.list.currentTag') : '',
              aliases: [p.vendor, p.productKey]
            });
          }
          if (historyList.length) {
            items.push({
              value: '__group_history',
              label: t('models.list.historyGroup'),
              isGroupHeader: true,
              dotColor: VENDOR_DOT_COLORS['其他']
            });
            for (const p of historyList) {
              const pState = resolveProductPreferenceState(p);
              const qSummary = resolveProductQuotaSummary(p, qView, nowMs);
              items.push({
                value: p.productKey,
                label: p.productLabel,
                displayRight: pState.shortText,
                quotaSummary: qSummary,
                tooltip: qSummary.tooltip,
                badgeText: p.productKey === activeSessionProductKey ? t('models.list.currentTag') : t('models.list.historyTag'),
                aliases: [p.vendor, p.productKey]
              });
            }
          }
          return items;
        }
      });
    } else if (ctxHeaderDropdownCtrl && typeof ctxHeaderDropdownCtrl.refresh === 'function') {
      ctxHeaderDropdownCtrl.refresh();
    }
  }

  ctxModelSelect?.addEventListener('change', (e) => {
    const val = e?.target?.value || '';
    if (!val) return;
    manualModelSelection = Boolean(activeSessionProductKey && val !== activeSessionProductKey);
    selectedProductKey = val;
    ctxDraftDirty = false;
    loadDraftFromSelectedModel(true);
    renderHeaderModelDropdown();
    renderModelSettingsTab();
  });

  function renderCompactSessionCard() {
    const scopeMode = getContextScopeMode();
    if (ctxCompactSavedEl) {
      if (scopeMode === 'unified') {
        ctxCompactSavedEl.textContent = formatSavedPrefLabel(contextUnifiedPreference);
      } else if (!activeSessionModelConfirmed || !activeSessionProductKey) {
        ctxCompactSavedEl.textContent = t('panel.ctx.currentModelUnconfirmed') || '当前模型待确认';
      } else {
        const products = getKnownModelProducts();
        const targetProd = products.find(p => p.productKey === activeSessionProductKey) || null;
        const pState = resolveProductPreferenceState(targetProd);
        ctxCompactSavedEl.textContent = pState.pref == null && pState.status === 'none' ? t('status.savedDefault') : pState.displayText;
      }
    }
    const statusInfo = mapUnlockDisplayStatus(currentUnlockStatus);
    if (ctxCompactClientEl) {
      if (unlockStatusFetchError) {
        ctxCompactClientEl.textContent = t('status.badge.unavailable');
      } else if (!currentUnlockStatus) {
        ctxCompactClientEl.textContent = t('status.badge.reading');
      } else if (currentUnlockStatus.status === 'patched_pending_restart' || needsRestartAfterApply) {
        ctxCompactClientEl.textContent = `${describeClientModeValue(currentUnlockStatus)}（${t('models.status.pendingRestart') || statusInfo.badge}）`;
      } else {
        ctxCompactClientEl.textContent = `${describeClientModeValue(currentUnlockStatus)}（${statusInfo.badge}）`;
      }
    }
  }

  function renderClientStatusBar() {
    const statusInfo = mapUnlockDisplayStatus(currentUnlockStatus);
    if (unlockBadge) {
      unlockBadge.textContent = statusInfo.badge;
      unlockBadge.className = `key-pill ${statusInfo.pillClass}`;
    }

    if (ctxClientStatusText) {
      if (unlockStatusFetchError) {
        ctxClientStatusText.textContent = t('status.badge.unavailable');
      } else if (!currentUnlockStatus) {
        ctxClientStatusText.textContent = t('status.client.reading');
      } else if (currentUnlockStatus.status === 'patched_pending_restart' || needsRestartAfterApply) {
        ctxClientStatusText.textContent = t('status.client.pendingRestart', { val: describeClientModeValue(currentUnlockStatus) });
      } else if (currentUnlockStatus.configuredMode === 'dynamic') {
        ctxClientStatusText.textContent = t('status.client.loadedDynamic');
      } else if (currentUnlockStatus.configuredMode === 'fixed' || currentUnlockStatus.limitTokens) {
        ctxClientStatusText.textContent = t('status.client.loadedFixed', { val: describeClientModeValue(currentUnlockStatus) });
      } else if (currentUnlockStatus.configuredMode === 'default' || currentUnlockStatus.status === 'unpatched_official') {
        ctxClientStatusText.textContent = t('status.client.loadedDefault');
      } else {
        ctxClientStatusText.textContent = t('status.client.loadedFixed', { val: describeClientModeValue(currentUnlockStatus) });
      }
    }

    if (ctxRestartMismatchNote) {
      if (restartMismatchNotice) {
        ctxRestartMismatchNote.textContent = restartMismatchNotice;
        ctxRestartMismatchNote.hidden = false;
      } else {
        ctxRestartMismatchNote.hidden = true;
      }
    }

    const showRestart = needsRestartAfterApply || currentUnlockStatus?.status === 'patched_pending_restart';
    const isErrorStatus = currentUnlockStatus?.status === 'partial_match' || currentUnlockStatus?.status === 'failed';
    if (btnRestartHost) {
      btnRestartHost.hidden = !showRestart || !hostSupportsRestart;
    }
    if (ctxManualRestartNote) {
      ctxManualRestartNote.hidden = hostSupportsRestart || !showRestart;
    }
    if (btnUnlockResultRestart) {
      btnUnlockResultRestart.hidden = !showRestart || !hostSupportsRestart;
    }
    if (btnUnlockResultRetry) {
      btnUnlockResultRetry.hidden = !isErrorStatus;
    }
    if (unlockResultManual) {
      unlockResultManual.hidden = !(showRestart && !hostSupportsRestart);
    }
    if (unlockResultActions) {
      const hasAction = (showRestart && hostSupportsRestart) || isErrorStatus;
      unlockResultActions.hidden = !hasAction;
    }
    const btnEnhanceRestart = el('btn-enhance-restart-host');
    if (btnEnhanceRestart) {
      btnEnhanceRestart.hidden = !(showRestart && hostSupportsRestart);
    }
  }

  function renderModelListGroup(products) {
    if (!ctxModelListEl || typeof document === 'undefined' || typeof document.createElement !== 'function') return;
    const nowMs = Date.now();
    const qView = getSafeQuotaViewForModelList(nowMs);
    if (!products.length) {
      modelListChipByProductKey.clear();
      ctxModelListEl._lastStructSig = '';
      ctxModelListEl.textContent = t('models.list.empty');
      return;
    }
    const catalogConfigs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
    const hasAccountCatalog = Array.isArray(catalogConfigs) && catalogConfigs.length > 0;
    const structSig = `${currentPanelLanguage}|${selectedProductKey || ''}|${activeSessionProductKey || ''}|${hasAccountCatalog ? 1 : 0}|` + products.map((p) => {
      const ps = resolveProductPreferenceState(p);
      return `${p.productKey}:${p.productLabel}:${p.vendor}:${p.unavailable ? 1 : 0}:${p.inAccountCatalog ? 1 : 0}:${p.isHistorical ? 1 : 0}:${ps.status}:${ps.shortText}:${Boolean(p.notice)}`;
    }).join(';');

    if (ctxModelListEl._lastStructSig === structSig && modelListChipByProductKey.size > 0) {
      syncModelListQuotaIndicators(qView, nowMs, false);
      return;
    }
    ctxModelListEl._lastStructSig = structSig;
    modelListChipByProductKey.clear();

    const outerPanel = el('panel');
    const prevPanelScrollTop = (outerPanel && typeof outerPanel.scrollTop === 'number') ? outerPanel.scrollTop : 0;
    const prevScrollTop = ctxModelListEl.scrollTop || 0;
    const accountProducts = hasAccountCatalog ? products.filter(p => p.inAccountCatalog) : products;
    const historyProducts = hasAccountCatalog ? products.filter(p => !p.inAccountCatalog) : [];

    const appendGroupRows = (fragNodes, vendor, list, isHistoryGroup = false) => {
      const grp = document.createElement('div');
      grp.className = 'ctx-model-group';

      const hdr = document.createElement('div');
      hdr.className = isHistoryGroup ? 'ctx-model-group-hdr is-history-hdr' : 'ctx-model-group-hdr';
      const dot = document.createElement('span');
      dot.className = 'ag-vendor-dot';
      if (dot.style) dot.style.background = VENDOR_DOT_COLORS[vendor] || VENDOR_DOT_COLORS['其他'];
      const vTxt = document.createElement('span');
      vTxt.textContent = isHistoryGroup ? t('models.list.historyGroup') : formatVendorLabel(vendor);
      hdr.appendChild(dot);
      hdr.appendChild(vTxt);
      grp.appendChild(hdr);

      for (const prod of list) {
        const pState = resolveProductPreferenceState(prod);
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `ctx-product-row${prod.productKey === selectedProductKey ? ' is-active' : ''}${prod.unavailable ? ' is-unavailable' : ''}`;
        row.setAttribute('data-product-key', prod.productKey);

        const left = document.createElement('span');
        left.className = 'ctx-product-row-left';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'ctx-product-row-name';
        nameSpan.textContent = prod.productLabel;
        left.appendChild(nameSpan);

        if (prod.unavailable) {
          const unavailTag = document.createElement('span');
          unavailTag.className = 'ctx-product-row-unavailable-tag';
          unavailTag.textContent = t('models.card.modelUnavailable') || '不可用';
          if (prod.unavailabilityReason) unavailTag.title = prod.unavailabilityReason;
          left.appendChild(unavailTag);
        } else if (prod.notice) {
          const noticeTag = document.createElement('span');
          noticeTag.className = 'ctx-product-row-notice-tag';
          noticeTag.textContent = 'Notice';
          noticeTag.title = typeof prod.notice === 'string' ? prod.notice : JSON.stringify(prod.notice);
          left.appendChild(noticeTag);
        }

        if (prod.productKey === activeSessionProductKey) {
          const curTag = document.createElement('span');
          curTag.className = 'ag-dropdown-badge';
          curTag.textContent = t('models.list.currentTag');
          left.appendChild(curTag);
        } else if (isHistoryGroup || prod.isHistorical) {
          const histTag = document.createElement('span');
          histTag.className = 'ctx-product-row-history-tag';
          histTag.textContent = t('models.list.historyTag');
          left.appendChild(histTag);
        }

        const right = document.createElement('span');
        right.className = 'ctx-product-row-right';
        const qSummary = resolveProductQuotaSummary(prod, qView, nowMs);
        const qChip = createMiniQuotaChipElement(qSummary, { variant: 'row' });
        right.appendChild(qChip);
        const valSpan = document.createElement('span');
        valSpan.className = `ctx-product-row-val${pState.status === 'conflict' ? ' is-conflict' : ''}`;
        valSpan.textContent = pState.shortText;
        right.appendChild(valSpan);
        row.title = qSummary.tooltip;
        modelListChipByProductKey.set(prod.productKey, { rowEl: row, chipEl: qChip });

        row.appendChild(left);
        row.appendChild(right);
        row.addEventListener('click', () => {
          manualModelSelection = Boolean(activeSessionProductKey && prod.productKey !== activeSessionProductKey);
          selectedProductKey = prod.productKey;
          ctxDraftDirty = false;
          loadDraftFromSelectedModel(true);
          renderHeaderModelDropdown();
          renderModelSettingsTab();
        });
        grp.appendChild(row);
      }
      fragNodes.push(grp);
    };

    const groups = new Map();
    for (const p of accountProducts) {
      if (!groups.has(p.vendor)) groups.set(p.vendor, []);
      groups.get(p.vendor).push(p);
    }
    const fragNodes = [];
    for (const [vendor, list] of groups.entries()) {
      appendGroupRows(fragNodes, vendor, list, false);
    }
    if (historyProducts.length > 0) {
      appendGroupRows(fragNodes, '其他', historyProducts, true);
    }
    if (typeof ctxModelListEl.replaceChildren === 'function') {
      ctxModelListEl.replaceChildren(...fragNodes);
    }
    if (prevScrollTop > 0 && Math.abs((ctxModelListEl.scrollTop || 0) - prevScrollTop) > 1) {
      ctxModelListEl.scrollTop = prevScrollTop;
    }
    if (outerPanel && prevPanelScrollTop > 0 && Math.abs((outerPanel.scrollTop || 0) - prevPanelScrollTop) > 1) {
      outerPanel.scrollTop = prevPanelScrollTop;
    }
  }

  function findLatestProductObservation(product, activeConvId = null) {
    if (!product) return { latestBudgetObs: null, latestServiceLimitObs: null };
    const scoped = budgetTracker ? budgetTracker.getScopedObservation(activeConvId, product.productKey) : null;
    if (scoped) {
      return {
        latestBudgetObs: scoped.budget > 0 ? scoped : null,
        latestServiceLimitObs: scoped.serviceLimit > 0 ? scoped : null
      };
    }
    const memberIds = new Set((product.members || []).map(m => m.modelId));
    if (product.productKey) memberIds.add(product.productKey);
    let latestBudgetObs = null;
    let latestServiceLimitObs = null;

    for (const mid of memberIds) {
      const obs = observedByModelId.get(mid);
      if (!obs) continue;
      if (activeConvId && obs.convoId && obs.convoId !== activeConvId) continue;
      if (obs.budget > 0 && (!latestBudgetObs || obs.ts > latestBudgetObs.ts)) {
        latestBudgetObs = obs;
      }
      if (obs.serviceLimit > 0 && (!latestServiceLimitObs || obs.ts > latestServiceLimitObs.ts)) {
        latestServiceLimitObs = obs;
      }
    }
    return { latestBudgetObs, latestServiceLimitObs };
  }

  function findPreRestartBudgetForProduct(product) {
    if (!product || !preRestartSnapshot?.observations) return null;
    const memberIds = new Set((product.members || []).map(m => m.modelId));
    if (product.productKey) memberIds.add(product.productKey);
    let best = null;
    for (const mid of memberIds) {
      const obs = preRestartSnapshot.observations[mid];
      if (obs && obs.budget > 0 && (!best || obs.ts > best.ts)) best = obs;
    }
    return best;
  }

  async function resolveProductConflict(product, chosenEntry) {
    if (!product || !chosenEntry) return;
    const legacyKeys = resolveProductPreferenceState(product).legacyKeys;
    const res = await saveSettingsPayloadBridge({
      contextPreference: {
        scope: 'product',
        productKey: product.productKey,
        modelId: product.productKey,
        label: product.productLabel,
        mode: chosenEntry.mode,
        limitTokens: chosenEntry.limitTokens,
        clearLegacyKeys: legacyKeys
      }
    });
    if (!res || !res.ok) {
      showUnlockResultBox(false, t('models.toast.saveFailed', { err: translateBackendText(res?.error) || t('models.err.saveFailed') }));
      return;
    }
    if (res.contextPreferences && typeof res.contextPreferences === 'object') {
      contextPreferencesMap = { ...res.contextPreferences };
    } else {
      for (const lk of legacyKeys) delete contextPreferencesMap[lk];
      contextPreferencesMap[product.productKey] = {
        scope: 'product',
        productKey: product.productKey,
        modelId: product.productKey,
        label: product.productLabel,
        mode: chosenEntry.mode,
        limitTokens: chosenEntry.limitTokens,
        updatedAt: new Date().toISOString()
      };
    }
    syncContextPreferencesCache(contextPreferencesMap);
    ctxDraftDirty = false;
    loadDraftFromSelectedModel(true);
    renderHeaderModelDropdown();
    renderModelSettingsTab();
    showUnlockResultBox(true, t('models.toast.savedUniform'));
  }

  function evaluateModelContextStatus(product) {
    const isEnEval = currentPanelLanguage === 'en';
    const isTwEval = currentPanelLanguage === 'zh-TW';
    if (!product) {
      return {
        status: 'unconfirmed',
        badge: t('panel.ctx.currentModelUnconfirmed') || (isEnEval ? 'Unconfirmed' : (isTwEval ? '待確認' : '待确认')),
        pillClass: 'pill-muted',
        diagnosis: isEnEval ? 'Model metadata unavailable' : (isTwEval ? '未取得模型資訊' : '未获取到模型信息'),
        targetText: '—',
        requestText: '—',
        observedText: '—',
        convoId: '—'
      };
    }

    const pState = resolveProductPreferenceState(product);
    const scopeMode = getContextScopeMode();
    const activePref = (scopeMode === 'unified') ? contextUnifiedPreference : pState.pref;
    const targetMode = activePref?.mode || 'default';
    const targetLimit = (targetMode === 'fixed') ? Number(activePref?.limitTokens) : null;
    const capSummary = getProductCapabilitySummary(product);

    let targetText = t('status.savedDefault') || (isEnEval ? 'Client Default' : (isTwEval ? '還原用戶端預設' : '恢复客户端默认'));
    if (targetMode === 'dynamic') {
      targetText = t('models.preset.dynamic') || (isEnEval ? 'Dynamic' : (isTwEval ? '動態跟隨' : '动态跟随'));
    } else if (targetMode === 'fixed' && targetLimit) {
      targetText = (targetLimit === 512000) ? `512K (512,000 tokens)` : `${formatKShort(targetLimit)} (${fmt(targetLimit)} tokens)`;
      if (!isEnEval) {
        targetText = (targetLimit === 512000) ? '512K（512,000 tokens）' : `${formatKShort(targetLimit)}（${fmt(targetLimit)} tokens）`;
      }
    }

    const activeConvId = state.activeConversationId || state.conversationId || state.route || null;
    const evalCore = budgetTracker
      ? budgetTracker.evaluateStatus({
        product,
        scopeMode,
        pref: activePref,
        activeConvId,
        modelHardLimit: capSummary?.modelTheoreticalMaxTokens || null
      })
      : {
        status: 'saved_pending_dispatch',
        convoId: activeConvId || '—',
        targetMode,
        targetLimit,
        dispatched: null,
        observation: findLatestProductObservation(product, activeConvId).latestBudgetObs
      };

    const dispatched = evalCore.dispatched;
    const obs = evalCore.observation;
    const obsBudget = Number(obs?.budget || 0);

    const noVerifyText = isEnEval ? 'Not verified in this session' : (isTwEval ? '尚無本次驗證' : '尚无本次验证');
    let requestText = dispatched
      ? (isEnEval ? 'Default passthrough (no override)' : (isTwEval ? '預設透傳（未附加自訂參數）' : '默认透传（未附加自定义参数）'))
      : noVerifyText;
    if (dispatched) {
      if (dispatched.status === 'send_failed') {
        const errPart = dispatched.errorMessage ? translateBackendText(dispatched.errorMessage) : (isEnEval ? 'Request incomplete' : (isTwEval ? '請求未完成' : '请求未完成'));
        requestText = isEnEval ? `Send failed (${errPart})` : (isTwEval ? `發送失敗（${errPart}）` : `发送失败（${dispatched.errorMessage || '请求未完成'}）`);
      } else if (dispatched.status === 'aborted') {
        requestText = isEnEval ? 'Aborted' : (isTwEval ? '已取消發送' : '已取消发送');
      } else if (dispatched.status === 'uninjectable') {
        requestText = isEnEval ? 'Passthrough (missing model identity / frame)' : (isTwEval ? '透傳未注入（缺少可靠模型/不支援影格）' : '透传未注入（缺少可靠模型/不支持帧）');
      } else if (dispatched.sentMode === 'fixed' && dispatched.sentLimitTokens) {
        requestText = isEnEval
          ? `${formatKShort(dispatched.sentLimitTokens)} (${fmt(dispatched.sentLimitTokens)} tokens)`
          : `${formatKShort(dispatched.sentLimitTokens)}（${fmt(dispatched.sentLimitTokens)} tokens）`;
      } else if (dispatched.sentMode === 'dynamic') {
        requestText = isEnEval ? 'Dynamic (fixed limit cleared)' : (isTwEval ? '動態跟隨（已清除固定數值）' : '动态跟随（已清除固定数值）');
      }
      if (dispatched.timestamp) {
        requestText += ` · ${formatMonthDayTime(dispatched.timestamp)}`;
      }
    }

    function statusUsesExistingObs(st, diagCode) {
      return st === 'confirmed'
        || st === 'clamped_by_model_limit'
        || st === 'mismatch'
        || (st === 'default' && diagCode === 'default_confirmed');
    }

    let observedText = noVerifyText;
    if (obsBudget > 0 && statusUsesExistingObs(evalCore.status, evalCore.diagnosisCode)) {
      const effTxt = obs.effort ? ` · ${formatEffortZh(obs.effort)}` : '';
      const tTxt = obs.ts ? ` · ${formatMonthDayTime(obs.ts)}` : '';
      observedText = isEnEval
        ? `${formatKShort(obsBudget)} (${fmt(obsBudget)} tokens)${effTxt}${tTxt}`
        : `${formatKShort(obsBudget)}（${fmt(obsBudget)} tokens）${effTxt}${tTxt}`;
    } else if (obsBudget > 0) {
      const effTxt = obs.effort ? ` · ${formatEffortZh(obs.effort)}` : '';
      observedText = isEnEval
        ? `Historical only: ${fmt(obsBudget)} tokens${effTxt} (current setting unverified)`
        : (isTwEval
          ? `僅見歷史觀測 ${fmt(obsBudget)} tokens${effTxt}（目前設定尚無本次驗證）`
          : `仅见历史观测 ${fmt(obsBudget)} tokens${effTxt}（当前设置尚无本次验证）`);
    }

    const convoId = evalCore.convoId || activeConvId || '—';

    let status = evalCore.status;
    let badge = t('models.status.savedPendingDispatch') || '已保存，下一次发送时尝试应用';
    let pillClass = 'pill-muted';
    let diagnosis = isEnEval
      ? 'Saved target limit; it will be injected automatically on the next request.'
      : (isTwEval
        ? '已儲存目標參數，將在下次發起請求時自動注入並發送。'

        : '已保存目标参数，将在下次发起请求时自动注入并发送。');

    if (status === 'default') {
      if (evalCore.diagnosisCode === 'default_confirmed') {
        badge = t('status.savedDefault') || '使用模型默认值';
        pillClass = 'pill-good';
        diagnosis = isEnEval
          ? `Passed through as client default (no override); reply confirmed ${fmt(obsBudget)} tokens.`
          : (isTwEval
            ? `本次請求已依用戶端預設透傳（未附加自訂覆寫），收到新回覆確認實際採用 ${fmt(obsBudget)} tokens。`
            : `本次请求已按客户端默认透传（未附加自定义覆盖），收到新回复确认实际采用 ${fmt(obsBudget)} tokens。`);
      } else {
        badge = t('status.savedDefault') || '使用模型默认值';
        pillClass = 'pill-muted';
        diagnosis = isEnEval
          ? 'Client default active (no override); verified on next request.'
          : (isTwEval
            ? '已還原/維持用戶端預設（不附加覆寫參數），將在下一次發送時生效並驗證實際採用值。'
            : '已恢复/保持客户端默认（不附加覆盖参数），将在下一次发送时生效并验证实际采用值。');
      }
    } else if (status === 'send_failed') {
      badge = isEnEval ? 'Send failed (unconfirmed)' : (isTwEval ? '發送失敗（未確認）' : '发送失败（未确认）');
      pillClass = 'pill-bad';
      const errMsg = evalCore.errorMessage ? translateBackendText(evalCore.errorMessage) : (isEnEval ? 'network or transport error' : (isTwEval ? '網路或傳輸錯誤' : '网络或传输错误'));
      diagnosis = isEnEval
        ? `Request failed (${errMsg}); actual budget could not be confirmed.`
        : (isTwEval ? `本次請求發送失敗（${errMsg}），因此無法確認實際預算。` : `本次请求发送失败（${evalCore.errorMessage || '网络或传输错误'}），因此无法确认实际预算。`);
    } else if (status === 'aborted') {
      badge = isEnEval ? 'Aborted (unconfirmed)' : (isTwEval ? '已取消（未確認）' : '已取消（未确认）');
      pillClass = 'pill-muted';
      diagnosis = isEnEval ? 'Request was cancelled before a reply was received.' : (isTwEval ? '本次請求在完成前被取消，未收到新回覆。' : '本次请求在完成前被取消，未收到新回复。');
    } else if (status === 'uninjectable') {
      badge = isEnEval ? 'Not injected (passthrough)' : (isTwEval ? '本次未注入（已透傳）' : '本次未注入（已透传）');
      pillClass = 'pill-warn';
      const reasonTxt = evalCore.diagnosisCode || (isEnEval ? 'missing model identity or unsupported frame' : (isTwEval ? '缺少可靠模型身分或協定格式不支援' : '缺少可靠模型身份或协议格式不支持'));
      diagnosis = isEnEval
        ? `Could not inject override (${reasonTxt}); passed through unchanged.`
        : (isTwEval ? `未能向本次請求自動注入參數（${reasonTxt}），已保持原樣透傳。` : `未能向本次请求自动注入参数（${evalCore.diagnosisCode || '缺少可靠模型身份或协议格式不支持'}），已保持原样透传。`);
    } else if (status === 'confirmed') {
      badge = t('models.status.confirmed') || '实际预算已确认';
      pillClass = 'pill-good';
      diagnosis = targetMode === 'dynamic'
        ? (isEnEval ? `Dynamic mode active; observed response budget ${fmt(obsBudget)} tokens.` : (isTwEval ? `已啟用動態跟隨模式，本次發送後實測回傳預算 ${fmt(obsBudget)} tokens。` : `已启用动态跟随模式，本次发送后实测返回预算 ${fmt(obsBudget)} tokens。`))
        : (isEnEval ? `Sent ${fmt(dispatched?.sentLimitTokens || targetLimit)}; server confirmed ${fmt(obsBudget)} tokens.` : (isTwEval ? `請求實際攜帶 ${fmt(dispatched?.sentLimitTokens || targetLimit)}，本次發送後伺服器端回傳預算 ${fmt(obsBudget)} tokens，完全吻合。` : `请求实际携带 ${fmt(dispatched?.sentLimitTokens || targetLimit)}，本次发送后服务端返回预算 ${fmt(obsBudget)} tokens，完全吻合。`));
    } else if (status === 'clamped_by_model_limit') {
      badge = isEnEval ? 'Clamped by model cap' : (isTwEval ? '受模型上限限制' : '受模型上限限制');
      pillClass = 'pill-warn';
      diagnosis = isEnEval
        ? `Sent ${fmt(dispatched?.sentLimitTokens || targetLimit)} tokens, clamped to ${fmt(obsBudget)} tokens by known cap (${fmt(evalCore.knownCap)} tokens).`
        : (isTwEval ? `請求攜帶 ${fmt(dispatched?.sentLimitTokens || targetLimit)} tokens，受已知模型/伺服器端上限（${fmt(evalCore.knownCap)} tokens）限制，實際採用 ${fmt(obsBudget)} tokens。` : `请求携带 ${fmt(dispatched?.sentLimitTokens || targetLimit)} tokens，受已知模型/服务端上限（${fmt(evalCore.knownCap)} tokens）限制，实际采用 ${fmt(obsBudget)} tokens。`);
    } else if (status === 'mismatch') {
      badge = t('models.status.mismatch') || '未生效：目标值与观测值不一致';
      pillClass = 'pill-bad';
      let detail = isEnEval
        ? `Target (${fmt(targetLimit)} tokens) differs from observed budget (${fmt(obsBudget)} tokens).`
        : (isTwEval ? `目標設定（${fmt(targetLimit)} tokens）與發送後實際觀測預算（${fmt(obsBudget)} tokens）不一致，原因待確認。` : `目标设置（${fmt(targetLimit)} tokens）与发送后实际观测预算（${fmt(obsBudget)} tokens）不一致，原因待确认。`);
      if (product.unavailable && product.unavailabilityReason) {
        detail += isEnEval ? ` (${product.unavailabilityReason})` : `（模型可用性說明：${product.unavailabilityReason}）`;
      }
      diagnosis = detail;
    } else if (status === 'timeout_unconfirmed') {
      badge = isEnEval ? 'Timed out (unconfirmed)' : (isTwEval ? '確認逾時（未觀測到新回覆）' : '确认超时（未观测到新回复）');
      pillClass = 'pill-warn';
      const secWait = Math.round(CTX_CONFIRM_TIMEOUT_MS / 1000);
      diagnosis = targetMode === 'default'
        ? (isEnEval ? `Sent with client default, but no budget confirmation arrived within ${secWait}s.` : (isTwEval ? `已依用戶端預設透傳發送請求，但超過 ${secWait} 秒未觀測到新回覆中的預算回傳。` : `已按客户端默认透传发送请求，但超过 ${Math.round(CTX_CONFIRM_TIMEOUT_MS / 1000)} 秒未观测到新回复中的预算回传。`))
        : (isEnEval ? `Sent override (${dispatched?.sentLimitTokens ? `${fmt(dispatched.sentLimitTokens)} tokens` : 'Dynamic'}), but no reply arrived within ${secWait}s.` : (isTwEval ? `已在請求中攜帶設定（${dispatched?.sentLimitTokens ? `${fmt(dispatched.sentLimitTokens)} tokens` : '動態跟隨'}），但超過 ${secWait} 秒未觀測到新回覆中的預算回傳。` : `已在请求中携带设置（${dispatched?.sentLimitTokens ? `${fmt(dispatched.sentLimitTokens)} tokens` : '动态跟随'}），但超过 ${Math.round(CTX_CONFIRM_TIMEOUT_MS / 1000)} 秒未观测到新回复中的预算回传。`));
    } else if (status === 'dispatched_pending_confirm') {
      badge = targetMode === 'default'
        ? (isEnEval ? 'Passthrough sent; awaiting confirm' : (isTwEval ? '已預設透傳，等待確認' : '已默认透传，等待确认'))
        : (t('models.status.dispatchedPendingConfirm') || '已发送设置，等待确认');
      pillClass = 'pill-warn';
      diagnosis = targetMode === 'default'
        ? (isEnEval ? 'Sent with client default (no override); awaiting reply to confirm allocated budget.' : (isTwEval ? '已依用戶端預設透傳發出請求（未附加覆寫參數），等待收到新回覆以確認伺服器端實際預算。' : '已按客户端默认透传发出请求（未附加覆盖参数），等待收到新回复以确认服务端实际预算。'))
        : (isEnEval ? `Injected (${dispatched?.sentLimitTokens ? `${fmt(dispatched.sentLimitTokens)} tokens` : 'Dynamic'}); awaiting reply to confirm budget.` : (isTwEval ? `已在本次請求中成功注入參數（${dispatched?.sentLimitTokens ? `${fmt(dispatched.sentLimitTokens)} tokens` : '動態跟隨'}），等待收到新回覆以確認實際分配預算。` : `已在本次请求中成功注入参数（${dispatched?.sentLimitTokens ? `${fmt(dispatched.sentLimitTokens)} tokens` : '动态跟随'}），等待收到新回复以确认实际分配预算。`));
    } else {
      status = 'saved_pending_dispatch';
      badge = t('models.status.savedPendingDispatch') || '已保存，下一次发送时尝试应用';
      pillClass = 'pill-muted';
      diagnosis = isEnEval
        ? `Saved (${targetText}); will be injected on the next request for this model.`
        : (isTwEval ? `已儲存目標設定（${targetText}），下一次在對應模型發起發送時將自動注入。` : `已保存目标设置（${targetText}），下一次在对应模型发起发送时将自动注入。`);
    }

    return {
      status,
      badge,
      pillClass,
      diagnosis,
      targetText,
      requestText,
      observedText,
      convoId
    };
  }

  function renderModelDetailCard(product) {
    if (!product) {
      if (ctxCardProductName) ctxCardProductName.textContent = t('models.card.waiting');
      if (ctxCardVendorName) ctxCardVendorName.textContent = '—';
      if (ctxCardQuotaSlot) ctxCardQuotaSlot.hidden = true;
      if (ctxCardEffortsList) ctxCardEffortsList.textContent = t('models.card.effortsEmpty');
      if (ctxCardSessionEffort) ctxCardSessionEffort.hidden = true;
      if (ctxConflictBanner) ctxConflictBanner.hidden = true;
      if (ctxSummaryModelEl) ctxSummaryModelEl.textContent = t('models.summary.pendingConfirm');
      if (ctxSummaryLengthEl) ctxSummaryLengthEl.textContent = '—';
      if (ctxSummaryStatusPillEl) ctxSummaryStatusPillEl.hidden = true;
      return;
    }

    const evalResult = evaluateModelContextStatus(product);
    const pState = resolveProductPreferenceState(product);
    if (ctxCardVendorDot?.style) {
      ctxCardVendorDot.style.background = VENDOR_DOT_COLORS[product.vendor] || VENDOR_DOT_COLORS['其他'];
    }
    if (ctxCardVendorName) ctxCardVendorName.textContent = formatVendorLabel(product.vendor);
    if (ctxCardQuotaSlot) {
      const nowMs = Date.now();
      const qSummary = resolveProductQuotaSummary(product, null, nowMs);
      ctxCardQuotaSlot.hidden = false;
      if (!ctxCardQuotaSlot._chipEl) {
        ctxCardQuotaSlot._chipEl = createMiniQuotaChipElement(qSummary, { variant: 'card' });
        if (typeof ctxCardQuotaSlot.replaceChildren === 'function') {
          ctxCardQuotaSlot.replaceChildren(ctxCardQuotaSlot._chipEl);
        } else {
          ctxCardQuotaSlot.appendChild(ctxCardQuotaSlot._chipEl);
        }
      } else {
        updateMiniQuotaChipElement(ctxCardQuotaSlot._chipEl, qSummary);
      }
    }
    if (ctxCardProductName) {
      if (product.unavailable) {
        ctxCardProductName.textContent = `${product.productLabel} [${t('models.card.modelUnavailable') || '不可用'}]`;
      } else {
        ctxCardProductName.textContent = product.productLabel;
      }
    }

    const efforts = product.members.map(m => m.effort).filter(Boolean);
    if (ctxCardEffortsList) {
      ctxCardEffortsList.textContent = efforts.length
        ? t('models.card.effortsList', { list: efforts.map(formatEffortZh).join(' · ') })
        : t('models.card.effortStandard');
    }
    if (ctxCardSessionEffort) {
      if (activeSessionProductKey === product.productKey && activeSessionEffort) {
        ctxCardSessionEffort.textContent = t('models.card.sessionEffort', { effort: formatEffortZh(activeSessionEffort) });
        ctxCardSessionEffort.hidden = false;
      } else {
        ctxCardSessionEffort.hidden = true;
      }
    }

    // 旧档位冲突横幅
    if (ctxConflictBanner && ctxConflictRows) {
      if (pState.status === 'conflict' && pState.conflictEntries.length > 0) {
        ctxConflictBanner.hidden = false;
        if (typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof ctxConflictRows.replaceChildren === 'function') {
          const rows = [];
          for (const ce of pState.conflictEntries) {
            const r = document.createElement('div');
            r.className = 'ctx-conflict-row';
            const lbl = document.createElement('span');
            lbl.textContent = `${ce.effortLabel} · ${formatSavedPrefLabel(ce)}`;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ctx-conflict-btn';
            btn.textContent = t('models.conflict.useThis');
            btn.addEventListener('click', () => { void resolveProductConflict(product, ce); });
            r.appendChild(lbl);
            r.appendChild(btn);
            rows.push(r);
          }
          const selfRow = document.createElement('div');
          selfRow.className = 'ctx-conflict-row';
          const selfHint = document.createElement('span');
          selfHint.textContent = t('models.conflict.orCustom');
          const selfBtn = document.createElement('button');
          selfBtn.type = 'button';
          selfBtn.className = 'ctx-conflict-btn';
          selfBtn.textContent = t('models.conflict.selfSet');
          selfBtn.addEventListener('click', () => {
            ctxCustomInput?.focus?.();
          });
          selfRow.appendChild(selfHint);
          selfRow.appendChild(selfBtn);
          rows.push(selfRow);
          ctxConflictRows.replaceChildren(...rows);
        }
      } else {
        ctxConflictBanner.hidden = true;
      }
    }

    // 0. 模型能力参考卡片渲染（紧邻预算设置区，不隐藏；严格区分模型上限 / 客户端限制 / 运行策略默认预算 / 可采纳范围）
    const capSummary = getProductCapabilitySummary(product);
    const runtimePolicy = capSummary?.runtimePolicy || resolveRuntimeUnlockPolicyClient();
    if (ctxCapWindowEl) {
      ctxCapWindowEl.textContent = capSummary?.maxTokens ? `${fmt(capSummary.maxTokens)} tokens` : '未知（待获取元数据）';
    }
    if (ctxCapOutputEl) {
      ctxCapOutputEl.textContent = capSummary?.maxOutputTokens != null ? `${fmt(capSummary.maxOutputTokens)} tokens` : '未知';
    }
    if (ctxCapModelMaxEl) {
      ctxCapModelMaxEl.textContent = capSummary?.modelTheoreticalMaxTokens != null
        ? `${fmt(capSummary.modelTheoreticalMaxTokens)} tokens`
        : t('models.cap.metaUnknown');
    }
    if (ctxCapClientPolicyEl) {
      if (!runtimePolicy || runtimePolicy.runtimeState === 'unknown') {
        ctxCapClientPolicyEl.textContent = t('models.cap.policyUnknown');
      } else if (runtimePolicy.runtimeState === 'pending_restart') {
        ctxCapClientPolicyEl.textContent = t('models.cap.policyPendingRestart', { disk: formatDiskPolicyText(runtimePolicy) });
      } else if (runtimePolicy.runtimeState === 'runtime_unconfirmed') {
        ctxCapClientPolicyEl.textContent = t('models.cap.policyUnconfirmed', { disk: formatDiskPolicyText(runtimePolicy) });
      } else if (runtimePolicy.runtimeState === 'partial') {
        ctxCapClientPolicyEl.textContent = t('models.cap.policyPartial');
      } else if (runtimePolicy.runtimeMode === 'dynamic') {
        ctxCapClientPolicyEl.textContent = t('models.cap.policyDynamic');
      } else if (runtimePolicy.runtimeMode === 'fixed' && runtimePolicy.currentClientLimitTokens != null) {
        ctxCapClientPolicyEl.textContent = t('models.cap.policyFixed', { limit: fmt(runtimePolicy.currentClientLimitTokens) });
      } else {
        ctxCapClientPolicyEl.textContent = t('models.cap.policyDefault');
      }
    }
    if (ctxCapDefaultEl) {
      if (capSummary?.currentStrategyDefaultBudget != null && runtimePolicy?.policyKnown) {
        let stratNote = '';
        if (runtimePolicy.runtimeMode === 'dynamic') {
          stratNote = t('models.cap.stratDynamic');
        } else if (runtimePolicy.runtimeMode === 'fixed') {
          stratNote = t('models.cap.stratFixed', { limit: fmt(runtimePolicy.currentClientLimitTokens) });
        } else {
          stratNote = t('models.cap.stratDefault');
        }
        ctxCapDefaultEl.textContent = `${fmt(capSummary.currentStrategyDefaultBudget)} tokens${stratNote}`;
      } else if (runtimePolicy && !runtimePolicy.policyKnown) {
        ctxCapDefaultEl.textContent = t('models.cap.defaultUnknownPolicy');
      } else {
        ctxCapDefaultEl.textContent = t('speed.unknown');
      }
    }
    if (ctxCapRangeEl) {
      if (capSummary?.maxAdjustableTokens != null) {
        ctxCapRangeEl.textContent = `${fmt(capSummary.rangeMin || CTX_MIN_ENGINEERING_TOKENS)} – ${fmt(capSummary.maxAdjustableTokens)} tokens`;
      } else if (runtimePolicy && !runtimePolicy.policyKnown) {
        ctxCapRangeEl.textContent = capSummary?.modelTheoreticalMaxTokens != null
          ? t('models.cap.rangeUnknownPolicyMax', { max: fmt(capSummary.modelTheoreticalMaxTokens) })
          : t('models.cap.rangeUnknownPolicyEng', { min: fmt(CTX_MIN_ENGINEERING_TOKENS), max: fmt(CTX_MAX_ENGINEERING_TOKENS) });
      } else {
        ctxCapRangeEl.textContent = t('models.cap.rangeUnknownModelMax', { min: fmt(CTX_MIN_ENGINEERING_TOKENS), max: fmt(CTX_MAX_ENGINEERING_TOKENS) });
      }
    }
    if (ctxCapFormulaEl) {
      const parts = [];
      if (capSummary?.sources?.length) {
        const srcText = capSummary.sources.map(s => (
          s === 'get_available_models'
            ? (currentPanelLanguage === 'en' ? 'GetAvailableModels Catalog' : (currentPanelLanguage === 'zh-TW' ? 'GetAvailableModels 目錄' : 'GetAvailableModels 目录'))
            : (s === 'step_model_info'
              ? (currentPanelLanguage === 'en' ? 'Session Step ModelInfo' : (currentPanelLanguage === 'zh-TW' ? '工作階段 Step ModelInfo' : '会话 Step ModelInfo'))
              : s)
        )).join(' + ');
        parts.push(currentPanelLanguage === 'en' ? `Source: ${srcText}` : `来源：${srcText}`);
      }
      if (capSummary?.formulaNote) {
        parts.push(typeof translateBackendText === 'function' ? translateBackendText(capSummary.formulaNote) : capSummary.formulaNote);
      } else {
        parts.push(currentPanelLanguage === 'en'
          ? 'Window & max output metadata not received for current account/step (never inferred from name).'
          : (currentPanelLanguage === 'zh-TW'
            ? '尚未取得目前帳號/步驟的模型視窗與最大輸出中繼資料（不依模型名稱推測上限）。'
            : '尚未获取到当前账号/步骤的模型窗口与最大输出元数据（不按模型名称推测上限）。'));
      }
      if (capSummary?.policyNote) {
        parts.push(typeof translateBackendText === 'function' ? translateBackendText(capSummary.policyNote) : capSummary.policyNote);
      }
      if (capSummary?.hasTierVariance) {
        parts.push(currentPanelLanguage === 'en'
          ? 'Note: effort tiers report varying window/output caps; adjustable limit uses safe intersection (see Tier Capabilities below).'
          : (currentPanelLanguage === 'zh-TW'
            ? '注意：該模型不同力度檔位回報了不同容量/最大輸出，可調上限取安全交集，詳情見下方「檔位能力」。'
            : '注意：该模型不同力度档位报告了不同容量/最大输出，可调上限取安全交集，详情见下方「档位能力」。'));
      }
      if (runtimePolicy?.diskVsRuntimeMismatch) {
        parts.push(currentPanelLanguage === 'en'
          ? 'Disk config and running process not yet verified consistent: projections are treated as unconfirmed.'
          : (currentPanelLanguage === 'zh-TW'
            ? '磁碟設定與執行中程序尚未確認一致：以下預測與預設預算均依未確認處理，請勿當作已實機生效。'
            : '磁盘配置与运行中进程尚未确认一致：以下预测与默认预算均按未确认处理，请勿当作已实机生效。'));
      }
      ctxCapFormulaEl.textContent = parts.join(currentPanelLanguage === 'en' ? '; ' : '；');
    }
    if (ctxRefSavedEl) {
      const targetSavedLabel = getContextScopeMode() === 'unified'
        ? formatSavedPrefLabel(contextUnifiedPreference)
        : pState.displayText;
      ctxRefSavedEl.textContent = targetSavedLabel;
    }
    if (ctxRefSentEl) {
      ctxRefSentEl.textContent = evalResult.requestText || t('models.cap.noneVerified');
    }
    if (ctxRefAdoptedEl) {
      ctxRefAdoptedEl.textContent = evalResult.observedText || t('models.cap.noneVerified');
    }

    if (ctxUnifiedProjEl) {
      if (getContextScopeMode() === 'unified' && typeof budgetEngine.projectUnifiedBudgetForProducts === 'function') {
        const allProducts = getKnownModelProducts().filter(p => p.inAccountCatalog);
        const projections = budgetEngine.projectUnifiedBudgetForProducts(contextUnifiedPreference, allProducts, currentUnlockStatus, state.modelCapabilitiesById || null);
        if (projections.length > 0 && typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof ctxUnifiedProjEl.replaceChildren === 'function') {
          const titleDiv = document.createElement('div');
          titleDiv.className = 'ctx-unified-proj-title';
          titleDiv.textContent = t('models.unified.projTitle');
          const rowNodes = [titleDiv];
          const isEnProj = currentPanelLanguage === 'en';
          const isTwProj = currentPanelLanguage === 'zh-TW';
          for (const pr of projections.slice(0, 8)) {
            const row = document.createElement('div');
            const isWarnRow = pr.outcome === 'clamped_to_model_max' || pr.outcome === 'exceeds_client_policy' || pr.outcome === 'clamped_by_client_policy' || pr.outcome === 'pending_restart_unconfirmed' || pr.outcome === 'partial_policy_unconfirmed' || pr.outcome === 'runtime_unconfirmed';
            row.className = `ctx-unified-proj-row${isWarnRow ? ' is-clamped' : ''}`;
            const lbl = document.createElement('span');
            lbl.textContent = pr.productLabel;
            const val = document.createElement('strong');
            if (pr.outcome === 'clamped_to_model_max') {
              val.textContent = isEnProj ? `Capped by model max -> ~${fmt(pr.projectedTokens)}` : (isTwProj ? `受模型上限限制 -> 預計 ${fmt(pr.projectedTokens)}（最大可用）` : `受模型上限限制 -> 预计 ${fmt(pr.projectedTokens)}（最大可用）`);
            } else if (pr.outcome === 'exceeds_client_policy') {
              val.textContent = isEnProj ? `Exceeds policy -> ~${fmt(pr.projectedTokens)} (limit ${fmt(pr.clientLimitTokens)})` : `超出当前客户端限制 -> 预计仅保底 ${fmt(pr.projectedTokens)}（策略上限 ${fmt(pr.clientLimitTokens)}）`;
            } else if (pr.outcome === 'clamped_by_client_policy') {
              val.textContent = isEnProj ? `Capped by policy -> ~${fmt(pr.projectedTokens)} (limit ${fmt(pr.clientLimitTokens)})` : `受当前客户端限制 -> 预计 ${fmt(pr.projectedTokens)}（策略上限 ${fmt(pr.clientLimitTokens)}）`;
            } else if (pr.outcome === 'pending_restart_unconfirmed') {
              val.textContent = isEnProj ? 'Pending restart (disk updated)' : (isTwProj ? '待重啟確認（磁碟已改）' : '待验证（磁盘已改，客户端未重启）');
            } else if (pr.outcome === 'runtime_unconfirmed') {
              val.textContent = isEnProj ? 'Pending (runtime unconfirmed)' : (isTwProj ? '待驗證（執行中程序未確認）' : '待验证（运行中进程未确认）');
            } else if (pr.outcome === 'partial_policy_unconfirmed') {
              val.textContent = t('models.cap.policyPartial');
            } else if (pr.outcome === 'unknown_policy') {
              val.textContent = t('models.cap.policyUnknown');
            } else if (pr.outcome === 'unknown_cap') {
              val.textContent = isEnProj ? 'Model cap unknown' : '模型上限未知';
            } else if (pr.outcome === 'client_default' && pr.projectedTokens != null) {
              val.textContent = isEnProj ? `~${fmt(pr.projectedTokens)} tokens (Policy default)` : `预计 ${fmt(pr.projectedTokens)} tokens（当前策略默认）`;
            } else if (pr.outcome === 'dynamic_follow' && pr.projectedTokens != null) {
              val.textContent = isEnProj ? `~${fmt(pr.projectedTokens)} tokens (Dynamic default)` : `预计 ${fmt(pr.projectedTokens)} tokens（Dynamic 默认）`;
            } else if (pr.projectedTokens != null) {
              val.textContent = isEnProj ? `~${fmt(pr.projectedTokens)} tokens` : `预计 ${fmt(pr.projectedTokens)} tokens`;
            } else {
              val.textContent = t('models.summary.pendingConfirm');
            }
            row.appendChild(lbl);
            row.appendChild(val);
            rowNodes.push(row);
          }
          ctxUnifiedProjEl.replaceChildren(...rowNodes);
          ctxUnifiedProjEl.hidden = false;
        } else {
          ctxUnifiedProjEl.hidden = true;
        }
      } else {
        ctxUnifiedProjEl.hidden = true;
      }
    }

    if (ctxCardTierCapsRowEl && ctxCardTierCapsEl) {
      if (capSummary?.tierDetails?.length) {
        ctxCardTierCapsRowEl.hidden = false;
        const lines = capSummary.tierDetails.map(td => {
          const tierName = td.effort ? formatEffortZh(td.effort) : (td.modelId || t('models.cap.tierStandard'));
          const winTxt = td.maxTokens ? t('models.cap.tierWin', { val: fmt(td.maxTokens) }) : t('models.cap.tierWinUnk');
          const outTxt = td.maxOutputTokens != null ? t('models.cap.tierOut', { val: fmt(td.maxOutputTokens) }) : t('models.cap.tierOutUnk');
          const maxInTxt = (td.maxTokens && td.maxOutputTokens != null && td.maxTokens > td.maxOutputTokens)
            ? t('models.cap.tierAdj', { val: fmt(td.maxTokens - td.maxOutputTokens) })
            : t('models.cap.tierAdjUnk');
          return `${tierName}：${winTxt} / ${outTxt} / ${maxInTxt}`;
        });
        if (typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof ctxCardTierCapsEl.replaceChildren === 'function') {
          ctxCardTierCapsEl.replaceChildren(...lines.map(l => {
            const d = document.createElement('div');
            d.textContent = l;
            return d;
          }));
        } else {
          ctxCardTierCapsEl.textContent = lines.join(' | ');
        }
      } else {
        ctxCardTierCapsRowEl.hidden = true;
      }
    }

    // 1. 目标值（已保存）
    if (ctxCardSavedEl) {
      ctxCardSavedEl.textContent = pState.displayText;
      ctxCardSavedEl.title = (pState.pref?.mode === 'fixed' && pState.pref.limitTokens)
        ? `${fmt(pState.pref.limitTokens)} tokens`
        : '';
    }

    // 2. 本次请求携带值
    if (ctxCardRequestEl) {
      ctxCardRequestEl.textContent = evalResult.requestText;
      ctxCardRequestEl.title = evalResult.requestText;
    }

    // 3. 对应会话
    if (ctxCardConvoEl) {
      ctxCardConvoEl.textContent = evalResult.convoId;
      ctxCardConvoEl.title = evalResult.convoId;
    }

    // 4. 生效诊断
    if (ctxCardDiagnosisEl) {
      ctxCardDiagnosisEl.textContent = evalResult.diagnosis;
      ctxCardDiagnosisEl.title = evalResult.diagnosis;
      ctxCardDiagnosisEl.className = `ctx-metric-value ctx-metric-diagnosis-val is-${evalResult.status}`;
    }

    // 5. 底座引擎（严格区分磁盘配置与当前运行进程已加载状态）
    const statusInfo = mapUnlockDisplayStatus(currentUnlockStatus);
    if (ctxCardClientEl) {
      if (unlockStatusFetchError) {
        ctxCardClientEl.textContent = t('status.badge.unavailable');
      } else if (!currentUnlockStatus) {
        ctxCardClientEl.textContent = t('status.badge.reading');
      } else if (runtimePolicy?.runtimeState === 'pending_restart') {
        ctxCardClientEl.textContent = t('models.cap.diskPending', { disk: formatDiskPolicyText(runtimePolicy) });
      } else if (runtimePolicy?.runtimeState === 'runtime_unconfirmed') {
        ctxCardClientEl.textContent = t('models.cap.diskUnconfirmed', { disk: formatDiskPolicyText(runtimePolicy) });
      } else if (runtimePolicy?.runtimeState === 'partial') {
        ctxCardClientEl.textContent = t('models.cap.clientPartialAlert');
      } else if (runtimePolicy?.policyKnown && runtimePolicy.runtimeMode === 'dynamic') {
        ctxCardClientEl.textContent = t('models.cap.clientDynamicOk');
      } else if (runtimePolicy?.policyKnown && runtimePolicy.runtimeMode === 'fixed' && runtimePolicy.currentClientLimitTokens != null) {
        ctxCardClientEl.textContent = t('models.cap.fixedAdvice', { val: formatKShort(runtimePolicy.currentClientLimitTokens) });
      } else {
        ctxCardClientEl.textContent = describeClientModeValue(currentUnlockStatus);
      }
    }
    if (ctxCardClientTagEl) {
      if (unlockStatusFetchError || !currentUnlockStatus) {
        ctxCardClientTagEl.hidden = true;
      } else {
        ctxCardClientTagEl.hidden = false;
        ctxCardClientTagEl.textContent = statusInfo.badge;
        ctxCardClientTagEl.className = `key-pill ${statusInfo.pillClass}`;
      }
    }

    // 6. 实测预算 + 独立 serviceLimit
    const { latestBudgetObs, latestServiceLimitObs } = findLatestProductObservation(product);
    const preObs = findPreRestartBudgetForProduct(product);
    if (ctxCardObservedBudgetEl) {
      if (pendingRestartVerification && !latestBudgetObs && preObs) {
        ctxCardObservedBudgetEl.textContent = t('models.card.observedWaitRestart');
        ctxCardObservedBudgetEl.title = '';
      } else if (latestBudgetObs?.budget > 0) {
        const effTxt = latestBudgetObs.effort ? ` · ${formatEffortZh(latestBudgetObs.effort)}` : '';
        const tTxt = latestBudgetObs.ts ? ` · ${formatMonthDayTime(latestBudgetObs.ts)}` : '';
        ctxCardObservedBudgetEl.textContent = `${formatKShort(latestBudgetObs.budget)}${effTxt}${tTxt}`;
        ctxCardObservedBudgetEl.title = t('models.card.observedTitle', { val: fmt(latestBudgetObs.budget) });
      } else {
        ctxCardObservedBudgetEl.textContent = t('models.card.observedBudgetNone');
        ctxCardObservedBudgetEl.title = '';
      }
    }
    if (ctxCardPreRestartBudgetEl) {
      if (!latestBudgetObs && preObs?.budget > 0) {
        const effTxt = preObs.effort ? ` · ${formatEffortZh(preObs.effort)}` : '';
        const tTxt = preObs.ts ? ` · ${formatMonthDayTime(preObs.ts)}` : '';
        ctxCardPreRestartBudgetEl.textContent = `${t('models.card.preRestartTitle', { val: formatKShort(preObs.budget) }).replace(/ tokens$/, '')}${effTxt}${tTxt}`;
        ctxCardPreRestartBudgetEl.title = t('models.card.preRestartTitle', { val: fmt(preObs.budget) });
        ctxCardPreRestartBudgetEl.hidden = false;
      } else {
        ctxCardPreRestartBudgetEl.title = '';
        ctxCardPreRestartBudgetEl.hidden = true;
      }
    }
    if (ctxCardServiceLimitEl) {
      if (latestServiceLimitObs?.serviceLimit > 0) {
        const tTxt = latestServiceLimitObs.ts ? `（${formatMonthDayTime(latestServiceLimitObs.ts)}）` : '';
        ctxCardServiceLimitEl.textContent = `${t('models.card.serviceLimit', { val: formatKShort(latestServiceLimitObs.serviceLimit) })}${tTxt}`;
        ctxCardServiceLimitEl.title = t('models.card.serviceLimitTitle', { val: fmt(latestServiceLimitObs.serviceLimit) });
        ctxCardServiceLimitEl.hidden = false;
      } else {
        ctxCardServiceLimitEl.title = '';
        ctxCardServiceLimitEl.hidden = true;
      }
    }

    // 7. 实测速度（按档位逐行显示中位数、样本数、时间，不跨档位借用）
    if (ctxCardObservedSpeedEl) {
      const mergedCalls = mergeAvailableSpeedCalls();
      const summaryRows = typeof summarizeSpeedByModel === 'function'
        ? summarizeSpeedByModel(mergedCalls, { days: 'all', cascadeModelConfigs: state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [] })
        : [];
      const summaryByExact = new Map(summaryRows.map(r => [r.modelExactId, r]));
      const members = product.members?.length ? product.members : [{ modelId: product.productKey, label: product.productLabel, effort: null }];
      const lines = [];
      for (const m of members) {
        const stat = summaryByExact.get(m.modelId);
        const prefix = m.effort ? `${formatEffortZh(m.effort)} ` : '';
        if (stat && stat.medianTps != null) {
          const tStr = stat.maxTs ? ` · ${formatMonthDayTime(stat.maxTs)}` : '';
          const lowNote = stat.lowSample ? t('models.card.lowSampleParen') : '';
          lines.push(t('models.card.speedLineText', { prefix, tps: stat.medianTps, count: stat.count, low: lowNote, ts: tStr }));
        } else {
          lines.push(`${prefix}${t('models.card.observedSpeedNone')}`);
        }
      }
      if (typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof ctxCardObservedSpeedEl.replaceChildren === 'function') {
        const lineNodes = lines.map(txt => {
          const d = document.createElement('div');
          d.textContent = txt;
          return d;
        });
        ctxCardObservedSpeedEl.replaceChildren(...lineNodes);
      } else {
        ctxCardObservedSpeedEl.textContent = lines.join(' | ');
      }
    }

    // 8. 提示规则与 Notice 说明
    if (ctxCardHintsEl) {
      const hints = [];
      if (product.notice) {
        const nText = typeof product.notice === 'string' ? product.notice : (product.notice.message || JSON.stringify(product.notice));
        hints.push(`模型提示：${nText}`);
      }
      if (product.unavailable && product.unavailabilityReason) {
        hints.push(`不可用原因：${product.unavailabilityReason}`);
      } else if (product.partialUnavailable && product.unavailabilityReason) {
        hints.push(`部分档位受限：${product.unavailabilityReason}`);
      }
      if (
        currentUnlockStatus?.configuredMode === 'fixed' &&
        currentUnlockStatus.configuredLimitTokens &&
        pState.pref &&
        !(pState.pref.mode === 'fixed' && Number(pState.pref.limitTokens) === Number(currentUnlockStatus.configuredLimitTokens))
      ) {
        hints.push(t('models.card.hintDiffClient'));
      }
      if (pState.pref?.mode === 'dynamic') {
        hints.push(t('models.validation.dynamicDesc'));
      }
      if (
        currentUnlockStatus?.configuredMode === 'fixed' &&
        currentUnlockStatus.configuredLimitTokens > 0 &&
        latestBudgetObs?.budget > 0 &&
        latestBudgetObs.budget < currentUnlockStatus.configuredLimitTokens
      ) {
        hints.push(t('models.card.hintBelowSet'));
      }
      if (hints.length > 0) {
        ctxCardHintsEl.hidden = false;
        if (typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof ctxCardHintsEl.replaceChildren === 'function') {
          const nodes = hints.map(h => {
            const div = document.createElement('div');
            div.className = 'ctx-card-hint-item';
            div.textContent = h;
            return div;
          });
          ctxCardHintsEl.replaceChildren(...nodes);
        } else {
          ctxCardHintsEl.textContent = hints.join(' ');
        }
      } else {
        ctxCardHintsEl.hidden = true;
      }
    }

    // 9. 精简主界面展示：当前模式、当前模型、目标设置与状态
    if (ctxSummaryModeEl) {
      ctxSummaryModeEl.textContent = contextScopeMode === 'unified'
        ? (t('models.mode.unifiedTitle') || '所有模型统一设置')
        : (t('models.mode.perModelTitle') || '按模型分别设置');
    }
    if (ctxSummaryModelEl) {
      if (contextScopeMode === 'unified') {
        ctxSummaryModelEl.textContent = t('models.summary.unifiedTarget') || '所有模型（统一生效）';
      } else if (activeSessionModelConfirmed && activeSessionProductKey === product.productKey) {
        ctxSummaryModelEl.textContent = product.productLabel;
      } else if (activeSessionModelConfirmed && activeSessionProductKey) {
        const cur = getKnownModelProducts().find(p => p.productKey === activeSessionProductKey);
        ctxSummaryModelEl.textContent = cur ? cur.productLabel : product.productLabel;
      } else if (product) {
        ctxSummaryModelEl.textContent = product.productLabel;
      } else {
        ctxSummaryModelEl.textContent = t('models.summary.pendingConfirm');
      }
    }
    if (ctxSummaryLengthEl) {
      ctxSummaryLengthEl.textContent = evalResult.targetText;
    }
    if (ctxSummaryStatusPillEl) {
      if (needsRestartAfterApply) {
        ctxSummaryStatusPillEl.hidden = false;
        ctxSummaryStatusPillEl.textContent = t('models.summary.pendingRestart') || '待重启生效';
        ctxSummaryStatusPillEl.className = 'key-pill pill-warn';
      } else {
        ctxSummaryStatusPillEl.hidden = false;
        ctxSummaryStatusPillEl.textContent = evalResult.badge;
        ctxSummaryStatusPillEl.className = `key-pill ${evalResult.pillClass}`;
      }
    }

    if (btnSaveModelCtx) btnSaveModelCtx.disabled = (contextScopeMode === 'unified') ? false : !product;
    if (btnResetModelCtx) btnResetModelCtx.disabled = (contextScopeMode === 'unified') ? false : !product;
  }

  function renderPresetSelectionUI() {
    const targetMode = ctxDraft.mode;
    const targetLimit = ctxDraft.limitTokens;
    const isUnified = contextScopeMode === 'unified';
    const currentProd = isUnified ? null : getSelectedProductObj();
    const capSummary = currentProd ? getProductCapabilitySummary(currentProd) : null;
    const knownEnvMax = (!isUnified && capSummary?.maxAdjustableTokens != null) ? capSummary.maxAdjustableTokens : null;
    const knownModelMax = (!isUnified && capSummary?.modelTheoreticalMaxTokens != null) ? capSummary.modelTheoreticalMaxTokens : null;
    const rp = capSummary?.runtimePolicy || resolveRuntimeUnlockPolicyClient();
    const policyKnown = Boolean(rp?.policyKnown);

    if (ctxPresetModelMaxSubEl) {
      if (isUnified) {
        ctxPresetModelMaxSubEl.textContent = t('models.preset.unifiedDisabled');
      } else if (knownEnvMax != null) {
        ctxPresetModelMaxSubEl.textContent = t('models.preset.envMax', { val: fmt(knownEnvMax) });
      } else if (!policyKnown && knownModelMax != null) {
        ctxPresetModelMaxSubEl.textContent = t('models.preset.policyUnconfirmed', { val: fmt(knownModelMax) });
      } else {
        ctxPresetModelMaxSubEl.textContent = t('models.preset.metaPending');
      }
    }

    const btns = ctxPresetGrid?.children || [];
    const applyPresetState = btn => {
      if (!btn) return;
      const bMode = btn.getAttribute?.('data-ctx-mode') || btn.dataset?.ctxMode;
      const bLimRaw = btn.getAttribute?.('data-ctx-limit') ?? btn.dataset?.ctxLimit;
      const bLim = bLimRaw ? Number(bLimRaw) : null;

      let disabled = false;
      let disableReason = '';
      const isEnPre = currentPanelLanguage === 'en';
      const isTwPre = currentPanelLanguage === 'zh-TW';
      if (bMode === 'model_max') {
        if (isUnified) {
          disabled = true;
          disableReason = isEnPre
            ? 'Max capacity varies per model in unified mode. Switch to Per-Model or enter a specific number.'
            : (isTwPre
              ? '統一模式下各模型最大可用上限不同，請切換為依模型個別設定或填寫具體數值。'
              : '统一模式下各模型最大可用上限不同，请切换到按模型分别设置或填写具体数值。');
        } else if (knownModelMax == null) {
          disabled = true;
          disableReason = isEnPre
            ? 'Context window and max output metadata not loaded yet for this model.'
            : (isTwPre
              ? '尚未取得此模型的上下文視窗與最大輸出中繼資料，無法計算最大可用值。'
              : '尚未获取到该模型的上下文窗口与最大输出元数据，无法计算最大可用值。');
        } else if (!policyKnown || knownEnvMax == null) {
          disabled = true;
          disableReason = isEnPre
            ? 'Client runtime policy is unknown or pending restart; environment max cannot be verified yet.'
            : (isTwPre
              ? '目前用戶端執行策略未知或待重啟確認，暫無法確定目前環境最大可用上限。'
              : '当前客户端运行策略未知或待重启确认，暂无法确定当前环境最大可用上限。');
        }
      } else if (bMode === 'fixed' && bLim && knownModelMax != null && bLim > knownModelMax) {
        disabled = true;
        disableReason = isEnPre
          ? `Preset ${fmt(bLim)} exceeds model theoretical input cap ${fmt(knownModelMax)} (window - max output).`
          : (isTwPre
            ? `預設 ${fmt(bLim)} 超出目前模型理論輸入上限 ${fmt(knownModelMax)}（總視窗 - 最大輸出）。`
            : `预设 ${fmt(bLim)} 超出当前模型理论输入上限 ${fmt(knownModelMax)}（总窗口 - 最大输出）。`);
      }

      if ('disabled' in btn) btn.disabled = disabled;
      if (btn.classList) {
        if (disabled) btn.classList.add('is-disabled');
        else btn.classList.remove('is-disabled');
      }
      if ('title' in btn) btn.title = disableReason;

      const matched = !disabled && (
        (bMode === 'model_max' && targetMode === 'fixed' && knownEnvMax != null && targetLimit === knownEnvMax) ||
        (bMode === targetMode && (targetMode !== 'fixed' || bLim === targetLimit))
      );
      if (btn.classList) {
        if (matched) btn.classList.add('active');
        else btn.classList.remove('active');
      }
      btn.setAttribute?.('aria-pressed', String(Boolean(matched)));
    };
    if (typeof ctxPresetGrid?.querySelectorAll === 'function') {
      const list = ctxPresetGrid.querySelectorAll('.ctx-preset-btn');
      if (list && typeof list.length === 'number') {
        for (let i = 0; i < list.length; i++) applyPresetState(list[i]);
      }
    } else if (Array.isArray(btns)) {
      for (const b of btns) applyPresetState(b);
    }

    if (ctxCustomInput && 'value' in ctxCustomInput) {
      if (targetMode === 'dynamic') {
        ctxCustomInput.value = '';
        ctxCustomInput.placeholder = t('models.input.phFollow');
      } else if (targetMode === 'default') {
        ctxCustomInput.value = '';
        ctxCustomInput.placeholder = t('models.input.phDefault');
      } else if (targetLimit != null) {
        const cleanVal = String(targetLimit);
        if (ctxCustomInput.value !== cleanVal && !ctxDraftDirty) {
          ctxCustomInput.value = cleanVal;
        }
      }
    }
    updateValidationMessageUI();
  }

  function updateValidationMessageUI() {
    if (!ctxValidationEl) return;
    if (ctxDraft.mode === 'dynamic') {
      ctxValidationEl.className = 'ctx-validation-msg';
      ctxValidationEl.textContent = t('models.validation.dynamicDesc');
      return;
    }
    if (ctxDraft.mode === 'default') {
      ctxValidationEl.className = 'ctx-validation-msg';
      ctxValidationEl.textContent = t('models.validation.defaultDesc');
      return;
    }
    const rawVal = ctxCustomInput && 'value' in ctxCustomInput && ctxCustomInput.value !== ''
      ? ctxCustomInput.value
      : ctxDraft.limitTokens;
    const val = validateCustomLimitClient(rawVal, 'fixed');
    if (!val.ok) {
      ctxValidationEl.className = 'ctx-validation-msg is-error';
      ctxValidationEl.textContent = val.error;
      return;
    }
    if (val.warnings && val.warnings.length > 0) {
      ctxValidationEl.className = 'ctx-validation-msg is-warn';
      ctxValidationEl.textContent = val.warnings.join(' ');
      return;
    }
    ctxValidationEl.className = 'ctx-validation-msg';
    ctxValidationEl.textContent = t('models.input.validFixed', { short: formatKShort(val.limitTokens), full: fmt(val.limitTokens) });
  }

  function loadDraftFromSelectedModel(forceResetDraft = false) {
    if (!ctxDraftDirty || forceResetDraft) {
      if (contextScopeMode === 'unified') {
        const pref = contextUnifiedPreference;
        if (pref && pref.mode) {
          ctxDraft = {
            mode: pref.mode || 'default',
            limitTokens: pref.mode === 'fixed' ? (pref.limitTokens || null) : null
          };
        } else {
          ctxDraft = { mode: 'default', limitTokens: null };
        }
      } else {
        const prod = getSelectedProductObj();
        const pState = resolveProductPreferenceState(prod);
        const pref = pState.pref;
        if (pref) {
          ctxDraft = {
            mode: pref.mode || 'default',
            limitTokens: pref.mode === 'fixed' ? (pref.limitTokens || null) : null
          };
        } else {
          const rp = resolveRuntimeUnlockPolicyClient();
          if (rp?.policyKnown && rp.runtimeMode !== 'unknown' && rp.runtimeMode !== 'partial') {
            ctxDraft = {
              mode: rp.runtimeMode,
              limitTokens: rp.runtimeMode === 'fixed' ? (rp.currentClientLimitTokens ?? null) : null
            };
          } else {
            ctxDraft = { mode: 'default', limitTokens: null };
          }
        }
      }
      ctxDraftDirty = false;
      if (ctxCustomInput && 'value' in ctxCustomInput) {
        ctxCustomInput.value = (ctxDraft.mode === 'fixed' && ctxDraft.limitTokens != null) ? String(ctxDraft.limitTokens) : '';
      }
    }
    renderModelSettingsTab();
    renderPresetSelectionUI();
  }

  function renderModelSettingsTab() {
    const products = getKnownModelProducts();
    const currentProd = getSelectedProductObj();
    if (btnModeUnified) {
      if (contextScopeMode === 'unified') addClass(btnModeUnified, 'is-active');
      else removeClass(btnModeUnified, 'is-active');
      btnModeUnified.setAttribute('aria-checked', contextScopeMode === 'unified' ? 'true' : 'false');
    }
    if (btnModePerModel) {
      if (contextScopeMode === 'per_model') addClass(btnModePerModel, 'is-active');
      else removeClass(btnModePerModel, 'is-active');
      btnModePerModel.setAttribute('aria-checked', contextScopeMode === 'per_model' ? 'true' : 'false');
    }
    if (ctxModelsToolbar) {
      ctxModelsToolbar.hidden = (contextScopeMode === 'unified');
    }
    if (ctxModelListEl) {
      ctxModelListEl.hidden = (contextScopeMode === 'unified');
    }
    renderCompactSessionCard();
    renderClientStatusBar();
    renderModelListGroup(products);
    renderModelDetailCard(currentProd);
    renderPresetSelectionUI();
  }

  function recordObservationFromSummary(summary, convoId, opts = {}) {
    if (!summary) return;
    const rawId = resolveStableModelKeyClient(summary);
    if (!rawId && !summary.model) return;
    const g = groupProductSafe({
      modelId: rawId || summary.model,
      label: summary.model || rawId,
      modelOrAlias: summary.modelOrAlias,
      effort: summary.effort
    });
    if (!g?.productKey) return;

    if (budgetTracker && (summary.budget > 0 || summary.serviceLimit > 0 || opts.callId)) {
      budgetTracker.recordObservation({
        convoId: convoId || state.activeConversationId || state.route || null,
        productKey: g.productKey,
        modelId: rawId || g.productKey,
        modelLabel: summary.model || g.productLabel,
        effort: g.effort || summary.effort || null,
        budget: Number(summary.budget || 0),
        serviceLimit: Number(summary.serviceLimit || 0),
        callId: opts.callId || null,
        stepCount: Number.isFinite(opts.stepCount) ? opts.stepCount : -1,
        ts: opts.ts || 0
      });
    }
  }

  function syncContextModelSelectionFromState() {
    const prevProd = activeSessionProductKey;
    const activeConvId = state.activeConversationId || state.conversationId || state.route || null;

    // 1. 最高优先级：宿主输入框旁真实选中的模型（排除插件自身 DOM）
    const hostSelected = extractHostSelectedModel();

    let exactId = null;
    let detectedProduct = null;
    let detectedEffort = null;
    let isConfirmed = false;

    if (hostSelected && hostSelected.productKey) {
      exactId = hostSelected.modelId;
      detectedProduct = hostSelected.productKey;
      detectedEffort = hostSelected.effort;
      isConfirmed = true;
    } else if (state.latest && activeConvId) {
      // 2. 次优先级：检查 state.latest 是否属于当前活跃会话且非历史归档模型
      const candidateId = resolveStableModelKeyClient(state.latest);
      if (candidateId) {
        const configs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
        const matchedCfg = Array.isArray(configs) && configs.length > 0
          ? configs.find(c => (resolveStableModelKeyClient(c) || c.modelId) === candidateId)
          : null;
        const isAllowedInCatalog = Array.isArray(configs) && configs.length > 0
          ? Boolean(matchedCfg && !matchedCfg.isHistorical)
          : true;
        if (isAllowedInCatalog) {
          const g = groupProductSafe({
            modelId: candidateId,
            label: state.latest?.model || candidateId,
            modelOrAlias: state.latest?.modelOrAlias,
            effort: state.latest?.effort
          });
          exactId = candidateId;
          detectedProduct = g.productKey;
          detectedEffort = g.effort || state.latest?.effort || null;
          isConfirmed = true;
        }
      }
    }

    if (isConfirmed && exactId && detectedProduct) {
      activeSessionModelKey = exactId;
      activeSessionProductKey = detectedProduct;
      activeSessionEffort = detectedEffort;
      activeSessionModelConfirmed = true;
      // 严禁在此处用 Date.now() 伪造观测时间戳；仅当无观测记录且有明确后端快照时保留已有真实观测
    } else {
      activeSessionModelConfirmed = false;
      activeSessionModelKey = null;
      activeSessionProductKey = null;
      activeSessionEffort = null;
    }

    if (activeSessionModelConfirmed && activeSessionProductKey && (!manualModelSelection || !selectedProductKey)) {
      const switched = prevProd !== activeSessionProductKey || selectedProductKey !== activeSessionProductKey;
      selectedProductKey = activeSessionProductKey;
      selectedEditModelKey = activeSessionModelKey;
      if (switched) {
        ctxDraftDirty = false;
        loadDraftFromSelectedModel(true);
      }
    }
    renderHeaderModelDropdown();
    renderCompactSessionCard();
    if (typeof renderQuotaBoard === 'function') renderQuotaBoard();
    if (!isContextSettingsView && activeContextTab === 'models') {
      renderModelSettingsTab();
    } else if (!isContextSettingsView && activeContextTab === 'speed') {
      renderSpeedComparisonTab();
    }
  }

  ctxPresetGrid?.addEventListener('click', (e) => {
    const btn = e?.target?.closest?.('.ctx-preset-btn');
    if (!btn || btn.disabled) return;
    userActionSeq++;
    const mode = btn.getAttribute?.('data-ctx-mode') || btn.dataset?.ctxMode || 'default';
    const rawLim = btn.getAttribute?.('data-ctx-limit') ?? btn.dataset?.ctxLimit;
    ctxDraftDirty = true;
    if (mode === 'dynamic') {
      ctxDraft = { mode: 'dynamic', limitTokens: null };
    } else if (mode === 'default') {
      ctxDraft = { mode: 'default', limitTokens: null };
    } else if (mode === 'model_max') {
      const prod = contextScopeMode === 'unified' ? null : getSelectedProductObj();
      const cap = prod ? getProductCapabilitySummary(prod) : null;
      if (!cap || !cap.runtimePolicy?.policyKnown || cap.maxAdjustableTokens == null) {
        updateValidationMessageUI();
        return;
      }
      ctxDraft = { mode: 'fixed', limitTokens: cap.maxAdjustableTokens };
    } else {
      const lim = Number(rawLim || 512000);
      ctxDraft = { mode: 'fixed', limitTokens: lim };
    }
    if (ctxCustomInput && 'value' in ctxCustomInput) {
      ctxCustomInput.value = (ctxDraft.mode === 'fixed' && ctxDraft.limitTokens != null) ? String(ctxDraft.limitTokens) : '';
    }
    if (ctxResetNoticeEl) ctxResetNoticeEl.hidden = true;
    renderPresetSelectionUI();
  });

  ctxCustomInput?.addEventListener('input', () => {
    userActionSeq++;
    const rawStr = String(ctxCustomInput.value || '').trim();
    ctxDraftDirty = true;
    if (ctxResetNoticeEl) ctxResetNoticeEl.hidden = true;
    if (!rawStr) {
      ctxDraft = { mode: 'fixed', limitTokens: null };
      renderPresetSelectionUI();
      return;
    }
    const val = validateCustomLimitClient(rawStr, 'fixed');
    ctxDraft = {
      mode: 'fixed',
      limitTokens: val.ok ? val.limitTokens : null
    };
    renderPresetSelectionUI();
  });

  async function saveSettingsPayloadBridge(payload = {}) {
    const ipcFn = window.contextMeterAPI?.saveSettings
      ? () => window.contextMeterAPI.saveSettings(payload)
      : null;
    if (!ipcFn && !hasLiveHttpBridge()) {
      return { ok: false, error: t('msg.noHostBridge') };
    }
    try {
      const out = await callBackendWithPriority({
        ipcCall: ipcFn,
        liveRoute: '/save-settings',
        liveBody: payload
      });
      return out.result || { ok: false, error: t('msg.noHostBridge') };
    } catch (e) {
      return { ok: false, error: e?.message || t('msg.noHostBridge') };
    }
  }

  function showUnlockResultBox(isSuccess, html, opts = {}) {
    if (!unlockResultBox || !unlockResultText) return;
    unlockResultBox.style.display = 'block';
    unlockResultBox.className = `unlock-result-box ${isSuccess ? 'result-success' : 'result-error'}`;
    unlockResultText.innerHTML = html;
    const canRestartHost = Boolean(hostSupportsRestart);
    const needRestart = Boolean(opts.needsRestart);
    const showRetry = Boolean(opts.showRetry);
    if (btnUnlockResultRestart) btnUnlockResultRestart.hidden = !(needRestart && canRestartHost);
    if (btnUnlockResultRetry) btnUnlockResultRetry.hidden = !showRetry;
    if (unlockResultManual) unlockResultManual.hidden = !(needRestart && !canRestartHost);
    if (unlockResultActions) unlockResultActions.hidden = !((needRestart && canRestartHost) || showRetry);
  }

  async function saveCurrentProductDraft() {
    userActionSeq++;
    if (contextScopeMode === 'unified') {
      const rawLimit = ctxDraft.mode === 'fixed'
        ? (ctxCustomInput && 'value' in ctxCustomInput && ctxCustomInput.value !== '' ? ctxCustomInput.value : ctxDraft.limitTokens)
        : ctxDraft.limitTokens;
      const val = validateCustomLimitClient(rawLimit, ctxDraft.mode);
      if (!val.ok) {
        updateValidationMessageUI();
        return { ok: false, error: val.error };
      }
      contextUnifiedPreference = {
        modelId: 'unified',
        mode: val.mode,
        limitTokens: val.limitTokens,
        updatedAt: new Date().toISOString()
      };
      const res = await saveSettingsPayloadBridge({
        contextUnifiedPreference,
        contextScopeMode: 'unified'
      });
      if (!res || !res.ok) {
        return { ok: false, error: translateBackendText(res?.error) || t('msg.saveFail') };
      }
      syncContextPreferencesCache(contextPreferencesMap);
      ctxDraftDirty = false;
      renderModelSettingsTab();
      let notice = null;
      if (val.mode === 'fixed' && typeof budgetEngine.projectUnifiedBudgetForProducts === 'function') {
        const projs = budgetEngine.projectUnifiedBudgetForProducts(contextUnifiedPreference, getKnownModelProducts().filter(p => p.inAccountCatalog), currentUnlockStatus, state.modelCapabilitiesById || null);
        const clampedModel = projs.filter(p => p.outcome === 'clamped_to_model_max');
        const clampedClient = projs.filter(p => p.outcome === 'exceeds_client_policy' || p.outcome === 'clamped_by_client_policy');
        const unconfirmed = projs.filter(p => p.outcome === 'pending_restart_unconfirmed' || p.outcome === 'runtime_unconfirmed' || p.outcome === 'partial_policy_unconfirmed' || p.outcome === 'unknown_policy');
        const msgParts = [];
        if (clampedModel.length > 0) {
          msgParts.push(`部分模型低于统一值：${clampedModel.map(c => `${c.productLabel}(上限 ${fmt(c.projectedTokens)})`).join('、')} 预计仅采用各自最大可用上限`);
        }
        if (clampedClient.length > 0) {
          msgParts.push(`当前客户端限制为 ${fmt(clampedClient[0].clientLimitTokens)} tokens，超限模型预计仅保底 ${clampedClient.map(c => `${c.productLabel}(${fmt(c.projectedTokens)})`).join('、')}`);
        }
        if (unconfirmed.length > 0) {
          msgParts.push('当前客户端运行策略尚未确认/待重启，统一值能否实机采用需后续发送请求验证');
        }
        if (msgParts.length > 0) {
          notice = `已保存统一目标 ${fmt(val.limitTokens)} tokens。注意：${msgParts.join('；')}。`;
        }
      }
      return { ok: true, prod: null, val, notice };
    }

    const prod = getSelectedProductObj();
    if (!prod) {
      return { ok: false, error: t('msg.noModelsDetected') };
    }
    const rawLimit = ctxDraft.mode === 'fixed'
      ? (ctxCustomInput && 'value' in ctxCustomInput && ctxCustomInput.value !== '' ? ctxCustomInput.value : ctxDraft.limitTokens)
      : ctxDraft.limitTokens;
    const val = validateCustomLimitClient(rawLimit, ctxDraft.mode, prod);
    if (!val.ok) {
      updateValidationMessageUI();
      return { ok: false, error: val.error };
    }
    if (val.exceedsModelLimit) {
      updateValidationMessageUI();
      const capSummary = getProductCapabilitySummary(prod);
      const modelMaxCap = capSummary?.modelTheoreticalMaxTokens ?? val.adoptableTokens;
      const capText = modelMaxCap != null ? `${fmt(modelMaxCap)} tokens` : '已知模型理论上限';
      return {
        ok: false,
        error: `输入 ${fmt(val.limitTokens)} 超出 ${prod.productLabel} 模型理论输入上限 ${capText}（依据元数据：总窗口 - 最大输出）。请修改为 <= ${capText} 或重新选择合法档位，系统不会静默改写数值。`
      };
    }
    const legacyKeys = resolveProductPreferenceState(prod).legacyKeys;
    const thisSaveSeq = ++contextPrefSaveSeq;
    const res = await saveSettingsPayloadBridge({
      contextPreference: {
        scope: 'product',
        productKey: prod.productKey,
        modelId: prod.productKey,
        label: prod.productLabel,
        mode: val.mode,
        limitTokens: val.limitTokens,
        clearLegacyKeys: legacyKeys
      }
    });
    if (thisSaveSeq !== contextPrefSaveSeq) return { ok: false, stale: true };
    if (!res || !res.ok) {
      return { ok: false, error: translateBackendText(res?.error) || t('msg.saveFail') };
    }
    if (res.contextPreferences && typeof res.contextPreferences === 'object') {
      contextPreferencesMap = { ...res.contextPreferences };
    } else {
      for (const lk of legacyKeys) delete contextPreferencesMap[lk];
      contextPreferencesMap[prod.productKey] = {
        scope: 'product',
        productKey: prod.productKey,
        modelId: prod.productKey,
        label: prod.productLabel,
        mode: val.mode,
        limitTokens: val.limitTokens,
        updatedAt: new Date().toISOString()
      };
    }
    syncContextPreferencesCache(contextPreferencesMap);
    ctxDraftDirty = false;
    renderHeaderModelDropdown();
    renderModelSettingsTab();
    return { ok: true, prod, val };
  }

  btnSaveModelCtx?.addEventListener('click', async () => {
    if (ctxResetNoticeEl) ctxResetNoticeEl.hidden = true;
    const res = await saveCurrentProductDraft();
    if (res.stale) return;
    if (!res.ok) {
      showUnlockResultBox(false, res.error);
      return;
    }
    showUnlockResultBox(true, res.notice || t('models.status.savedPendingDispatch') || '已保存，下一次发送时尝试应用');
  });

  btnResetModelCtx?.addEventListener('click', async () => {
    userActionSeq++;
    if (contextScopeMode === 'unified') {
      contextUnifiedPreference = {
        modelId: 'unified',
        mode: 'default',
        limitTokens: null,
        updatedAt: new Date().toISOString()
      };
      const res = await saveSettingsPayloadBridge({
        contextUnifiedPreference: { mode: 'default' },
        contextScopeMode: 'unified'
      });
      if (!res || !res.ok) {
        showUnlockResultBox(false, t('msg.clearFail', { err: translateBackendText(res?.error) || t('msg.unknownErr') }));
        return;
      }
      syncContextPreferencesCache(contextPreferencesMap);
      ctxDraft = { mode: 'default', limitTokens: null };
      ctxDraftDirty = false;
      if (ctxCustomInput && 'value' in ctxCustomInput) ctxCustomInput.value = '';
      renderModelSettingsTab();
      renderPresetSelectionUI();
      showUnlockResultBox(true, t('models.summary.modelDefault') || '已恢复默认值');
      return;
    }

    const prod = getSelectedProductObj();
    if (!prod) return;
    const pState = resolveProductPreferenceState(prod);
    const oldSavedPref = pState.pref;
    const clearAll = [prod.productKey, ...pState.legacyKeys];
    const thisSaveSeq = ++contextPrefSaveSeq;
    const res = await saveSettingsPayloadBridge({
      clearContextPreferences: clearAll
    });
    if (thisSaveSeq !== contextPrefSaveSeq) return;
    if (!res || !res.ok) {
      showUnlockResultBox(false, t('msg.clearFail', { err: translateBackendText(res?.error) || t('msg.unknownErr') }));
      return;
    }
    if (res.contextPreferences && typeof res.contextPreferences === 'object') {
      contextPreferencesMap = { ...res.contextPreferences };
    } else {
      for (const k of clearAll) delete contextPreferencesMap[k];
    }
    syncContextPreferencesCache(contextPreferencesMap);
    ctxDraft = { mode: 'default', limitTokens: null };
    ctxDraftDirty = false;
    if (ctxCustomInput && 'value' in ctxCustomInput) ctxCustomInput.value = '';
    renderHeaderModelDropdown();
    renderModelSettingsTab();
    renderPresetSelectionUI();

    if (ctxResetNoticeEl) {
      const clientUsingSame = oldSavedPref && currentUnlockStatus && (
        (oldSavedPref.mode === 'dynamic' && currentUnlockStatus.configuredMode === 'dynamic') ||
        (oldSavedPref.mode === 'fixed' && currentUnlockStatus.configuredMode === 'fixed' && Number(oldSavedPref.limitTokens) === Number(currentUnlockStatus.configuredLimitTokens))
      );
      if (clientUsingSame) {
        const curVal = describeClientModeValue(currentUnlockStatus);
        ctxResetNoticeEl.textContent = t('msg.resetStillUsing', { val: curVal });
        ctxResetNoticeEl.hidden = false;
      } else {
        ctxResetNoticeEl.hidden = true;
      }
    }
    showUnlockResultBox(true, t('msg.resetDefault'));
  });

  function setScopeMode(newMode) {
    userActionSeq++;
    contextScopeMode = newMode === 'per_model' ? 'per_model' : 'unified';
    if (btnModeUnified) {
      if (contextScopeMode === 'unified') addClass(btnModeUnified, 'is-active');
      else removeClass(btnModeUnified, 'is-active');
      btnModeUnified.setAttribute('aria-checked', contextScopeMode === 'unified' ? 'true' : 'false');
    }
    if (btnModePerModel) {
      if (contextScopeMode === 'per_model') addClass(btnModePerModel, 'is-active');
      else removeClass(btnModePerModel, 'is-active');
      btnModePerModel.setAttribute('aria-checked', contextScopeMode === 'per_model' ? 'true' : 'false');
    }
    if (ctxModelsToolbar) {
      ctxModelsToolbar.hidden = (contextScopeMode === 'unified');
    }
    if (ctxModelListEl) {
      ctxModelListEl.hidden = (contextScopeMode === 'unified');
    }
    syncContextPreferencesCache(contextPreferencesMap);
    void saveSettingsPayloadBridge({ contextScopeMode });
    loadDraftFromSelectedModel(true);
    const prod = getSelectedProductObj();
    if (prod) renderModelDetailCard(prod);
  }

  btnModeUnified?.addEventListener('click', () => setScopeMode('unified'));
  btnModePerModel?.addEventListener('click', () => setScopeMode('per_model'));

  async function invokeUnlockApi(endpoint, payload = {}) {
    const ipcMap = {
      status: window.contextMeterAPI?.getContextUnlockStatus,
      apply: window.contextMeterAPI?.applyContextUnlock,
      restore: window.contextMeterAPI?.restoreContextUnlock
    };
    const ipcFn = typeof ipcMap[endpoint] === 'function' ? () => ipcMap[endpoint](payload) : null;
    if (!ipcFn && !hasLiveHttpBridge()) {
      return { ok: false, error: t('models.err.noApplyBridge') };
    }
    try {
      const out = await callBackendWithPriority({
        ipcCall: ipcFn,
        liveRoute: `/context-unlock-${endpoint}`,
        liveBody: payload
      });
      return out.result || { ok: false, error: t('models.err.noApplyBridge') };
    } catch (e) {
      return { ok: false, error: e?.message || t('models.err.noApplyBridge') };
    }
  }

  async function invokeRestartHostApi() {
    if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.restartHost === 'function') {
      return await window.contextMeterAPI.restartHost();
    }
    if (hasLiveHttpBridge()) {
      try {
        return await postLiveHttpEndpoint('/restart-host', {});
      } catch {
        return { ok: true, supported: false };
      }
    }
    return { ok: true, supported: false };
  }

  async function invokeEnhanceApi(endpoint, payload = {}) {
    const ipcMap = {
      status: window.contextMeterAPI?.getEnhanceStatus,
      apply: window.contextMeterAPI?.applyEnhancePatch,
      restore: window.contextMeterAPI?.restoreAllEnhance,
      'restart-ls': window.contextMeterAPI?.restartLanguageServers
    };
    const routeMap = {
      status: '/enhance-status',
      apply: '/enhance-apply',
      restore: '/enhance-restore',
      'restart-ls': '/restart-language-servers'
    };
    const ipcFn = typeof ipcMap[endpoint] === 'function' ? () => ipcMap[endpoint](payload) : null;
    const liveRoute = routeMap[endpoint] || '';
    if ((!ipcFn && !hasLiveHttpBridge()) || !liveRoute) {
      return { ok: false, errorKey: 'enhance.result.noBridge', error: t('enhance.result.noBridge'), unavailable: true };
    }
    try {
      const out = await callBackendWithPriority({
        ipcCall: ipcFn,
        liveRoute,
        liveBody: payload
      });
      return out.result || { ok: false, errorKey: 'enhance.result.noBridge', error: t('enhance.result.noBridge'), unavailable: true };
    } catch (e) {
      return { ok: false, error: e?.message || t('enhance.result.noBridge') };
    }
  }

  async function invokeModulesApi(action, name, enable, opts = {}) {
    const ipcFn = (action === 'status' && typeof window.contextMeterAPI?.getModulesStatus === 'function')
      ? () => window.contextMeterAPI.getModulesStatus()
      : ((action === 'toggle' && typeof window.contextMeterAPI?.toggleModule === 'function')
        ? () => window.contextMeterAPI.toggleModule(name, enable, opts)
        : null);
    const liveRoute = action === 'status' ? '/modules-status' : '/toggle-module';
    const liveBody = action === 'status' ? {} : { name, enable, opts };
    if (!ipcFn && !hasLiveHttpBridge()) {
      return { ok: false, error: t('msg.noHostBridge'), unavailable: true };
    }
    try {
      const out = await callBackendWithPriority({
        ipcCall: ipcFn,
        liveRoute,
        liveBody
      });
      return out.result || { ok: false, error: t('msg.noHostBridge'), unavailable: true };
    } catch (e) {
      return { ok: false, error: e?.message || t('msg.noHostBridge') };
    }
  }

  async function refreshUnlockStatus() {
    const thisSeq = ++unlockReqSeq;
    try {
      const currentObservedBudget = (state.latest?.budget && state.latest.budget > 0)
        ? state.latest.budget
        : undefined;
      const res = await invokeUnlockApi('status', { currentBudget: currentObservedBudget });
      if (thisSeq !== unlockReqSeq) return;

      if (!res || !res.ok || !res.data) {
        unlockStatusFetchError = true;
        currentUnlockStatus = null;
        if (unlockStatusDesc) unlockStatusDesc.textContent = t('status.client.unavailable');
        renderCompactSessionCard();
        renderClientStatusBar();
        if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
        return;
      }

      unlockStatusFetchError = false;
      const data = res.data;
      currentUnlockStatus = data;
      lastPartialReason = data.partialMatchReason || data.error || '';
      if (typeof data.hostSupportsRestart === 'boolean') {
        hostSupportsRestart = data.hostSupportsRestart;
      }
      if (data.status === 'patched_pending_restart') {
        needsRestartAfterApply = true;
      } else if (data.status === 'patched_loaded' || data.status === 'not_patched') {
        needsRestartAfterApply = false;
      }

      // 重启后校验核对
      if (pendingRestartVerification) {
        if (data.runtimeEvidence?.restartDetected === true) {
          if (data.status === 'patched_loaded' && doesClientMatchVerification(data, pendingRestartVerification)) {
            restartMismatchNotice = '';
          } else {
            restartMismatchNotice = t('models.status.restartMismatch', { actual: describeClientModeValue(data) });
          }
          pendingRestartVerification = null;
          void saveSettingsPayloadBridge({ uiPreferences: { restartVerification: null } });
        }
      }

      const statusInfo = mapUnlockDisplayStatus(data);
      if (unlockStatusDesc) {
        unlockStatusDesc.textContent = t('models.status.line', { badge: statusInfo.badge, mode: describeClientModeValue(data) });
      }
      if (unlockMetaMode) {
        unlockMetaMode.textContent = `${describeClientModeValue(data)}（${statusInfo.badge}）`;
      }
      if (unlockMetaTarget) {
        unlockMetaTarget.textContent = data.arch ? t('models.meta.targetDesktopArch', { arch: data.arch }) : t('models.meta.targetDesktop');
      }
      if (unlockMetaArch) unlockMetaArch.textContent = data.arch || t('models.meta.archUnknown');
      if (unlockMetaBackup) {
        unlockMetaBackup.textContent = data.hasBackup
          ? (data.backupStaleReason ? t('models.meta.backupStale') : t('models.meta.backupReady'))
          : t('models.meta.backupNone');
      }

      if (btnApplyUnlock) {
        const writableStatuses = new Set(['not_patched', 'patched_runtime_unconfirmed', 'patched_pending_restart', 'patched_loaded']);
        const archSupported = data.isPlatformSupported !== false && (!data.arch || data.arch === 'x86-64' || data.arch === 'arm64');
        if (writableStatuses.has(data.status) && archSupported) {
          btnApplyUnlock.disabled = false;
          btnApplyUnlock.textContent = t('models.btn.saveApply');
        } else if (data.status === 'partial_match') {
          btnApplyUnlock.disabled = true;
          btnApplyUnlock.textContent = t('models.btn.partialBlocked');
        } else if (data.status === 'failed') {
          btnApplyUnlock.disabled = false;
          btnApplyUnlock.textContent = t('models.btn.retryApply');
        } else {
          btnApplyUnlock.disabled = true;
          btnApplyUnlock.textContent = t('models.btn.unsupported');
        }
      }

      if (btnRestoreUnlock) {
        btnRestoreUnlock.disabled = !(
          (data.hasBackup && data.backupValidForCurrentBinary !== false) ||
          data.hasMatchingGate3BSidecar ||
          (data.status && data.status !== 'not_patched' && data.status !== 'unsupported')
        );
      }

      if (data.status === 'partial_match' && unlockResultBox && (!unlockResultBox.style.display || unlockResultBox.style.display === 'none')) {
        showUnlockResultBox(
          false,
          t('models.card.partialFailDetail', { reason: translateBackendText(lastPartialReason) || '' }),
          { showRetry: true }
        );
      }

      if (!ctxDraftDirty && !resolveProductPreferenceState(getSelectedProductObj()).pref) {
        loadDraftFromSelectedModel(false);
      } else {
        renderCompactSessionCard();
        renderClientStatusBar();
        if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
      }
      if (typeof syncEnhanceInteractiveDisabledState === 'function') {
        syncEnhanceInteractiveDisabledState();
      }
    } catch {
      if (thisSeq !== unlockReqSeq) return;
      unlockStatusFetchError = true;
      currentUnlockStatus = null;
      renderCompactSessionCard();
      renderClientStatusBar();
    }
  }

  btnRefreshUnlock?.addEventListener('click', () => {
    void refreshUnlockStatus();
  });

  function yieldForSettingsPaint() {
    if (typeof requestAnimationFrame === 'function') {
      return new Promise((resolve) => requestAnimationFrame(resolve));
    }
    if (typeof MessageChannel === 'function') {
      return new Promise((resolve) => {
        const mc = new MessageChannel();
        mc.port1.onmessage = () => resolve();
        mc.port2.postMessage(null);
      });
    }
    return Promise.resolve();
  }

  btnApplyUnlock?.addEventListener('click', async () => {
    if (isUnlocking) return;
    if (ctxResetNoticeEl) ctxResetNoticeEl.hidden = true;
    const saved = await saveCurrentProductDraft();
    if (saved.stale) return;
    if (!saved.ok) {
      showUnlockResultBox(false, saved.error);
      return;
    }

    isUnlocking = true;
    if (btnApplyUnlock) btnApplyUnlock.disabled = true;
    if (btnRestoreUnlock) btnRestoreUnlock.disabled = true;
    showUnlockResultBox(true, t('mod.processing'));
    needsRestartAfterApply = false;
    restartMismatchNotice = '';

    try {
      await yieldForSettingsPaint();
      // ELV-41: 底座统一应用为动态透传模式 (mov esi, edx)，使各模型设置能够独立生效，绝不把单一模型的数值固化进二进制
      const res = await invokeUnlockApi('apply', {
        mode: 'dynamic',
        limitTokens: null,
        serviceLimit: state.latest?.serviceLimit || undefined
      });
      if (!res || !res.ok) {
        needsRestartAfterApply = false;
        showUnlockResultBox(false, buildFriendlyWriteError(res?.error), { showRetry: true });
        return;
      }
      if (res.needsRestart === true) {
        needsRestartAfterApply = true;
        showUnlockResultBox(true, t('msg.appliedRestart'), { needsRestart: true });
      } else if (res.alreadyMatched) {
        needsRestartAfterApply = false;
        showUnlockResultBox(true, '底座引擎已处于动态跟随状态。当前模型设置已保存，下一次发送时尝试应用。');
      } else {
        needsRestartAfterApply = false;
        showUnlockResultBox(true, '已应用底座配置。当前模型设置已保存，下一次发送时尝试应用。');
      }
    } catch (e) {
      needsRestartAfterApply = false;
      showUnlockResultBox(false, buildFriendlyWriteError(e?.message), { showRetry: true });
    } finally {
      isUnlocking = false;
      if (btnApplyUnlock) btnApplyUnlock.disabled = false;
      if (btnRestoreUnlock) btnRestoreUnlock.disabled = false;
      await refreshUnlockStatus();
      if (!needsRestartAfterApply && currentUnlockStatus?.status === 'patched_pending_restart') {
        needsRestartAfterApply = true;
        renderClientStatusBar();
      }
    }
  });

  let isRestartInProgress = false;

  async function executeClientRestart(fromModal = false) {
    if (isRestartInProgress) return;
    isRestartInProgress = true;
    if (btnModalRestartConfirm) btnModalRestartConfirm.disabled = true;
    if (btnRestartConfirmGo) btnRestartConfirmGo.disabled = true;

    // 记录重启前的观测快照（不保存草稿）
    try {
      const obsObj = budgetTracker ? { ...budgetTracker.exportAllObservationsByProduct() } : {};
      for (const [mid, val] of observedByModelId.entries()) obsObj[mid] = val;
      preRestartSnapshot = { requestedAt: new Date().toISOString(), observations: obsObj };
      localStorage?.setItem(CTX_PRE_RESTART_OBS_KEY, JSON.stringify(preRestartSnapshot));
    } catch { }

    const feedbackEl = fromModal ? modalRestartFeedback : (modalRestartFeedback || ctxRestartFeedback);
    if (feedbackEl) {
      feedbackEl.textContent = t('client.restart.triggering');
      feedbackEl.hidden = false;
    }

    const res = await invokeRestartHostApi();
    if (!res || res.supported === false) {
      hostSupportsRestart = false;
      if (feedbackEl) {
        feedbackEl.textContent = t('client.restart.hostNotSupported');
        feedbackEl.hidden = false;
      }
      isRestartInProgress = false;
      if (btnModalRestartConfirm) btnModalRestartConfirm.disabled = false;
      if (btnRestartConfirmGo) btnRestartConfirmGo.disabled = false;
      renderClientStatusBar();
      return;
    }
    if (res.ok === false) {
      if (feedbackEl) {
        feedbackEl.textContent = t('client.restart.failed', { err: translateBackendText(res.error) || t('msg.unknownErr') });
        feedbackEl.hidden = false;
      }
      isRestartInProgress = false;
      if (btnModalRestartConfirm) btnModalRestartConfirm.disabled = false;
      if (btnRestartConfirmGo) btnRestartConfirmGo.disabled = false;
      return;
    }

    if (feedbackEl) {
      feedbackEl.textContent = t('models.restart.restarting');
      feedbackEl.hidden = false;
    }
    if (restartTimeoutTimer) clearTimeout(restartTimeoutTimer);
    restartTimeoutTimer = setTimeout(() => {
      if (!state.disposed && feedbackEl) {
        feedbackEl.textContent = t('models.restart.notExited');
        feedbackEl.hidden = false;
      }
      isRestartInProgress = false;
      if (btnModalRestartConfirm) btnModalRestartConfirm.disabled = false;
      if (btnRestartConfirmGo) btnRestartConfirmGo.disabled = false;
    }, 15000);
  }

  function openClientRestartConfirmFlow() {
    if (!hostSupportsRestart) {
      showUnlockResultBox(true, t('client.restart.hostNotSupported'), { needsRestart: true });
      const upStatusEl = el('up-pop-status');
      const upPop = el('update-popover');
      if (upStatusEl && upPop && upPop.style.display === 'block') {
        upStatusEl.style.display = 'block';
        upStatusEl.textContent = t('client.restart.hostNotSupported');
      }
      renderQuotaBoard?.();
      return;
    }
    if (globalRestartModal) {
      if (modalRestartFeedback) {
        modalRestartFeedback.textContent = '';
        modalRestartFeedback.hidden = true;
      }
      if (btnModalRestartConfirm) btnModalRestartConfirm.disabled = false;
      isRestartInProgress = false;
      globalRestartModal.hidden = false;
      return;
    }
    if (ctxRestartConfirm) {
      ctxRestartConfirm.hidden = false;
      if (ctxRestartFeedback) ctxRestartFeedback.hidden = true;
    }
  }

  btnRestartHost?.addEventListener('click', openClientRestartConfirmFlow);
  btnUnlockResultRestart?.addEventListener('click', openClientRestartConfirmFlow);
  btnUnlockResultRetry?.addEventListener('click', () => {
    if (unlockResultBox) unlockResultBox.style.display = 'none';
    void refreshUnlockStatus();
  });

  btnModalRestartCancel?.addEventListener('click', () => {
    if (globalRestartModal) globalRestartModal.hidden = true;
  });
  globalRestartModal?.addEventListener('click', (e) => {
    if (e.target === globalRestartModal) {
      globalRestartModal.hidden = true;
    }
  });

  btnModalRestartConfirm?.addEventListener('click', () => executeClientRestart(true));

  btnRestartCancel?.addEventListener('click', () => {
    if (ctxRestartConfirm) ctxRestartConfirm.hidden = true;
  });

  btnRestartConfirmGo?.addEventListener('click', () => executeClientRestart(false));

  btnRestoreUnlock?.addEventListener('click', async () => {
    if (isUnlocking) return;
    isUnlocking = true;
    if (btnRestoreUnlock) btnRestoreUnlock.disabled = true;
    if (btnApplyUnlock) btnApplyUnlock.disabled = true;
    showUnlockResultBox(true, t('mod.processing'));

    try {
      await yieldForSettingsPaint();
      const res = await invokeUnlockApi('restore');
      if (!res || !res.ok) {
        showUnlockResultBox(false, buildFriendlyWriteError(res?.error || t('msg.restoreFail')), { showRetry: true });
        return;
      }
      needsRestartAfterApply = true;
      showUnlockResultBox(true, t('msg.restoredRestart'), { needsRestart: true });
    } catch (e) {
      showUnlockResultBox(false, buildFriendlyWriteError(e?.message), { showRetry: true });
    } finally {
      isUnlocking = false;
      if (btnRestoreUnlock) btnRestoreUnlock.disabled = false;
      if (btnApplyUnlock) btnApplyUnlock.disabled = false;
      await refreshUnlockStatus();
    }
  });

  // -----------------------------------------------------------------------
  // 速度对比分页与纯 SVG 图表渲染
  // -----------------------------------------------------------------------
  function isValidSpeedSampleSafe(c) {
    if (typeof isValidSpeedSample === 'function') return isValidSpeedSample(c);
    return Boolean(c && c.status === 'final' && !c.estimated && Number(c.outputTokens) > 0 && Number(c.durationSec) > 0 && Number(c.tps) > 0);
  }

  function mergeAvailableSpeedCalls() {
    const byId = new Map();
    const hist = Array.isArray(ANTIGRAVITY_TOKEN_DATA.speedRecords) ? ANTIGRAVITY_TOKEN_DATA.speedRecords : [];
    for (const r of hist) {
      if (r && r.callId) byId.set(r.callId, r);
    }
    const cur = Array.isArray(state.sessionCalls) ? state.sessionCalls : [];
    for (const r of cur) {
      if (!r || !r.callId) continue;
      const prev = byId.get(r.callId);
      if (!prev || (!isValidSpeedSampleSafe(prev) && isValidSpeedSampleSafe(r)) || Number(r.outputTokens || 0) > Number(prev.outputTokens || 0)) {
        byId.set(r.callId, r);
      }
    }
    return Array.from(byId.values());
  }

  function createSvgEl(tag, attrs = {}) {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc) return null;
    const node = typeof doc.createElementNS === 'function'
      ? doc.createElementNS('http://www.w3.org/2000/svg', tag)
      : (typeof doc.createElement === 'function' ? doc.createElement(tag) : null);
    if (!node) return null;
    for (const [k, v] of Object.entries(attrs)) {
      if (v != null && typeof node.setAttribute === 'function') node.setAttribute(k, String(v));
    }
    return node;
  }

  function renderSpeedBarChart(groups) {
    const svg = el('speed-bar-svg');
    const wrap = el('speed-bar-chart-wrap');
    const emptyEl = el('speed-bar-empty');
    const tooltip = el('speed-bar-tooltip');
    const titleEl = el('speed-bar-title');

    const metricTitleMap = { tps: t('speed.barTitle.tps'), ttft: t('speed.barTitle.ttft'), duration: t('speed.barTitle.duration') };
    if (titleEl) titleEl.textContent = metricTitleMap[speedMetric] || t('speed.barTitle.tps');

    if (!groups.length) {
      if (emptyEl) emptyEl.hidden = false;
      if (wrap) wrap.hidden = true;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    if (wrap) wrap.hidden = false;
    if (!svg || typeof svg.replaceChildren !== 'function') return;

    const width = 420;
    const rowH = 34;
    const padTop = 8;
    const padBottom = 10;
    const labelW = 148;
    const valW = 86;
    const barAreaW = width - labelW - valW - 12;

    const height = padTop + padBottom + groups.length * rowH;

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));

    const getVal = g => speedMetric === 'ttft' ? g.medianTtft : speedMetric === 'duration' ? g.medianDuration : g.medianTps;
    const maxVal = Math.max(...groups.map(g => getVal(g) || 0), 0.1);

    const nodes = [];
    groups.forEach((g, idx) => {
      const y = padTop + idx * rowH;
      const val = getVal(g) || 0;
      const w = Math.max(4, (val / maxVal) * barAreaW);
      const displayLabel = formatProductDisplayWithEffort(g.productLabel, g.effort);
      const unitStr = speedMetric === 'tps' ? `${val} tok/s` : t('speed.unitSec', { val });

      const rowGrp = createSvgEl('g', { style: 'cursor:pointer' });
      const bgHit = createSvgEl('rect', { x: 0, y, width, height: rowH - 4, rx: 4, fill: 'transparent' });
      const dot = createSvgEl('circle', {
        cx: 7,
        cy: y + 14,
        r: 3.5,
        fill: VENDOR_DOT_COLORS[g.vendor] || '#8a8a94'
      });
      const lbl = createSvgEl('text', {
        x: 15,
        y: y + 18,
        fill: 'var(--ag-text-primary, #ececef)',
        'font-size': '10.5'
      });
      if (lbl) lbl.textContent = displayLabel.length > 20 ? displayLabel.slice(0, 19) + '…' : displayLabel;

      const track = createSvgEl('rect', {
        x: labelW,
        y: y + 7,
        width: barAreaW,
        height: 14,
        rx: 3,
        fill: 'var(--ag-track-bg, rgba(255,255,255,0.08))'
      });
      const bar = createSvgEl('rect', {
        x: labelW,
        y: y + 7,
        width: w.toFixed(1),
        height: 14,
        rx: 3,
        fill: VENDOR_DOT_COLORS[g.vendor] || 'var(--ag-custom-speed, #38bdf8)',
        opacity: g.lowSample ? '0.45' : '0.92'
      });
      const valTxt = createSvgEl('text', {
        x: labelW + barAreaW + 6,
        y: y + 18,
        fill: g.lowSample ? 'var(--ag-text-muted, #8a8a94)' : 'var(--ag-text-secondary, #c8c8d0)',
        'font-size': '10'
      });
      if (valTxt) valTxt.textContent = `${unitStr}${g.lowSample ? ` ${t('speed.lowSample')}` : ''}`;

      if (rowGrp) {
        if (bgHit) rowGrp.appendChild(bgHit);
        if (dot) rowGrp.appendChild(dot);
        if (lbl) rowGrp.appendChild(lbl);
        if (track) rowGrp.appendChild(track);
        if (bar) rowGrp.appendChild(bar);
        if (valTxt) rowGrp.appendChild(valTxt);
        rowGrp.addEventListener?.('mouseenter', () => {
          if (!tooltip) return;
          const rangeTxt = g.minTs && g.maxTs
            ? `${formatMonthDayTime(g.minTs)} ~ ${formatMonthDayTime(g.maxTs)}`
            : '—';
          tooltip.innerHTML =
            `<strong>${displayLabel}</strong><br>` +
            `${t('speed.tip.samples', { n: g.count, low: g.lowSample ? t('models.card.lowSampleParen') : '' })}<br>` +
            `${t('speed.tip.timeRange', { range: rangeTxt })}<br>` +
            `${t('speed.tip.medOut', { val: fmt(g.medianOutputTokens) })}<br>` +
            `${t('speed.tip.medIn', { val: fmt(g.medianInputTokens) })}`;
          tooltip.hidden = false;
          if (tooltip.style) {
            tooltip.style.top = `${Math.max(4, y - 4)}px`;
            tooltip.style.right = '8px';
          }
        });
        rowGrp.addEventListener?.('mouseleave', () => {
          if (tooltip) tooltip.hidden = true;
        });
        rowGrp.addEventListener?.('click', () => {
          selectedSpeedExactModelId = g.modelExactId;
          renderSpeedComparisonTab();
        });
        nodes.push(rowGrp);
      }
    });
    svg.replaceChildren(...nodes);
  }

  function renderSpeedLineChart(selectedGroup) {
    const svg = el('speed-line-svg');
    const wrap = el('speed-line-chart-wrap');
    const emptyEl = el('speed-line-empty');
    const tooltip = el('speed-line-tooltip');

    const samples = (selectedGroup?.samples || []).filter(s => s && s.tps > 0);
    if (!samples.length) {
      if (emptyEl) emptyEl.hidden = false;
      if (wrap) wrap.hidden = true;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    if (wrap) wrap.hidden = false;
    if (!svg || typeof svg.replaceChildren !== 'function') return;

    const width = 420;
    const height = 148;
    const padL = 38;
    const padR = 14;
    const padT = 14;
    const padB = 24;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));

    const maxTps = Math.max(...samples.map(s => Number(s.tps) || 0), 10);
    const minTps = Math.max(0, Math.min(...samples.map(s => Number(s.tps) || 0)) * 0.8);
    const spanTps = Math.max(1, maxTps - minTps);

    const nodes = [];
    // Y 轴参考线与刻度
    [0, 0.5, 1].forEach(ratio => {
      const y = padT + plotH * (1 - ratio);
      const val = Math.round(minTps + spanTps * ratio);
      const grid = createSvgEl('line', {
        x1: padL, y1: y.toFixed(1), x2: width - padR, y2: y.toFixed(1),
        stroke: 'var(--ag-border-subtle, rgba(255,255,255,0.08))', 'stroke-width': 1
      });
      const txt = createSvgEl('text', {
        x: padL - 5, y: (y + 3).toFixed(1), 'text-anchor': 'end',
        fill: 'var(--ag-text-muted, #8a8a94)', 'font-size': '9.5'
      });
      if (txt) txt.textContent = String(val);
      if (grid) nodes.push(grid);
      if (txt) nodes.push(txt);
    });

    const pts = samples.map((s, idx) => {
      const x = samples.length === 1 ? padL + plotW / 2 : padL + (idx / (samples.length - 1)) * plotW;
      const y = padT + plotH * (1 - ((Number(s.tps) - minTps) / spanTps));
      return { x, y, sample: s };
    });

    if (pts.length >= 2) {
      const dAttr = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
      const path = createSvgEl('path', {
        d: dAttr, fill: 'none',
        stroke: VENDOR_DOT_COLORS[selectedGroup.vendor] || 'var(--ag-custom-speed, #38bdf8)',
        'stroke-width': 1.8
      });
      if (path) nodes.push(path);
    }

    pts.forEach((pt, idx) => {
      const circle = createSvgEl('circle', {
        cx: pt.x.toFixed(1),
        cy: pt.y.toFixed(1),
        r: 3.5,
        fill: VENDOR_DOT_COLORS[selectedGroup.vendor] || 'var(--ag-custom-speed, #38bdf8)',
        stroke: 'var(--ag-bg-panel, #181818)',
        'stroke-width': 1.2,
        style: 'cursor:pointer'
      });
      if (circle) {
        circle.addEventListener?.('mouseenter', () => {
          if (!tooltip) return;
          const s = pt.sample;
          const originTxt = s.origin === 'speed-test' ? t('speed.originProbe') : t('speed.origin.chat');
          const ttftTxt = s.ttftSec != null ? t('speed.unitSec', { val: s.ttftSec }) : t('speed.unknown');
          tooltip.innerHTML =
            `<strong>${t('speed.tip.tpsLine', { idx: idx + 1, tps: s.tps })}</strong><br>` +
            `${t('speed.tip.time', { val: formatMonthDayTime(s.ts || s.createdAt) || '—' })}<br>` +
            `${t('speed.tip.output', { val: fmt(s.outputTokens) })}<br>` +
            `${t('speed.tip.ttft', { val: ttftTxt })}<br>` +
            `${t('speed.tip.origin', { val: originTxt })}`;
          tooltip.hidden = false;
          if (tooltip.style) {
            tooltip.style.top = '6px';
            tooltip.style.right = '8px';
          }
        });
        circle.addEventListener?.('mouseleave', () => {
          if (tooltip) tooltip.hidden = true;
        });
        nodes.push(circle);
      }
    });

    const firstLbl = createSvgEl('text', { x: padL, y: height - 6, fill: 'var(--ag-text-muted, #8a8a94)', 'font-size': '9.5' });
    if (firstLbl) firstLbl.textContent = formatMonthDayTime(samples[0].ts || samples[0].createdAt) || '#1';
    const lastLbl = createSvgEl('text', { x: width - padR, y: height - 6, 'text-anchor': 'end', fill: 'var(--ag-text-muted, #8a8a94)', 'font-size': '9.5' });
    if (lastLbl && samples.length > 1) lastLbl.textContent = formatMonthDayTime(samples[samples.length - 1].ts || samples[samples.length - 1].createdAt) || `#${samples.length}`;
    if (firstLbl) nodes.push(firstLbl);
    if (lastLbl) nodes.push(lastLbl);

    svg.replaceChildren(...nodes);
  }

  let lastSpeedGroups = [];

  function renderSpeedComparisonTab() {
    const mergedCalls = mergeAvailableSpeedCalls();
    const daysArg = speedRangeDays === 'all' ? 'all' : Number(speedRangeDays);
    const groups = typeof summarizeSpeedByModel === 'function'
      ? summarizeSpeedByModel(mergedCalls, {
        days: daysArg,
        origin: speedOriginFilter,
        metric: speedMetric,
        cascadeModelConfigs: state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || []
      })
      : [];
    lastSpeedGroups = groups;

    renderSpeedBarChart(groups);

    if (!selectedSpeedExactModelId || !groups.some(g => g.modelExactId === selectedSpeedExactModelId)) {
      selectedSpeedExactModelId = groups[0]?.modelExactId || null;
    }
    const chosenGroup = groups.find(g => g.modelExactId === selectedSpeedExactModelId) || null;
    const speedDropLabel = el('speed-model-dropdown-label');
    if (speedDropLabel) {
      if (chosenGroup) {
        speedDropLabel.textContent = formatProductDisplayWithEffort(chosenGroup.productLabel, chosenGroup.effort);
      } else {
        speedDropLabel.textContent = t('speed.lineNoModel');
      }
    }

    if (!speedModelDropdownCtrl && typeof initDropdownController === 'function' && el('speed-model-dropdown-wrap')) {
      speedModelDropdownCtrl = initDropdownController({
        wrapId: 'speed-model-dropdown-wrap',
        triggerId: 'speed-model-dropdown-trigger',
        labelId: 'speed-model-dropdown-label',
        menuId: 'speed-model-dropdown-menu',
        emptyLabel: () => t('speed.lineNoModel'),
        searchPlaceholder: () => t('dropdown.speedSearch'),
        emptyText: () => t('dropdown.speedEmpty'),
        getSelectedValue: () => selectedSpeedExactModelId || '',
        onSelect: (opt) => {
          const val = opt?.value || '';
          if (!val) return;
          selectedSpeedExactModelId = val;
          renderSpeedComparisonTab();
        },
        getOptions: () => lastSpeedGroups.map(g => {
          return {
            value: g.modelExactId,
            label: formatProductDisplayWithEffort(g.productLabel, g.effort),
            displayRight: t('speed.samples', { n: g.count })
          };
        })
      });
    } else if (speedModelDropdownCtrl && typeof speedModelDropdownCtrl.refresh === 'function') {
      speedModelDropdownCtrl.refresh();
    }

    renderSpeedLineChart(chosenGroup);
  }

  const SPEED_RANGE_MAP = { 'speed-range-7d': '7', 'speed-range-30d': '30', 'speed-range-all': 'all' };
  const SPEED_ORIGIN_MAP = { 'speed-origin-all': 'all', 'speed-origin-chat': 'chat' };
  const SPEED_METRIC_MAP = { 'speed-metric-tps': 'tps', 'speed-metric-ttft': 'ttft', 'speed-metric-duration': 'duration' };

  function bindSpeedFilterGroup(map, onPick) {
    const ids = Object.keys(map);
    ids.forEach(id => {
      el(id)?.addEventListener('click', () => {
        const val = map[id];
        onPick(val);
        ids.forEach(k => setPillActive(el(k), map[k] === val));
        renderSpeedComparisonTab();
      });
    });
  }

  bindSpeedFilterGroup(SPEED_RANGE_MAP, v => { speedRangeDays = v; });
  bindSpeedFilterGroup(SPEED_ORIGIN_MAP, v => { speedOriginFilter = v; });
  bindSpeedFilterGroup(SPEED_METRIC_MAP, v => { speedMetric = v; });

  applyContextViewVisibility();

  const UNLOCK_POST_URL = 'https://linux.do/t/topic/3117832';
  let unlockToastTimer = null;

  function showUnlockToast(msg) {
    if (!unlockLinkToast) return;
    if (unlockToastTimer) clearTimeout(unlockToastTimer);
    unlockLinkToast.textContent = msg;
    unlockLinkToast.style.display = 'block';
    unlockToastTimer = setTimeout(() => {
      unlockLinkToast.style.display = 'none';
    }, 4500);
  }

  async function openUnlockAuthorPost() {
    let opened = false;
    try {
      if (window.contextMeterAPI?.openExternal) {
        const res = await window.contextMeterAPI.openExternal(UNLOCK_POST_URL);
        if (res && res.ok) opened = true;
      }
    } catch { }

    if (!opened) {
      try {
        const w = window.open(UNLOCK_POST_URL, '_blank');
        if (w) opened = true;
      } catch { }
    }

    if (opened) {
      showUnlockToast(t('models.linkOpened'));
    } else {
      copyUnlockPostUrl(true);
    }
  }

  function copyUnlockPostUrl(fromFailedOpen = false) {
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(UNLOCK_POST_URL);
        copied = true;
      }
    } catch { }
    if (!copied) {
      try {
        const ta = document.createElement('textarea');
        ta.value = UNLOCK_POST_URL;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        copied = true;
      } catch { }
    }
    showUnlockToast(fromFailedOpen
      ? t('models.linkCopyFallback')
      : t('models.copyOk'));
  }

  linkUnlockAuthor?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void openUnlockAuthorPost();
  });

  linkUnlockAuthor?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      void openUnlockAuthorPost();
    }
  });

  btnCopyUnlockLink?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    copyUnlockPostUrl(false);
  });

  // -------------------------------------------------------------
  // -------------------------------------------------------------
  // 模块 1.5: 插件面板语言 (Context Meter) 与客户端语言 (Antigravity)
  // -------------------------------------------------------------
  const panelLangBtns = {
    'zh-CN': el('btn-panel-lang-zh-CN'),
    'zh-TW': el('btn-panel-lang-zh-TW'),
    en: el('btn-panel-lang-en')
  };
  const panelTopLangBtns = {
    'zh-CN': el('btn-top-lang-zh-CN'),
    'zh-TW': el('btn-top-lang-zh-TW'),
    en: el('btn-top-lang-en')
  };
  const panelLangSaveBadge = el('panel-lang-save-badge');
  const btnClientLangZhCn = el('btn-client-lang-zh-CN');
  const btnClientLangEn = el('btn-client-lang-en');

  function syncPanelLanguageButtons(lang) {
    const normalized = normalizePanelLanguage(lang);
    for (const [k, btn] of Object.entries(panelLangBtns)) {
      if (!btn) continue;
      const active = k === normalized;
      if (active) addClass(btn, 'active');
      else removeClass(btn, 'active');
      btn.setAttribute?.('aria-pressed', String(active));
    }
    for (const [k, btn] of Object.entries(panelTopLangBtns)) {
      if (!btn) continue;
      const active = k === normalized;
      if (active) addClass(btn, 'active');
      else removeClass(btn, 'active');
      btn.setAttribute?.('aria-pressed', String(active));
      btn.setAttribute?.('aria-selected', String(active));
    }
  }

  function syncClientLanguageButtons() {
    if (btnClientLangZhCn) {
      if (currentChineseEnabled) addClass(btnClientLangZhCn, 'active');
      else removeClass(btnClientLangZhCn, 'active');
      btnClientLangZhCn.setAttribute?.('aria-pressed', String(currentChineseEnabled));
    }
    if (btnClientLangEn) {
      if (!currentChineseEnabled) addClass(btnClientLangEn, 'active');
      else removeClass(btnClientLangEn, 'active');
      btnClientLangEn.setAttribute?.('aria-pressed', String(!currentChineseEnabled));
    }
  }

  async function applyPanelLanguage(lang, opts = {}) {
    const nextLang = normalizePanelLanguage(lang);
    const persist = opts.persist !== false;
    setPanelLanguageInternal(nextLang);
    syncPanelLanguageButtons(nextLang);
    applyStaticPanelTranslations(shadow);

    try {
      if (colorDrawerArrow && colorDrawerBody) {
        const open = colorDrawerBody.style.display === 'block';
        colorDrawerArrow.textContent = open ? t('drawer.colors.collapse') : t('drawer.colors.expand');
      }
      if (drawerArrow && drawerBody) {
        const open = drawerBody.style.display === 'block';
        drawerArrow.textContent = open ? t('session.techDrawer.collapse') : t('session.techDrawer.expand');
      }
      if (tokenColorDrawerArrow && tokenColorDrawerBody) {
        const open = tokenColorDrawerBody.style.display === 'block';
        tokenColorDrawerArrow.textContent = open ? t('drawer.colors.collapse') : t('drawer.colors.expand');
      }
      if (cardDrawerArrow && cardDrawerBody) {
        const open = cardDrawerBody.style.display === 'block';
        cardDrawerArrow.textContent = open ? t('session.techDrawer.collapse') : t('session.techDrawer.expand');
      }
      if (unlockDrawerArrow && unlockDrawerBody) {
        const open = unlockDrawerBody.style.display === 'block';
        unlockDrawerArrow.textContent = open ? t('drawer.collapse') : t('drawer.expand');
      }
      if (proxyDrawerArrow && proxyDrawerBody) {
        const open = proxyDrawerBody.style.display === 'block';
        proxyDrawerArrow.textContent = open ? t('drawer.shortCollapse') : t('drawer.shortExpand');
      }
      if (chineseDrawerArrow && chineseDrawerBody) {
        const open = chineseDrawerBody.style.display === 'block';
        chineseDrawerArrow.textContent = open ? t('drawer.collapse') : t('drawer.expand');
      }
      const btnCostDet = el('btn-cost-details-toggle');
      const costDetBody = el('cost-details-pane');
      if (btnCostDet && costDetBody) {
        const open = costDetBody.style.display === 'block';
        btnCostDet.textContent = open ? t('cost.btnCollapse') : t('cost.btnExpand');
      }
      const btnPlanDet = el('btn-plan-detail-toggle');
      if (btnPlanDet) {
        btnPlanDet.textContent = planDetailExpanded ? t('plan.detail.toggleClose') : t('plan.detail.toggleOpen');
      }
    } catch { }
    try { if (typeof applyTheme === 'function') applyTheme(); } catch { }
    try { render(); } catch { }
    try { renderSessionCost(); } catch { }
    try { if (typeof renderQuotaBoard === 'function') renderQuotaBoard(); } catch { }
    try { if (typeof renderInspectorActiveTab === 'function') renderInspectorActiveTab(); } catch { }
    try { renderHeaderModelDropdown(); } catch { }
    try { renderModelSettingsTab(); } catch { }
    try { renderSpeedComparisonTab(); } catch { }
    try { if (currentUnlockStatus) { renderClientStatusBar(); renderCompactSessionCard(); } } catch { }
    try {
      if (typeof renderPlanDetail === 'function' && ANTIGRAVITY_TOKEN_DATA?.planStatus) {
        renderPlanDetail(ANTIGRAVITY_TOKEN_DATA.planStatus);
      } else {
        const pv = el('plan-summary-price-val');
        if (pv && /^\$19\.99\/(月|mo)$/.test(String(pv.textContent || '').trim())) {
          pv.textContent = `$19.99${t('plan.summary.perMonth')}`;
        }
      }
      const countryInp = el('input-custom-country');
      if (countryInp && countryInp.value) {
        const locCountry = localizeRegionDisplayValue(countryInp.value);
        if (locCountry) countryInp.value = locCountry;
      }
      const regInp = el('input-custom-region');
      if (regInp && regInp.value) {
        const locReg = localizeRegionDisplayValue(regInp.value);
        if (locReg) regInp.value = locReg;
      }
      if (typeof refreshRegionPresetSelectOptions === 'function') refreshRegionPresetSelectOptions();
      if (typeof refreshDirectCountryDisplay === 'function') refreshDirectCountryDisplay();
      if (typeof refreshDirectRegionDisplay === 'function') refreshDirectRegionDisplay();
      if (typeof refreshDirectCurrencyDisplay === 'function') refreshDirectCurrencyDisplay();
      if (typeof refreshValidEndDatePicker === 'function') refreshValidEndDatePicker();
      if (typeof updateRegionCnyPreviewFromForm === 'function') updateRegionCnyPreviewFromForm();
      if (typeof syncAllNativeSelectDropdowns === 'function') syncAllNativeSelectDropdowns();
    } catch { }
    try {
      if (typeof renderEnhanceSectionUI === 'function') renderEnhanceSectionUI();
      if (typeof rerenderSettingsFeedbacks === 'function') rerenderSettingsFeedbacks();
      if (typeof renderAccountsOverviewSection === 'function' && accountsUiState?.overview) {
        renderAccountsOverviewSection();
      }
    } catch { }
    try {
      if (isChineseExpanded || isProxyExpanded || isContextSettingsView) {
        void refreshModulesDisplay();
      }
      if (isContextSettingsView && typeof refreshEnhanceStatus === 'function') {
        void refreshEnhanceStatus(false);
      }
    } catch { }
    try {
      const basePayload = ANTIGRAVITY_TOKEN_DATA?.rawPayload || ANTIGRAVITY_TOKEN_DATA;
      if (typeof applyTokenHistoryPayload === 'function' && basePayload) {
        applyTokenHistoryPayload(basePayload);
      }
    } catch { }

    if (persist) {
      userActionSeq++;
      try { localStorage?.setItem('ag_panel_language', nextLang); } catch { }
      const res = await saveSettingsPayloadBridge({
        panelLanguage: nextLang,
        uiPreferences: { panelLanguage: nextLang }
      });
      if (panelLangSaveBadge) {
        panelLangSaveBadge.textContent = res?.ok ? t('settings.panelLang.saved') : t('settings.panelLang.saveLocal');
        panelLangSaveBadge.className = `key-pill ${res?.ok ? 'pill-ok' : 'pill-warn'}`;
        panelLangSaveBadge.hidden = false;
      }
    }
  }

  function setPanelLanguageInternal(lang) {
    currentPanelLanguage = normalizePanelLanguage(lang);
  }

  for (const [langCode, btn] of Object.entries(panelLangBtns)) {
    btn?.addEventListener('click', () => {
      void applyPanelLanguage(langCode, { persist: true });
    });
  }

  for (const [langCode, btn] of Object.entries(panelTopLangBtns)) {
    btn?.addEventListener('click', () => {
      void applyPanelLanguage(langCode, { persist: true });
    });
  }

  // 模块 2: 客户端界面汉化 (AntigravityChinese)
  // -------------------------------------------------------------
  const btnToggleChinese = el('btn-toggle-chinese');
  const chineseDrawerBody = el('chinese-drawer-body');
  const chineseDrawerArrow = el('chinese-drawer-arrow');
  const chineseBadge = el('chinese-badge');
  const chineseStatusDesc = el('chinese-status-desc');
  const btnToggleChineseModule = el('btn-toggle-chinese-module');

  let isChineseExpanded = false;
  let currentChineseEnabled = false;

  btnToggleChinese?.addEventListener('click', () => {
    isChineseExpanded = !isChineseExpanded;
    if (chineseDrawerBody) chineseDrawerBody.style.display = isChineseExpanded ? 'block' : 'none';
    if (chineseDrawerArrow) chineseDrawerArrow.textContent = isChineseExpanded ? t('drawer.collapse') : t('drawer.expand');
    btnToggleChinese?.setAttribute('aria-expanded', String(isChineseExpanded));
    if (isChineseExpanded) {
      void refreshModulesDisplay();
    }
  });

  // -------------------------------------------------------------
  // 模块 3: 免 TUN 网络直连 (AntigravityProxyNoTun)
  // -------------------------------------------------------------
  const btnToggleProxy = el('btn-toggle-proxy');
  const proxyDrawerBody = el('proxy-drawer-body');
  const proxyDrawerArrow = el('proxy-drawer-arrow');
  const proxyBadge = el('proxy-badge');
  const proxyStatusDesc = el('proxy-status-desc');
  const inputProxyUrl = el('input-proxy-url');
  const inputProxyBypass = el('input-proxy-bypass');
  const btnTestProxy = el('btn-test-proxy');
  const btnSaveProxyConfig = el('btn-save-proxy-config');
  const btnToggleProxyModule = el('btn-toggle-proxy-module');
  const proxyTestResult = el('proxy-test-result');

  let isProxyExpanded = false;
  let currentProxyEnabled = false;
  let proxyInputDirty = false;
  let savedProxyUrl = '';
  let savedProxyBypass = '';
  let isProxyBusy = false;
  let modulesStatusReqSeq = 0;

  function proxyInputsDifferFromSaved() {
    const curUrl = String(inputProxyUrl?.value ?? '').trim();
    const curBypass = String(inputProxyBypass?.value ?? '').trim();
    return Boolean(
      (curUrl && curUrl !== savedProxyUrl) ||
      (curBypass !== savedProxyBypass)
    );
  }

  function syncProxySaveButtonState() {
    if (!btnSaveProxyConfig) return;
    const show = Boolean(currentProxyEnabled && (proxyInputDirty || proxyInputsDifferFromSaved()));
    btnSaveProxyConfig.hidden = !show;
    btnSaveProxyConfig.disabled = Boolean(isProxyBusy);
    btnSaveProxyConfig.textContent = isProxyBusy ? t('mod.proxy.btnSaving') : t('mod.proxy.btnSave');
  }

  inputProxyUrl?.addEventListener('input', () => {
    proxyInputDirty = true;
    syncProxySaveButtonState();
  });
  inputProxyBypass?.addEventListener('input', () => {
    proxyInputDirty = true;
    syncProxySaveButtonState();
  });

  async function invokeTestProxyApi(proxyUrl) {
    const ipcFn = (typeof window !== 'undefined' && typeof window.contextMeterAPI?.testProxy === 'function')
      ? () => window.contextMeterAPI.testProxy(proxyUrl)
      : null;
    if (!ipcFn && !hasLiveHttpBridge()) {
      return { ok: false, error: t('msg.noHostBridge'), unavailable: true };
    }
    try {
      const out = await callBackendWithPriority({
        ipcCall: ipcFn,
        liveRoute: '/test-proxy',
        liveBody: { proxyUrl }
      });
      return out.result || { ok: false, error: t('msg.noHostBridge'), unavailable: true };
    } catch (e) {
      return { ok: false, error: e?.message || t('msg.noHostBridge') };
    }
  }

  btnToggleProxy?.addEventListener('click', () => {
    isProxyExpanded = !isProxyExpanded;
    if (proxyDrawerBody) proxyDrawerBody.style.display = isProxyExpanded ? 'block' : 'none';
    if (proxyDrawerArrow) proxyDrawerArrow.textContent = isProxyExpanded ? t('drawer.shortCollapse') : t('drawer.shortExpand');
    btnToggleProxy?.setAttribute('aria-expanded', String(isProxyExpanded));
    if (isProxyExpanded) {
      void refreshModulesDisplay();
    }
  });

  // -------------------------------------------------------------
  // 模块 3.5: 系统增强、提示词档位、品牌与推荐配置控制器 (PR #3 / PR #4 融合)
  // -------------------------------------------------------------
  const btnEnhancePresetApply = el('btn-enhance-preset-apply');
  const btnEnhanceRestoreAll = el('btn-enhance-restore-all');
  const enhanceGlobalBadge = el('enhance-global-badge');
  const enhancePresetConfirm = el('enhance-preset-confirm');
  const enhanceConfirmTitle = el('enhance-preset-confirm-text');
  const btnEnhanceConfirmCancel = el('btn-enhance-confirm-cancel');
  const btnEnhanceConfirmGo = el('btn-enhance-confirm-go');
  const enhanceGlobalResult = el('enhance-global-result');
  const enhanceResultText = el('enhance-global-result-text');
  const enhanceResultActions = el('enhance-global-result-actions');
  const enhanceManualNote = el('enhance-global-manual-note');
  const btnEnhanceRestartHost = el('btn-enhance-restart-host');
  const btnEnhanceRestartLs = el('btn-enhance-restart-ls');

  const chkPresetPrompt = el('chk-rec-prompt');
  const chkPresetTitle = el('chk-rec-title');
  const chkPresetLang = el('chk-rec-lang');
  const chkPresetCtx = el('chk-rec-ctx');

  const brandTitleBtns = {
    english: el('btn-brand-english'),
    hidden: el('btn-brand-hidden'),
    translated: el('btn-brand-translated')
  };

  const enhancePromptBadge = el('enhance-prompt-badge');
  const enhanceStatPrompt = el('enhance-stat-prompt');
  const enhanceStatTitle = el('enhance-stat-title');
  const enhanceStatSlots = el('enhance-stat-slots');
  const enhanceStatBackup = el('enhance-stat-backup');
  const enhanceTierGrid = el('enhance-tier-grid');
  const enhanceTierBtns = [0, 1, 2, 3, 4].map(n =>
    el(`enhance-tier-${n}`) || enhanceTierGrid?.querySelector?.(`[data-enhance-tier="${n}"]`) || null
  );
  const enhanceTierSummary = el('enhance-tier-matrix-title');
  const enhanceTierCurrentDesc = el('enhance-tier-current-desc');
  const enhanceTierKeeps = el('enhance-tier-keeps');
  const enhanceTierClears = el('enhance-tier-clears');
  const enhanceTierReplaces = el('enhance-tier-replaces');
  const enhanceTierMeaning = el('enhance-tier-meaning');
  const btnApplyBrandTitle = el('btn-apply-brand-title');
  const brandApplyFeedback = el('brand-apply-feedback');
  const enhanceChineseTitleCheck = el('chk-enhance-chinese-title');
  const btnApplyEnhancePrompt = el('btn-enhance-apply-prompt');
  const btnRefreshEnhance = el('btn-enhance-refresh');
  const enhancePromptResult = el('enhance-prompt-result');
  const enhancePromptResultText = el('enhance-prompt-result-text');
  const btnToggleEnhanceDetails = el('btn-toggle-enhance-details');
  const enhanceDetailsBody = el('enhance-details-body');
  const enhanceDetailsArrow = el('enhance-details-arrow');
  const enhanceBinaryList = el('enhance-binary-list');

  let currentBrandTitle = 'english';
  let currentEnhanceStatus = null;
  let selectedEnhanceTier = 0;
  let enhanceTitleDraft = false;
  let enhanceTierDirty = false;
  let enhanceTitleDirty = false;
  let enhanceStatusReqSeq = 0;
  let pendingEnhanceConfirmMode = null; // 'preset' | 'restore' | null
  let isEnhanceBusy = false;
  let isLsRestartBusy = false;
  let hasPendingLsReload = false;
  let enhanceGlobalResultState = null; // { ok, resolveMessage, opts }
  let enhancePromptResultState = null; // { ok, resolveMessage }
  let brandFeedbackState = null;       // { mode, isSuccess, resolveMessage, isApplied }
  let lastProxyTestState = null;       // { pending, thrownErr, res }

  function syncBrandTitleButtons(mode = currentBrandTitle) {
    for (const [k, btn] of Object.entries(brandTitleBtns)) {
      if (!btn) continue;
      const active = k === mode;
      if (active) addClass(btn, 'active');
      else removeClass(btn, 'active');
      btn.setAttribute?.('aria-pressed', String(active));
    }
  }

  function renderEnhancePromptMatrix(tier = selectedEnhanceTier) {
    const idx = [0, 1, 2, 3, 4].includes(Number(tier)) ? Number(tier) : 0;
    const allTierBtns = enhanceTierGrid?.querySelectorAll?.('[data-enhance-tier]') || enhanceTierBtns.filter(Boolean);
    allTierBtns.forEach?.((btn) => {
      const bIdx = Number(btn.getAttribute?.('data-enhance-tier'));
      const active = bIdx === idx;
      if (active) addClass(btn, 'active');
      else removeClass(btn, 'active');
      btn.setAttribute?.('aria-pressed', String(active));
    });
    if (enhanceTierSummary) enhanceTierSummary.textContent = t(`enhance.tier.${idx}.desc`);
    if (enhanceTierCurrentDesc) enhanceTierCurrentDesc.textContent = t(`enhance.tier.${idx}.desc`);
    if (enhanceTierKeeps) enhanceTierKeeps.textContent = t(`enhance.tier.${idx}.keeps`);
    if (enhanceTierClears) enhanceTierClears.textContent = t(`enhance.tier.${idx}.clears`);
    if (enhanceTierReplaces) enhanceTierReplaces.textContent = t(`enhance.tier.${idx}.replaces`);
    if (enhanceTierMeaning) enhanceTierMeaning.textContent = t(`enhance.tier.${idx}.meaning`);
  }

  function syncEnhanceInteractiveDisabledState() {
    const unsupported = Boolean(currentEnhanceStatus && currentEnhanceStatus.supported === false);
    const lockPromptControls = Boolean(isEnhanceBusy || unsupported);
    const allTierBtns = enhanceTierGrid?.querySelectorAll?.('[data-enhance-tier]') || enhanceTierBtns.filter(Boolean);
    allTierBtns.forEach?.((btn) => {
      btn.disabled = lockPromptControls;
    });
    if (enhanceChineseTitleCheck) enhanceChineseTitleCheck.disabled = lockPromptControls;
    if (btnApplyEnhancePrompt) btnApplyEnhancePrompt.disabled = lockPromptControls;
    if (btnRefreshEnhance) btnRefreshEnhance.disabled = Boolean(isEnhanceBusy);
    if (btnEnhancePresetApply) btnEnhancePresetApply.disabled = Boolean(isEnhanceBusy);
    if (btnEnhanceRestoreAll) btnEnhanceRestoreAll.disabled = Boolean(isEnhanceBusy);
    if (btnEnhanceConfirmGo) btnEnhanceConfirmGo.disabled = Boolean(isEnhanceBusy);

    if (currentEnhanceStatus) {
      if (chkPresetPrompt) {
        if (unsupported) chkPresetPrompt.checked = false;
        chkPresetPrompt.disabled = lockPromptControls;
      }
      if (chkPresetTitle) {
        if (unsupported) chkPresetTitle.checked = false;
        chkPresetTitle.disabled = lockPromptControls;
      }
    }
    const ctxUnsupported = Boolean(
      currentUnlockStatus &&
      currentUnlockStatus.isPlatformSupported === false &&
      currentUnlockStatus.status === 'unsupported'
    );
    if (chkPresetCtx && currentUnlockStatus) {
      if (ctxUnsupported) chkPresetCtx.checked = false;
      chkPresetCtx.disabled = Boolean(isEnhanceBusy || ctxUnsupported);
    }
  }

  function renderEnhanceSectionUI() {
    syncBrandTitleButtons(currentBrandTitle);
    renderEnhancePromptMatrix(selectedEnhanceTier);
    syncEnhanceInteractiveDisabledState();

    const data = currentEnhanceStatus;
    const s = data?.summary || data;
    const isUnsupported = Boolean(data && data.supported === false);
    const tierNum = s?.promptTier ?? s?.detectedTier;
    const hasTitle = Boolean(s?.chineseTitleEnabled);
    const titleMode = s?.chineseTitleMode || (hasTitle ? 'zh' : 'en');
    const slotCount = Number(s?.slotCount || 0);
    const totalCap = Number(s?.totalCapacityBytes || 0);
    const activeBytes = Number(s?.activeSlotBytes || 0);
    const allBak = Boolean(s?.allBackedUp ?? s?.hasBackup);
    const syncState = s?.syncState || null;
    const targetsList = Array.isArray(data?.binaries) ? data.binaries : (Array.isArray(data?.targets) ? data.targets : []);
    const hasUnsavedDraft = Boolean(
      data &&
      data.supported &&
      !isUnsupported &&
      ((enhanceTierDirty && Number(selectedEnhanceTier) !== Number(tierNum)) ||
        (enhanceTitleDirty && Boolean(enhanceChineseTitleCheck ? enhanceChineseTitleCheck.checked : enhanceTitleDraft) !== hasTitle))
    );

    if (enhanceGlobalBadge) {
      if (!data) {
        enhanceGlobalBadge.textContent = t('enhance.status.unread');
        enhanceGlobalBadge.className = 'key-pill pill-muted';
      } else if (isUnsupported) {
        enhanceGlobalBadge.textContent = t('enhance.status.unsupportedPlatform');
        enhanceGlobalBadge.className = 'key-pill pill-warn';
      } else if (syncState === 'client_updated_mismatch') {
        enhanceGlobalBadge.textContent = t('enhance.status.clientUpdated');
        enhanceGlobalBadge.className = 'key-pill pill-warn';
      } else if (syncState === 'saved_disk_mismatch' || syncState === 'partial_mismatch') {
        enhanceGlobalBadge.textContent = t('enhance.status.diskMismatch');
        enhanceGlobalBadge.className = 'key-pill pill-warn';
      } else if (syncState === 'pending_ls_restart' || hasPendingLsReload) {
        enhanceGlobalBadge.textContent = t('enhance.status.pendingRestartLs');
        enhanceGlobalBadge.className = 'key-pill pill-warn';
      } else if (syncState === 'runtime_confirmed' && (Number(tierNum) > 0 || hasTitle)) {
        enhanceGlobalBadge.textContent = t('enhance.status.runtimeConfirmed');
        enhanceGlobalBadge.className = 'key-pill pill-ok';
      } else if (Number(tierNum) > 0 || hasTitle) {
        enhanceGlobalBadge.textContent = t('enhance.status.patchedActive');
        enhanceGlobalBadge.className = 'key-pill pill-ok';
      } else {
        enhanceGlobalBadge.textContent = t('enhance.status.stock');
        enhanceGlobalBadge.className = 'key-pill pill-muted';
      }
    }
    if (enhancePromptBadge) {
      if (!data) {
        enhancePromptBadge.textContent = t('enhance.status.unread');
        enhancePromptBadge.className = 'key-pill pill-muted';
      } else if (isUnsupported) {
        enhancePromptBadge.textContent = t('enhance.status.unsupportedPlatform');
        enhancePromptBadge.className = 'key-pill pill-warn';
      } else {

        const baseText = [0, 1, 2, 3, 4].includes(Number(tierNum))
          ? t(`enhance.tier.${tierNum}.short`)
          : t('enhance.status.patchedActive');
        enhancePromptBadge.textContent = hasUnsavedDraft ? `${baseText}${t('enhance.status.draftUnsaved')}` : baseText;
        enhancePromptBadge.className = hasUnsavedDraft
          ? 'key-pill pill-warn'
          : (Number(tierNum) > 0 ? 'key-pill pill-ok' : 'key-pill pill-muted');
      }
    }
    if (enhanceStatPrompt) {
      if (!data) {
        enhanceStatPrompt.textContent = t('enhance.status.unread');
      } else if (isUnsupported) {
        enhanceStatPrompt.textContent = t('enhance.status.unsupportedPlatform');
      } else {
        enhanceStatPrompt.textContent = [0, 1, 2, 3, 4].includes(Number(tierNum))
          ? t(`enhance.tier.${tierNum}.short`)
          : t('enhance.status.patchedActive');
      }
    }
    if (enhanceStatTitle) {
      if (!data) enhanceStatTitle.textContent = t('enhance.status.unread');
      else if (isUnsupported) enhanceStatTitle.textContent = t('enhance.status.unsupportedPlatform');
      else if (titleMode === 'zh' || hasTitle) {
        enhanceStatTitle.textContent = (hasPendingLsReload || s?.pendingLsRestart)
          ? t('enhance.titleState.onWritten')
          : (syncState === 'runtime_confirmed' ? t('enhance.titleState.onConfirmed') : t('enhance.titleState.on'));
      } else if (titleMode === 'mixed') enhanceStatTitle.textContent = t('enhance.titleState.conflict');
      else enhanceStatTitle.textContent = t('enhance.titleState.off');
    }
    if (enhanceStatSlots) {
      if (!data) {
        enhanceStatSlots.textContent = t('enhance.status.unread');
      } else if (isUnsupported) {
        enhanceStatSlots.textContent = t('enhance.status.unsupportedPlatform');
      } else if (totalCap <= 0) {
        enhanceStatSlots.textContent = t('enhance.status.unread');
      } else {
        enhanceStatSlots.textContent = `${activeBytes} / ${totalCap} B (${slotCount})`;
      }
    }
    if (enhanceStatBackup) {
      if (!data) enhanceStatBackup.textContent = t('enhance.status.unread');
      else if (isUnsupported) enhanceStatBackup.textContent = t('enhance.status.unsupportedPlatform');
      else enhanceStatBackup.textContent = allBak ? t('enhance.status.backupYes') : t('enhance.status.backupNo');
    }
    if (enhanceBinaryList && targetsList.length) {
      enhanceBinaryList.textContent = targetsList.map(tgt => `${tgt.label || tgt.id || ''}: ${tgt.path || tgt}${tgt.exists === false ? ' (missing)' : ''}`).join(' | ');
    }
    if (enhanceDetailsArrow && enhanceDetailsBody) {
      const open = enhanceDetailsBody.style.display === 'block';
      enhanceDetailsArrow.textContent = open ? t('drawer.shortCollapse') : t('drawer.shortExpand');
    }
  }

  /** 获取用于操作反馈插值的品牌名称展示值 */
  function getBrandDisplayValue(modeKey) {
    if (modeKey === 'translated') return '反重力';
    if (modeKey === 'hidden') return t('enhance.brand.hiddenValue');
    return 'Antigravity';
  }

  /** 解析后端或增强桥接返回错误，兼容 errorKey 与后端原文翻译 */
  function resolveSettingsErrorText(rawOrRes, fallbackKey = 'msg.unknownErr') {
    if (rawOrRes && typeof rawOrRes === 'object') {
      if (rawOrRes.errorKey) return t(rawOrRes.errorKey);
      return translateBackendText(rawOrRes.error ?? rawOrRes.message) || t(fallbackKey);
    }
    return translateBackendText(rawOrRes) || t(fallbackKey);
  }

  function showEnhanceResultBox(ok, messageOrResolver, opts = {}) {
    if (!enhanceGlobalResult || !enhanceResultText) return;
    const resolveMessage = typeof messageOrResolver === 'function'
      ? messageOrResolver
      : () => String(messageOrResolver ?? '');
    enhanceGlobalResultState = { ok, resolveMessage, opts };
    enhanceGlobalResult.style.display = 'block';
    enhanceGlobalResult.className = `unlock-result-box ${ok ? 'result-success' : 'result-error'}`;
    enhanceResultText.textContent = resolveMessage();
    const needLs = Boolean(opts.needsLsRestart);
    const needHost = Boolean(opts.needsHostRestart);
    const canRestartHost = Boolean(hostSupportsRestart);
    if (btnEnhanceRestartLs) btnEnhanceRestartLs.hidden = !needLs;
    if (btnEnhanceRestartHost) btnEnhanceRestartHost.hidden = !(needHost && canRestartHost);
    if (enhanceManualNote) enhanceManualNote.hidden = !(needHost && !canRestartHost);
    if (enhanceResultActions) enhanceResultActions.hidden = !(needLs || (needHost && canRestartHost));
  }

  function showEnhancePromptResult(ok, messageOrResolver) {
    if (!enhancePromptResult || !enhancePromptResultText) return;
    const resolveMessage = typeof messageOrResolver === 'function'
      ? messageOrResolver
      : () => String(messageOrResolver ?? '');
    enhancePromptResultState = { ok, resolveMessage };
    enhancePromptResult.style.display = 'block';
    enhancePromptResult.className = `unlock-result-box ${ok ? 'result-success' : 'result-error'}`;
    enhancePromptResultText.textContent = resolveMessage();
  }

  function getSelectedPresetLabelResolvers() {
    const resolvers = [];
    if (chkPresetPrompt?.checked) resolvers.push(() => t('enhance.preset.itemPrompt'));
    if (chkPresetTitle?.checked) resolvers.push(() => t('enhance.preset.itemTitle'));
    if (chkPresetLang?.checked) resolvers.push(() => t('enhance.preset.itemLang'));
    if (chkPresetCtx?.checked) resolvers.push(() => t('enhance.preset.itemCtx'));
    return resolvers;
  }

  function renderEnhancePresetConfirmText() {
    if (!enhancePresetConfirm || enhancePresetConfirm.hidden || !enhanceConfirmTitle || !pendingEnhanceConfirmMode) return;
    if (pendingEnhanceConfirmMode === 'preset') {
      const items = getSelectedPresetLabelResolvers().map(fn => fn()).join(t('list.sep'));
      enhanceConfirmTitle.textContent = t('enhance.confirm.presetSummary', { items });
    } else if (pendingEnhanceConfirmMode === 'restore') {
      enhanceConfirmTitle.textContent = t('enhance.confirm.restoreSummary');
    }
  }

  function renderProxyTestResultView() {
    if (!proxyTestResult || !lastProxyTestState) return;
    if (lastProxyTestState.pending) {
      proxyTestResult.textContent = t('settings.proxy.testingDetail');
      return;
    }
    if (lastProxyTestState.thrownErr) {
      proxyTestResult.textContent = t('settings.proxy.testErr', { err: translateBackendText(lastProxyTestState.thrownErr) || t('msg.unknownErr') });
      return;
    }
    const res = lastProxyTestState.res;
    if (!res || !res.ok) {
      proxyTestResult.textContent = t('settings.proxy.testFail', { err: translateBackendText(res?.error) || t('models.meta.archUnknown') });
      return;
    }
    const d = res.data;
    proxyTestResult.innerHTML = `
      ${t('settings.proxy.resFmt')}: ${d.configValid ? t('settings.proxy.resValid') : t('settings.proxy.resInvalid')}<br>
      ${t('settings.proxy.resPort')}: ${d.proxyReachable ? t('settings.proxy.resReachable') : t('settings.proxy.resUnreachable')}<br>
      ${t('settings.proxy.resNet')}: ${d.internetReachable ? t('settings.proxy.resOnline') : t('settings.proxy.resOffline')}<br>
      ${t('settings.proxy.resModel')}: ${t('settings.proxy.resPending')}
      ${d.error ? `<br><span style="color:var(--ag-danger)">⚠️ ${translateBackendText(d.error)}</span>` : ''}
    `;
  }

  /** 面板语言切换后，同步更新设置页当前仍可见的动态操作反馈与确认提示 */
  function rerenderSettingsFeedbacks() {
    renderEnhancePresetConfirmText();
    if (enhanceGlobalResultState && enhanceGlobalResult && enhanceGlobalResult.style.display && enhanceGlobalResult.style.display !== 'none') {
      showEnhanceResultBox(enhanceGlobalResultState.ok, enhanceGlobalResultState.resolveMessage, enhanceGlobalResultState.opts);
    }
    if (enhancePromptResultState && enhancePromptResult && enhancePromptResult.style.display && enhancePromptResult.style.display !== 'none') {
      showEnhancePromptResult(enhancePromptResultState.ok, enhancePromptResultState.resolveMessage);
    }
    if (brandFeedbackState && brandApplyFeedback && !brandApplyFeedback.hidden && brandApplyFeedback.style.display && brandApplyFeedback.style.display !== 'none') {
      showBrandFeedback(brandFeedbackState.mode, brandFeedbackState.isSuccess, brandFeedbackState.resolveMessage, brandFeedbackState.isApplied);
    }
    if (lastProxyTestState && proxyTestResult && proxyTestResult.style.display && proxyTestResult.style.display !== 'none') {
      renderProxyTestResultView();
    }
  }

  function applyEnhanceStatusPayload(statusData, { syncDrafts = true, forceSyncDrafts = false } = {}) {
    currentEnhanceStatus = statusData;
    const s = statusData?.summary || statusData;
    if (s && s.pendingLsRestart !== undefined) {
      hasPendingLsReload = Boolean(s.pendingLsRestart);
    }
    const useSavedAfterUpdate = Boolean(s?.clientUpdatedSinceSave && [0, 1, 2, 3, 4].includes(Number(s?.savedPromptTier)));
    if (syncDrafts && s && statusData?.supported !== false) {
      if (forceSyncDrafts || !enhanceTierDirty) {
        const tierVal = useSavedAfterUpdate ? s.savedPromptTier : (s.promptTier ?? s.detectedTier);
        if ([0, 1, 2, 3, 4].includes(Number(tierVal))) {
          selectedEnhanceTier = Number(tierVal);
        }
        if (forceSyncDrafts) enhanceTierDirty = false;
      }
      if (forceSyncDrafts || !enhanceTitleDirty) {
        enhanceTitleDraft = useSavedAfterUpdate ? Boolean(s.savedChineseTitle) : Boolean(s.chineseTitleEnabled);
        if (enhanceChineseTitleCheck) enhanceChineseTitleCheck.checked = enhanceTitleDraft;
        if (forceSyncDrafts) enhanceTitleDirty = false;
      }
      if (useSavedAfterUpdate && (!enhancePromptResult || enhancePromptResult.style.display === 'none')) {
        const savedTierSnap = Number(s.savedPromptTier);
        const savedTitleSnap = Boolean(s.savedChineseTitle);
        showEnhancePromptResult(false, () => t('enhance.result.clientUpdatedNotice', {
          tier: t(`enhance.tier.${savedTierSnap}.short`),
          title: savedTitleSnap ? t('enhance.titleState.on') : t('enhance.titleState.off')
        }));
      }
    }
    renderEnhanceSectionUI();
  }

  async function refreshEnhanceStatus(syncDrafts = true, { forceSyncDrafts = false, forceRefresh = false } = {}) {
    const seq = ++enhanceStatusReqSeq;
    try {
      const res = await invokeEnhanceApi('status', forceRefresh ? { forceRefresh: true } : {});
      if (seq !== enhanceStatusReqSeq) return;
      if (res && res.ok && res.data) {
        applyEnhanceStatusPayload(res.data, { syncDrafts, forceSyncDrafts });
      } else if (res && res.unavailable) {
        currentEnhanceStatus = { supported: false };
        renderEnhanceSectionUI();
      } else {
        renderEnhanceSectionUI();
      }
    } catch {
      if (seq !== enhanceStatusReqSeq) return;
      currentEnhanceStatus = null;
      renderEnhanceSectionUI();
    }
  }

  for (let i = 0; i < enhanceTierBtns.length; i++) {
    const btn = enhanceTierBtns[i];
    btn?.addEventListener('click', () => {
      if (isEnhanceBusy) return;
      selectedEnhanceTier = i;
      enhanceTierDirty = true;
      renderEnhancePromptMatrix(i);
      renderEnhanceSectionUI();
    });
  }

  enhanceTierGrid?.addEventListener('click', (e) => {
    if (isEnhanceBusy) return;
    const btn = e?.target?.closest?.('[data-enhance-tier]');
    if (!btn || btn.disabled) return;
    const idx = Number(btn.getAttribute('data-enhance-tier'));
    if (![0, 1, 2, 3, 4].includes(idx)) return;
    selectedEnhanceTier = idx;
    enhanceTierDirty = true;
    renderEnhancePromptMatrix(idx);
    renderEnhanceSectionUI();
  });

  enhanceChineseTitleCheck?.addEventListener('change', (e) => {
    if (isEnhanceBusy) return;
    enhanceTitleDraft = Boolean(e?.target?.checked);
    enhanceTitleDirty = true;
    renderEnhanceSectionUI();
  });

  btnToggleEnhanceDetails?.addEventListener('click', () => {
    if (!enhanceDetailsBody) return;
    const isHidden = enhanceDetailsBody.style.display === 'none' || !enhanceDetailsBody.style.display;
    enhanceDetailsBody.style.display = isHidden ? 'block' : 'none';
    btnToggleEnhanceDetails.setAttribute('aria-expanded', String(isHidden));
    renderEnhanceSectionUI();
  });

  btnRefreshEnhance?.addEventListener('click', () => {
    if (isEnhanceBusy) return;
    void refreshEnhanceStatus(true, { forceSyncDrafts: true, forceRefresh: true });
  });

  btnApplyEnhancePrompt?.addEventListener('click', async () => {
    if (isEnhanceBusy) return;
    if (currentEnhanceStatus && currentEnhanceStatus.supported === false) {
      showEnhancePromptResult(false, () => t('enhance.status.unsupportedPlatform'));
      return;
    }
    const submittedTier = Number(selectedEnhanceTier);
    const submittedTitle = enhanceChineseTitleCheck ? Boolean(enhanceChineseTitleCheck.checked) : Boolean(enhanceTitleDraft);
    isEnhanceBusy = true;
    syncEnhanceInteractiveDisabledState();
    if (btnApplyEnhancePrompt) {
      btnApplyEnhancePrompt.disabled = true;
      btnApplyEnhancePrompt.textContent = t('enhance.btn.applyPromptBusy');
    }
    showEnhancePromptResult(true, () => t('enhance.btn.applyPromptBusy'));
    try {
      await yieldForSettingsPaint();
      const res = await invokeEnhanceApi('apply', {
        promptTier: submittedTier,
        chineseTitle: submittedTitle,
        restartLanguageServer: false
      });
      if (!res || !res.ok) {
        const errPayload = res;
        const resolveErr = () => t('enhance.result.fail', { err: resolveSettingsErrorText(errPayload, 'msg.unknownErr') });
        showEnhancePromptResult(false, resolveErr);
        showEnhanceResultBox(false, resolveErr);
        await refreshEnhanceStatus(false);
      } else {
        const actualTier = [0, 1, 2, 3, 4].includes(Number(res.appliedPromptTier))
          ? Number(res.appliedPromptTier)
          : ([0, 1, 2, 3, 4].includes(Number(res.status?.summary?.promptTier)) ? Number(res.status.summary.promptTier) : submittedTier);
        const actualTitle = res.appliedChineseTitleEnabled !== undefined
          ? Boolean(res.appliedChineseTitleEnabled)
          : (res.status?.summary?.chineseTitleEnabled !== undefined ? Boolean(res.status.summary.chineseTitleEnabled) : submittedTitle);
        const changedAny = res.changed !== false;
        const needLsRestart = res.needsRestart !== undefined ? Boolean(res.needsRestart) : changedAny;
        hasPendingLsReload = needLsRestart;
        enhanceTierDirty = false;
        enhanceTitleDirty = false;

        const resolveSuccess = (!changedAny && !needLsRestart)
          ? () => t('enhance.result.alreadyApplied', {
            tier: t(`enhance.tier.${actualTier}.short`),
            title: actualTitle ? t('enhance.titleState.on') : t('enhance.titleState.off')
          })
          : () => t('enhance.result.appliedNeedRestartLs', {
            tier: t(`enhance.tier.${actualTier}.short`),
            title: actualTitle ? t('enhance.titleState.on') : t('enhance.titleState.off')
          });
        showEnhancePromptResult(true, resolveSuccess);
        showEnhanceResultBox(true, resolveSuccess, { needsLsRestart: needLsRestart, needsHostRestart: false });
        if (res.status) {
          applyEnhanceStatusPayload(res.status, { syncDrafts: true, forceSyncDrafts: true });
        } else {
          await refreshEnhanceStatus(true, { forceSyncDrafts: true });
        }
      }
    } catch (e) {
      const rawErr = e?.message;
      const resolveErr = () => t('enhance.result.fail', { err: translateBackendText(rawErr) || t('msg.unknownErr') });
      showEnhancePromptResult(false, resolveErr);
      showEnhanceResultBox(false, resolveErr);
    } finally {
      isEnhanceBusy = false;
      if (btnApplyEnhancePrompt) {
        btnApplyEnhancePrompt.textContent = t('enhance.btn.applyPrompt');
      }
      syncEnhanceInteractiveDisabledState();
    }
  });

  btnEnhancePresetApply?.addEventListener('click', () => {
    if (isEnhanceBusy) return;
    const selectedResolvers = getSelectedPresetLabelResolvers();
    if (!selectedResolvers.length) {
      showEnhanceResultBox(false, () => t('enhance.confirm.noneSelected'));
      return;
    }
    pendingEnhanceConfirmMode = 'preset';
    if (enhancePresetConfirm) enhancePresetConfirm.hidden = false;
    renderEnhancePresetConfirmText();
  });

  btnEnhanceRestoreAll?.addEventListener('click', () => {
    if (isEnhanceBusy) return;
    pendingEnhanceConfirmMode = 'restore';
    if (enhancePresetConfirm) enhancePresetConfirm.hidden = false;
    renderEnhancePresetConfirmText();
  });

  btnEnhanceConfirmCancel?.addEventListener('click', () => {
    pendingEnhanceConfirmMode = null;
    if (enhancePresetConfirm) enhancePresetConfirm.hidden = true;
  });

  btnEnhanceConfirmGo?.addEventListener('click', async () => {
    const mode = pendingEnhanceConfirmMode;
    pendingEnhanceConfirmMode = null;
    if (enhancePresetConfirm) enhancePresetConfirm.hidden = true;
    if (!mode || isEnhanceBusy) return;

    const wantPrompt = Boolean(chkPresetPrompt?.checked);
    const wantTitle = Boolean(chkPresetTitle?.checked);
    const wantLang = Boolean(chkPresetLang?.checked);
    const wantCtx = Boolean(chkPresetCtx?.checked);

    isEnhanceBusy = true;
    syncEnhanceInteractiveDisabledState();
    showEnhanceResultBox(true, () => t(mode === 'restore' ? 'enhance.result.restoreWorking' : 'enhance.result.presetWorking'));

    try {
      await yieldForSettingsPaint();
      const doneResolvers = [];
      const failedResolvers = [];
      let needsLsRestart = false;
      let needsHostRestart = false;
      let anyChanged = false;
      let latestEnhanceStatus = null;

      if (mode === 'preset') {
        if (wantPrompt || wantTitle) {
          const resolveItemLabel = () => [wantPrompt ? t('enhance.preset.itemPrompt') : '', wantTitle ? t('enhance.preset.itemTitle') : ''].filter(Boolean).join(t('list.sep'));
          try {
            const payload = {};
            if (wantPrompt) payload.promptTier = 4;
            if (wantTitle) payload.chineseTitle = true;
            const eRes = await invokeEnhanceApi('apply', payload);
            if (!eRes || !eRes.ok) {
              const errPayload = eRes;
              failedResolvers.push(() => `${resolveItemLabel()}: ${resolveSettingsErrorText(errPayload, 'msg.unknownErr')}`);
            } else {
              if (wantPrompt) doneResolvers.push(() => t('enhance.preset.itemPrompt'));
              if (wantTitle) doneResolvers.push(() => t('enhance.preset.itemTitle'));
              if (eRes.changed !== false) anyChanged = true;
              if (eRes.needsRestart !== false) needsLsRestart = true;
              if (eRes.status) latestEnhanceStatus = eRes.status;
              enhanceTierDirty = false;
              enhanceTitleDirty = false;
            }
          } catch (stepErr) {
            const rawErr = stepErr?.message;
            failedResolvers.push(() => `${resolveItemLabel()}: ${translateBackendText(rawErr) || t('msg.unknownErr')}`);
          }
        }

        if (wantLang) {
          try {
            const lRes = await invokeModulesApi('toggle', 'chinese', true, {
              language: 'zh-CN',
              brandTitle: currentBrandTitle
            });
            if (!lRes || !lRes.ok) {
              const errPayload = lRes;
              failedResolvers.push(() => `${t('enhance.preset.itemLang')}: ${resolveSettingsErrorText(errPayload, 'mod.zh.toggleFail')}`);
            } else {
              doneResolvers.push(() => t('enhance.preset.itemLang'));
              anyChanged = true;
              if (lRes.restartRequired !== false) needsHostRestart = true;
            }
          } catch (stepErr) {
            const rawErr = stepErr?.message;
            failedResolvers.push(() => `${t('enhance.preset.itemLang')}: ${translateBackendText(rawErr) || t('mod.zh.toggleFail')}`);
          }
        }

        if (wantCtx) {
          try {
            const cRes = await invokeUnlockApi('apply', { mode: 'dynamic', limitTokens: null });
            if (!cRes || !cRes.ok) {
              const rawErr = cRes?.error;
              failedResolvers.push(() => `${t('enhance.preset.itemCtx')}: ${buildFriendlyWriteError(rawErr)}`);
            } else {
              doneResolvers.push(() => t('enhance.preset.itemCtx'));
              if (!cRes.alreadyMatched) anyChanged = true;
              if (cRes.needsRestart) needsHostRestart = true;
            }
          } catch (stepErr) {
            const rawErr = stepErr?.message;
            failedResolvers.push(() => `${t('enhance.preset.itemCtx')}: ${translateBackendText(rawErr) || t('msg.unknownErr')}`);
          }
        }
      } else if (mode === 'restore') {
        const resolvePromptTitleLabel = () => `${t('enhance.preset.itemPrompt')} / ${t('enhance.preset.itemTitle')}`;
        try {
          const rRes = await invokeEnhanceApi('restore', {});
          if (!rRes || !rRes.ok) {
            const errPayload = rRes;
            failedResolvers.push(() => `${resolvePromptTitleLabel()}: ${resolveSettingsErrorText(errPayload, 'msg.restoreFail')}`);
          } else {
            doneResolvers.push(resolvePromptTitleLabel);
            if (rRes.needsRestart) needsLsRestart = true;
            if (rRes.status) latestEnhanceStatus = rRes.status;
            enhanceTierDirty = false;
            enhanceTitleDirty = false;
          }
        } catch (stepErr) {
          const rawErr = stepErr?.message;
          failedResolvers.push(() => `${resolvePromptTitleLabel()}: ${translateBackendText(rawErr) || t('msg.restoreFail')}`);
        }

        try {
          const lRes = await invokeModulesApi('toggle', 'chinese', false, { language: 'en', brandTitle: 'english' });
          if (!lRes || !lRes.ok) {
            const errPayload = lRes;
            failedResolvers.push(() => `${t('enhance.preset.itemLang')}: ${resolveSettingsErrorText(errPayload, 'mod.zh.toggleFail')}`);
          } else {
            currentBrandTitle = 'english';
            doneResolvers.push(() => t('enhance.preset.itemLang'));
            if (lRes.restartRequired !== false) needsHostRestart = true;
          }
        } catch (stepErr) {
          const rawErr = stepErr?.message;
          failedResolvers.push(() => `${t('enhance.preset.itemLang')}: ${translateBackendText(rawErr) || t('mod.zh.toggleFail')}`);
        }

        try {
          const cRes = await invokeUnlockApi('restore', {});
          if (!cRes || !cRes.ok) {
            const rawErr = cRes?.error;
            failedResolvers.push(() => `${t('enhance.preset.itemCtx')}: ${buildFriendlyWriteError(rawErr)}`);
          } else {
            doneResolvers.push(() => t('enhance.preset.itemCtx'));
            if (cRes.needsRestart) needsHostRestart = true;
          }
        } catch (stepErr) {
          const rawErr = stepErr?.message;
          failedResolvers.push(() => `${t('enhance.preset.itemCtx')}: ${translateBackendText(rawErr) || t('msg.restoreFail')}`);
        }
      }

      if (needsHostRestart) needsRestartAfterApply = true;
      if (needsLsRestart) hasPendingLsReload = true;

      if (failedResolvers.length > 0) {
        const resolveMsg = doneResolvers.length > 0
          ? () => t('enhance.result.partialFail', {
            done: doneResolvers.map(fn => fn()).join(t('list.sep')),
            failed: failedResolvers.map(fn => fn()).join(t('list.semiSep'))
          })
          : () => t('enhance.result.fail', {
            err: failedResolvers.map(fn => fn()).join(t('list.semiSep'))
          });
        showEnhanceResultBox(false, resolveMsg, { needsLsRestart, needsHostRestart });
      } else if (mode === 'preset') {
        const key = (!anyChanged && !needsLsRestart && !needsHostRestart)
          ? 'enhance.result.presetAlreadyApplied'
          : 'enhance.result.presetDone';
        showEnhanceResultBox(
          true,
          () => t(key, { summary: doneResolvers.map(fn => fn()).join(t('list.sep')) }),
          { needsLsRestart, needsHostRestart }
        );
      } else if (mode === 'restore') {
        showEnhanceResultBox(true, () => t('enhance.result.restoredDone'), { needsLsRestart, needsHostRestart: true });
      }

      if (latestEnhanceStatus) {
        applyEnhanceStatusPayload(latestEnhanceStatus, { syncDrafts: true, forceSyncDrafts: true });
        await Promise.all([refreshModulesDisplay(), refreshUnlockStatus()]);
      } else {
        await Promise.all([refreshEnhanceStatus(true, { forceSyncDrafts: true }), refreshModulesDisplay(), refreshUnlockStatus()]);
      }
    } catch (e) {
      const rawErr = e?.message;
      showEnhanceResultBox(false, () => t('enhance.result.fail', { err: translateBackendText(rawErr) || t('msg.unknownErr') }));
    } finally {
      isEnhanceBusy = false;
      syncEnhanceInteractiveDisabledState();
    }
  });

  btnEnhanceRestartLs?.addEventListener('click', async () => {
    if (isLsRestartBusy) return;
    isLsRestartBusy = true;
    if (btnEnhanceRestartLs) {
      btnEnhanceRestartLs.disabled = true;
      btnEnhanceRestartLs.textContent = t('enhance.btn.restartLsBusy');
    }
    try {
      await yieldForSettingsPaint();
      const res = await invokeEnhanceApi('restart-ls', {});
      if (!res || !res.ok) {
        const errPayload = res;
        showEnhanceResultBox(false, () => t('enhance.result.lsRestartFail', { err: resolveSettingsErrorText(errPayload, 'msg.unknownErr') }));
        return;
      }
      const killedCount = Array.isArray(res.killed) ? res.killed.length : (Number(res.killed) || 0);
      hasPendingLsReload = false;
      const hostRestartFlag = needsRestartAfterApply;
      showEnhanceResultBox(true, () => t('enhance.result.lsRestarted', { killed: killedCount }), { needsLsRestart: false, needsHostRestart: hostRestartFlag });
      await refreshEnhanceStatus(false);
    } catch (e) {
      const rawErr = e?.message;
      showEnhanceResultBox(false, () => t('enhance.result.lsRestartFail', { err: translateBackendText(rawErr) || t('msg.unknownErr') }));
    } finally {
      isLsRestartBusy = false;
      if (btnEnhanceRestartLs) {
        btnEnhanceRestartLs.disabled = false;
        btnEnhanceRestartLs.textContent = t('enhance.btn.restartLs');
      }
    }
  });

  btnEnhanceRestartHost?.addEventListener('click', openClientRestartConfirmFlow);

  let selectedBrandTitle = currentBrandTitle;

  /**
   * 定位品牌按钮内的目标文本节点，避免直接覆写 textContent 破坏 React 子元素结构
   */
  function findBrandTextNode(el) {
    if (!el) return null;
    const nodes = el.childNodes ? Array.from(el.childNodes) : (el.children || []);
    for (const node of nodes) {
      if (node && node.nodeType === 3) {
        return node;
      }
    }
    let cur = el;
    let depth = 0;
    while (cur && depth < 6) {
      const children = cur.childNodes ? Array.from(cur.childNodes) : [];
      if (children.length === 1) {
        const only = children[0];
        if (only && only.nodeType === 3) return only;
        if (only && only.nodeType === 1) {
          cur = only;
          depth++;
          continue;
        }
      }
      break;
    }
    return null;
  }

  /**
   * 仅更新品牌节点的纯文本内容，保持 DOM 结构与 i18n 运行时状态同步
   */
  function writeBrandButtonText(btn, expectedText) {
    if (!btn) return;
    const textNode = findBrandTextNode(btn);
    if (textNode) {
      if (textNode.nodeValue !== expectedText) {
        textNode.nodeValue = expectedText;
      }
      textNode._agyOriginal = expectedText;
      return;
    }
    if ((btn.textContent || '') !== expectedText) {
      btn.textContent = expectedText;
    }
  }

  /**
   * 在修改品牌 DOM 之前先同步运行时配置，防止 i18n 扫描器与品牌设置互相冲突
   */
  function syncRuntimeBrandConfig(modeKey) {
    try {
      if (typeof window !== 'undefined' && window.__AGY_I18N_CONFIG__) {
        window.__AGY_I18N_CONFIG__.brandTitle = modeKey;
      }
    } catch { }
  }

  function ensureBrandObserver(modeKey, targetBtn) {
    disconnectBrandObserver();
    try {
      if (globalThis.__AGContextMeterBrandObserver && typeof globalThis.__AGContextMeterBrandObserver.disconnect === 'function') {
        globalThis.__AGContextMeterBrandObserver.disconnect();
        globalThis.__AGContextMeterBrandObserver = null;
      }
    } catch { }
    if (state.disposed || !targetBtn || modeKey === 'english') return;
    try {
      const container = targetBtn.parentElement || targetBtn;
      const expectedText = modeKey === 'hidden' ? '' : '反重力';
      let burstWindowStart = 0;
      let burstCount = 0;
      const obs = new MutationObserver(() => {
        if (state.disposed || brandObserver !== obs || globalThis.__AGContextMeterBrandObserver !== obs) {
          try { obs.disconnect(); } catch { }
          return;
        }
        const btn = document.querySelector('button[data-agy-brand-item="true"]') || targetBtn;
        if (!btn) return;
        const txt = btn.textContent?.trim() || '';
        if (txt === expectedText) return;
        const now = Date.now();
        if (now - burstWindowStart > 250) {
          burstWindowStart = now;
          burstCount = 0;
        }
        burstCount++;
        if (burstCount > 8) {
          // 熔断保护：检测到高频互搏变更时主动停止监听，防止渲染进程主线程卡死
          disconnectBrandObserver();
          return;
        }
        try {
          obs.disconnect();
          writeBrandButtonText(btn, expectedText);
        } finally {
          if (!state.disposed && brandObserver === obs && globalThis.__AGContextMeterBrandObserver === obs) {
            try { obs.observe(container, { childList: true, subtree: true, characterData: true }); } catch { }
          }
        }
      });
      brandObserver = obs;
      globalThis.__AGContextMeterBrandObserver = obs;
      obs.observe(container, { childList: true, subtree: true, characterData: true });
    } catch { }
  }

  function applyBrandTitleToDom(modeKey) {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
      return { found: false, applied: false, nodeText: null };
    }
    disconnectBrandObserver();
    // 1. 优先通过持久化标记锁定曾确认过的品牌节点（确保隐藏清空文字后仍可精准识别与无损恢复）
    let targetBtn = document.querySelector('button[data-agy-brand-item="true"]');

    // 2. 若尚未标记，遍历所有 title-menu-bar-item 菜单按钮，精准仅匹配原文本为 Antigravity 的节点
    if (!targetBtn && typeof document.querySelectorAll === 'function') {
      const menuItems = document.querySelectorAll('button[data-testid="title-menu-bar-item"]');
      for (const btn of menuItems) {
        const txt = btn.textContent?.trim();
        if (txt === 'Antigravity' || txt === '反重力' || btn._agyBrandManaged) {
          targetBtn = btn;
          break;
        }
      }
    }

    // 3. 备选：极左上角区域（top <= 70 && left <= 300）候选定位
    if (!targetBtn && typeof document.querySelectorAll === 'function') {
      const candidateBtns = document.querySelectorAll('button.agy-button, button[class*="agy-button"]');
      for (const btn of candidateBtns) {
        const rect = btn.getBoundingClientRect ? btn.getBoundingClientRect() : { top: 0, left: 0 };
        if (rect.top <= 70 && rect.left <= 300) {
          const txt = btn.textContent?.trim();
          if (txt === 'Antigravity' || txt === '反重力' || btn._agyBrandManaged) {
            targetBtn = btn;
            break;
          }
        }
      }
    }

    if (!targetBtn) {
      return { found: false, applied: false, nodeText: null };
    }

    // 永久保留节点引用与原始身份标记，不顺带修改 document.title 或任务栏标题
    targetBtn.setAttribute('data-agy-brand-item', 'true');
    targetBtn._agyBrandManaged = true;
    if (!targetBtn._agyOriginalText) {
      targetBtn._agyOriginalText = 'Antigravity';
    }

    const expectedText = modeKey === 'translated' ? '反重力' : (modeKey === 'hidden' ? '' : 'Antigravity');

    // 保留菜单入口可用（不设置 display: none，隐藏模式仅清空文字），确保菜单功能随时可点击
    targetBtn.style.display = '';
    writeBrandButtonText(targetBtn, expectedText);
    targetBtn.setAttribute('data-agy-brand-mode', modeKey);

    ensureBrandObserver(modeKey, targetBtn);

    const currentText = targetBtn.textContent?.trim() || '';
    const isApplied = (modeKey === 'hidden' ? currentText === '' : currentText === expectedText);

    return {
      found: true,
      applied: isApplied,
      nodeText: currentText
    };
  }

  function showBrandFeedback(mode, isSuccess = true, customMsgOrResolver = '', isApplied = false) {
    if (!brandApplyFeedback) return;
    const resolveMessage = typeof customMsgOrResolver === 'function'
      ? customMsgOrResolver
      : (customMsgOrResolver
        ? () => String(customMsgOrResolver)
        : () => {
          if (!isSuccess) return t('msg.saveFail');
          const brandVal = getBrandDisplayValue(mode);
          if (!isApplied) return t('enhance.brand.savedNotFound', { mode: brandVal });
          return mode === 'hidden'
            ? t('enhance.brand.appliedHidden')
            : t('enhance.brand.appliedName', { mode: brandVal });
        });
    brandFeedbackState = { mode, isSuccess, resolveMessage, isApplied };
    brandApplyFeedback.style.display = 'block';
    brandApplyFeedback.hidden = false;
    if (!isSuccess) {
      brandApplyFeedback.textContent = resolveMessage();
      brandApplyFeedback.style.color = '#ef4444';
      return;
    }
    brandApplyFeedback.textContent = resolveMessage();
    if (!isApplied) {
      const rBtn = document.createElement('button');
      rBtn.type = 'button';
      rBtn.className = 'unlock-btn unlock-btn-secondary';
      rBtn.style.cssText = 'margin-left:8px;padding:2px 8px;font-size:11px;cursor:pointer;';
      rBtn.textContent = t('models.btnRestartHost');
      rBtn.addEventListener('click', () => openClientRestartConfirmFlow());
      brandApplyFeedback.appendChild(rBtn);
    }
    brandApplyFeedback.style.color = isApplied ? '#10b981' : 'var(--ag-text-primary)';
  }

  async function applyBrandTitleSetting(modeKey) {
    if (btnApplyBrandTitle) btnApplyBrandTitle.disabled = true;
    try {
      await yieldForSettingsPaint();
      const res = await invokeModulesApi('toggle', 'chinese', currentChineseEnabled, {
        language: currentChineseEnabled ? 'zh-CN' : 'en',
        brandTitle: modeKey
      });
      if (!res || !res.ok) {
        const errPayload = res;
        const resolveErr = () => t('enhance.brand.saveFailErr', { err: resolveSettingsErrorText(errPayload, 'msg.saveFail') });
        showBrandFeedback(modeKey, false, resolveErr, false);
        showEnhanceResultBox(false, resolveErr);
        return;
      }
      currentBrandTitle = modeKey;
      selectedBrandTitle = modeKey;
      syncBrandTitleButtons(modeKey);

      // 实时真实 DOM 应用（先同步运行时配置再更新 DOM，防止 i18n 扫描器与品牌设置互相冲突）
      syncRuntimeBrandConfig(modeKey);
      const domResult = applyBrandTitleToDom(modeKey);

      // 实时热同步（若已注入运行时环境）
      try {
        if (typeof window !== 'undefined' && typeof window.__AGY_RUN_FULL_SCAN__ === 'function') {
          window.__AGY_RUN_FULL_SCAN__();
        }
      } catch { }

      if (domResult.applied) {
        const resolveApplied = modeKey === 'hidden'
          ? () => t('enhance.brand.appliedHidden')
          : () => t('enhance.brand.appliedName', { mode: getBrandDisplayValue(modeKey) });
        showBrandFeedback(modeKey, true, resolveApplied, true);
        showEnhanceResultBox(true, resolveApplied, { needsHostRestart: false });
      } else {
        const resolveNotApplied = !domResult.found
          ? () => t('enhance.brand.savedNotFound', { mode: getBrandDisplayValue(modeKey) })
          : () => t('enhance.brand.savedApplyFailed', { mode: getBrandDisplayValue(modeKey) });
        showBrandFeedback(modeKey, true, resolveNotApplied, false);
        showEnhanceResultBox(false, resolveNotApplied, { needsHostRestart: true });
      }
    } catch (e) {
      const rawErr = e?.message;
      const resolveErr = () => t('enhance.brand.saveFailErr', { err: translateBackendText(rawErr) || t('msg.saveFail') });
      showBrandFeedback(modeKey, false, resolveErr, false);
      showEnhanceResultBox(false, resolveErr);
    } finally {
      if (btnApplyBrandTitle) btnApplyBrandTitle.disabled = false;
    }
  }

  for (const [modeKey, btn] of Object.entries(brandTitleBtns)) {
    btn?.addEventListener('click', () => {
      selectedBrandTitle = modeKey;
      syncBrandTitleButtons(modeKey);
      void applyBrandTitleSetting(modeKey);
    });
  }

  btnApplyBrandTitle?.addEventListener('click', () => {
    void applyBrandTitleSetting(selectedBrandTitle || currentBrandTitle);
  });

  async function refreshModulesDisplay({ forceProxySync = false } = {}) {
    const seq = ++modulesStatusReqSeq;
    try {
      const res = await invokeModulesApi('status');
      if (seq !== modulesStatusReqSeq) return;
      if (!res || !res.ok || !res.data) {
        const errMsg = (res && res.error) ? translateBackendText(res.error) : t('msg.unknownErr');
        if (chineseBadge) {
          chineseBadge.textContent = t('mod.readFail');
          chineseBadge.className = 'key-pill pill-danger';
        }
        if (chineseStatusDesc) {
          chineseStatusDesc.textContent = t('mod.zh.failDetect', { err: errMsg });
        }

        if (proxyBadge) {
          proxyBadge.textContent = t('mod.readFail');
          proxyBadge.className = 'key-pill pill-danger';
        }
        if (proxyStatusDesc) {
          proxyStatusDesc.textContent = t('mod.proxy.failDetect', { err: errMsg });
        }
        return;
      }
      const cfg = res.data;
      if (res.configCorrupted && res.configError) {
        showEnhanceResultBox(false, () => translateBackendText(res.configError));
      }

      currentChineseEnabled = Boolean(cfg.modules?.chinese?.enabled);
      currentBrandTitle = cfg.modules?.chinese?.brandTitle || 'english';
      syncBrandTitleButtons(currentBrandTitle);
      syncRuntimeBrandConfig(currentBrandTitle);
      applyBrandTitleToDom(currentBrandTitle);
      const runtimeMeta = res.runtime && typeof res.runtime === 'object' ? res.runtime : null;
      // 判定宿主界面是否已翻译：优先使用 __AGY_I18N_CONFIG__，其次主进程启动期快照 runtimeMeta.chineseActive（跨 Electron 沙箱隔离真实可靠），最后仅匹配宿主固定壳层控件并严格排除用户项目/会话标题
      const isDomTranslated = (() => {
        const cfgSnap = typeof window.__AGY_I18N_CONFIG__ === 'object' && window.__AGY_I18N_CONFIG__
          ? window.__AGY_I18N_CONFIG__
          : null;
        if (cfgSnap) {
          return Boolean(cfgSnap.enabled === true && cfgSnap.language !== 'en');
        }
        if (runtimeMeta && typeof runtimeMeta.chineseActive === 'boolean') {
          return Boolean(runtimeMeta.chineseActive);
        }
        if (typeof window.__AGY_I18N_DATA__ !== 'undefined' || typeof window.__AGY_TRANSLATE_EL__ !== 'undefined') {
          return true;
        }
        try {
          const fixedSelectors = [
            "[data-testid='new-conversation-button']",
            "[data-testid='automations-button']",
            "[data-testid='settings-button']",
            "[data-testid='open-editor-single']",
            "[data-testid='title-menu-bar-item']"
          ];
          const exactSystemLabels = new Set([
            '新建对话', '新建会话', '自动化', '设置', '打开 IDE', '工作区', '视图', '窗口', '自定义扩展'
          ]);
          for (let i = 0; i < fixedSelectors.length; i++) {
            const nodes = document.querySelectorAll ? document.querySelectorAll(fixedSelectors[i]) : [];
            for (let j = 0; j < nodes.length; j++) {
              const txt = (nodes[j].textContent || '').replace(/^\+\s*/, '').trim();
              if (txt && exactSystemLabels.has(txt)) return true;
            }
          }
        } catch { }
        return false;
      })();
      const disk = res.disk || {};
      const isChineseDiskReady = disk.chineseReady !== undefined ? Boolean(disk.chineseReady) : Boolean(disk.chinese);
      const isChinesePartial = Boolean(disk.chinese && disk.chineseReady === false);
      const isProxyDiskReady = disk.proxyReady !== undefined ? Boolean(disk.proxyReady) : Boolean(disk.proxy);
      const isProxyPartial = Boolean(disk.proxy && disk.proxyReady === false);

      if (chineseBadge) {
        if (!currentChineseEnabled) {
          if (isDomTranslated) {
            chineseBadge.textContent = t('mod.zh.badgeRestartEn');
            chineseBadge.className = 'key-pill pill-warn';
          } else {
            chineseBadge.textContent = isChineseDiskReady ? t('mod.zh.badgeOffReady') : t('mod.zh.badgeNotInstalled');
            chineseBadge.className = 'key-pill pill-muted';
          }
        } else if (isDomTranslated) {
          chineseBadge.textContent = t('mod.zh.badgeActive');
          chineseBadge.className = 'key-pill pill-ok';
        } else if (!isChineseDiskReady) {
          chineseBadge.textContent = t('mod.zh.badgeNotInjected');
          chineseBadge.className = 'key-pill pill-danger';
        } else {
          chineseBadge.textContent = t('mod.zh.badgePendingRestart');
          chineseBadge.className = 'key-pill pill-warn';
        }
      }
      if (chineseStatusDesc) {
        if (!currentChineseEnabled) {
          if (isDomTranslated) {
            chineseStatusDesc.textContent = t('mod.zh.descRestartEn');
          } else {
            chineseStatusDesc.textContent = isChineseDiskReady
              ? t('mod.zh.descOffReady')
              : t('mod.zh.descOffNotInstalled');
          }
        } else if (isDomTranslated) {
          chineseStatusDesc.textContent = t('mod.zh.descActive');
        } else if (!isChineseDiskReady) {
          chineseStatusDesc.textContent = isChinesePartial && disk.chineseReason
            ? t('mod.zh.descPartialInject', { reason: translateBackendText(disk.chineseReason) })
            : t('mod.zh.descNeedInject');
        } else {
          chineseStatusDesc.textContent = t('mod.zh.descPendingRestart');
        }
      }
      if (btnToggleChineseModule) {
        btnToggleChineseModule.textContent = currentChineseEnabled ? t('mod.zh.btnDisable') : t('mod.zh.btnEnable');
      }
      syncClientLanguageButtons();

      currentProxyEnabled = Boolean(cfg.modules?.proxy?.enabled);
      const diskProxyUrl = String(cfg.modules?.proxy?.proxyUrl || '');
      const diskProxyBypass = String(cfg.modules?.proxy?.bypassList || '');
      savedProxyUrl = diskProxyUrl;
      savedProxyBypass = diskProxyBypass;

      if (inputProxyUrl && diskProxyUrl && (forceProxySync || (!proxyInputDirty && document?.activeElement !== inputProxyUrl))) {
        inputProxyUrl.value = diskProxyUrl;
      }
      if (inputProxyBypass && (forceProxySync || (!proxyInputDirty && document?.activeElement !== inputProxyBypass))) {
        inputProxyBypass.value = diskProxyBypass;
      }
      if (runtimeMeta) {
        if (typeof runtimeMeta.chineseNeedsRestart === 'boolean') {
          needsRestartAfterApply = Boolean(runtimeMeta.proxyNeedsRestart || runtimeMeta.chineseNeedsRestart);
        } else if (runtimeMeta.proxyNeedsRestart) {
          needsRestartAfterApply = true;
        }
        renderClientStatusBar();
      }

      if (proxyBadge) {
        if (currentProxyEnabled) {
          if (!isProxyDiskReady) {
            proxyBadge.textContent = t('mod.proxy.badgeNotInjected');
            proxyBadge.className = 'key-pill pill-warn';
          } else if (runtimeMeta?.proxyNeedsRestart) {
            proxyBadge.textContent = t('mod.proxy.badgePendingRestart');
            proxyBadge.className = 'key-pill pill-warn';
          } else if (runtimeMeta?.proxyActive) {
            proxyBadge.textContent = t('mod.proxy.badgeActive');
            proxyBadge.className = 'key-pill pill-ok';
          } else {
            proxyBadge.textContent = t('mod.proxy.badgeOk');
            proxyBadge.className = 'key-pill pill-ok';
          }
        } else if (runtimeMeta?.proxyNeedsRestart) {
          proxyBadge.textContent = t('mod.proxy.badgePendingOff');
          proxyBadge.className = 'key-pill pill-warn';
        } else {
          proxyBadge.textContent = t('mod.proxy.badgeOff');
          proxyBadge.className = 'key-pill pill-muted';
        }
      }
      if (proxyStatusDesc) {
        if (currentProxyEnabled) {
          if (!isProxyDiskReady) {
            proxyStatusDesc.textContent = isProxyPartial && disk.proxyReason
              ? t('mod.proxy.descPartialInject', { reason: translateBackendText(disk.proxyReason) })
              : t('mod.proxy.descNeedInject');
          } else if (runtimeMeta?.proxyNeedsRestart) {
            proxyStatusDesc.textContent = t('mod.proxy.descPendingRestart', { url: diskProxyUrl });
          } else if (runtimeMeta?.proxyActive) {
            proxyStatusDesc.textContent = t('mod.proxy.descActive', { url: runtimeMeta.runtimeProxyUrl || diskProxyUrl });
          } else {
            proxyStatusDesc.textContent = t('mod.proxy.descOn', { url: diskProxyUrl });
          }
        } else if (runtimeMeta?.proxyNeedsRestart) {
          proxyStatusDesc.textContent = t('mod.proxy.descPendingOff', { url: runtimeMeta.runtimeProxyUrl || '' });
        } else {
          proxyStatusDesc.textContent = t('mod.proxy.descOff');
        }
      }
      if (btnToggleProxyModule) {
        btnToggleProxyModule.textContent = currentProxyEnabled ? t('mod.proxy.btnDisable') : t('mod.proxy.btnEnable');
      }
      syncProxySaveButtonState();
    } catch (err) {
      if (seq !== modulesStatusReqSeq) return;
      const errMsg = err?.message || String(err);
      if (chineseBadge) {
        chineseBadge.textContent = t('mod.readErr');
        chineseBadge.className = 'key-pill pill-danger';
      }
      if (chineseStatusDesc) {
        chineseStatusDesc.textContent = t('mod.zh.errDetect', { err: errMsg });
      }
      if (proxyBadge) {
        proxyBadge.textContent = t('mod.readErr');
        proxyBadge.className = 'key-pill pill-danger';
      }
      if (proxyStatusDesc) {
        proxyStatusDesc.textContent = t('mod.proxy.errDetect', { err: errMsg });
      }
    }
  }

  async function setClientLanguageTarget(wantChinese) {
    if (Boolean(wantChinese) === Boolean(currentChineseEnabled)) return;
    if (btnToggleChineseModule) {
      btnToggleChineseModule.disabled = true;
      btnToggleChineseModule.textContent = t('mod.processing');
    }
    try {
      await yieldForSettingsPaint();
      const res = await invokeModulesApi('toggle', 'chinese', Boolean(wantChinese), {
        language: wantChinese ? 'zh-CN' : 'en',
        brandTitle: currentBrandTitle
      });
      if (!res || !res.ok) {
        const errPayload = res;
        showEnhanceResultBox(false, () => resolveSettingsErrorText(errPayload, 'mod.zh.toggleFail'));
      } else {
        needsRestartAfterApply = Boolean(res.restartRequired);
        renderClientStatusBar();
        if (res.restartRequired) {
          showEnhanceResultBox(
            true,
            () => t(wantChinese ? 'mod.zh.savedEnableRestart' : 'mod.zh.savedDisableRestart'),
            { needsHostRestart: true }
          );
        } else {
          showEnhanceResultBox(
            true,
            () => translateBackendText(res.message || '已同步回当前运行状态，无需重启'),
            { needsHostRestart: false }
          );
        }
      }
      await refreshModulesDisplay();
    } catch (e) {
      showEnhanceResultBox(false, () => `${t('mod.zh.toggleFail')}: ${resolveSettingsErrorText(e, 'msg.unknownErr')}`);
    } finally {
      if (btnToggleChineseModule) {
        btnToggleChineseModule.disabled = false;
        btnToggleChineseModule.textContent = currentChineseEnabled ? t('mod.zh.btnDisable') : t('mod.zh.btnEnable');
      }
    }
  }

  btnClientLangZhCn?.addEventListener('click', () => {
    void setClientLanguageTarget(true);
  });
  btnClientLangEn?.addEventListener('click', () => {
    void setClientLanguageTarget(false);
  });

  btnToggleChineseModule?.addEventListener('click', () => {
    void setClientLanguageTarget(!currentChineseEnabled);
  });

  async function applyProxyModuleUpdate(enableTarget) {
    if (isProxyBusy) return;
    isProxyBusy = true;
    const rawUrl = String(inputProxyUrl?.value ?? '').trim();
    const rawBypass = String(inputProxyBypass?.value ?? '').trim();
    if (btnToggleProxyModule) {
      btnToggleProxyModule.disabled = true;
      btnToggleProxyModule.textContent = t('mod.processing');
    }
    syncProxySaveButtonState();
    try {
      await yieldForSettingsPaint();
      const res = await invokeModulesApi('toggle', 'proxy', Boolean(enableTarget), {
        proxyUrl: rawUrl || undefined,
        bypassList: rawBypass
      });
      if (!res || !res.ok) {
        const errPayload = res;
        showEnhanceResultBox(false, () => resolveSettingsErrorText(errPayload, 'mod.proxy.toggleFail'));
      } else {
        proxyInputDirty = false;
        const needRestart = Boolean(res.runtime?.proxyNeedsRestart ?? res.restartRequired);
        if (needRestart) needsRestartAfterApply = true;
        const appliedUrl = res.data?.modules?.proxy?.proxyUrl || rawUrl;
        if (enableTarget) {
          const msgKey = needRestart ? 'mod.proxy.savedPendingRestart' : 'mod.proxy.savedAlreadyActive';
          showEnhanceResultBox(true, () => t(msgKey, { url: appliedUrl }), { needsHostRestart: needRestart });
        } else {
          const msgKey = needRestart ? 'mod.proxy.disabledPendingRestart' : 'mod.proxy.disabledSaved';
          showEnhanceResultBox(true, () => t(msgKey), { needsHostRestart: needRestart });
        }
      }
      await refreshModulesDisplay({ forceProxySync: true });
    } catch (e) {
      showEnhanceResultBox(false, () => `${t('mod.proxy.toggleFail')}: ${resolveSettingsErrorText(e, 'msg.unknownErr')}`);
    } finally {
      isProxyBusy = false;
      if (btnToggleProxyModule) {
        btnToggleProxyModule.disabled = false;
        btnToggleProxyModule.textContent = currentProxyEnabled ? t('mod.proxy.btnDisable') : t('mod.proxy.btnEnable');
      }
      syncProxySaveButtonState();
    }
  }

  btnToggleProxyModule?.addEventListener('click', () => {
    void applyProxyModuleUpdate(!currentProxyEnabled);
  });

  btnSaveProxyConfig?.addEventListener('click', () => {
    void applyProxyModuleUpdate(true);
  });

  btnTestProxy?.addEventListener('click', async () => {
    if (isProxyBusy) return;
    try {
      if (btnTestProxy) {
        btnTestProxy.disabled = true;
        btnTestProxy.textContent = t('settings.proxy.testing');
      }
      if (proxyTestResult) {
        proxyTestResult.style.display = 'block';
        lastProxyTestState = { pending: true };
        renderProxyTestResultView();
      }
      await yieldForSettingsPaint();
      const res = await invokeTestProxyApi(inputProxyUrl?.value?.trim());
      if (proxyTestResult) {
        lastProxyTestState = { pending: false, res };
        renderProxyTestResultView();
      }
    } catch (e) {
      if (proxyTestResult) {
        lastProxyTestState = { pending: false, thrownErr: e?.message || String(e || '') };
        renderProxyTestResultView();
      }
    } finally {
      if (btnTestProxy) {
        btnTestProxy.disabled = false;
        btnTestProxy.textContent = t('settings.proxy.testBtn');
      }
    }
  });

  // 静默初始化检测一次解锁状态与各模块状态
  const initDetectTimer1 = setTimeout(() => {
    if (state.disposed) return;
    void refreshUnlockStatus();
    void refreshModulesDisplay();
  }, 500);
  const initDetectTimer2 = setTimeout(() => {
    if (state.disposed) return;
    if (currentChineseEnabled) {
      void refreshModulesDisplay();
    }
  }, 2000);
  earlyDisposeHooks.push(() => {
    clearTimeout(initDetectTimer1);
    clearTimeout(initDetectTimer2);
  });

  // 二级抽屉 1（面板 B 内）: 指标与背景颜色自定义抽屉折叠展开
  const btnColors = el('btn-toggle-colors');
  const colorDrawerBody = el('color-drawer-body');
  const colorDrawerArrow = el('color-drawer-arrow');
  function toggleColorsDrawer(forceOpen) {
    if (!colorDrawerBody) return;
    const isHidden = colorDrawerBody.style.display === 'none' || !colorDrawerBody.style.display;
    const nextOpen = typeof forceOpen === 'boolean' ? forceOpen : isHidden;
    colorDrawerBody.style.display = nextOpen ? 'block' : 'none';
    if (colorDrawerArrow) colorDrawerArrow.textContent = nextOpen ? t('drawer.colors.collapse') : t('drawer.colors.expand');
    btnColors?.setAttribute('aria-expanded', String(nextOpen));
    if (!nextOpen) {
      closeColorPicker();
    }
  }
  btnColors?.addEventListener('click', () => toggleColorsDrawer());

  // 二级抽屉 2（面板 B 内）: 底层技术抽屉折叠展开
  const btnDetails = el('btn-toggle-details');
  const drawerBody = el('drawer-body');
  const drawerArrow = el('drawer-arrow');
  btnDetails?.addEventListener('click', () => {
    if (!drawerBody) return;
    const isHidden = drawerBody.style.display === 'none' || !drawerBody.style.display;
    drawerBody.style.display = isHidden ? 'block' : 'none';
    if (drawerArrow) drawerArrow.textContent = isHidden ? t('session.techDrawer.collapse') : t('session.techDrawer.expand');
    btnDetails.setAttribute('aria-expanded', String(isHidden));
  });

  // 模型卡片下一层详情折叠展开（实测预算、速度与内部详情）
  const btnCardDetails = el('btn-toggle-card-details');
  const cardDrawerBody = el('ctx-card-drawer-body');
  const cardDrawerArrow = el('ctx-card-drawer-arrow');
  btnCardDetails?.addEventListener('click', () => {
    if (!cardDrawerBody) return;
    const isHidden = cardDrawerBody.style.display === 'none' || !cardDrawerBody.style.display;
    cardDrawerBody.style.display = isHidden ? 'block' : 'none';
    if (cardDrawerArrow) cardDrawerArrow.textContent = isHidden ? t('session.techDrawer.collapse') : t('session.techDrawer.expand');
    btnCardDetails.setAttribute('aria-expanded', String(isHidden));
  });

  // 二级抽屉 3（面板 A 内就近设置）: 热力图色阶与面板外观自定义抽屉折叠展开
  const btnTokenColors = el('btn-toggle-token-colors');
  const tokenColorDrawerBody = el('token-color-drawer-body');
  const tokenColorDrawerArrow = el('token-color-drawer-arrow');
  function toggleTokenColorsDrawer(forceOpen) {
    if (!tokenColorDrawerBody) return;
    const curHidden = tokenColorDrawerBody.style.display === 'none' || !tokenColorDrawerBody.style.display;
    const nextOpen = typeof forceOpen === 'boolean' ? forceOpen : curHidden;
    tokenColorDrawerBody.style.display = nextOpen ? 'block' : 'none';
    tokenColorDrawerBody.classList?.toggle?.('is-expanded', nextOpen);
    if (tokenColorDrawerArrow) tokenColorDrawerArrow.textContent = nextOpen ? t('drawer.colors.collapse') : t('drawer.colors.expand');
    btnTokenColors?.setAttribute('aria-expanded', String(nextOpen));
    if (!nextOpen) {
      closeColorPicker(false);
    }
  }
  btnTokenColors?.addEventListener('click', () => toggleTokenColorsDrawer());
  el('heat-legend-scale')?.addEventListener('click', () => toggleTokenColorsDrawer(true));

  // 热力图视图切换（每天 / 每周 / 累计总量）

  // 费用估算范围（默认本期：自然月）与估值模式（默认参考模型折算，首屏展示真实用量价值）
  let activeCostScope = 'period'; // 'period' | 'all'
  let costModelMode = 'ref'; // 'ref' | 'hybrid' | 'identified'
  let activeRefMode = 'all'; // 兼容旧接口 'all' | 'hybrid'

  function switchCostScope(scope) {
    activeCostScope = scope;
    setPillActive(el('cost-btn-scope-period'), scope === 'period');
    setPillActive(el('cost-btn-scope-all'), scope === 'all');
    renderActiveCostEstimateView();
  }
  el('cost-btn-scope-period')?.addEventListener('click', () => switchCostScope('period'));
  el('cost-btn-scope-all')?.addEventListener('click', () => switchCostScope('all'));

  function switchCostModelMode(mode) {
    costModelMode = mode;
    setPillActive(el('cost-btn-mode-ref'), mode === 'ref');
    setPillActive(el('cost-btn-mode-hybrid'), mode === 'hybrid');
    setPillActive(el('cost-btn-mode-identified'), mode === 'identified');
    renderActiveCostEstimateView();
  }
  el('cost-btn-mode-ref')?.addEventListener('click', () => switchCostModelMode('ref'));
  el('cost-btn-mode-hybrid')?.addEventListener('click', () => switchCostModelMode('hybrid'));
  el('cost-btn-mode-identified')?.addEventListener('click', () => switchCostModelMode('identified'));

  function toggleRefCostDrawer(forceOpen) {
    const body = el('ref-cost-drawer-body');
    const btn = el('btn-toggle-ref-cost-drawer');
    if (!body) return;
    const curHidden = body.style.display === 'none' || !body.style.display;
    const next = typeof forceOpen === 'boolean' ? forceOpen : curHidden;
    body.style.display = next ? 'block' : 'none';
    if (btn) btn.textContent = next ? t('cost.btnCollapse') : t('cost.btnExpand');
  }
  el('btn-toggle-ref-cost-drawer')?.addEventListener('click', () => toggleRefCostDrawer());

  function switchRefMode(mode) {
    activeRefMode = mode;
    costModelMode = mode === 'hybrid' ? 'hybrid' : 'ref';
    setPillActive(el('btn-ref-mode-all'), mode === 'all');
    setPillActive(el('btn-ref-mode-hybrid'), mode === 'hybrid');
    renderActiveCostEstimateView();
  }
  el('btn-ref-mode-all')?.addEventListener('click', () => switchRefMode('all'));
  el('btn-ref-mode-hybrid')?.addEventListener('click', () => switchRefMode('hybrid'));

  function renderActiveCostEstimateView() {
    const isPeriod = activeCostScope === 'period';
    const titleEl = el('cost-card-title');
    const periodTag = el('cost-period-tag');
    const grandVal = el('cost-grand-val');
    const grandSub = el('cost-grand-sub');
    const covPill = el('cost-coverage-pill');
    const subSpendVal = el('cost-sub-spend-val');
    const subSpendLbl = el('cost-sub-spend-lbl');
    const subNote = el('cost-sub-compare-note');
    const usageSummary = el('cost-usage-summary');
    const diffSummary = el('cost-diff-summary');
    const breakdown = el('cost-breakdown-info');

    // 分类卡片 DOM
    const inVal = el('ref-cost-input-val');
    const inTok = el('ref-cost-input-tok');
    const caVal = el('ref-cost-cache-val');
    const caTok = el('ref-cost-cache-tok');
    const outVal = el('ref-cost-output-val');
    const outTok = el('ref-cost-output-tok');

    if (titleEl) titleEl.textContent = isPeriod ? t('cost.title') : t('cost.titleAll');
    if (periodTag) {
      const pKey = formatPeriodCalendarLabel(ANTIGRAVITY_TOKEN_DATA.currentPeriod);
      periodTag.textContent = isPeriod ? pKey : t('cost.allHistory');
    }

    // 1. 提取当前范围真实用量与折算数据
    const curIn = isPeriod
      ? Number(ANTIGRAVITY_TOKEN_DATA.summary?.currentMonthInput || 0)
      : Number(ANTIGRAVITY_TOKEN_DATA.summary?.totalInputTokens || 0);
    const curCa = isPeriod
      ? Number(ANTIGRAVITY_TOKEN_DATA.summary?.currentMonthCache || 0)
      : Number(ANTIGRAVITY_TOKEN_DATA.summary?.totalCacheTokens || 0);
    const curOut = isPeriod
      ? Number(ANTIGRAVITY_TOKEN_DATA.summary?.currentMonthOutput || 0)
      : Number(ANTIGRAVITY_TOKEN_DATA.summary?.totalOutputTokens || 0);
    const curTotal = isPeriod
      ? Number(ANTIGRAVITY_TOKEN_DATA.summary?.monthTokens || (curIn + curCa + curOut))
      : Number(ANTIGRAVITY_TOKEN_DATA.summary?.grandTotalTokens || (curIn + curCa + curOut));

    const refAll = ANTIGRAVITY_TOKEN_DATA.referenceCost?.all || {};
    const refMonth = ANTIGRAVITY_TOKEN_DATA.referenceCost?.currentMonth || {};
    const refHybridAll = ANTIGRAVITY_TOKEN_DATA.referenceCost?.hybrid || {};
    const refHybridMonth = ANTIGRAVITY_TOKEN_DATA.referenceCost?.currentMonthHybrid || refHybridAll;

    const curRef = isPeriod ? refMonth : refAll;
    const curHybrid = isPeriod ? refHybridMonth : refHybridAll;

    const ceSourceMap = ANTIGRAVITY_TOKEN_DATA.costEstimateBySource || {};
    const ceAll = ceSourceMap[activeTokenSource] || ceSourceMap.all || ANTIGRAVITY_TOKEN_DATA.costEstimate || {};
    const cePeriod = ANTIGRAVITY_TOKEN_DATA.costEstimateCurrentMonth || ceAll;
    const curIdentified = isPeriod ? cePeriod : ceAll;

    let apiCost = 0;
    let pillText = t('cost.covFull');
    let pillClass = 'key-pill pill-good';

    const inShare = el('ref-cost-input-share');
    const inBar = el('ref-cost-input-bar');
    const caShare = el('ref-cost-cache-share');
    const caBar = el('ref-cost-cache-bar');
    const outShare = el('ref-cost-output-share');
    const outBar = el('ref-cost-output-bar');
    let cInUSD = 0, cCaUSD = 0, cOutUSD = 0;

    // 2. 估值模式计算
    let effectiveRef = curRef;
    if ((effectiveRef.totalCostUSD === undefined || effectiveRef.totalCostUSD === null) && curTotal > 0) {
      const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
      if (core && core.calculateReferenceModelCost) {
        effectiveRef = core.calculateReferenceModelCost({
          inputTokens: curIn,
          outputTokens: curOut,
          cacheTokens: curCa,
          totalTokens: curTotal
        }, 'gemini-3.8-flash', { pricingDate: '2026-11-09', mode: 'all' });
      }
    }

    const rateIn = Number(effectiveRef.matchedTier?.inputPerMillion ?? 0.75);
    const rateCa = Number(effectiveRef.matchedTier?.cacheReadPerMillion ?? 0.075);
    const rateOut = Number(effectiveRef.matchedTier?.outputPerMillion ?? 3.75);

    // 更新小摘要来源与时间描述行及非实付常驻标识
    const scopeDescEl = el('cost-scope-desc');
    if (scopeDescEl) {
      const srcName = activeTokenSource === 'desktop' ? t('tokens.srcDesktopLabel') : activeTokenSource === 'cli' ? 'CLI' : t('tokens.srcAllLabel');
      const pLabel = isPeriod ? formatPeriodCalendarLabel(ANTIGRAVITY_TOKEN_DATA.currentPeriod) : t('cost.allHistory');
      scopeDescEl.textContent = `${srcName} · ${pLabel}`;
    }
    const nonPaidBadge = el('cost-non-paid-badge');
    if (nonPaidBadge) nonPaidBadge.textContent = t('cost.nonPaidBadge');

    if (costModelMode === 'ref') {
      apiCost = Number(effectiveRef.totalCostUSD || 0);
      if (grandVal) {
        if (apiCost > 0) {
          grandVal.textContent = currentPanelLanguage === 'zh-CN'
            ? t('cost.approx', { val: apiCost.toFixed(2) })
            : formatUsdMetricDisplay(apiCost, { detail: currentPanelLanguage === 'zh-TW' });
          grandVal.title = formatUsdMetricTooltip(apiCost);
        } else if (curTotal > 0 && curIn === 0 && curCa === 0 && curOut === 0) {
          grandVal.textContent = t('cost.notReady');
          grandVal.title = t('cost.notReady');
        } else if (activeTokenAccountFilter !== 'all' && curTotal === 0) {
          grandVal.textContent = t('cost.noRecords');
          grandVal.title = t('accounts.filterNoData');
        } else {
          grandVal.textContent = '$0.00';
          grandVal.title = t('cost.noRecords');
        }
      }
      if (grandSub) {
        grandSub.textContent = t('cost.refSub', {
          model: effectiveRef.modelDisplayName || 'Gemini 3.8 Flash',
          in: rateIn.toFixed(2),
          ca: rateCa.toFixed(3),
          out: rateOut.toFixed(2)
        });
      }
      pillText = t('cost.modeRef');
      pillClass = 'key-pill pill-muted';

      cInUSD = Number(effectiveRef.inputCostUSD || (curIn * rateIn / 1e6));
      cCaUSD = Number(effectiveRef.cacheCostUSD || (curCa * rateCa / 1e6));
      cOutUSD = Number(effectiveRef.outputCostUSD || (curOut * rateOut / 1e6));
      if (inVal) inVal.textContent = `$${cInUSD.toFixed(2)}`;
      if (inTok) inTok.textContent = `${fmtYi(curIn)} tok`;
      if (caVal) caVal.textContent = `$${cCaUSD.toFixed(2)}`;
      if (caTok) caTok.textContent = t('cost.tokCacheDiscount', { tok: fmtYi(curCa) });
      if (outVal) outVal.textContent = `$${cOutUSD.toFixed(2)}`;
      if (outTok) outTok.textContent = `${fmtYi(curOut)} tok`;
    } else if (costModelMode === 'hybrid') {
      const h = curHybrid.hybrid || {};
      apiCost = Number(h.combinedTotalUSD || effectiveRef.totalCostUSD || 0);
      if (grandVal) {
        grandVal.textContent = currentPanelLanguage === 'zh-CN'
          ? t('cost.approx', { val: apiCost.toFixed(2) })
          : formatUsdMetricDisplay(apiCost, { detail: currentPanelLanguage === 'zh-TW' });
        grandVal.title = `${t('cost.hybridSub', { known: Number(h.knownCostUSD || 0).toFixed(2), res: Number(h.unpricedResidualCostUSD || 0).toFixed(2) })} | ${formatUsdMetricTooltip(apiCost)}`;
      }
      if (grandSub) {
        grandSub.textContent = t('cost.hybridSub', {
          known: Number(h.knownCostUSD || 0).toFixed(2),
          res: Number(h.unpricedResidualCostUSD || 0).toFixed(2)
        });
      }
      pillText = t('cost.hybridBadge');
      pillClass = 'key-pill pill-muted';

      const rb = h.residualTokensBreakdown || {};
      cInUSD = Number(rb.inputCostUSD || (Number(rb.input || 0) * rateIn / 1e6));
      cCaUSD = Number(rb.cacheCostUSD || (Number(rb.cache || 0) * rateCa / 1e6));
      cOutUSD = Number(rb.outputCostUSD || (Number(rb.output || 0) * rateOut / 1e6));
      if (inVal) inVal.textContent = `$${cInUSD.toFixed(2)}`;
      if (inTok) inTok.textContent = t('cost.tokResidual', { tok: fmtYi(rb.input || 0) });
      if (caVal) caVal.textContent = `$${cCaUSD.toFixed(2)}`;
      if (caTok) caTok.textContent = t('cost.tokResidual', { tok: fmtYi(rb.cache || 0) });
      if (outVal) outVal.textContent = `$${cOutUSD.toFixed(2)}`;
      if (outTok) outTok.textContent = t('cost.tokResidual', { tok: fmtYi(rb.output || 0) });
    } else {
      // 仅已识别真实模型
      const pricedCount = Number(curIdentified.pricedRequestsCount || 0);
      const unpricedCount = Number(curIdentified.unpricedRequestsCount || 0);
      const totalCount = pricedCount + unpricedCount;
      apiCost = Number(curIdentified.pricedCostUSD || 0);

      if (grandVal) {
        if (totalCount === 0) {
          grandVal.textContent = t('cost.noRecords');
        } else if (pricedCount === 0) {
          grandVal.textContent = t('cost.unpriced');
          grandVal.title = t('cost.identSubNone');
        } else if (apiCost < 0.01 && apiCost > 0) {
          grandVal.textContent = '<$0.01';
          grandVal.title = `$${apiCost.toFixed(6)}`;
        } else {
          grandVal.textContent = currentPanelLanguage === 'zh-TW'
            ? formatUsdMetricDisplay(apiCost, { withPrefix: false, detail: true })
            : `$${apiCost.toFixed(2)}`;
          grandVal.title = formatUsdMetricTooltip(apiCost);
        }
      }
      if (grandSub) {
        grandSub.textContent = pricedCount > 0
          ? t('cost.identSub', { n: pricedCount })
          : t('cost.identSubNone');
      }
      if (pricedCount === 0) {
        pillText = t('cost.covPct', { pct: 0 });
        pillClass = 'key-pill pill-warn';
      } else {
        const pct = curIdentified.coveragePercent != null ? curIdentified.coveragePercent : 0;
        pillText = t('cost.covPct', { pct });
        pillClass = `key-pill ${pct >= 100 ? 'pill-good' : 'pill-warn'}`;
      }

      cInUSD = (curIdentified.byCategory?.inputTokens || 0) * rateIn / 1e6;
      cCaUSD = (curIdentified.byCategory?.cacheTokens || 0) * rateCa / 1e6;
      cOutUSD = (curIdentified.byCategory?.outputTokens || 0) * rateOut / 1e6;
      if (inVal) inVal.textContent = `$${cInUSD.toFixed(2)}`;
      if (inTok) inTok.textContent = `${fmtYi(curIdentified.byCategory?.inputTokens || 0)} tok`;
      if (caVal) caVal.textContent = `$${cCaUSD.toFixed(2)}`;
      if (caTok) caTok.textContent = `${fmtYi(curIdentified.byCategory?.cacheTokens || 0)} tok`;
      if (outVal) outVal.textContent = `$${cOutUSD.toFixed(2)}`;
      if (outTok) outTok.textContent = `${fmtYi(curIdentified.byCategory?.outputTokens || 0)} tok`;
    }

    const cSumUSD = cInUSD + cCaUSD + cOutUSD;
    const pctIn = cSumUSD > 0 ? Math.max(0, Math.min(100, (cInUSD / cSumUSD) * 100)) : 0;
    const pctCa = cSumUSD > 0 ? Math.max(0, Math.min(100, (cCaUSD / cSumUSD) * 100)) : 0;
    const pctOut = cSumUSD > 0 ? Math.max(0, Math.min(100, (cOutUSD / cSumUSD) * 100)) : 0;
    if (inShare) inShare.textContent = `${pctIn.toFixed(1)}%`;
    if (inBar) inBar.style.width = `${pctIn.toFixed(1)}%`;
    if (caShare) caShare.textContent = `${pctCa.toFixed(1)}%`;
    if (caBar) caBar.style.width = `${pctCa.toFixed(1)}%`;
    if (outShare) outShare.textContent = `${pctOut.toFixed(1)}%`;
    if (outBar) outBar.style.width = `${pctOut.toFixed(1)}%`;

    if (covPill) {
      covPill.textContent = pillText;
      covPill.className = pillClass;
      covPill.setAttribute?.('class', pillClass);
    }

    // 3. 用户实际支出渲染（首屏并列右栏）
    const ps = ANTIGRAVITY_TOKEN_DATA.planStatus || {};
    const curSymbol = ps.currencySymbol || '$';
    if (subSpendLbl) subSpendLbl.textContent = t('cost.subSpendLabel');

    const extraNoCompare = isPeriod ? '' : t('cost.allNoCompare');
    const resolvedAcqLabel = (ps.acquisitionSourceName && ps.acquisitionSourceName !== '正常付费订阅')
      ? localizeAcquisitionSource(ps.acquisitionSourceName)
      : localizeAcquisitionSource(ps.acquisitionSource || 'normal_paid');
    const resolvedCycleLabel = ps.billingCycle ? localizeBillingCycleLabel(ps.billingCycle) : t('plan.summary.perMonth');
    if (subSpendVal && subNote) {
      if (ps.actualPricePaid === 0 || ps.isZeroExtraCost) {
        subSpendVal.textContent = `${curSymbol}0`;
        subNote.textContent = t('cost.freeActive', { src: resolvedAcqLabel || t('cost.freePromo'), extra: extraNoCompare });
      } else if (ps.actualPricePaid !== null && ps.actualPricePaid !== undefined) {
        subSpendVal.textContent = `${curSymbol}${Number(ps.actualPricePaid).toFixed(2)}`;
        const expTag = ps.isExpired ? t('cost.expiredTag') : '';
        subNote.textContent = `${resolvedAcqLabel || t('cost.subSpend')} · ${t('cost.paidLabel')} (${resolvedCycleLabel})${expTag}${extraNoCompare}`;
      } else if (ps.officialPriceMonthly !== null && ps.officialPriceMonthly !== undefined) {
        subSpendVal.textContent = t('cost.paidUnknown');
        subNote.textContent = `${t('cost.publicRefMonthly', { p: ps.officialPriceMonthly })}${extraNoCompare}`;
      } else {
        subSpendVal.textContent = t('cost.unknown');
        subNote.textContent = t('cost.noPlanData');
      }
    }

    const subLine = el('cost-sub-line');
    if (subLine) {
      if (ps.actualPricePaid === 0 || ps.isZeroExtraCost) {
        subLine.textContent = t('cost.subLineFree', { sym: curSymbol, src: resolvedAcqLabel || t('plan.tag.promo') });
      } else if (ps.actualPricePaid !== null && ps.actualPricePaid !== undefined) {
        const secPart = formatSubscriptionSecondaryConversion(ps.actualPricePaid, ps.currency || 'USD', ps.region, { detail: true });
        const cnyPart = secPart ? ` (${secPart})` : '';
        subLine.textContent = t('cost.subLinePaid', {
          sym: curSymbol,
          val: Number(ps.actualPricePaid).toFixed(2),
          cny: cnyPart,
          cycle: resolvedCycleLabel,
          exp: ps.isExpired ? ' · ⚠️' : ''
        });
      } else {
        subLine.textContent = t('cost.subUnknown');
      }
    }

    // 4. 用量与参考差额指标条（注明累计处理 Token，含缓存读取）
    if (usageSummary) {
      usageSummary.textContent = t('cost.usageSummary', { total: fmtYi(curTotal), cache: fmtYi(curCa) });
    }
    if (diffSummary) {
      if (!isPeriod) {
        diffSummary.textContent = t('cost.diffAll');
      } else if (ps.actualPricePaid === 0 || ps.isZeroExtraCost) {
        diffSummary.textContent = t('cost.diffFree', { val: apiCost.toFixed(2) });
      } else if (ps.actualPricePaid !== null && ps.actualPricePaid !== undefined) {
        const paidUsd = (ps.currency || 'USD') === 'USD'
          ? Number(ps.actualPricePaid)
          : convertCurrencyUi(ps.actualPricePaid, ps.currency || 'USD', 'USD', ps.region);
        if (paidUsd !== null && Number.isFinite(paidUsd)) {
          const diff = apiCost - paidUsd;
          diffSummary.textContent = t('cost.diffPaid', { sign: diff >= 0 ? '+' : '', val: diff.toFixed(2) });
        } else {
          diffSummary.textContent = t('cost.diffUnknown');
        }
      } else {
        diffSummary.textContent = t('cost.diffUnknown');
      }
    }

    // 5. 详细未计价原因说明
    if (breakdown) {
      const modelKeys = Object.keys(curIdentified.byModel || {});
      const modelDetails = modelKeys.map(k => `${k}: $${curIdentified.byModel[k].costUSD} (${fmt(curIdentified.byModel[k].tokens)} tok)`).join('; ');
      breakdown.textContent = t('cost.breakdownPrefix', {
        details: modelDetails || t('cost.breakdownNone'),
        note: ''
      });
    }

    // 6. 兼容性辅助隐藏层同步
    const refGrand = el('ref-cost-grand-val');
    if (refGrand) {
      const refNum = Number(curRef.totalCostUSD || 0);
      refGrand.textContent = currentPanelLanguage === 'zh-TW'
        ? formatUsdMetricDisplay(refNum, { detail: true })
        : t('cost.refApprox', { val: refNum.toFixed(2) });
    }
  }

  const heatPop = el('heat-pop');
  const heatPopDate = el('heat-pop-date');
  const heatPopVal = el('heat-pop-val');
  const heatPopDet = el('heat-pop-det');

  function hidePopover() {
    if (heatPop) heatPop.style.opacity = '0';
  }

  function updateHeatTabThumb() {
    const thumb = el('heat-tab-thumb');
    const tabsBar = el('heat-tabs-bar');
    const activeBtn = el(`h-tab-${activeHeatView}`);
    if (!thumb || !tabsBar || !activeBtn) return;

    const offsetLeft = activeBtn.offsetLeft || 0;
    const offsetWidth = activeBtn.offsetWidth || 0;
    thumb.style.transform = `translateX(${offsetLeft}px)`;
    thumb.style.width = `${offsetWidth}px`;

    const thumbColor = customColors.tokenAccent || (typeof getEffectiveHeatmapScale === 'function' ? getEffectiveHeatmapScale()[4] : '#a78bfa');
    thumb.style.setProperty('--ag-tab-thumb-bg', thumbColor);
  }

  function renderActiveHeatView(forceRebuild = false) {
    if (activeHeatView === 'weekly') {
      renderHeatmapWeekly();
    } else if (activeHeatView === 'monthly') {
      renderHeatmapMonthly();
    } else if (activeHeatView === 'yearly') {
      renderHeatmapYearly();
    } else if (activeHeatView === 'cum') {
      renderHeatmapCum();
    } else {
      renderHeatmapGrid(forceRebuild);
    }
    computeTimelineWindow();
    updateHeatTabThumb();
  }

  function switchHeatView(view, save = true) {
    if (!['daily', 'weekly', 'monthly', 'yearly', 'cum'].includes(view)) view = 'daily';
    activeHeatView = view;

    const views = ['daily', 'weekly', 'monthly', 'yearly', 'cum'];
    views.forEach(v => {
      const tabBtn = el(`h-tab-${v}`);
      const box = el(`h-${v}-box`);
      const isActive = (v === view);
      if (tabBtn) {
        if (tabBtn.classList) {
          if (isActive) tabBtn.classList.add('active');
          else tabBtn.classList.remove('active');
        } else {
          const cls = (tabBtn.className || '').split(/\s+/).filter(c => c && c !== 'active');
          if (isActive) cls.push('active');
          tabBtn.className = cls.join(' ');
        }
        tabBtn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        tabBtn.setAttribute('tabindex', isActive ? '0' : '-1');
      }
      if (box) {
        if (isActive) {
          box.style.display = (v === 'weekly' || v === 'monthly' || v === 'yearly') ? 'flex' : 'block';
        } else {
          box.style.display = 'none';
        }
      }
    });

    setClassFlag(el('h-scroll-box'), 'is-cum-active', view === 'cum');

    hidePopover();
    renderActiveHeatView(true);
    updateHeatTabThumb();

    if (save && (typeof window?.contextMeterAPI?.saveSettings === 'function' || hasLiveHttpBridge())) {
      void saveSettingsPayloadBridge({ savedHeatView: view });

    }
  }

  ['daily', 'weekly', 'monthly', 'yearly', 'cum'].forEach(v => {
    el(`h-tab-${v}`)?.addEventListener('click', () => switchHeatView(v));
  });

  const tabsBarEl = el('heat-tabs-bar');
  tabsBarEl?.addEventListener('keydown', e => {
    const views = ['daily', 'weekly', 'monthly', 'yearly', 'cum'];
    const curIdx = views.indexOf(activeHeatView);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIdx = (curIdx + 1) % views.length;
      switchHeatView(views[nextIdx]);
      el(`h-tab-${views[nextIdx]}`)?.focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIdx = (curIdx - 1 + views.length) % views.length;
      switchHeatView(views[prevIdx]);
      el(`h-tab-${views[prevIdx]}`)?.focus();
    }
  });

  // 初始化默认热力图视图状态与药丸滑块
  switchHeatView('daily', false);

  /**
   * 仅在累计页可见宽度跨过 460px 窄窗阈值时重绘，自动切换 .is-narrow
   */
  function syncCumResponsiveNarrowState() {
    if (state.disposed || activeHeatView !== 'cum') return false;
    const cumBox = el('h-cum-box');
    const scrollBox = el('h-scroll-box') || cumBox?.parentElement;
    const panelTokens = el('panel-tokens');
    const rect = scrollBox && typeof scrollBox.getBoundingClientRect === 'function' ? scrollBox.getBoundingClientRect() : null;
    const panelRect = panelTokens && typeof panelTokens.getBoundingClientRect === 'function' ? panelTokens.getBoundingClientRect() : null;
    let width = (rect && rect.width > 120) ? rect.width : 0;
    if (!width && panelRect && panelRect.width > 120) {
      width = Math.max(121, panelRect.width - 56);
    }
    if (!width) return false;
    const nextNarrow = width < 460;
    const cumRoot = cumBox?.querySelector?.('.cum-root') || (cumBox?.children?.[0] || null);
    if (!cumRoot) return false;
    const curNarrow = hasClass(cumRoot, 'is-narrow');
    if (curNarrow === nextNarrow) return false;
    renderActiveHeatView(true);
    return true;
  }

  let panelTokensResizeObserver = null;
  if (typeof ResizeObserver === 'function') {
    const pTokensObsTarget = el('panel-tokens');
    const hScrollObsTarget = el('h-scroll-box');
    if (pTokensObsTarget) {
      panelTokensResizeObserver = new ResizeObserver(() => {
        syncCumResponsiveNarrowState();
      });
      panelTokensResizeObserver.observe(pTokensObsTarget);
      if (hScrollObsTarget) panelTokensResizeObserver.observe(hScrollObsTarget);
      earlyDisposeHooks.push(() => {
        try { panelTokensResizeObserver?.disconnect?.(); } catch { }
        panelTokensResizeObserver = null;
      });
    }
  }

  el('h-page-prev')?.addEventListener('click', () => {
    if (activeHeatView === 'monthly') {
      heatMonthOffset -= 1;
    } else if (activeHeatView === 'yearly') {
      heatYearOffset -= 1;
    } else {
      heatPageOffset -= 1;
    }
    renderActiveHeatView(true);
  });
  el('h-page-next')?.addEventListener('click', () => {
    if (activeHeatView === 'monthly') {
      if (heatMonthOffset < 0) heatMonthOffset += 1;
    } else if (activeHeatView === 'yearly') {
      if (heatYearOffset < 0) heatYearOffset += 1;
    } else {
      if (heatPageOffset < 0) heatPageOffset += 1;
    }
    renderActiveHeatView(true);
  });

  el('refresh').addEventListener('click', () => { if (state.route && !state.scanBusy) void scan(state.generation, state.route, true); });
  const outside = e => {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    const pop = el('color-picker-popover');
    if (!path.includes(host)) {
      closeColorPicker(true);
      toggle(false);
      hideContextTooltip();
      hideQuotaTooltip();
      const om = el('overflow-menu');
      if (om) om.hidden = true;
      syncHostStackingElevation(false);
      return;
    }
    const isClosingNow = pop?.classList ? pop.classList.contains('is-closing') : pop?.getAttribute('data-closing') === 'true';
    if (pop && !pop.hidden && !isClosingNow) {
      const isInsidePicker = path.includes(pop);
      const isSwatchBtn = path.some(n => n?.classList?.contains?.('color-swatch-btn') || n?.classList?.contains?.('heat-leg-swatch') || n?.id?.startsWith?.('swatch-') || n?.id?.startsWith?.('heat-leg-'));
      if (!isInsidePicker && !isSwatchBtn) {
        closeColorPicker();
      }
    }
  };
  const escape = e => {
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && String(e.key || '').toLowerCase() === 'c') {
      e.preventDefault?.();
      if (el('panel-inspector') && !el('panel-inspector').hidden) closeInspector?.({ instant: true });
      else openInspector?.({ tab: 'live', sub: 'overview', instant: true });
      return;
    }
    if (e.key === 'Escape') {
      if (el('panel-inspector') && !el('panel-inspector').hidden) {
        closeInspector?.({ instant: true });
        return;
      }
      if (accountsUiState.removeModal?.open) {
        if (!accountsUiState.removeModal.busy) closeRemoveAccountModal();
        return;
      }
      if (activeHeatView === 'cum' && typeof hasActiveCumLock === 'function' && hasActiveCumLock()) {
        if (typeof clearCumLockAndRefresh === 'function') clearCumLockAndRefresh();
        return;
      }
      const pop = el('color-picker-popover');
      const isEscClosing = pop?.classList ? pop.classList.contains('is-closing') : pop?.getAttribute('data-closing') === 'true';
      if (pop && !pop.hidden && !isEscClosing) {
        const returnFocus = activePickerAnchor;
        closeColorPicker();
        returnFocus?.focus?.();
        return;
      }
      const tokenDrawer = el('token-color-drawer-body');
      if (tokenDrawer && tokenDrawer.style.display !== 'none') {
        toggleTokenColorsDrawer(false);
        btnTokenColors?.focus?.();
        return;
      }
      const colorDrawer = el('color-drawer-body');
      if (colorDrawer && colorDrawer.style.display !== 'none') {
        toggleColorsDrawer(false);
        btnColors?.focus?.();
        return;
      }
      toggle(false);
      hideContextTooltip();
      hideQuotaTooltip();
      const om = el('overflow-menu');
      if (om) om.hidden = true;
      syncHostStackingElevation(false);
      el('badge')?.focus?.();
    }
  };
  document.addEventListener('click', outside);
  document.addEventListener('keydown', escape);
