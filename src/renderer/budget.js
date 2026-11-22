(function (root) {
  'use strict';

  const DEFAULT_MIN_TOKENS = 16384;
  const DEFAULT_MAX_TOKENS = 2097152;
  const STOCK_DEFAULT_CLAMP_TOKENS = 256000;
  const DEFAULT_CONFIRM_TIMEOUT_MS = 45000;

  // Known static enum values from host bundle E.Model (dynamic PLACEHOLDER_M* resolved from cascadeModelConfigs)
  const STATIC_MODEL_ENUM_MAP = {
    235: 'chat_20706',
    246: 'google_gemini_2_5_pro',
    269: 'chat_23310',
    281: 'claude_4_sonnet',
    282: 'claude_4_sonnet_thinking',
    290: 'claude_4_opus',
    291: 'claude_4_opus_thinking',
    312: 'google_gemini_2_5_flash',
    313: 'google_gemini_2_5_flash_thinking',
    327: 'google_gemini_for_google_2_5_pro',
    328: 'google_gemini_nemosreef',
    329: 'google_gemini_2_5_flash_thinking_tools',
    330: 'google_gemini_2_5_flash_lite',
    331: 'google_gemini_2_5_pro_eval',
    332: 'google_gemini_2_5_flash_image_preview',
    333: 'claude_4_5_sonnet',
    334: 'claude_4_5_sonnet_thinking',
    335: 'google_gemini_computer_use_experimental',
    336: 'google_gemini_horizondawn',
    337: 'google_gemini_pureprism',
    338: 'google_gemini_gentleisland',
    339: 'google_gemini_rainsong',
    340: 'claude_4_5_haiku',
    341: 'claude_4_5_haiku_thinking',
    342: 'openai_gpt_oss_120b_medium',
    343: 'google_gemini_orionfire',
    346: 'google_jarvis_proxy',
    347: 'google_gemini_cosmicforge',
    348: 'google_gemini_riftrunner',
    349: 'google_jarvis_v4s',
    350: 'google_gemini_infinityjet',
    351: 'google_gemini_infinitybloom',
    352: 'google_gemini_riftrunner_thinking_low',
    353: 'google_gemini_riftrunner_thinking_high',
    354: 'google_gemini_example_gemax_sampler'
  };

  /**
   * Normalize Protobuf enum prefix: align "MODEL_PLACEHOLDER_M37" with "PLACEHOLDER_M37"
   */
  function stripModelEnumPrefix(raw) {
    if (raw === null || raw === undefined) return '';
    const s = String(raw).trim();
    if (!s) return '';
    return s.replace(/^MODEL_/i, '');
  }

  /**
   * Convert generic numeric ID to E.Model enum name (1000+ maps to PLACEHOLDER_M{n-1000})
   */
  function modelEnumNumberToName(num) {
    const n = Number(num);
    if (!Number.isInteger(n) || n <= 0) return null;
    if (STATIC_MODEL_ENUM_MAP[n]) return STATIC_MODEL_ENUM_MAP[n].toUpperCase();
    if (n >= 1000 && n < 2000) return `PLACEHOLDER_M${n - 1000}`;
    return null;
  }

  /**
   * Check whether URL / RPC method is a target RPC eligible for context budget injection.
   * Fact check: StartCascadeRequest does not contain cascade_config; only SendUserCascadeMessage carries it.
   */
  function isTargetBudgetRpc(urlOrProcedure) {
    if (!urlOrProcedure) return false;
    const s = String(urlOrProcedure);
    if (s.includes('StartCascade')) return false;
    return s.includes('SendUserCascadeMessage');
  }

  // =========================================================================
  // 1. Protobuf Binary Wire Codec (zero-dependency exact read/write for SendUserCascadeMessageRequest)
  //    Verified schema layout:
  //    - SendUserCascadeMessageRequest: 1 = cascade_id (string), 5 = cascade_config (CascadeConfig)
  //    - CascadeConfig: 1 = planner_config (CascadePlannerConfig), 2 = checkpoint_config (CheckpointConfig)
  //    - CascadePlannerConfig: 1 = plan_model (enum), 15 = requested_model (ModelOrAlias: 1=model, 2=alias),
  //                            27 = custom_model_info_override (ModelInfo), 28 = model_name (string)
  //    - CheckpointConfig: 1 = token_threshold, 2 = is_sync, 5 = max_token_limit (uint32),
  //                        11 = max_output_tokens, 36 = context_window (string)
  // =========================================================================

  function readVarint(bytes, offset) {
    let result = 0n;
    let shift = 0n;
    let pos = offset;
    while (pos < bytes.length) {
      const b = bytes[pos++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) {
        return { value: result, nextOffset: pos };
      }
      shift += 7n;
      if (shift > 70n) throw new Error('Invalid protobuf varint overflow');
    }
    throw new Error('Truncated protobuf varint');
  }

  function writeVarint(num) {
    let v = typeof num === 'bigint' ? num : BigInt(num);
    if (v < 0n) v = BigInt.asUintN(64, v);
    const out = [];
    while (v >= 0x80n) {
      out.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    out.push(Number(v));
    return new Uint8Array(out);
  }

  function concatUint8Arrays(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }

  function encodeVarintField(fieldNumber, value) {
    const tag = writeVarint((fieldNumber << 3) | 0);
    const val = writeVarint(value);
    return concatUint8Arrays([tag, val]);
  }

  function encodeLengthDelimitedField(fieldNumber, payloadBytes) {
    const tag = writeVarint((fieldNumber << 3) | 2);
    const len = writeVarint(payloadBytes.length);
    return concatUint8Arrays([tag, len, payloadBytes]);
  }

  /**
   * Strictly parse single-layer Protobuf message fields, preserving each field's raw slice (tag + value)
   */
  function parseProtoFields(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new Error('Expected Uint8Array');
    const fields = [];
    let pos = 0;
    while (pos < bytes.length) {
      const start = pos;
      const tagInfo = readVarint(bytes, pos);
      pos = tagInfo.nextOffset;
      const tagNum = Number(tagInfo.value);
      const fieldNumber = tagNum >>> 3;
      const wireType = tagNum & 0x07;
      if (fieldNumber <= 0) throw new Error(`Invalid protobuf field number: ${fieldNumber}`);

      let valueStart = pos;
      let valueEnd = pos;
      let varintValue = null;
      let sliceValue = null;

      if (wireType === 0) {
        const vInfo = readVarint(bytes, pos);
        varintValue = vInfo.value;
        pos = vInfo.nextOffset;
        valueEnd = pos;
      } else if (wireType === 1) {
        if (pos + 8 > bytes.length) throw new Error('Truncated 64-bit field');
        pos += 8;
        valueEnd = pos;
      } else if (wireType === 2) {
        const lenInfo = readVarint(bytes, pos);
        const len = Number(lenInfo.value);
        pos = lenInfo.nextOffset;
        if (!Number.isSafeInteger(len) || len < 0 || pos + len > bytes.length) {
          throw new Error('Truncated length-delimited field');
        }
        valueStart = pos;
        sliceValue = bytes.subarray(pos, pos + len);
        pos += len;
        valueEnd = pos;
      } else if (wireType === 5) {
        if (pos + 4 > bytes.length) throw new Error('Truncated 32-bit field');
        pos += 4;
        valueEnd = pos;
      } else {
        throw new Error(`Unsupported protobuf wire type: ${wireType}`);
      }

      fields.push({
        fieldNumber,
        wireType,
        varintValue,
        bytesValue: sliceValue,
        rawField: bytes.subarray(start, valueEnd)
      });
    }
    return fields;
  }

  function decodeUtf8Strict(bytes) {
    if (!(bytes instanceof Uint8Array) || !bytes.length) return '';
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  /**
   * Extract cascadeId, model identifier, and existing checkpointConfig from binary SendUserCascadeMessageRequest
   */
  function extractProtoSendMessageMetadata(bytes) {
    const topFields = parseProtoFields(bytes);
    let cascadeId = null;
    let planModelEnum = null;
    let requestedModelEnum = null;
    let modelName = null;
    let customModelOverrideRaw = null;
    let existingMaxTokenLimit = null;
    let existingContextWindow = null;

    for (const f of topFields) {
      if (f.fieldNumber === 1 && f.wireType === 2 && f.bytesValue) {
        try { cascadeId = decodeUtf8Strict(f.bytesValue); } catch {}
      } else if (f.fieldNumber === 5 && f.wireType === 2 && f.bytesValue) {
        const cfgFields = parseProtoFields(f.bytesValue);
        for (const cf of cfgFields) {
          if (cf.fieldNumber === 1 && cf.wireType === 2 && cf.bytesValue) {
            const plannerFields = parseProtoFields(cf.bytesValue);
            for (const pf of plannerFields) {
              if (pf.fieldNumber === 1 && pf.wireType === 0 && pf.varintValue !== null) {
                planModelEnum = Number(pf.varintValue);
              } else if (pf.fieldNumber === 15 && pf.wireType === 2 && pf.bytesValue) {
                const moaFields = parseProtoFields(pf.bytesValue);
                for (const mf of moaFields) {
                  if (mf.fieldNumber === 1 && mf.wireType === 0 && mf.varintValue !== null) {
                    requestedModelEnum = Number(mf.varintValue);
                  } else if (mf.fieldNumber === 2 && mf.wireType === 0 && mf.varintValue !== null) {
                    requestedModelEnum = Number(mf.varintValue);
                  }
                }
              } else if (pf.fieldNumber === 27 && pf.wireType === 2 && pf.bytesValue) {
                try {
                  const overrideFields = parseProtoFields(pf.bytesValue);
                  for (const ofield of overrideFields) {
                    if (ofield.wireType === 2 && ofield.bytesValue) {
                      const s = decodeUtf8Strict(ofield.bytesValue);
                      if (s && !customModelOverrideRaw) customModelOverrideRaw = s;
                    } else if (ofield.fieldNumber === 15 && ofield.wireType === 0 && ofield.varintValue !== null) {
                      if (planModelEnum === null) planModelEnum = Number(ofield.varintValue);
                    }
                  }
                } catch {}
              } else if (pf.fieldNumber === 28 && pf.wireType === 2 && pf.bytesValue) {
                try { modelName = decodeUtf8Strict(pf.bytesValue); } catch {}
              }
            }
          } else if (cf.fieldNumber === 2 && cf.wireType === 2 && cf.bytesValue) {
            const cpFields = parseProtoFields(cf.bytesValue);
            for (const cpf of cpFields) {
              if (cpf.fieldNumber === 5 && cpf.wireType === 0 && cpf.varintValue !== null) {
                existingMaxTokenLimit = Number(cpf.varintValue);
              } else if (cpf.fieldNumber === 36 && cpf.wireType === 2 && cpf.bytesValue) {
                try { existingContextWindow = decodeUtf8Strict(cpf.bytesValue); } catch {}
              }
            }
          }
        }
      }
    }

    return {
      cascadeId,
      planModelEnum,
      requestedModelEnum,
      modelName,
      customModelOverrideRaw,
      existingMaxTokenLimit,
      existingContextWindow
    };
  }

  /**
   * Losslessly rewrite cascade_config(5).checkpoint_config(2).max_token_limit(5) in binary SendUserCascadeMessageRequest
   * @param {Uint8Array} bytes
   * @param {{ mode: 'fixed'|'dynamic'|'default', limitTokens?: number|null }} action
   */
  function rewriteProtoSendMessageCheckpointLimit(bytes, action) {
    const topFields = parseProtoFields(bytes);
    const isFixed = action?.mode === 'fixed' && Number.isSafeInteger(action?.limitTokens) && action.limitTokens > 0;

    // Rebuild CheckpointConfig bytes: preserve all fields except field 5 (max_token_limit)
    const buildCheckpointBytes = (existingCpBytes) => {
      const kept = [];
      if (existingCpBytes) {
        const cpFields = parseProtoFields(existingCpBytes);
        for (const cpf of cpFields) {
          if (cpf.fieldNumber === 5) continue;
          kept.push(cpf.rawField);
        }
      }
      if (isFixed) {
        kept.push(encodeVarintField(5, action.limitTokens));
      }
      if (!kept.length) return null;
      return concatUint8Arrays(kept);
    };

    // Rebuild CascadeConfig bytes: preserve all fields except field 2 (checkpoint_config)
    const buildCascadeConfigBytes = (existingCfgBytes) => {
      const kept = [];
      let mergedCp = null;
      if (existingCfgBytes) {
        const cfgFields = parseProtoFields(existingCfgBytes);
        for (const cf of cfgFields) {
          if (cf.fieldNumber === 2 && cf.wireType === 2 && cf.bytesValue) {
            mergedCp = mergedCp ? concatUint8Arrays([mergedCp, cf.bytesValue]) : cf.bytesValue;
            continue;
          }
          kept.push(cf.rawField);
        }
      }
      const nextCpBytes = buildCheckpointBytes(mergedCp);
      if (nextCpBytes) {
        kept.push(encodeLengthDelimitedField(2, nextCpBytes));
      }
      if (!kept.length) return null;
      return concatUint8Arrays(kept);
    };

    const outFields = [];
    let mergedCascadeCfg = null;
    for (const f of topFields) {
      if (f.fieldNumber === 5 && f.wireType === 2 && f.bytesValue) {
        mergedCascadeCfg = mergedCascadeCfg ? concatUint8Arrays([mergedCascadeCfg, f.bytesValue]) : f.bytesValue;
        continue;
      }
      outFields.push(f.rawField);
    }

    if (mergedCascadeCfg || isFixed) {
      const nextCfgBytes = buildCascadeConfigBytes(mergedCascadeCfg);
      if (nextCfgBytes) {
        outFields.push(encodeLengthDelimitedField(5, nextCfgBytes));
      }
    }

    return concatUint8Arrays(outFields);
  }

  // =========================================================================
  // 2. Multi-transport unpack & repack (JSON / Lcc WebSocket JSON / 5-byte Envelope / Protobuf Binary)
  // =========================================================================

  function toUint8Array(body) {
    if (!body) return null;
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(body)) {
      return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    }
    return null;
  }

  function looksLikeJsonText(text) {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
  }

  /**
   * Unified unpacker for outbound request bodies or WebSocket text frames
   * @param {any} body
   * @param {{ channel?: string, urlOrProcedure?: string, contentType?: string }} [meta]
   */
  function unpackTransportPayload(body, meta = {}) {
    if (!body) return null;
    const channel = meta.channel || 'http';
    const contentType = String(meta.contentType || '').toLowerCase();
    const urlOrProc = String(meta.urlOrProcedure || '');

    if (typeof body === 'string') {
      if (!looksLikeJsonText(body)) return null;
      let parsed = null;
      try {
        parsed = JSON.parse(body.trim());
      } catch {
        return null;
      }
      // Host Lcc WebSocket JSON wrapper: { streamId, type: "start", procedure, stream, headers, payload }
      if (parsed && typeof parsed === 'object' && parsed.type === 'start' && typeof parsed.procedure === 'string' && parsed.payload && typeof parsed.payload === 'object') {
        return {
          format: 'ws_lcc_json',
          procedure: parsed.procedure,
          envelope: parsed,
          payload: parsed.payload
        };
      }
      return { format: 'json_string', payload: parsed };
    }

    const raw = toUint8Array(body);
    if (!raw || raw.length === 0) return null;

    // Check for 5-byte Connect / gRPC-Web Envelope first: [flags(1B), uint32BE length(4B)] + body
    const expectsProtoContentType = contentType.includes('proto') || contentType.includes('grpc');
    if (raw.length >= 5) {
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const flags = view.getUint8(0);
      const declaredLen = view.getUint32(1, false);
      if (raw.length === 5 + declaredLen || (raw.length > 5 + declaredLen && (flags === 0 || flags === 1 || flags === 2))) {
        if ((flags & 1) !== 0) {
          return { format: 'compressed_unsupported', flags, uninjectableReason: 'unsupported_compressed_frame' };
        }
        const inner = raw.subarray(5, 5 + declaredLen);
        let decodedText = null;
        try {
          decodedText = new TextDecoder('utf-8', { fatal: true }).decode(inner);
        } catch {}
        if (!expectsProtoContentType && decodedText && looksLikeJsonText(decodedText)) {
          try {
            return { format: 'connect_envelope', flags, payload: JSON.parse(decodedText.trim()) };
          } catch {}
        }
        try {
          const protoMeta = extractProtoSendMessageMetadata(inner);
          return { format: 'connect_proto_envelope', flags, rawInner: inner, trailing: raw.subarray(5 + declaredLen), protoMeta };
        } catch {}
      }
    }

    // Try plain UTF-8 JSON binary body
    if (!expectsProtoContentType) {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
        if (looksLikeJsonText(text)) {
          const parsed = JSON.parse(text.trim());
          if (parsed && typeof parsed === 'object' && parsed.type === 'start' && typeof parsed.procedure === 'string' && parsed.payload) {
            return {
              format: 'ws_lcc_json_binary',
              procedure: parsed.procedure,
              envelope: parsed,
              payload: parsed.payload
            };
          }
          return { format: 'raw_binary_json', payload: parsed };
        }
      } catch {}
    }

    // Try raw binary Protobuf (only when URL/type indicates target Protobuf RPC, to avoid misparsing arbitrary binary)
    if (expectsProtoContentType || isTargetBudgetRpc(urlOrProc)) {
      try {
        const protoMeta = extractProtoSendMessageMetadata(raw);
        return { format: 'raw_binary_proto', rawBytes: raw, protoMeta };
      } catch {
        return { format: 'unparseable_binary', uninjectableReason: 'invalid_protobuf_wire' };
      }
    }

    return null;
  }

  function packTransportPayload(unpacked, nextData) {
    if (!unpacked) return null;
    if (unpacked.format === 'json_string') {
      return JSON.stringify(nextData);
    }
    if (unpacked.format === 'ws_lcc_json') {
      return JSON.stringify({ ...unpacked.envelope, payload: nextData });
    }
    if (unpacked.format === 'ws_lcc_json_binary') {
      return new TextEncoder().encode(JSON.stringify({ ...unpacked.envelope, payload: nextData }));
    }
    if (unpacked.format === 'raw_binary_json') {
      return new TextEncoder().encode(JSON.stringify(nextData));
    }
    if (unpacked.format === 'connect_envelope') {
      const bytes = new TextEncoder().encode(JSON.stringify(nextData));
      const out = new Uint8Array(5 + bytes.length);
      const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
      view.setUint8(0, unpacked.flags || 0);
      view.setUint32(1, bytes.length, false);
      out.set(bytes, 5);
      return out;
    }
    if (unpacked.format === 'connect_proto_envelope' && nextData instanceof Uint8Array) {
      const tailLen = unpacked.trailing ? unpacked.trailing.length : 0;
      const out = new Uint8Array(5 + nextData.length + tailLen);
      const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
      view.setUint8(0, unpacked.flags || 0);
      view.setUint32(1, nextData.length, false);
      out.set(nextData, 5);
      if (tailLen > 0) out.set(unpacked.trailing, 5 + nextData.length);
      return out;
    }
    if (unpacked.format === 'raw_binary_proto' && nextData instanceof Uint8Array) {
      return nextData;
    }
    return null;
  }

  // =========================================================================
  // 2.5 Model capability reference, runtime policy resolution, adjustable range, and unified-mode per-model prediction
  // =========================================================================

  /**
   * Strictly parse base unlock/runtime policy state, separating "disk-detected mode" from "runtime confirmation state".
   * Never treat null / partial / pending_restart / runtime_unconfirmed as active dynamic or 256K.
   */
  function resolveRuntimeUnlockPolicy(unlockStatus) {
    if (!unlockStatus || typeof unlockStatus !== 'object') {
      return {
        policyKnown: false,
        runtimeState: 'unknown',
        diskMode: 'unknown',
        diskLimitTokens: null,
        runtimeMode: 'unknown',
        runtimeLimitTokens: null,
        currentClientLimitTokens: null,
        isDynamicUnlocked: null,
        diskVsRuntimeMismatch: false,
        status: null
      };
    }

    const status = typeof unlockStatus.status === 'string' ? unlockStatus.status : null;
    const gate3a = unlockStatus.gate3a && typeof unlockStatus.gate3a === 'object' ? unlockStatus.gate3a : null;
    const runtimeEvidence = unlockStatus.runtimeEvidence && typeof unlockStatus.runtimeEvidence === 'object'
      ? unlockStatus.runtimeEvidence
      : null;

    // 1. Parse disk/config-state policy (read actual fixed value; never blindly fall back to 256,000)
    let diskMode = 'unknown';
    let diskLimitTokens = null;
    const rawConfMode = unlockStatus.configuredMode;
    const rawClampState = gate3a?.clampState || null;

    if (rawConfMode === 'dynamic' || (!rawConfMode && rawClampState === 'DYN')) {
      diskMode = 'dynamic';
    } else if (rawConfMode === 'fixed' || (!rawConfMode && rawClampState === 'CONST')) {
      const rawLim = Number(unlockStatus.configuredLimitTokens ?? gate3a?.limit);
      if (Number.isSafeInteger(rawLim) && rawLim > 0) {
        diskMode = 'fixed';
        diskLimitTokens = rawLim;
      } else {
        diskMode = 'unknown';
      }
    } else if (
      rawConfMode === 'default' ||
      (!rawConfMode && rawClampState === 'ORIG') ||
      (!rawConfMode && status === 'not_patched')
    ) {
      diskMode = 'default';
      diskLimitTokens = STOCK_DEFAULT_CLAMP_TOKENS;
    } else if (rawConfMode === 'partial' || status === 'partial_match') {
      diskMode = 'partial';
    }

    // 2. Determine runtime confirmation level (unrestarted disk edits, unconfirmed process, partial match, or unknown must never impersonate active runtime)
    let runtimeState = 'unknown';
    let policyKnown = false;
    let diskVsRuntimeMismatch = false;

    if (status === 'partial_match' || diskMode === 'partial') {
      runtimeState = 'partial';
    } else if (status === 'failed' || status === 'unsupported' || diskMode === 'unknown') {
      runtimeState = 'unknown';
    } else if (status === 'patched_pending_restart' || runtimeEvidence?.restartDetected === false) {
      runtimeState = 'pending_restart';
      diskVsRuntimeMismatch = true;
    } else if (status === 'patched_runtime_unconfirmed') {
      runtimeState = 'runtime_unconfirmed';
      diskVsRuntimeMismatch = true;
    } else if (status === 'patched_loaded' || status === 'not_patched' || !status) {
      // When no negative state and not pending restart, treat policy as known if an explicit state (patched_loaded / not_patched / or policy object) is passed
      runtimeState = 'confirmed';
      policyKnown = true;
    }

    const runtimeMode = policyKnown ? diskMode : 'unknown';
    const runtimeLimitTokens = policyKnown ? diskLimitTokens : null;
    const currentClientLimitTokens = policyKnown && (runtimeMode === 'default' || runtimeMode === 'fixed')
      ? runtimeLimitTokens
      : null;
    const isDynamicUnlocked = policyKnown ? (runtimeMode === 'dynamic') : null;

    return {
      policyKnown,
      runtimeState,
      diskMode,
      diskLimitTokens,
      runtimeMode,
      runtimeLimitTokens,
      currentClientLimitTokens,
      isDynamicUnlocked,
      diskVsRuntimeMismatch,
      status
    };
  }

  /**
   * Aggregate real capability metadata from product and its members (including GetAvailableModels / Step.metadata.modelInfo),
   * strictly separating: model theoretical cap, current client limit, current policy default budget, and adoptable range.
   * Only trust structured fields (maxTokens / maxOutputTokens); no model-name guessing or hardcoding.
   */
  function deriveModelCapabilitySummary(product, unlockStatus = null, modelCapabilitiesById = null) {
    const members = Array.isArray(product?.members) ? product.members : [];
    const capById = modelCapabilitiesById && typeof modelCapabilitiesById === 'object' ? modelCapabilitiesById : null;

    const findCapForMember = (m) => {
      if (!capById || !m) return null;
      const candidates = [m.modelId, m.modelOrAlias?.model, m.label]
        .filter(Boolean)
        .map(v => stripModelEnumPrefix(v).toLowerCase());
      for (const k of candidates) {
        if (k && capById[k]) return capById[k];
      }
      return null;
    };

    const tierDetails = [];
    for (const m of members) {
      const extCap = findCapForMember(m);
      const maxTokens = Number.isSafeInteger(Number(m?.maxTokens)) && Number(m.maxTokens) > 0
        ? Number(m.maxTokens)
        : (Number.isSafeInteger(Number(extCap?.maxTokens)) && Number(extCap.maxTokens) > 0 ? Number(extCap.maxTokens) : null);
      const rawOut = m?.maxOutputTokens ?? extCap?.maxOutputTokens;
      const maxOutputTokens = rawOut !== null && rawOut !== undefined && Number.isSafeInteger(Number(rawOut)) && Number(rawOut) >= 0
        ? Number(rawOut)
        : null;
      const thinkingBudget = m?.thinkingBudget ?? extCap?.thinkingBudget ?? null;
      const thinkingLevel = m?.thinkingLevel || extCap?.thinkingLevel || null;
      const capabilitySource = m?.capabilitySource || extCap?.capabilitySource || null;
      if (maxTokens !== null || maxOutputTokens !== null || thinkingLevel || thinkingBudget !== null) {
        tierDetails.push({
          modelId: m.modelId || null,
          effort: m.effort || null,
          maxTokens,
          maxOutputTokens,
          thinkingBudget,
          thinkingLevel,
          capabilitySource
        });
      }
    }

    const withWindow = tierDetails.filter(t => t.maxTokens !== null);
    const withOutput = tierDetails.filter(t => t.maxOutputTokens !== null);
    const uniqueWindows = Array.from(new Set(withWindow.map(t => t.maxTokens)));
    const uniqueOutputs = Array.from(new Set(withOutput.map(t => t.maxOutputTokens)));

    const maxTokens = uniqueWindows.length > 0 ? Math.min(...uniqueWindows) : null;
    const maxOutputTokens = uniqueOutputs.length > 0 ? Math.max(...uniqueOutputs) : null;
    const hasTierVariance = uniqueWindows.length > 1 || uniqueOutputs.length > 1;
    const sources = Array.from(new Set(tierDetails.map(t => t.capabilitySource).filter(Boolean)));

    const runtimePolicy = resolveRuntimeUnlockPolicy(unlockStatus);
    const isDynamicUnlocked = runtimePolicy.isDynamicUnlocked;
    const currentClientLimitTokens = runtimePolicy.currentClientLimitTokens;

    // 1. Model theoretical capability cap and dynamic baseline (based solely on structured model metadata, independent of client state)
    let modelTheoreticalMaxTokens = null;
    let dynamicDefaultBudget = null;
    if (maxTokens !== null && maxOutputTokens !== null && maxTokens > maxOutputTokens) {
      const reserve = Math.max(maxOutputTokens, 40000);
      dynamicDefaultBudget = maxTokens > reserve ? (maxTokens - reserve) : 0;
      modelTheoreticalMaxTokens = Math.min(DEFAULT_MAX_TOKENS, maxTokens - maxOutputTokens);
    }

    // 2. Current policy default budget (runtime default when no custom maxTokenLimit is carried):
    //    Verified against binary:
    //    - utils.GetCheckpointConfig clamps to min(dynamicDefault, 256000) under default(ORIG);
    //    - under fixed(CONST=N), rewrites directly to N and clamps via ClampCheckpointConfigForModelInfo to <= maxTokens - maxOutputTokens;
    //    - under dynamic(DYN), uses dynamicDefault;
    //    - under unknown / partial / pending_restart / runtime_unconfirmed, must remain null (never guess or apply 983040 / 256000).
    let currentStrategyDefaultBudget = null;
    if (runtimePolicy.policyKnown) {
      if (runtimePolicy.runtimeMode === 'dynamic') {
        currentStrategyDefaultBudget = dynamicDefaultBudget;
      } else if (runtimePolicy.runtimeMode === 'default') {
        currentStrategyDefaultBudget = dynamicDefaultBudget !== null
          ? Math.min(dynamicDefaultBudget, STOCK_DEFAULT_CLAMP_TOKENS)
          : null;
      } else if (runtimePolicy.runtimeMode === 'fixed' && runtimePolicy.runtimeLimitTokens !== null) {
        const fixedVal = Math.min(DEFAULT_MAX_TOKENS, runtimePolicy.runtimeLimitTokens);
        if (modelTheoreticalMaxTokens !== null) {
          currentStrategyDefaultBudget = Math.min(fixedVal, modelTheoreticalMaxTokens);
        } else if (maxTokens !== null) {
          currentStrategyDefaultBudget = Math.min(fixedVal, maxTokens);
        } else {
          currentStrategyDefaultBudget = fixedVal;
        }
      }
    }
    const effectiveDefaultBudget = currentStrategyDefaultBudget;

    // 3. Confirmed safe adjustable cap in current environment (consistent with reference card, max-available button, presets/validation, and unified prediction):
    //    Although explicit request maxTokenLimit has higher priority in local merge chain than base default, until Dynamic is enabled and confirmed on device,
    //    downstream overrides and server policy limits may still constrain actual budget to currentClientLimitTokens.
    let maxAdjustableTokens = null;
    if (runtimePolicy.policyKnown) {
      if (runtimePolicy.runtimeMode === 'dynamic') {
        maxAdjustableTokens = modelTheoreticalMaxTokens;
      } else if ((runtimePolicy.runtimeMode === 'default' || runtimePolicy.runtimeMode === 'fixed') && currentClientLimitTokens !== null) {
        const clientCap = Math.min(DEFAULT_MAX_TOKENS, currentClientLimitTokens);
        maxAdjustableTokens = modelTheoreticalMaxTokens !== null
          ? Math.min(modelTheoreticalMaxTokens, clientCap)
          : clientCap;
      }
    }

    let formulaNote = null;
    if (maxTokens !== null && maxOutputTokens !== null && maxTokens > maxOutputTokens) {
      formulaNote = '模型理论输入上限 = maxTokens - maxOutputTokens（动态默认按 max(maxOutputTokens, 40,000) 预留）';
    } else if (maxTokens !== null && maxOutputTokens === null) {
      formulaNote = 'IDE 仅返回总窗口但缺少 maxOutputTokens，无法推导模型理论输入上限';
    }

    let policyNote = null;
    if (runtimePolicy.runtimeState === 'pending_restart') {
      policyNote = '磁盘配置已变更但运行中的客户端尚未重启，当前运行策略与可采纳上限待确认';
    } else if (runtimePolicy.runtimeState === 'runtime_unconfirmed') {
      policyNote = '仅检测到磁盘配置，尚未确认运行中进程已加载该策略';
    } else if (runtimePolicy.runtimeState === 'partial') {
      policyNote = '检测到当前环境处于部分异常状态，运行策略上限未知';
    } else if (runtimePolicy.runtimeState === 'unknown') {
      policyNote = '尚未获取或无法确认当前客户端运行策略，默认预算及目标采纳范围标为未知';
    } else if (runtimePolicy.runtimeMode === 'fixed' && currentClientLimitTokens !== null) {
      policyNote = `当前客户端运行于固定限制 ${currentClientLimitTokens.toLocaleString('en-US')} tokens`;
    } else if (runtimePolicy.runtimeMode === 'default') {
      policyNote = '当前客户端运行于默认 256,000 tokens 限制';
    } else if (runtimePolicy.runtimeMode === 'dynamic') {
      policyNote = '当前客户端已开启 Dynamic 动态跟随，按模型自身上限裁剪';
    }

    const rangeMin = maxAdjustableTokens !== null
      ? Math.min(DEFAULT_MIN_TOKENS, maxAdjustableTokens)
      : DEFAULT_MIN_TOKENS;
    const rangeMax = maxAdjustableTokens;

    return {
      productKey: product?.productKey || null,
      productLabel: product?.productLabel || null,
      maxTokens,
      maxOutputTokens,
      modelTheoreticalMaxTokens,
      dynamicDefaultBudget,
      currentClientLimitTokens,
      currentStrategyDefaultBudget,
      effectiveDefaultBudget,
      maxAdjustableTokens,
      rangeMin,
      rangeMax,
      hasMetadata: maxTokens !== null && maxOutputTokens !== null,
      hasPartialMetadata: (maxTokens !== null) !== (maxOutputTokens !== null),
      hasTierVariance,
      tierDetails,
      sources,
      runtimePolicy,
      isDynamicUnlocked,
      formulaNote,
      policyNote
    };
  }

  /**
   * Evaluate validity and adoptable value of current input/preset against model capability and current client runtime policy.
   * Never silently alter the user's value and report success, and never confuse model capability cap with client policy limit.
   */
  function evaluateLimitInput(rawVal, capSummary = null, unlockStatus = null, serviceLimit = null) {
    const rawStr = typeof rawVal === 'number' ? String(rawVal) : String(rawVal ?? '').trim().replace(/[,\s_]/g, '');
    if (!/^\d+$/.test(rawStr)) {
      return { ok: false, reasonCode: 'not_integer', limitTokens: null };
    }
    const num = Number(rawStr);
    if (!Number.isSafeInteger(num) || num <= 0) {
      return { ok: false, reasonCode: 'not_integer', limitTokens: null };
    }
    if (num < DEFAULT_MIN_TOKENS || num > DEFAULT_MAX_TOKENS) {
      return {
        ok: false,
        reasonCode: 'out_of_engineering_range',
        limitTokens: num,
        min: DEFAULT_MIN_TOKENS,
        max: DEFAULT_MAX_TOKENS
      };
    }

    const warnings = [];
    const policy = arguments.length >= 3
      ? resolveRuntimeUnlockPolicy(unlockStatus)
      : (capSummary?.runtimePolicy || resolveRuntimeUnlockPolicy(null));
    const modelMaxAllowed = capSummary?.modelTheoreticalMaxTokens ?? null;
    const clientLimit = policy.policyKnown ? policy.currentClientLimitTokens : null;

    let exceedsModelLimit = false;
    const modelCapped = modelMaxAllowed !== null ? Math.min(num, modelMaxAllowed) : num;
    if (modelMaxAllowed !== null && num > modelMaxAllowed) {
      exceedsModelLimit = true;
      warnings.push({
        code: 'exceeds_model_limit',
        limitTokens: num,
        maxAllowed: modelMaxAllowed,
        adoptableTokens: policy.policyKnown && clientLimit !== null
          ? Math.min(modelCapped, clientLimit)
          : (policy.policyKnown ? modelCapped : null)
      });
    }

    let exceedsClientPolicy = false;
    let requiresDynamicUnlock = false;
    if (!policy.policyKnown) {
      warnings.push({
        code: 'unconfirmed_runtime_policy',
        limitTokens: num,
        runtimeState: policy.runtimeState,
        diskMode: policy.diskMode,
        diskLimitTokens: policy.diskLimitTokens
      });
    } else if (clientLimit !== null && num > clientLimit) {
      exceedsClientPolicy = true;
      if (policy.runtimeMode === 'default') {
        requiresDynamicUnlock = true;
        warnings.push({
          code: 'requires_dynamic_unlock',
          limitTokens: num,
          stockCap: clientLimit
        });
      } else if (policy.runtimeMode === 'fixed') {
        warnings.push({
          code: 'exceeds_fixed_client_limit',
          limitTokens: num,
          fixedCap: clientLimit
        });
      }
    }

    let adoptableTokens = null;
    if (policy.policyKnown) {
      if (policy.runtimeMode === 'dynamic') {
        adoptableTokens = modelCapped;
      } else if (clientLimit !== null) {
        adoptableTokens = Math.min(modelCapped, clientLimit);
      }
    }

    const sLimit = Number(serviceLimit || 0);
    if (sLimit > 0 && num > sLimit) {
      warnings.push({
        code: 'exceeds_service_limit',

        limitTokens: num,
        serviceLimit: sLimit
      });
    }

    if (num < 65536) {
      warnings.push({
        code: 'below_recommended_floor',
        limitTokens: num
      });
    }

    return {
      ok: true,
      limitTokens: num,
      exceedsModelLimit,
      exceedsClientPolicy,
      clientPolicyLimit: clientLimit,
      runtimeState: policy.runtimeState,
      policyKnown: policy.policyKnown,
      adoptableTokens,
      requiresDynamicUnlock,
      warnings
    };
  }

  /**
   * In unified budget mode, predict adoptable result per model under the current runtime policy.
   * Strictly distinguish "predicted value" from "runtime-confirmed"; never misclassify unknown/pending_restart/default/fixed as exact.
   */
  function projectUnifiedBudgetForProducts(unifiedPref, products = [], unlockStatus = null, modelCapabilitiesById = null) {
    const mode = unifiedPref?.mode || 'default';
    const rawLimit = mode === 'fixed' && Number.isSafeInteger(Number(unifiedPref?.limitTokens))
      ? Number(unifiedPref.limitTokens)
      : null;
    const policy = resolveRuntimeUnlockPolicy(unlockStatus);
    const unresolvedOutcome = policy.runtimeState === 'pending_restart'
      ? 'pending_restart_unconfirmed'
      : (policy.runtimeState === 'partial'
        ? 'partial_policy_unconfirmed'
        : (policy.runtimeState === 'runtime_unconfirmed' ? 'runtime_unconfirmed' : 'unknown_policy'));

    return (Array.isArray(products) ? products : []).map(prod => {
      const cap = deriveModelCapabilitySummary(prod, unlockStatus, modelCapabilitiesById);
      const modelCap = cap.modelTheoreticalMaxTokens;
      const clientCap = policy.policyKnown ? policy.currentClientLimitTokens : null;

      if (mode === 'default') {
        if (!policy.policyKnown) {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: unresolvedOutcome,
            projectedTokens: null
          };
        }
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'client_default',
          projectedTokens: cap.effectiveDefaultBudget
        };
      }

      if (mode === 'dynamic') {
        if (!policy.policyKnown) {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: unresolvedOutcome,
            projectedTokens: null
          };
        }
        if (policy.runtimeMode === 'default' || policy.runtimeMode === 'fixed') {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: 'clamped_by_client_policy',
            clientLimitTokens: clientCap,
            projectedTokens: cap.effectiveDefaultBudget
          };
        }
        if (cap.dynamicDefaultBudget === null) {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: 'unknown_cap',
            projectedTokens: null
          };
        }
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'dynamic_follow',
          projectedTokens: cap.dynamicDefaultBudget
        };
      }

      if (!rawLimit) {
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'invalid_target',
          projectedTokens: null
        };
      }

      if (!policy.policyKnown) {
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: unresolvedOutcome,
          targetTokens: rawLimit,
          exceedsModelLimit: modelCap !== null && rawLimit > modelCap,
          projectedTokens: null
        };
      }

      if (policy.runtimeMode === 'dynamic') {
        if (modelCap === null) {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: 'unknown_cap',
            targetTokens: rawLimit,
            projectedTokens: null
          };
        }
        if (rawLimit > modelCap) {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: 'clamped_to_model_max',
            targetTokens: rawLimit,
            projectedTokens: modelCap
          };
        }
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'exact',
          targetTokens: rawLimit,
          projectedTokens: rawLimit
        };
      }

      // runtimeMode === 'default' (256,000) or 'fixed' (N)
      if (modelCap !== null && rawLimit > modelCap) {
        if (clientCap !== null && clientCap < modelCap && rawLimit > clientCap) {
          return {
            productKey: prod.productKey,
            productLabel: prod.productLabel,
            vendor: prod.vendor,
            capability: cap,
            outcome: 'clamped_by_client_policy',
            targetTokens: rawLimit,
            clientLimitTokens: clientCap,
            modelTheoreticalMaxTokens: modelCap,
            projectedTokens: clientCap
          };
        }
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'clamped_to_model_max',
          targetTokens: rawLimit,
          clientLimitTokens: clientCap,
          projectedTokens: modelCap
        };
      }

      if (clientCap !== null && rawLimit > clientCap) {
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'exceeds_client_policy',
          targetTokens: rawLimit,
          clientLimitTokens: clientCap,
          modelTheoreticalMaxTokens: modelCap,
          projectedTokens: modelCap !== null ? Math.min(modelCap, clientCap) : clientCap
        };
      }

      if (modelCap === null) {
        return {
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          capability: cap,
          outcome: 'unknown_cap',
          targetTokens: rawLimit,
          clientLimitTokens: clientCap,
          projectedTokens: null
        };
      }

      return {
        productKey: prod.productKey,
        productLabel: prod.productLabel,
        vendor: prod.vendor,
        capability: cap,
        outcome: 'exact',
        targetTokens: rawLimit,
        clientLimitTokens: clientCap,
        projectedTokens: rawLimit
      };
    });
  }

  // =========================================================================
  // 3. Request model extraction (never fall back to plugin settings panel selection or global historical snapshot)
  // =========================================================================

  function matchConfigByCandidate(candidate, knownConfigs) {
    if (!Array.isArray(knownConfigs) || !knownConfigs.length || candidate === null || candidate === undefined) {
      return null;
    }
    if (typeof candidate === 'number') {
      const byValue = knownConfigs.find(c => Number(c?.value) === candidate);
      if (byValue) return byValue;
      const enumName = modelEnumNumberToName(candidate);
      if (enumName) {
        return matchConfigByCandidate(enumName, knownConfigs);
      }
      return null;
    }
    const rawStr = String(candidate).trim();
    if (!rawStr) return null;
    const rawLower = rawStr.toLowerCase();
    const strippedLower = stripModelEnumPrefix(rawStr).toLowerCase();
    return knownConfigs.find(c => {
      const fields = [c?.modelId, c?.model, c?.modelOrAlias?.model, c?.modelOrAlias?.alias, c?.modelAlias, c?.label];
      for (const f of fields) {
        if (f === null || f === undefined) continue;
        const fl = String(f).trim().toLowerCase();
        if (!fl) continue;
        if (fl === rawLower || stripModelEnumPrefix(fl) === strippedLower) return true;
      }
      if (/^\d+$/.test(rawStr) && Number(c?.value) === Number(rawStr)) return true;
      return false;
    }) || null;
  }

  function normalizeResolvedCandidate(rawCandidate, knownConfigs, groupFn, resolveStableFn) {
    if (rawCandidate === null || rawCandidate === undefined) return null;
    const matchedCfg = matchConfigByCandidate(rawCandidate, knownConfigs);
    if (matchedCfg) {
      const mId = matchedCfg.modelId || matchedCfg.model || matchedCfg.modelOrAlias?.model || matchedCfg.label;
      const lbl = matchedCfg.label || matchedCfg.modelDisplayName || mId;
      const g = groupFn({ modelId: mId, label: lbl, modelOrAlias: matchedCfg.modelOrAlias, effort: matchedCfg.effort });
      if (g?.productKey) {
        return {
          productKey: g.productKey,
          productLabel: g.productLabel,
          modelId: (resolveStableFn ? resolveStableFn(matchedCfg, knownConfigs) : null) || String(mId || '').toLowerCase(),
          rawCandidate
        };
      }
    }

    let strVal = null;
    if (typeof rawCandidate === 'number') {
      strVal = modelEnumNumberToName(rawCandidate);
    } else if (typeof rawCandidate === 'string') {
      strVal = rawCandidate.trim();
    }
    if (!strVal) return null;

    // Strip Protobuf enum prefix and prettify readable name for fallback grouping
    const stripped = stripModelEnumPrefix(strVal);
    if (/^PLACEHOLDER_M\d+$/i.test(stripped)) {
      // When no concrete product name is found in known catalog, group by exact placeholder ID rather than guessing across models
      const g = groupFn({ modelId: stripped.toLowerCase(), label: stripped.toLowerCase() });
      return {
        productKey: g?.productKey || `product:other:${stripped.toLowerCase()}`,
        productLabel: g?.productLabel || stripped.toLowerCase(),
        modelId: stripped.toLowerCase(),
        rawCandidate
      };
    }

    const readable = stripped.includes('_') && stripped === stripped.toUpperCase()
      ? stripped.toLowerCase().replace(/_/g, '-')
      : stripped;
    const g = groupFn({ modelId: readable, label: readable });
    if (!g?.productKey) return null;
    return {
      productKey: g.productKey,
      productLabel: g.productLabel,
      modelId: (resolveStableFn ? resolveStableFn(readable, knownConfigs) : null) || readable.toLowerCase(),
      rawCandidate
    };
  }

  /**
   * Extract actual model product key from outbound request object / binary metadata
   * @param {object} requestOrProtoMeta
   * @param {{
   *   isProtoMeta?: boolean,
   *   knownConfigs?: Array,
   *   verifiedConversationBindings?: Record<string, { productKey: string, modelId?: string }>,
   *   groupProduct?: Function,
   *   resolveStableModelId?: Function
   * }} [options]
   */
  function resolveRequestModel(requestOrProtoMeta, options = {}) {
    if (!requestOrProtoMeta || typeof requestOrProtoMeta !== 'object') {
      return { resolved: false, reason: 'invalid_payload', cascadeId: null };
    }

    const knownConfigs = Array.isArray(options.knownConfigs) ? options.knownConfigs : [];
    const bindings = options.verifiedConversationBindings || {};
    const groupFn = typeof options.groupProduct === 'function'
      ? options.groupProduct
      : (input) => {
        const s = String(input?.label || input?.modelId || 'unknown').trim();
        const low = s.toLowerCase().replace(/[^a-z0-9.\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '');
        return { productKey: `product:other:${low || 'unknown'}`, productLabel: s, vendor: '其他', effort: null };
      };
    const resolveStableFn = typeof options.resolveStableModelId === 'function' ? options.resolveStableModelId : null;

    if (options.isProtoMeta) {
      const cascadeId = requestOrProtoMeta.cascadeId || null;
      const candidates = [
        { source: 'customModelInfoOverride', value: requestOrProtoMeta.customModelOverrideRaw },
        { source: 'modelName', value: requestOrProtoMeta.modelName },
        { source: 'requestedModel', value: requestOrProtoMeta.requestedModelEnum },
        { source: 'planModel', value: requestOrProtoMeta.planModelEnum }
      ];
      for (const c of candidates) {
        if (c.value === null || c.value === undefined || c.value === 0 || c.value === '') continue;
        const norm = normalizeResolvedCandidate(c.value, knownConfigs, groupFn, resolveStableFn);
        if (norm) return { resolved: true, source: `proto_${c.source}`, cascadeId, ...norm };
      }
      if (cascadeId && bindings[cascadeId]?.productKey) {
        return {
          resolved: true,
          source: 'verified_conversation_binding',
          cascadeId,
          productKey: bindings[cascadeId].productKey,
          productLabel: bindings[cascadeId].productLabel || bindings[cascadeId].productKey,
          modelId: bindings[cascadeId].modelId || bindings[cascadeId].productKey
        };
      }
      return { resolved: false, reason: 'unidentifiable_request_model', cascadeId };
    }

    const payload = requestOrProtoMeta;
    const cascadeId = payload.cascadeId || payload.cascade_id || null;
    const cfg = payload.cascadeConfig || payload.cascade_config || {};
    const planner = cfg.plannerConfig || cfg.planner_config || payload.plannerConfig || payload.planner_config || {};

    const override = planner.customModelInfoOverride || planner.custom_model_info_override || {};
    const reqModelObj = planner.requestedModel || planner.requested_model || {};
    const candidates = [
      { source: 'customModelInfoOverride', value: override.model || override.modelId || override.label },
      { source: 'modelName', value: planner.modelName || planner.model_name },
      { source: 'requestedModel', value: reqModelObj.model || reqModelObj.alias || (reqModelObj.choice?.case ? reqModelObj.choice.value : null) },
      { source: 'planModel', value: planner.planModel ?? planner.plan_model }
    ];

    for (const c of candidates) {
      if (c.value === null || c.value === undefined || c.value === 0 || c.value === '') continue;
      const norm = normalizeResolvedCandidate(c.value, knownConfigs, groupFn, resolveStableFn);
      if (norm) return { resolved: true, source: c.source, cascadeId, ...norm };
    }

    if (cascadeId && bindings[cascadeId]?.productKey) {
      return {
        resolved: true,
        source: 'verified_conversation_binding',
        cascadeId,
        productKey: bindings[cascadeId].productKey,
        productLabel: bindings[cascadeId].productLabel || bindings[cascadeId].productKey,
        modelId: bindings[cascadeId].modelId || bindings[cascadeId].productKey
      };
    }

    return { resolved: false, reason: 'unidentifiable_request_model', cascadeId };
  }

  // =========================================================================
  // 4. Budget preference lookup & request rewriting (supports object/JSON/Protobuf, preserves $typeName, and cleans up defaults)
  // =========================================================================

  function findPreferenceForProduct(productKey, contextPreferencesMap) {
    if (!productKey || !contextPreferencesMap || typeof contextPreferencesMap !== 'object') return null;
    if (contextPreferencesMap[productKey]) return contextPreferencesMap[productKey];
    const pSlug = String(productKey).replace(/^product:[^:]+:/, '').toLowerCase();
    for (const [k, pref] of Object.entries(contextPreferencesMap)) {
      if (!pref) continue;
      const kSlug = String(k).replace(/^product:[^:]+:/, '').toLowerCase();
      if (kSlug && kSlug === pSlug) return pref;
    }
    return null;
  }

  function resolveBudgetPolicy(options = {}) {
    const scopeMode = options.scopeMode === 'per_model' ? 'per_model' : 'unified';
    const pref = scopeMode === 'unified'
      ? (options.unifiedPreference || { mode: 'default', limitTokens: null })
      : findPreferenceForProduct(options.productKey, options.contextPreferencesMap);
    if (!pref) {
      return { mode: 'default', limitTokens: null, hasExplicitPref: false };
    }
    const mode = pref.mode === 'fixed' || pref.mode === 'dynamic' ? pref.mode : 'default';
    if (mode === 'fixed') {
      const limit = Number(pref.limitTokens);
      const minTokens = Number(options.minTokens || DEFAULT_MIN_TOKENS);
      const maxTokens = Number(options.maxTokens || DEFAULT_MAX_TOKENS);
      if (Number.isSafeInteger(limit) && limit >= minTokens && limit <= maxTokens) {
        return { mode: 'fixed', limitTokens: limit, hasExplicitPref: true };
      }
      return { mode: 'invalid_fixed', limitTokens: limit, hasExplicitPref: true };
    }
    return { mode, limitTokens: null, hasExplicitPref: true };
  }

  /**
   * Inject or clear CheckpointConfig.maxTokenLimit on JS request objects (supports Snake/Camel single-form and @bufbuild/protobuf v2 $typeName)
   */
  function applyBudgetPolicyToObject(payload, policy) {
    if (!payload || typeof payload !== 'object' || !policy) {
      return { modified: false, appliedMode: 'passthrough', sentLimitTokens: null };
    }

    const usesProtoBufTypeName = Boolean(
      payload.$typeName
      || payload.cascadeConfig?.$typeName
      || payload.cascadeConfig?.plannerConfig?.$typeName
      || payload.cascadeConfig?.checkpointConfig?.$typeName
    );
    const isSnake = Boolean(payload.cascade_config && !payload.cascadeConfig);

    if (policy.mode === 'fixed' && Number.isSafeInteger(policy.limitTokens)) {
      if (isSnake) {
        payload.cascade_config = payload.cascade_config || {};
        payload.cascade_config.checkpoint_config = payload.cascade_config.checkpoint_config || {};
        payload.cascade_config.checkpoint_config.max_token_limit = policy.limitTokens;
      } else {
        if (!payload.cascadeConfig) {
          payload.cascadeConfig = usesProtoBufTypeName ? { $typeName: 'exa.cortex_pb.CascadeConfig' } : {};
        }
        if (!payload.cascadeConfig.checkpointConfig) {
          payload.cascadeConfig.checkpointConfig = usesProtoBufTypeName ? { $typeName: 'exa.cortex_pb.CheckpointConfig' } : {};
        } else if (usesProtoBufTypeName && !payload.cascadeConfig.checkpointConfig.$typeName) {
          payload.cascadeConfig.checkpointConfig.$typeName = 'exa.cortex_pb.CheckpointConfig';
        }
        payload.cascadeConfig.checkpointConfig.maxTokenLimit = policy.limitTokens;
      }
      return { modified: true, appliedMode: 'fixed', sentLimitTokens: policy.limitTokens };
    }

    // dynamic or default: must clear any residual fixed threshold; never retain a leftover fixed value from earlier
    let cleared = false;
    if (payload.cascadeConfig?.checkpointConfig && payload.cascadeConfig.checkpointConfig.maxTokenLimit !== undefined) {
      delete payload.cascadeConfig.checkpointConfig.maxTokenLimit;
      cleared = true;
    }
    if (payload.cascade_config?.checkpoint_config && payload.cascade_config.checkpoint_config.max_token_limit !== undefined) {
      delete payload.cascade_config.checkpoint_config.max_token_limit;
      cleared = true;
    }
    return {
      modified: cleared,
      appliedMode: policy.mode === 'dynamic' ? 'dynamic' : 'default',
      sentLimitTokens: null
    };
  }

  /**
   * All-in-one intercept transform (supports client_object / HTTP JSON / WebSocket Lcc / Envelope / Protobuf Binary)
   */
  function transformOutgoingSendRequest(input, context = {}) {
    const channel = context.channel || 'http';
    const urlOrProcedure = context.urlOrProcedure || '';

    // 1. Check RPC channel target first
    if (channel !== 'ws_frame' && urlOrProcedure && !isTargetBudgetRpc(urlOrProcedure)) {
      return { handled: false, passthrough: true, reason: 'non_target_rpc' };
    }

    // 2. If direct object passed from client decorator
    if (channel === 'client_object') {
      if (!input || typeof input !== 'object') {
        return { handled: false, passthrough: true, reason: 'invalid_client_request' };
      }
      const resolved = resolveRequestModel(input, context);
      const scopeMode = context.scopeMode === 'per_model' ? 'per_model' : 'unified';
      if (!resolved.resolved && scopeMode !== 'unified') {
        return {
          handled: true,
          passthrough: true,
          modified: false,
          uninjectable: true,
          reason: resolved.reason || 'unidentifiable_request_model',
          cascadeId: resolved.cascadeId || null,
          productKey: null
        };
      }
      const policy = resolveBudgetPolicy({
        scopeMode,
        unifiedPreference: context.unifiedPreference,
        contextPreferencesMap: context.contextPreferencesMap,
        productKey: resolved.productKey,
        minTokens: context.minTokens,
        maxTokens: context.maxTokens
      });
      if (policy.mode === 'invalid_fixed') {
        return {
          handled: true,
          passthrough: true,
          modified: false,
          uninjectable: true,
          reason: 'invalid_fixed_limit',
          cascadeId: resolved.cascadeId || null,
          productKey: resolved.productKey || null
        };
      }
      const applied = applyBudgetPolicyToObject(input, policy);
      return {
        handled: true,
        passthrough: policy.mode === 'default' && !applied.modified,
        modified: applied.modified,
        uninjectable: false,
        channel,
        cascadeId: resolved.cascadeId || input.cascadeId || input.cascade_id || null,
        productKey: resolved.productKey || (scopeMode === 'unified' ? '__unified__' : null),
        productLabel: resolved.productLabel || null,
        modelId: resolved.modelId || null,
        modelSource: resolved.source || null,
        scopeMode,
        targetMode: policy.mode,
        targetLimitTokens: policy.limitTokens,
        sentMode: applied.appliedMode,
        sentLimitTokens: applied.sentLimitTokens,
        output: input
      };
    }

    // 3. Transport-layer frame/request body (WebSocket / Fetch / XHR)
    const unpacked = unpackTransportPayload(input, { channel, urlOrProcedure, contentType: context.contentType });
    if (!unpacked) {
      return { handled: false, passthrough: true, reason: 'unrecognized_body' };
    }

    // WebSocket Lcc frames require checking procedure after unpacking
    if (channel === 'ws_frame') {
      if (!unpacked.procedure || !isTargetBudgetRpc(unpacked.procedure)) {
        return { handled: false, passthrough: true, reason: 'non_target_ws_procedure' };
      }
    }

    if (unpacked.uninjectableReason) {
      return {
        handled: true,
        passthrough: true,
        modified: false,
        uninjectable: true,
        reason: unpacked.uninjectableReason,
        channel,
        cascadeId: null,
        productKey: null
      };
    }

    const isProto = unpacked.format === 'connect_proto_envelope' || unpacked.format === 'raw_binary_proto';
    const resolved = isProto
      ? resolveRequestModel(unpacked.protoMeta, { ...context, isProtoMeta: true })
      : resolveRequestModel(unpacked.payload, { ...context, isProtoMeta: false });

    const scopeMode = context.scopeMode === 'per_model' ? 'per_model' : 'unified';
    if (!resolved.resolved && scopeMode !== 'unified') {
      return {
        handled: true,
        passthrough: true,
        modified: false,
        uninjectable: true,
        reason: resolved.reason || 'unidentifiable_request_model',
        channel,
        cascadeId: resolved.cascadeId || null,
        productKey: null
      };
    }

    const policy = resolveBudgetPolicy({
      scopeMode,
      unifiedPreference: context.unifiedPreference,
      contextPreferencesMap: context.contextPreferencesMap,
      productKey: resolved.productKey,
      minTokens: context.minTokens,
      maxTokens: context.maxTokens
    });
    if (policy.mode === 'invalid_fixed') {
      return {
        handled: true,
        passthrough: true,
        modified: false,
        uninjectable: true,
        reason: 'invalid_fixed_limit',
        channel,
        cascadeId: resolved.cascadeId || null,
        productKey: resolved.productKey || null
      };
    }

    if (isProto) {
      const srcBytes = unpacked.format === 'connect_proto_envelope' ? unpacked.rawInner : unpacked.rawBytes;
      const hadExisting = unpacked.protoMeta?.existingMaxTokenLimit !== null && unpacked.protoMeta?.existingMaxTokenLimit !== undefined;
      let nextProtoBytes = srcBytes;
      let modified = false;
      if (policy.mode === 'fixed') {
        nextProtoBytes = rewriteProtoSendMessageCheckpointLimit(srcBytes, { mode: 'fixed', limitTokens: policy.limitTokens });
        modified = true;
      } else if (hadExisting) {
        nextProtoBytes = rewriteProtoSendMessageCheckpointLimit(srcBytes, { mode: policy.mode, limitTokens: null });
        modified = true;
      }
      const packed = modified ? packTransportPayload(unpacked, nextProtoBytes) : input;
      return {
        handled: true,
        passthrough: !modified,
        modified,
        uninjectable: false,
        channel,
        format: unpacked.format,
        cascadeId: resolved.cascadeId || null,
        productKey: resolved.productKey || (scopeMode === 'unified' ? '__unified__' : null),
        productLabel: resolved.productLabel || null,
        modelId: resolved.modelId || null,
        modelSource: resolved.source || null,
        scopeMode,
        targetMode: policy.mode,
        targetLimitTokens: policy.limitTokens,
        sentMode: policy.mode === 'fixed' ? 'fixed' : (policy.mode === 'dynamic' ? 'dynamic' : 'default'),
        sentLimitTokens: policy.mode === 'fixed' ? policy.limitTokens : null,
        output: packed || input
      };
    }

    const applied = applyBudgetPolicyToObject(unpacked.payload, policy);
    const packed = applied.modified ? packTransportPayload(unpacked, unpacked.payload) : input;
    return {
      handled: true,
      passthrough: !applied.modified,
      modified: Boolean(applied.modified && packed),
      uninjectable: false,
      channel,
      format: unpacked.format,
      cascadeId: resolved.cascadeId || unpacked.payload?.cascadeId || unpacked.payload?.cascade_id || null,
      productKey: resolved.productKey || (scopeMode === 'unified' ? '__unified__' : null),
      productLabel: resolved.productLabel || null,
      modelId: resolved.modelId || null,
      modelSource: resolved.source || null,
      scopeMode,
      targetMode: policy.mode,
      targetLimitTokens: policy.limitTokens,
      sentMode: applied.appliedMode,
      sentLimitTokens: applied.sentLimitTokens,
      output: packed || input
    };
  }

  // =========================================================================
  // 5. Dispatch tracking, causal observation & strict state machine (prevents timestamp fabrication and false confirmation)
  // =========================================================================

  function makeScopeKey(convoId, productKey) {
    return `${convoId || '__no_conv__'}::${productKey || '__no_product__'}`;
  }

  function createContextBudgetTracker(options = {}) {
    const confirmTimeoutMs = Number(options.confirmTimeoutMs || DEFAULT_CONFIRM_TIMEOUT_MS);
    const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
    let seqCounter = 0;

    // Store latest dispatch record isolated by (convoId, productKey) to prevent concurrent sessions/rapid switches from overwriting each other
    const dispatchesByScope = new Map();
    const dispatchesById = new Map();
    // Fallback lookup by product only when no active session context exists; never spoof confirmation across sessions
    const dispatchesByProduct = new Map();
    // Store real observation snapshots isolated by (convoId, productKey)
    const observationsByScope = new Map();
    // Verified session -> model bindings (only from explicit request responses or that session's real metadata)
    const verifiedConversationBindings = Object.create(null);

    function recordConversationBinding(convoId, binding) {
      if (!convoId || !binding?.productKey) return;
      verifiedConversationBindings[convoId] = {
        productKey: binding.productKey,
        productLabel: binding.productLabel || binding.productKey,
        modelId: binding.modelId || binding.productKey,
        updatedAt: nowFn()
      };
    }

    function getBaselineForScope(convoId, productKey) {
      const obs = observationsByScope.get(makeScopeKey(convoId, productKey));
      if (!obs) return { callId: null, stepCount: -1, obsTs: 0 };
      return {
        callId: obs.callId || null,
        stepCount: Number.isFinite(obs.stepCount) ? obs.stepCount : -1,
        obsTs: Number(obs.ts || 0)
      };
    }

    function beginDispatch(info = {}) {
      const seq = ++seqCounter;
      const timestamp = Number(info.timestamp || nowFn());
      const convoId = info.cascadeId || info.convoId || null;
      const productKey = info.productKey || null;
      const dispatchId = `disp_${seq}_${timestamp}`;

      if (convoId && productKey && productKey !== '__unified__') {
        recordConversationBinding(convoId, {
          productKey,
          productLabel: info.productLabel,
          modelId: info.modelId
        });
      }

      const baseline = getBaselineForScope(convoId, productKey);
      // Never persist user conversation content or credentials in diagnostic traces; keep only structured budget tracking fields
      const sanitizedPrefSnapshot = info.prefSnapshot && typeof info.prefSnapshot === 'object'
        ? {
          mode: info.prefSnapshot.mode || 'default',
          limitTokens: info.prefSnapshot.mode === 'fixed' && Number.isSafeInteger(Number(info.prefSnapshot.limitTokens))
            ? Number(info.prefSnapshot.limitTokens)
            : null
        }
        : {
          mode: info.targetMode || 'default',
          limitTokens: info.targetLimitTokens ?? null
        };
      const record = {
        dispatchId,
        seq,
        cascadeId: convoId,
        convoId,
        productKey,
        modelId: info.modelId || null,
        scopeMode: info.scopeMode || 'per_model',
        prefSnapshot: sanitizedPrefSnapshot,
        targetMode: info.targetMode || 'default',
        targetLimitTokens: info.targetLimitTokens ?? null,
        sentMode: info.sentMode || info.targetMode || 'default',
        sentLimitTokens: info.sentLimitTokens ?? null,
        channel: info.channel || 'http',
        transport: info.channel || 'http',
        status: info.status || 'dispatched',
        errorMessage: info.errorMessage ? String(info.errorMessage).slice(0, 160) : null,
        reason: info.reason || null,
        baselineCallId: baseline.callId,
        baselineStepCount: baseline.stepCount,
        baselineObsTs: baseline.obsTs,
        timestamp
      };

      const sKey = makeScopeKey(convoId, productKey);
      dispatchesByScope.set(sKey, record);
      dispatchesById.set(dispatchId, record);
      if (dispatchesById.size > 200) {
        const oldestKey = dispatchesById.keys().next().value;
        if (oldestKey) dispatchesById.delete(oldestKey);
      }
      if (productKey && productKey !== '__unified__') {
        dispatchesByProduct.set(productKey, record);
      }
      return record;
    }

    function updateDispatchStatus(dispatchId, patch = {}) {
      const rec = dispatchesById.get(dispatchId);
      if (!rec) return null;
      Object.assign(rec, patch);
      return rec;
    }

    /**
     * Record real backend observation; never refresh ts on an old snapshot using Date.now()
     */
    function recordObservation(obsInput = {}) {
      const convoId = obsInput.convoId || obsInput.cascadeId || null;
      const productKey = obsInput.productKey || null;
      if (!productKey) return null;

      const sKey = makeScopeKey(convoId, productKey);
      const prev = observationsByScope.get(sKey);
      const budget = Number(obsInput.budget || 0);
      const serviceLimit = Number(obsInput.serviceLimit || 0);
      const modelHardLimit = Number(obsInput.modelHardLimit || 0);
      const callId = obsInput.callId || null;
      const stepCount = Number.isFinite(Number(obsInput.stepCount)) ? Number(obsInput.stepCount) : -1;
      const explicitTs = Number(obsInput.ts || 0);

      // Determine whether this is a "new step / new response" rather than repeated polling of the same snapshot (never advance old snapshot ts on poll)
      const sameCall = callId ? prev?.callId === callId : prev?.callId === null;
      const sameStep = stepCount === prev?.stepCount;
      const downgradedMissingCall = Boolean(
        prev &&
        !callId &&
        prev.callId &&
        (stepCount < 0 || prev.stepCount < 0 || stepCount <= prev.stepCount)
      );
      const isSameSnapshot = Boolean(
        prev &&
        prev.budget === budget &&
        prev.serviceLimit === serviceLimit &&
        prev.modelHardLimit === modelHardLimit &&
        (
          (sameCall && sameStep && (!explicitTs || callId !== null || stepCount >= 0 || explicitTs <= prev.ts)) ||
          downgradedMissingCall
        )
      );

      if (isSameSnapshot) {
        return prev;
      }

      const nextTs = explicitTs > 0 ? explicitTs : nowFn();
      const next = {
        convoId,
        productKey,
        modelId: obsInput.modelId || prev?.modelId || null,

        modelLabel: obsInput.modelLabel || prev?.modelLabel || null,
        effort: obsInput.effort || prev?.effort || null,
        budget,
        serviceLimit,
        modelHardLimit,
        callId,
        stepCount,
        ts: nextTs
      };
      observationsByScope.set(sKey, next);

      if (convoId && productKey !== '__unified__') {
        recordConversationBinding(convoId, {
          productKey,
          productLabel: next.modelLabel,
          modelId: next.modelId
        });
      }
      return next;
    }

    function getScopedObservation(convoId, productKey) {
      if (!productKey) return null;
      if (convoId) {
        return observationsByScope.get(makeScopeKey(convoId, productKey)) || null;
      }
      // Do not guess when no active session exists; may return latest matching scope while annotating convoId
      let latest = null;
      for (const obs of observationsByScope.values()) {
        if (obs.productKey === productKey && (!latest || obs.ts > latest.ts)) {
          latest = obs;
        }
      }
      return latest;
    }

    function getScopedDispatch(convoId, productKey, scopeMode = 'per_model') {
      if (convoId) {
        const direct = dispatchesByScope.get(makeScopeKey(convoId, productKey));
        if (direct) return direct;
        if (scopeMode === 'unified') {
          const unifiedRec = dispatchesByScope.get(makeScopeKey(convoId, '__unified__'));
          if (unifiedRec) return unifiedRec;
        }
        return null;
      }
      if (productKey && dispatchesByProduct.has(productKey)) {
        return dispatchesByProduct.get(productKey);
      }
      return null;
    }

    function isPostDispatchObservation(dispatch, obs) {
      if (!dispatch || !obs) return false;
      if (dispatch.convoId && obs.convoId && dispatch.convoId !== obs.convoId) return false;
      if (obs.ts < dispatch.timestamp) return false;
      const changedCall = Boolean(obs.callId && obs.callId !== dispatch.baselineCallId);
      const advancedStep = obs.stepCount >= 0 && obs.stepCount > dispatch.baselineStepCount;
      if (changedCall || advancedStep) return true;
      // If callId matches pre-send baseline and step count has not grown, it is still the old snapshot (even if scannedAt/ts updated, never a new response)
      if (obs.callId && dispatch.baselineCallId && obs.callId === dispatch.baselineCallId) {
        return false;
      }
      // If both sides have clear step baselines and step count has not advanced, forbid pseudo-confirmation from polling timestamps alone
      if (dispatch.baselineStepCount >= 0 && obs.stepCount >= 0 && obs.stepCount <= dispatch.baselineStepCount) {
        return false;
      }
      return obs.ts > dispatch.baselineObsTs;
    }

    function evaluateStatus(params = {}) {
      const product = params.product || null;
      const scopeMode = params.scopeMode === 'per_model' ? 'per_model' : 'unified';
      const activePref = params.pref || { mode: 'default', limitTokens: null };
      const activeConvId = params.activeConvId || null;
      const now = Number(params.now || nowFn());

      if (!product) {
        return {
          status: 'unconfirmed',
          convoId: activeConvId || '—',
          targetMode: activePref?.mode || 'default',
          targetLimit: activePref?.mode === 'fixed' ? Number(activePref?.limitTokens) : null,
          dispatched: null,
          observation: null,
          diagnosisCode: 'missing_product'
        };
      }

      const targetMode = activePref?.mode || 'default';
      const targetLimit = targetMode === 'fixed' && Number.isSafeInteger(Number(activePref?.limitTokens))
        ? Number(activePref.limitTokens)
        : null;

      const rawDispatched = getScopedDispatch(activeConvId, product.productKey, scopeMode);
      const obs = getScopedObservation(activeConvId || rawDispatched?.convoId || null, product.productKey);
      const obsBudget = Number(obs?.budget || 0);
      const serviceLimit = Number(obs?.serviceLimit || 0);
      const modelHardLimit = Number(params.modelHardLimit || obs?.modelHardLimit || 0);

      // Verify latest dispatch matches "currently saved new target" (including fixed->default or failed->new value) to avoid misreporting stale results
      const matchesCurrentTarget = Boolean(
        rawDispatched &&
        rawDispatched.targetMode === targetMode &&
        (targetMode !== 'fixed' || rawDispatched.targetLimitTokens === targetLimit)
      );
      const dispatched = matchesCurrentTarget ? rawDispatched : null;
      const effectiveConvoId = dispatched?.convoId || obs?.convoId || activeConvId || '—';

      if (!dispatched) {
        if (targetMode === 'default') {
          return {
            status: 'default',
            convoId: effectiveConvoId,
            targetMode,
            targetLimit: null,
            dispatched: null,
            observation: obs,
            diagnosisCode: 'default_pending_dispatch'
          };
        }
        return {
          status: 'saved_pending_dispatch',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          dispatched: null,
          observation: obs,
          diagnosisCode: 'awaiting_next_send'
        };
      }

      if (dispatched.status === 'send_failed') {
        return {
          status: 'send_failed',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          dispatched,
          observation: obs,
          diagnosisCode: 'dispatch_failed',
          errorMessage: dispatched.errorMessage || '请求发送失败'
        };
      }
      if (dispatched.status === 'aborted') {
        return {
          status: 'aborted',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          dispatched,
          observation: obs,
          diagnosisCode: 'dispatch_aborted'
        };
      }
      if (dispatched.status === 'uninjectable') {
        return {
          status: 'uninjectable',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          dispatched,
          observation: obs,
          diagnosisCode: dispatched.reason || 'uninjectable'
        };
      }

      const hasPostObs = isPostDispatchObservation(dispatched, obs);
      if (!hasPostObs || obsBudget <= 0) {
        if (now - dispatched.timestamp > confirmTimeoutMs) {
          return {
            status: 'timeout_unconfirmed',
            convoId: effectiveConvoId,
            targetMode,
            targetLimit,
            dispatched,
            observation: obs,
            diagnosisCode: 'confirm_timeout'
          };
        }
        return {
          status: 'dispatched_pending_confirm',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          dispatched,
          observation: obs,
          diagnosisCode: 'awaiting_backend_obs'
        };
      }

      if (targetMode === 'default') {
        return {
          status: 'default',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit: null,
          dispatched,
          observation: obs,
          diagnosisCode: 'default_confirmed'
        };
      }

      if (targetMode === 'dynamic') {
        return {
          status: 'confirmed',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit: null,
          dispatched,
          observation: obs,
          diagnosisCode: 'dynamic_observed'
        };
      }

      // Exact integer comparison; do not relax to ±5% or ±64 and mask discrepancies
      if (obsBudget === targetLimit) {
        return {
          status: 'confirmed',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          dispatched,
          observation: obs,
          diagnosisCode: 'exact_match'
        };
      }

      // Only classify as capped by model limit when explicit server or ModelInfo hard-cap evidence exists and target exceeds that cap
      const knownCap = (serviceLimit > 0 ? serviceLimit : 0) || (modelHardLimit > 0 ? modelHardLimit : 0);
      if (knownCap > 0 && targetLimit > knownCap && obsBudget <= knownCap) {
        return {
          status: 'clamped_by_model_limit',
          convoId: effectiveConvoId,
          targetMode,
          targetLimit,
          knownCap,
          dispatched,
          observation: obs,
          diagnosisCode: 'server_or_model_cap'
        };
      }

      return {
        status: 'mismatch',
        convoId: effectiveConvoId,
        targetMode,
        targetLimit,
        dispatched,
        observation: obs,
        diagnosisCode: 'budget_mismatch_unknown_reason'
      };
    }

    function clearConversation(convoId) {
      if (!convoId) return;
      for (const k of Array.from(dispatchesByScope.keys())) {
        if (k.startsWith(`${convoId}::`)) dispatchesByScope.delete(k);
      }
      for (const k of Array.from(observationsByScope.keys())) {
        if (k.startsWith(`${convoId}::`)) observationsByScope.delete(k);
      }
      delete verifiedConversationBindings[convoId];
    }

    function exportAllObservationsByProduct() {
      const out = {};
      for (const obs of observationsByScope.values()) {
        if (!obs.productKey) continue;
        const prev = out[obs.productKey];
        if (!prev || obs.ts > prev.ts) out[obs.productKey] = obs;
      }
      return out;
    }

    function exportDiagnosticTraces() {
      return Array.from(dispatchesById.values()).map(rec => {
        const obs = getScopedObservation(rec.convoId, rec.productKey);
        const postMatched = obs && isPostDispatchObservation(rec, obs);
        return {
          dispatchSeq: rec.seq,
          dispatchId: rec.dispatchId,
          convoId: rec.convoId || null,
          productKey: rec.productKey || null,
          modelId: rec.modelId || null,
          scopeMode: rec.scopeMode,
          prefSnapshot: rec.prefSnapshot || null,
          sentMode: rec.sentMode,
          sentLimitTokens: rec.sentLimitTokens,
          transport: rec.transport || rec.channel || null,
          status: rec.status,
          observedBudget: postMatched ? (obs.budget || null) : null,
          observedAt: postMatched ? (obs.ts || null) : null,
          timestamp: rec.timestamp
        };
      });
    }

    return {
      beginDispatch,
      updateDispatchStatus,
      recordObservation,
      recordConversationBinding,
      getScopedDispatch,
      getScopedObservation,
      evaluateStatus,
      clearConversation,
      exportAllObservationsByProduct,
      exportDiagnosticTraces,
      verifiedConversationBindings
    };
  }

  const api = {
    DEFAULT_MIN_TOKENS,
    DEFAULT_MAX_TOKENS,
    STOCK_DEFAULT_CLAMP_TOKENS,
    DEFAULT_CONFIRM_TIMEOUT_MS,
    STATIC_MODEL_ENUM_MAP,
    stripModelEnumPrefix,
    modelEnumNumberToName,
    isTargetBudgetRpc,
    readVarint,
    writeVarint,
    encodeVarintField,
    encodeLengthDelimitedField,
    parseProtoFields,
    extractProtoSendMessageMetadata,
    rewriteProtoSendMessageCheckpointLimit,
    unpackTransportPayload,
    packTransportPayload,
    resolveRuntimeUnlockPolicy,
    deriveModelCapabilitySummary,
    evaluateLimitInput,
    projectUnifiedBudgetForProducts,
    resolveRequestModel,
    findPreferenceForProduct,
    resolveBudgetPolicy,
    applyBudgetPolicyToObject,
    transformOutgoingSendRequest,
    createContextBudgetTracker
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.__AGContextBudgetEngine = api;
  }
})(globalThis);
