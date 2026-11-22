  // =========================================================================
  // ELV-91: 生成体验面板（纯流式速度 7 档 / TTFT 7 档 / 总耗时 7 档 / E 指数 6 档 / 三阶段）
  // 最高采用依据：ELV-91 维护者指定终极版与 Gemini 11 页会话最终决策（左闭右开区间）
  // =========================================================================

  const ELV91_SCORE_RULE_VERSION = 'elv91-v1';

  /**
   * 格式化人性化耗时（<60s 用秒；>=60s 进位分秒；>=3600s 进位时分）
   * 示例：138.65s -> 2 分 19 秒；4200s -> 1 小时 10 分；3599.6s -> 1 小时 0 分。
   */
  function formatHumanDuration(sec, lang = 'zh-CN') {
    if (sec === null || sec === undefined || sec === '') return '—';
    const n = Number(sec);
    if (!Number.isFinite(n) || n < 0) return '—';
    const isEn = lang === 'en';
    const isTw = lang === 'zh-TW';
    if (n >= 3600) {
      const totalMin = Math.round(n / 60);
      const hrs = Math.floor(totalMin / 60);
      const mins = totalMin % 60;
      return isEn ? `${hrs}h ${mins}m` : (isTw ? `${hrs} 小時 ${mins} 分` : `${hrs} 小时 ${mins} 分`);
    }
    if (n >= 59.95) {
      const roundedSec = Math.round(n);
      if (roundedSec >= 3600) {
        const totalMin = Math.round(roundedSec / 60);
        const hrs = Math.floor(totalMin / 60);
        const mins = totalMin % 60;
        return isEn ? `${hrs}h ${mins}m` : (isTw ? `${hrs} 小時 ${mins} 分` : `${hrs} 小时 ${mins} 分`);
      }
      const mins = Math.floor(roundedSec / 60);
      const remSec = roundedSec % 60;
      return isEn ? `${mins}m ${remSec}s` : `${mins} 分 ${remSec} 秒`;
    }
    const fixedStr = n >= 10 ? n.toFixed(1) : n.toFixed(2);
    const trimmed = fixedStr.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
    return `${trimmed}s`;
  }

  function pickI18nText(obj, lang) {
    if (!obj || typeof obj !== 'object') return String(obj || '');
    if (lang === 'en') return obj.en ?? obj['zh-CN'] ?? '';
    if (lang === 'zh-TW') return obj['zh-TW'] ?? obj['zh-CN'] ?? '';
    return obj['zh-CN'] ?? '';
  }

  const ELV91_STREAM_SPEED_TIERS = [
    {
      id: 'stalled',
      maxExclusive: 1,
      color: '#DC2626',
      severity: 'critical',
      glyph: '✕',
      title: { 'zh-CN': '彻底停滞', 'zh-TW': '徹底停滯', en: 'Stalled' },
      comment: {
        'zh-CN': '按帧播放. 每秒连 1 个字都憋不出来. 别耽误干活了. 这边建议先去隔壁开个 Claude、Codex 或豆包救救急吧.',
        'zh-TW': '逐幀播放. 每秒連 1 個字都憋不出來. 別耽誤工作了. 這邊建議先去隔壁開個 Claude、Codex 或豆包應急吧.',
        en: 'Frame-by-frame crawl (< 1 tok/s). Consider switching to Claude, Codex, or Doubao if urgent.'
      }
    },
    {
      id: 'crawling',
      maxExclusive: 10,
      color: '#EF4444',
      severity: 'danger',
      glyph: '!',
      title: { 'zh-CN': '濒临卡死', 'zh-TW': '瀕臨卡死', en: 'Near-Stall' },
      comment: {
        'zh-CN': '慢得批爆. 基本处于不可用状态. 一个字往外蹦看得人血压飙升.',
        'zh-TW': '慢得要命. 基本處於不可用狀態. 一個字往外蹦看得人血壓飆升.',
        en: 'Painfully slow trickle; virtually unusable for interactive reading.'
      }
    },
    {
      id: 'slow',
      maxExclusive: 30,
      color: '#F59E0B',
      severity: 'warn',
      glyph: '⚡',
      title: { 'zh-CN': '慢于阅读', 'zh-TW': '慢於閱讀', en: 'Below Reading Pace' },
      comment: {
        'zh-CN': '挤牙膏中. 勉强能看但确实磨叽. 急性子可能有点难熬.',
        'zh-TW': '擠牙膏中. 勉強能看但確實磨蹭. 急性子可能有點難熬.',
        en: 'Squeezing out tokens slower than reading pace; long answers will test patience.'
      }
    },
    {
      id: 'smooth',
      maxExclusive: 80,
      color: '#10B981',
      severity: 'good',
      glyph: '⚡',
      title: { 'zh-CN': '流畅跟读', 'zh-TW': '流暢跟讀', en: 'Smooth Pace' },
      comment: {
        'zh-CN': '丝滑够用. 刚好跑赢你的眼睛. 属于比较舒服的节奏.',
        'zh-TW': '絲滑夠用. 剛好跑贏你的眼睛. 屬於比較舒服的節奏.',
        en: 'Silky and comfortable; easily keeps ahead of reading speed.'
      }
    },
    {
      id: 'fast',
      maxExclusive: 180,
      color: '#3B82F6',
      severity: 'fast',
      glyph: '⚡',
      title: { 'zh-CN': '高速输出', 'zh-TW': '高速輸出', en: 'High Throughput' },
      comment: {
        'zh-CN': '火力全开. 字数蹭蹭往上涨. 几乎不用干等.',
        'zh-TW': '火力全開. 字數飛快往上漲. 幾乎不用乾等.',
        en: 'Full throttle; output flies in with minimal waiting.'
      }
    },
    {
      id: 'rapid',
      maxExclusive: 300,
      color: '#06B6D4',
      severity: 'rapid',
      glyph: '⚡',
      title: { 'zh-CN': '疾速刷屏', 'zh-TW': '疾速刷屏', en: 'Blazing Stream' },
      comment: {
        'zh-CN': '手速冒烟. 屏幕直接刷出残影. 眼睛快跟不上了.',
        'zh-TW': '手速冒煙. 螢幕直接刷出殘影. 眼睛快跟不上了.',
        en: 'Screen-blurring token speed; faster than visual tracking.'
      }
    },
    {
      id: 'burst',
      maxExclusive: Infinity,
      color: '#8B5CF6',
      severity: 'epic',
      glyph: '⚡',
      title: { 'zh-CN': '瞬时爆发', 'zh-TW': '瞬時爆發', en: 'Instant Burst' },
      comment: {
        'zh-CN': '光速交卷. 刚回车就写完了. 甚至没看清过程.',
        'zh-TW': '光速交卷. 剛按完 Enter 就寫完了. 甚至沒看清過程.',
        en: 'Burst throughput (>= 300 tok/s); streaming finishes almost instantaneously.'
      }
    }
  ];

  const ELV91_TTFT_TIERS = [
    {
      id: 'instant',
      maxExclusive: 1,
      color: '#10B981',
      severity: 'good',
      glyph: '⚡',
      title: { 'zh-CN': '秒回响应', 'zh-TW': '秒回回應', en: 'Instant First Token' },
      comment: {
        'zh-CN': '几乎零延迟. 回车刚按下去就开始往外蹦字了.',
        'zh-TW': '幾乎零延遲. 剛送出就開始往外蹦字了.',
        en: 'Near-zero startup latency; tokens begin immediately.'
      }
    },
    {
      id: 'normal',
      maxExclusive: 10,
      color: '#10B981',
      severity: 'good',
      glyph: '⏳',
      title: { 'zh-CN': '正常等待', 'zh-TW': '正常等待', en: 'Normal Wait' },
      comment: {
        'zh-CN': '属于常规反应时间. 稍微喘口气就来了.',
        'zh-TW': '屬於常規反應時間. 稍微喘口氣就來了.',
        en: 'Standard startup latency; brief breath before output begins.'
      }
    },
    {
      id: 'thinking',
      maxExclusive: 30,
      color: '#F59E0B',
      severity: 'warn',
      glyph: '⏳',
      title: { 'zh-CN': '思考较久', 'zh-TW': '思考較久', en: 'Extended Thinking' },
      comment: {
        'zh-CN': '正在酝酿情绪. 遇到长上下文或深度思考时挺常见的.',
        'zh-TW': '正在醞釀情緒. 遇到長上下文或深度思考時挺常見的.',
        en: 'Warming up; common with long context prefill or deep reasoning.'
      }
    },
    {
      id: 'sluggish',
      maxExclusive: 60,
      color: '#F59E0B',
      severity: 'warn',
      glyph: '!',
      title: { 'zh-CN': '明显迟缓', 'zh-TW': '明顯遲緩', en: 'Noticeably Slow' },
      comment: {
        'zh-CN': '半分钟过去了还没动静. 手指已经开始忍不住想点取消了.',
        'zh-TW': '半分鐘過去了還沒動靜. 手指已經開始忍不住想點取消了.',
        en: 'Over 30 seconds without output; finger hovering over Cancel.'
      }
    },
    {
      id: 'agonizing',
      maxExclusive: 300,
      color: '#EF4444',
      severity: 'danger',
      glyph: '!',
      title: { 'zh-CN': '漫长煎熬', 'zh-TW': '漫長煎熬', en: 'Minute-Scale Wait' },
      comment: {
        'zh-CN': '等待时间正式跨入分钟级. 等得花都谢了. 别干盯着屏幕看了.',
        'zh-TW': '等待時間正式跨入分鐘級. 等得花都謝了. 別乾盯著螢幕看了.',
        en: 'Waiting has crossed into minutes; stop staring at the cursor.'
      }
    },
    {
      id: 'extreme',
      maxExclusive: 600,
      color: '#DC2626',
      severity: 'critical',
      glyph: '✕',
      title: { 'zh-CN': '极度漫长', 'zh-TW': '極度漫長', en: 'Extreme Wait' },
      comment: {
        'zh-CN': '已经等了 {elapsed}. 进度条仿佛静止. 活还得干. 这边建议先去隔壁开个 Claude、Codex 或豆包救救急吧.',
        'zh-TW': '已經等了 {elapsed}. 進度條彷彿靜止. 工作還得進行. 這邊建議先去隔壁開個 Claude、Codex 或豆包應急吧.',
        en: 'Waited {elapsed} with a frozen progress bar; consider switching to Claude, Codex, or Doubao if work cannot wait.'
      }
    },
    {
      id: 'century',
      maxExclusive: Infinity,
      color: '#DC2626',
      severity: 'critical',
      glyph: '✕',
      title: { 'zh-CN': '世纪等待', 'zh-TW': '世紀等待', en: 'Over 10 Minutes' },
      comment: {
        'zh-CN': '突破十分钟大关. 已经分不清是在推理还是在挂机. 别耽误干活了. 赶紧去用 Claude、Codex 或豆包吧.',
        'zh-TW': '突破十分鐘大關. 已經分不清是在推理還是在掛機. 別耽誤工作了. 趕緊去用 Claude、Codex 或豆包吧.',
        en: 'Over 10 minutes without a first token; unclear if reasoning or idling. Consider using Claude, Codex, or Doubao.'
      }
    }
  ];

  const ELV91_DURATION_TIERS = [
    {
      id: 'flash',
      maxExclusive: 5,
      color: '#10B981',
      severity: 'good',
      title: { 'zh-CN': '瞬时完成', 'zh-TW': '瞬時完成', en: 'Instant Finish' },
      comment: {
        'zh-CN': '刚眨眼就搞定了. 适合轻量化问答或小片段补全.',
        'zh-TW': '剛眨眼就搞定了. 適合輕量化問答或小片段補全.',
        en: 'Finished in a blink; well-suited for quick Q&A or short edits.'
      }
    },
    {
      id: 'routine',
      maxExclusive: 30,
      color: '#10B981',
      severity: 'good',
      title: { 'zh-CN': '常规耗时', 'zh-TW': '常規耗時', en: 'Routine Turn' },
      comment: {
        'zh-CN': '喝口水的功夫. 日常写段代码或改个 Bug 的正常节奏.',
        'zh-TW': '喝口水的工夫. 日常寫段程式碼或修個 Bug 的正常節奏.',
        en: 'Time for a sip of water; normal cadence for daily coding or bug fixes.'
      }
    },
    {
      id: 'deep',
      maxExclusive: 120,
      color: '#3B82F6',
      severity: 'fast',
      title: { 'zh-CN': '深度处理', 'zh-TW': '深度處理', en: 'Deep Work' },
      comment: {
        'zh-CN': '开始动真格了. 通常是在做长文输出或复杂逻辑推理.',
        'zh-TW': '開始動真格了. 通常是在做長文輸出或複雜邏輯推理.',
        en: 'Substantial turn duration; typical of long outputs or multi-step reasoning.'
      }
    },
    {
      id: 'long_run',
      maxExclusive: 600,
      color: '#F59E0B',
      severity: 'warn',
      title: { 'zh-CN': '长程运行', 'zh-TW': '長程運行', en: 'Long Run' },
      comment: {
        'zh-CN': '进入长线作战. 如果是大体量任务还算合理. 要是简单输出就有点磨叽了.',
        'zh-TW': '進入長線作戰. 如果是大體量任務還算合理. 要是簡單輸出就有點磨蹭了.',
        en: 'Multi-minute turn; reasonable for heavy tasks, sluggish if output was tiny.'
      }
    },
    {
      id: 'heavy',
      maxExclusive: 1800,
      color: '#F59E0B',
      severity: 'warn',
      title: { 'zh-CN': '重度攻坚', 'zh-TW': '重度攻堅', en: 'Heavy Grind' },
      comment: {
        'zh-CN': '跑了十几分钟大工程. 希望最终产出对得起这度电和耐心.',
        'zh-TW': '跑了十幾分鐘大工程. 希望最終產出對得起這度電和耐心.',
        en: '10–30 minute marathon; hopefully the result justifies the patience.'
      }
    },
    {
      id: 'marathon',
      maxExclusive: 3600,
      color: '#EF4444',
      severity: 'danger',
      title: { 'zh-CN': '超长耐久', 'zh-TW': '超長耐久', en: 'Ultra-Long' },
      comment: {
        'zh-CN': '半小时起步的持久战. 这已经不是在聊天. 是在跑批处理任务了.',
        'zh-TW': '半小時起步的持久戰. 這已經不是在聊天. 是在跑批次處理任務了.',
        en: 'Over 30 minutes; feels more like a batch pipeline than chat.'
      }
    },
    {
      id: 'overtime',
      maxExclusive: Infinity,
      color: '#DC2626',
      severity: 'critical',
      title: { 'zh-CN': '跨时鏖战', 'zh-TW': '跨時鏖戰', en: 'Over an Hour' },
      comment: {
        'zh-CN': '干了一个多小时. 建议结合真实进度与产出检查是否出现无意义空转.',
        'zh-TW': '跑了一個多小時. 建議結合真實進度與產出檢查是否出現無意義空轉.',
        en: 'Exceeded 60 minutes; worth checking actual progress vs idle stalls.'
      }
    }
  ];

  const ELV91_EFFICIENCY_GRADES = [
    {
      grade: 'S',
      glyph: '★',
      minInclusive: 90,
      color: '#8B5CF6',
      severity: 'epic',
      title: { 'zh-CN': 'S 级 · 帕累托最优', 'zh-TW': 'S 級 · 柏拉圖最優', en: 'Grade S · Optimal' },
      comment: {
        'zh-CN': '响应、吞吐、体量全线拉满. 几乎零摩擦的高效生产力状态.',
        'zh-TW': '回應、吞吐、體量全線拉滿. 幾乎零摩擦的高效生產力狀態.',
        en: 'Top response speed, throughput, and scale efficiency with minimal friction.'
      }
    },
    {
      grade: 'A',
      glyph: '⚡',
      minInclusive: 75,
      color: '#3B82F6',
      severity: 'fast',
      title: { 'zh-CN': 'A 级 · 高效稳健', 'zh-TW': 'A 級 · 高效穩健', en: 'Grade A · High Efficiency' },
      comment: {
        'zh-CN': '发挥非常扎实. 时间和算力都花在了刀刃上. 干活很顺手.',
        'zh-TW': '發揮非常紮實. 時間和算力都花在了刀刃上. 做事很順手.',
        en: 'Solid responsiveness and throughput; compute well spent.'
      }
    },
    {
      grade: 'B',
      glyph: '●',
      minInclusive: 60,
      color: '#10B981',
      severity: 'good',
      title: { 'zh-CN': 'B 级 · 均衡达标', 'zh-TW': 'B 級 · 均衡達標', en: 'Grade B · Balanced' },
      comment: {
        'zh-CN': '整体表现中规中矩. 如果任务本身很重. 这个耗时完全在情理之中.',
        'zh-TW': '整體表現中規中矩. 如果任務本身很重. 這個耗時完全在情理之中.',
        en: 'Balanced overall; reasonable turnaround given task size.'
      }
    },
    {
      grade: 'C',
      glyph: '▲',
      minInclusive: 40,
      color: '#F59E0B',
      severity: 'warn',
      title: { 'zh-CN': 'C 级 · 边际递减', 'zh-TW': 'C 級 · 邊際遞減', en: 'Grade C · Mediocre' },
      comment: {
        'zh-CN': '效率开始打折了. 要么是任务确实吃重. 要么是前期思考等待磨蹭了半天.',
        'zh-TW': '效率開始打折了. 要麼是任務確實吃重. 要麼是前期思考等待磨蹭了半天.',
        en: 'Noticeable friction from either heavy workload or long initial waiting.'
      }
    },
    {
      grade: 'D',
      glyph: '!',
      minInclusive: 20,
      color: '#EF4444',
      severity: 'danger',
      title: { 'zh-CN': 'D 级 · 低效失衡', 'zh-TW': 'D 級 · 低效失衡', en: 'Grade D · Inefficient' },
      comment: {
        'zh-CN': '投入产出比偏低. 明显感觉在空转等进度. 体感已经开始烦躁了.',
        'zh-TW': '投入產出比偏低. 明顯感覺在空轉等進度. 體感已經開始煩躁了.',
        en: 'Low efficiency relative to wait time; frustrating idle ratio.'
      }
    },
    {
      grade: 'F',
      glyph: '✕',
      minInclusive: 0,
      color: '#DC2626',
      severity: 'critical',
      title: { 'zh-CN': 'F 级 · 效能崩盘', 'zh-TW': 'F 級 · 效能崩盤', en: 'Grade F · Collapsed' },
      comment: {
        'zh-CN': '极其抽象的表现——活没干多少. 时间全耗在干等上了. 这边建议直接打开 Claude、Codex 或豆包救救急吧.',
        'zh-TW': '極其抽象的表現——事沒幹多少. 時間全耗在乾等上了. 這邊建議直接打開 Claude、Codex 或豆包應急吧.',
        en: 'Severe wait-to-output imbalance; consider using Claude, Codex, or Doubao if stalled.'
      }
    }
  ];

  function pickLeftClosedTier(tiers, value, lang = 'zh-CN') {
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0) return null;
    for (const tier of tiers) {
      if (v < tier.maxExclusive) {
        return {
          id: tier.id,
          color: tier.color,
          severity: tier.severity,
          glyph: tier.glyph || '⚡',
          title: pickI18nText(tier.title, lang),
          comment: pickI18nText(tier.comment, lang)
        };
      }
    }
    const last = tiers[tiers.length - 1];
    return {
      id: last.id,
      color: last.color,
      severity: last.severity,
      glyph: last.glyph || '⚡',
      title: pickI18nText(last.title, lang),
      comment: pickI18nText(last.comment, lang)
    };
  }

  function classifyStreamSpeedTier(streamSpeed, lang = 'zh-CN') {
    return pickLeftClosedTier(ELV91_STREAM_SPEED_TIERS, streamSpeed, lang);
  }

  function classifyTtftTier(ttftSec, lang = 'zh-CN') {
    return pickLeftClosedTier(ELV91_TTFT_TIERS, ttftSec, lang);
  }

  function classifyDurationTier(durationSec, lang = 'zh-CN') {
    return pickLeftClosedTier(ELV91_DURATION_TIERS, durationSec, lang);
  }

  function classifyEfficiencyGrade(score, lang = 'zh-CN') {
    const s = Number(score);
    if (!Number.isFinite(s) || s < 0) return null;
    for (const g of ELV91_EFFICIENCY_GRADES) {
      if (s >= g.minInclusive) {
        return {
          grade: g.grade,
          color: g.color,
          severity: g.severity,
          glyph: g.glyph || '⚡',
          title: pickI18nText(g.title, lang),
          comment: pickI18nText(g.comment, lang)
        };
      }
    }
    const last = ELV91_EFFICIENCY_GRADES[ELV91_EFFICIENCY_GRADES.length - 1];
    return {
      grade: last.grade,
      color: last.color,
      severity: last.severity,
      glyph: last.glyph || '✕',
      title: pickI18nText(last.title, lang),
      comment: pickI18nText(last.comment, lang)
    };
  }

  /**
   * 评估流式输出稳定性（必须同时满足采样点数 >= 15、纯流式耗时 > 2.0s 且真实间隔 CV <= 0.65）。
   * 若缺少实际间隔波动数据，严禁凭直觉或流式均速给出平稳勾选。
   */
  function computeStreamStability(input = {}) {
    if (input && (input.isSyntheticPoll === true || input.sampleSource === 'poll' || input.sampleSource === 'synthetic')) {
      const streamingSec = Number(input.streamingSec);
      return {
        isStable: false,
        chunks: 0,
        streamingSec: Number.isFinite(streamingSec) ? streamingSec : null,
        intervalCv: null,
        reason: 'synthetic_poll_unsupported'
      };
    }
    const chunks = Number(input.chunkCount ?? input.chunks ?? 0);
    const streamingSec = Number(input.streamingSec);
    let intervalCv = (input.intervalCv !== undefined && input.intervalCv !== null && Number.isFinite(Number(input.intervalCv)) && Number(input.intervalCv) >= 0)
      ? Number(input.intervalCv)
      : null;

    if (intervalCv === null && Array.isArray(input.chunkIntervalsMs)) {
      const valid = input.chunkIntervalsMs.map(Number).filter(v => Number.isFinite(v) && v >= 0);
      if (valid.length >= 14) {
        const mean = valid.reduce((s, v) => s + v, 0) / valid.length;
        if (mean > 0) {
          const variance = valid.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / valid.length;
          intervalCv = Math.sqrt(variance) / mean;
        } else {
          intervalCv = 0;
        }
      }
    }

    if (!Number.isFinite(streamingSec) || streamingSec <= 2.0) {
      return {
        isStable: false,
        chunks: Number.isFinite(chunks) ? chunks : 0,
        streamingSec: Number.isFinite(streamingSec) ? streamingSec : null,
        intervalCv: intervalCv !== null ? Number(intervalCv.toFixed(3)) : null,
        reason: 'short_stream'
      };
    }
    if (!Number.isFinite(chunks) || chunks < 15) {
      return {
        isStable: false,
        chunks: Number.isFinite(chunks) ? chunks : 0,
        streamingSec,
        intervalCv: intervalCv !== null ? Number(intervalCv.toFixed(3)) : null,
        reason: 'insufficient_chunks'
      };
    }
    if (intervalCv === null) {
      return {
        isStable: false,
        chunks,
        streamingSec,
        intervalCv: null,
        reason: 'missing_interval_evidence'
      };
    }
    const isStable = intervalCv <= 0.65;
    return {
      isStable,
      chunks,
      streamingSec,
      intervalCv: Number(intervalCv.toFixed(3)),
      reason: isStable ? 'stable' : 'high_variance'
    };
  }

  /**
   * 计算 ELV-91 综合体验指数 E ∈ [0, 100]（Weber-Fechner + Hill Log-Logistic + Cobb-Douglas）。
   * 若缺少必需指标或满足极端小样本门槛（outputTokens < 15 && totalDurationSec < 2），不强行补造分数。
   */
  function calculateExperienceScore(input = {}, lang = 'zh-CN') {
    const outRaw = input.outputTokens;
    const outputTokens = (outRaw !== undefined && outRaw !== null && Number.isFinite(Number(outRaw))) ? Number(outRaw) : null;
    const inRaw = input.totalInputTokens ?? input.inputTokens;
    const inputTokens = (inRaw !== undefined && inRaw !== null && Number.isFinite(Number(inRaw)) && Number(inRaw) > 0) ? Number(inRaw) : null;
    const ttftRaw = input.ttftSec ?? input.ttft;
    const ttftSec = (ttftRaw !== undefined && ttftRaw !== null && Number.isFinite(Number(ttftRaw)) && Number(ttftRaw) >= 0) ? Number(ttftRaw) : null;
    const durRaw = input.totalDurationSec ?? input.durationSec ?? input.duration;
    const totalDurationSec = (durRaw !== undefined && durRaw !== null && Number.isFinite(Number(durRaw)) && Number(durRaw) > 0) ? Number(durRaw) : null;

    let streamSpeed = (input.streamSpeed !== undefined && input.streamSpeed !== null && Number.isFinite(Number(input.streamSpeed)) && Number(input.streamSpeed) > 0)
      ? Number(input.streamSpeed)
      : ((input.streamingTps !== undefined && input.streamingTps !== null && Number.isFinite(Number(input.streamingTps)) && Number(input.streamingTps) > 0)
        ? Number(input.streamingTps)
        : null);

    const streamSecRaw = input.streamingSec;
    let streamingSec = (streamSecRaw !== undefined && streamSecRaw !== null && Number.isFinite(Number(streamSecRaw)) && Number(streamSecRaw) > 0)
      ? Number(streamSecRaw)
      : ((totalDurationSec !== null && ttftSec !== null && totalDurationSec > ttftSec + 0.01) ? Number((totalDurationSec - ttftSec).toFixed(4)) : null);

    if (streamSpeed === null && outputTokens !== null && outputTokens > 0 && streamingSec !== null && streamingSec >= 0.05) {
      streamSpeed = outputTokens / streamingSec;
    }

    if ((outputTokens !== null && outputTokens < 15) || (streamingSec !== null && streamingSec < 0.5)) {
      return {
        available: false,
        skippedReason: 'insufficient_sample',
        score: null,
        grade: null,
        tier: null,
        ruleVersion: ELV91_SCORE_RULE_VERSION
      };
    }

    if (outputTokens === null || ttftSec === null || totalDurationSec === null || streamSpeed === null || !Number.isFinite(streamSpeed) || streamSpeed <= 0) {
      return {
        available: false,
        skippedReason: 'missing_metrics',
        score: null,
        grade: null,
        tier: null,
        ruleVersion: ELV91_SCORE_RULE_VERSION
      };
    }

    const N_work = inputTokens !== null
      ? Math.max(1, outputTokens + 0.15 * inputTokens)
      : Math.max(1, outputTokens);
    const C = Math.log10(1 + N_work);
    const gamma = 1 + 0.50 * Math.max(0, C - 2.3);
    const S_resp = 1 / (1 + Math.pow(ttftSec / (8 * gamma), 1.5));
    const S_speed = 1 / (1 + Math.pow(35 / Math.max(streamSpeed, 0.1), 1.4));
    const T_base = 5.0 + N_work / 25.0;
    const S_dur = 1 / (1 + Math.pow(totalDurationSec / (T_base * gamma), 1.2));
    const w1 = Math.min(0.40, Math.max(0.15, 0.40 - 0.10 * Math.max(0, C - 2.3)));
    const w2 = 0.35;
    const w3 = 1 - w1 - w2;
    const score = Math.round(100 * Math.pow(S_resp, w1) * Math.pow(S_speed, w2) * Math.pow(S_dur, w3) * 10) / 10;
    const clampedScore = Math.max(0, Math.min(100, score));
    const tier = classifyEfficiencyGrade(clampedScore, lang);

    return {
      available: true,
      skippedReason: null,
      score: clampedScore,
      grade: tier.grade,
      tier,
      ruleVersion: ELV91_SCORE_RULE_VERSION,
      basis: {
        N_work: Number(N_work.toFixed(1)),
        usedInputWeight: inputTokens !== null,
        C: Number(C.toFixed(4)),
        gamma: Number(gamma.toFixed(4)),
        S_resp: Number(S_resp.toFixed(4)),
        S_speed: Number(S_speed.toFixed(4)),
        T_base: Number(T_base.toFixed(2)),
        S_dur: Number(S_dur.toFixed(4)),
        w1: Number(w1.toFixed(4)),
        w2,
        w3: Number(w3.toFixed(4))
      }
    };
  }

  /**
   * ELV-91 三阶段生成体验综合判定器。
   * 覆盖：等待首字(waiting) / 流式生成中(streaming) / 已完成(final) / 异常(canceled, failed, exceeded, network, idle)。
   * 严格执行：左闭右开区间、TTFT > 30s 木桶优先警示、样本不足与缺失兜底、真实间隔方差平稳判定、防错因/重连承诺。
   */
  function evaluateGenerationExperience(rawInput = {}, lang = 'zh-CN') {
    const isEn = lang === 'en';
    const isTw = lang === 'zh-TW';
    const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
    const outcome = String(input.outcomeStatus || input.status || '').toLowerCase();

    const rawElapsed = input.elapsedSec ?? input.waitingSec;
    const elapsedSec = (rawElapsed !== undefined && rawElapsed !== null && Number.isFinite(Number(rawElapsed)) && Number(rawElapsed) >= 0) ? Number(rawElapsed) : null;
    const rawTtft = input.ttftSec ?? input.ttft;
    const ttftSec = (rawTtft !== undefined && rawTtft !== null && Number.isFinite(Number(rawTtft)) && Number(rawTtft) >= 0) ? Number(rawTtft) : null;
    const rawDur = input.totalDurationSec ?? input.durationSec ?? input.duration;
    const totalDurationSec = (rawDur !== undefined && rawDur !== null && Number.isFinite(Number(rawDur)) && Number(rawDur) > 0) ? Number(rawDur) : null;
    const rawOut = input.outputTokens;
    const outputTokens = (rawOut !== undefined && rawOut !== null && Number.isFinite(Number(rawOut)) && Number(rawOut) >= 0) ? Number(rawOut) : null;

    let streamingSec = (input.streamingSec !== undefined && input.streamingSec !== null && Number.isFinite(Number(input.streamingSec)) && Number(input.streamingSec) >= 0)
      ? Number(input.streamingSec)
      : ((totalDurationSec !== null && ttftSec !== null && totalDurationSec > ttftSec) ? Number((totalDurationSec - ttftSec).toFixed(4)) : null);

    let streamSpeed = (input.streamSpeed !== undefined && input.streamSpeed !== null && Number.isFinite(Number(input.streamSpeed)) && Number(input.streamSpeed) > 0)
      ? Number(Number(input.streamSpeed).toFixed(1))
      : ((input.streamingTps !== undefined && input.streamingTps !== null && Number.isFinite(Number(input.streamingTps)) && Number(input.streamingTps) > 0)
        ? Number(Number(input.streamingTps).toFixed(1))
        : null);
    if (streamSpeed === null && outputTokens !== null && outputTokens > 0 && streamingSec !== null && streamingSec >= 0.05) {
      streamSpeed = Number((outputTokens / streamingSec).toFixed(1));
    }

    const overallTps = (input.overallTps !== undefined && input.overallTps !== null && Number.isFinite(Number(input.overallTps)) && Number(input.overallTps) > 0)
      ? Number(Number(input.overallTps).toFixed(1))
      : ((outputTokens !== null && outputTokens > 0 && totalDurationSec !== null && totalDurationSec > 0) ? Number((outputTokens / totalDurationSec).toFixed(1)) : null);

    const ttftRatioPct = (ttftSec !== null && totalDurationSec !== null && totalDurationSec > 0)
      ? Number((Math.min(100, Math.max(0, (ttftSec / totalDurationSec) * 100))).toFixed(1))
      : null;

    const ttftFormatted = ttftSec !== null ? formatHumanDuration(ttftSec, lang) : '—';
    const durationFormatted = totalDurationSec !== null ? formatHumanDuration(totalDurationSec, lang) : '—';
    const elapsedFormatted = elapsedSec !== null ? formatHumanDuration(elapsedSec, lang) : '—';

    let phase = input.phase || '';
    if (!phase) {
      if (outcome === 'canceled') phase = 'canceled';
      else if (['failed', 'exceeded', 'network', 'quota_exhausted', 'rate_limited', 'auth_error', 'service_unavailable'].includes(outcome) || input.error) phase = 'failed';
      else if (outcome === 'waiting' || (elapsedSec !== null && ttftSec === null && !outputTokens)) phase = 'waiting';
      else if (outcome === 'streaming') phase = 'streaming';
      else if (ttftSec !== null || totalDurationSec !== null || streamSpeed !== null || (outputTokens !== null && outputTokens > 0)) phase = 'final';
      else phase = 'idle';
    }

    // 异常 / 取消 / 空闲状态处理（绝不制造评分或速率）
    if (phase === 'idle') {
      return {
        phase: 'idle',
        scoreRuleVersion: ELV91_SCORE_RULE_VERSION,
        badge: {
          text: isEn ? 'Standby' : (isTw ? '待生成' : '待生成'),
          color: '#9CA3AF',
          severity: 'neutral',
          glyph: '⚡'
        },
        shortTitle: isEn ? 'Standby' : '待生成',
        comment: isEn
          ? 'Waiting for model output to evaluate first-token wait and streaming throughput.'
          : (isTw ? '等待首次模型輸出產生首字延遲與純流式速度評估.' : '等待首次模型输出产生首字延迟与纯流式速度评估.'),
        subLabel: isEn ? 'No data yet' : (isTw ? '暫無即時生成資料' : '暂无本次生成数据'),
        elapsedFormatted: '—',
        ttftFormatted: '—',
        durationFormatted: '—',
        ttftRatioPct: null,
        streamSpeed: null,
        overallTps: null,
        ttftTier: null,
        speedTier: null,
        durationTier: null,
        stability: computeStreamStability({}),
        efficiency: { available: false, skippedReason: 'idle', score: null, grade: null, tier: null, ruleVersion: ELV91_SCORE_RULE_VERSION }
      };
    }

    if (phase === 'canceled' || phase === 'failed') {
      const isCanc = phase === 'canceled';
      const baseColor = isCanc ? '#9CA3AF' : '#EF4444';
      const titleTxt = isCanc
        ? (isEn ? 'Interrupted' : (isTw ? '已中斷' : '已中断'))
        : (isEn ? 'Request Failed' : (isTw ? '請求失敗' : '请求失败'));
      const reasonTxt = input.error ? String(input.error).slice(0, 120) : '';
      return {
        phase,
        scoreRuleVersion: ELV91_SCORE_RULE_VERSION,
        badge: { text: titleTxt, color: baseColor, severity: isCanc ? 'neutral' : 'danger', glyph: isCanc ? '⏸' : '✕' },
        shortTitle: titleTxt,
        comment: isCanc
          ? (isEn ? 'The request was canceled before normal completion; efficiency score is omitted.' : (isTw ? '本次請求未正常完成即中斷. 略過綜合評分.' : '本次请求未正常完成即中断. 跳过综合效率评分.'))
          : (reasonTxt || (isEn ? 'Request failed; throughput and efficiency score are omitted.' : (isTw ? '本次請求異常結束. 略過速度與綜合評分.' : '本次请求异常结束. 跳过速度与综合评分.'))),
        subLabel: ttftSec !== null
          ? (isEn ? `TTFT ${ttftFormatted} · Score omitted` : (isTw ? `首字 ${ttftFormatted} · 略過評分` : `首字 ${ttftFormatted} · 跳过综合评分`))
          : (isEn ? 'Score omitted' : (isTw ? '略過綜合評分' : '跳过综合评分')),
        elapsedFormatted,
        ttftFormatted,
        durationFormatted,
        ttftRatioPct,
        streamSpeed,
        overallTps,
        ttftTier: ttftSec !== null ? classifyTtftTier(ttftSec, lang) : null,
        speedTier: null,
        durationTier: totalDurationSec !== null ? classifyDurationTier(totalDurationSec, lang) : null,
        stability: computeStreamStability({}),
        efficiency: { available: false, skippedReason: phase, score: null, grade: null, tier: null, ruleVersion: ELV91_SCORE_RULE_VERSION }
      };
    }

    // 阶段 1：仍在等待首字 (waiting)
    if (phase === 'waiting') {
      const waitSec = elapsedSec ?? 0;
      const waitFmt = formatHumanDuration(waitSec, lang);
      const tTier = classifyTtftTier(waitSec, lang);
      let color = '#9CA3AF';
      let severity = 'neutral';
      let glyph = '⏳';
      let shortTitle = isEn ? 'Awaiting First Token' : '等待首字';
      let comment = isEn
        ? `Waiting for response (${waitSec.toFixed(1)}s elapsed); rate evaluation paused.`
        : (isTw ? `正在等待回應. 已等待 ${waitSec.toFixed(1)}s. 尚未收到首個字元. 暫不評估速率.` : `正在等待响应. 已等待 ${waitSec.toFixed(1)}s. 尚未收到首个字符. 暂不评估速率.`);
      if (waitSec >= 10 && tTier) {
        color = tTier.color;
        severity = tTier.severity;
        glyph = tTier.glyph;
        shortTitle = tTier.title;
        const tplComment = tTier.comment.replace('{elapsed}', waitFmt);
        const suffix = isEn ? ` (${waitFmt} elapsed).` : (isTw ? ` 已累計等待 ${waitFmt}.` : ` 已累计等待 ${waitFmt}.`);
        comment = `${tplComment}${suffix}`;
      }
      return {
        phase: 'waiting',
        scoreRuleVersion: ELV91_SCORE_RULE_VERSION,
        badge: { text: shortTitle, color, severity, glyph },
        shortTitle,
        comment,
        subLabel: isEn ? 'First token pending · Timing' : (isTw ? '首字未達 · 計時中' : '首字未达 · 计时中'),
        elapsedFormatted: waitFmt,
        ttftFormatted: waitFmt,
        durationFormatted: '—',
        ttftRatioPct: null,
        streamSpeed: null,
        overallTps: null,
        ttftTier: tTier,
        speedTier: null,
        durationTier: null,
        stability: computeStreamStability({}),
        efficiency: { available: false, skippedReason: 'waiting', score: null, grade: null, tier: null, ruleVersion: ELV91_SCORE_RULE_VERSION }
      };
    }

    // 已拿到首字之后（streaming 或 final）先算核心组件
    const ttftTier = ttftSec !== null ? classifyTtftTier(ttftSec, lang) : null;
    const speedTier = streamSpeed !== null ? classifyStreamSpeedTier(streamSpeed, lang) : null;
    const durationTier = totalDurationSec !== null ? classifyDurationTier(totalDurationSec, lang) : null;
    const stability = computeStreamStability({
      chunkCount: input.chunkCount ?? input.chunks,
      chunkIntervalsMs: input.chunkIntervalsMs,
      intervalCv: input.intervalCv,
      streamingSec,
      sampleSource: input.sampleSource,
      isSyntheticPoll: input.isSyntheticPoll
    });
    const efficiency = phase === 'final'
      ? calculateExperienceScore({
          outputTokens,
          inputTokens: input.totalInputTokens ?? input.inputTokens,
          ttftSec,
          streamingSec,
          totalDurationSec,
          streamSpeed
        }, lang)
      : { available: false, skippedReason: 'streaming', score: null, grade: null, tier: null, ruleVersion: ELV91_SCORE_RULE_VERSION };

    // 按规则 2 / 3 / 4 判断实时速度与首字等待展示评价
    const isLongTtft = ttftSec !== null && ttftSec > 30;
    const lowStreamTokens = outputTokens !== null && outputTokens < 15;
    const shortStreamTime = streamingSec !== null && streamingSec < 0.5;
    const hasMissingSpeed = streamSpeed === null;
    const isShortStreamOnly = !lowStreamTokens && shortStreamTime;
    const isSampleSparse = lowStreamTokens || shortStreamTime;
    const isReliableSpeed = !(isSampleSparse || hasMissingSpeed);
    const shortWindowEstimateSpeed = (isSampleSparse && streamSpeed !== null) ? streamSpeed : null;

    let evalColor = '#9CA3AF';
    let evalSeverity = 'neutral';
    let evalGlyph = '⚡';
    let evalTitle = '';
    let evalComment = '';
    let subLabel = '';

    const ratioSuffix = ttftRatioPct !== null
      ? (isEn ? ` (${ttftRatioPct}% of turn)` : (isTw ? `佔總耗時 ${ttftRatioPct}%` : `占用了 ${ttftRatioPct}% 的时间`))
      : '';
    const stableSuffix = stability.isStable
      ? (isEn ? ' · Steady output' : (isTw ? ' · 輸出平穩' : ' · 输出平稳'))
      : '';

    if (isLongTtft) {
      // 规则 2：首字 > 30s 木桶优先警示规则（若流式样本过短或无有效速率，不把短窗口突发换算当作后续极快）
      evalColor = ttftTier.color;
      evalSeverity = ttftTier.severity;
      evalGlyph = ttftTier.glyph;
      const baseWaitComment = ttftTier.comment.replace('{elapsed}', ttftFormatted);
      if (hasMissingSpeed || isSampleSparse) {
        evalTitle = ttftTier.title;
        if (isShortStreamOnly && shortWindowEstimateSpeed !== null) {
          evalComment = isEn
            ? `${baseWaitComment} First token took ${ttftFormatted}${ratioSuffix ? ` (${ratioSuffix})` : ''}; streaming window too short (${streamingSec.toFixed(2)}s across ${outputTokens} tokens), short-window speed omitted.`
            : (isTw ? `${baseWaitComment} 首字苦等 ${ttftFormatted}${ratioSuffix ? `（${ratioSuffix}）` : ''}. 流式持續時間過短（僅 ${streamingSec.toFixed(2)}s，共輸出 ${outputTokens} tokens），不作高速評級.` : `${baseWaitComment} 首字苦等 ${ttftFormatted}${ratioSuffix ? `（${ratioSuffix}）` : ''}. 流式持续时间过短（仅 ${streamingSec.toFixed(2)}s，共输出 ${outputTokens} tokens），不作高速评级.`);
          subLabel = isEn
            ? `TTFT ${ttftFormatted} · Short stream (${streamingSec.toFixed(2)}s)`
            : (isTw ? `首字 ${ttftFormatted} · 短時窗樣本 (${streamingSec.toFixed(2)}s)` : `首字 ${ttftFormatted} · 短窗口样本 (${streamingSec.toFixed(2)}s)`);
        } else {
          evalComment = isEn
            ? `${baseWaitComment} First token took ${ttftFormatted}${ratioSuffix ? ` (${ratioSuffix})` : ''}; streaming throughput unavailable.`
            : (isTw ? `${baseWaitComment} 首字苦等 ${ttftFormatted}${ratioSuffix ? `（${ratioSuffix}）` : ''}. 暫無有效後續流速資料.` : `${baseWaitComment} 首字苦等 ${ttftFormatted}${ratioSuffix ? `（${ratioSuffix}）` : ''}. 暂无有效后续流速数据.`);
          subLabel = isEn
            ? `TTFT ${ttftFormatted} · Rate unavailable`
            : (isTw ? `首字 ${ttftFormatted} · 暫無有效流速` : `首字 ${ttftFormatted} · 暂无有效流速`);
        }
      } else if (streamSpeed >= 30) {
        const fastPhrase = streamSpeed >= 80
          ? (isEn ? 'Fast Stream' : (isTw ? '後續極快' : '后续极快'))
          : (isEn ? 'Steady Stream' : (isTw ? '後續流暢' : '后续流畅'));
        evalTitle = `${ttftTier.title} · ${fastPhrase}`;
        evalComment = isEn
          ? `${baseWaitComment} Though streaming reached ${streamSpeed} tok/s, waiting ${ttftFormatted} took ${ttftRatioPct != null ? ttftRatioPct + '%' : 'most'} of total time.`
          : (isTw ? `${baseWaitComment} 雖然開始吐字後速率達 ${streamSpeed} tok/s. 但首字苦等 ${ttftFormatted}${ratioSuffix ? ` ${ratioSuffix}` : ''}.` : `${baseWaitComment} 虽然开始吐字后速率达 ${streamSpeed} tok/s. 但首字苦等 ${ttftFormatted}${ratioSuffix ? ` ${ratioSuffix}` : ''}.`);
        subLabel = (isEn ? `TTFT ${ttftFormatted} · Stream ${streamSpeed} tok/s` : `首字 ${ttftFormatted} · 流式 ${streamSpeed} tok/s`) + stableSuffix;
      } else {
        const worseTitle = streamSpeed < 1 && speedTier ? speedTier.title : `${ttftTier.title} · ${isEn ? 'Slow Stream' : (isTw ? '後續也慢' : '后续也慢')}`;
        evalTitle = worseTitle;
        evalComment = isEn
          ? `${baseWaitComment} Subsequent streaming also crawled at ${streamSpeed} tok/s.`
          : (isTw ? `${baseWaitComment} 開始吐字後速率也僅有 ${streamSpeed} tok/s.` : `${baseWaitComment} 开始吐字后速率也仅有 ${streamSpeed} tok/s.`);
        subLabel = (isEn ? `TTFT ${ttftFormatted} · Stream ${streamSpeed} tok/s` : `首字 ${ttftFormatted} · 流式 ${streamSpeed} tok/s`) + stableSuffix;
      }
    } else if (isSampleSparse || hasMissingSpeed) {
      // 规则 3：样本/数据不足兜底（严格区分“仅输出字少”与“流式持续时间过短”）
      evalColor = '#9CA3AF';
      evalSeverity = 'neutral';
      evalGlyph = '⏳';
      evalTitle = isShortStreamOnly
        ? (isEn ? 'Short Stream Sample' : (isTw ? '流式時長過短' : '流式时长过短'))
        : (isEn ? 'Insufficient Sample' : (isTw ? '樣本過少' : '样本过少'));
      if (hasMissingSpeed) {
        evalComment = isEn
          ? `TTFT was ${ttftFormatted}; missing effective streaming window or token count to compute throughput.`
          : (isTw ? `本次首字耗時 ${ttftFormatted}. 缺少有效流式階段耗時或輸出量. 暫不計算流式速率.` : `本次首字耗时 ${ttftFormatted}. 缺少有效流式阶段耗时或输出量. 暂不计算流式速率.`);
      } else if (isShortStreamOnly) {
        evalComment = isEn
          ? `Streaming duration too short (${streamingSec.toFixed(2)}s across ${outputTokens} tokens); short-window speed is omitted from main display.`
          : (isTw ? `流式持續時間過短（僅 ${streamingSec.toFixed(2)}s，共輸出 ${outputTokens} tokens），短視窗速率易偏高，不作為主指標展示.` : `流式持续时间过短（仅 ${streamingSec.toFixed(2)}s，共输出 ${outputTokens} tokens），短窗口速率易偏高，不作为主指标展示.`);
      } else if (lowStreamTokens && !shortStreamTime) {
        evalComment = isEn
          ? `Too few output tokens (only ${outputTokens} tokens); speed metric is not representative.`
          : (isTw ? `字太少測不準. 本次僅輸出 ${outputTokens} tokens. 速率指標不具備參考價值.` : `字太少测不出. 本次仅输出 ${outputTokens} tokens. 速率指标不具备参考价值.`);
      } else {
        evalComment = isEn
          ? `Insufficient sample (only ${outputTokens} tokens & short ${streamingSec.toFixed(2)}s window); speed metric is not representative.`
          : (isTw ? `樣本過少測不準. 本次僅輸出 ${outputTokens} tokens 且流式耗時極短 (${streamingSec.toFixed(2)}s). 速率指標不具備參考價值.` : `样本不足测不出. 本次仅输出 ${outputTokens} tokens 且流式耗时极短 (${streamingSec.toFixed(2)}s). 速率指标不具备参考价值.`);
      }
      subLabel = ttftSec !== null
        ? (isEn ? `TTFT ${ttftFormatted} · Stability skipped` : (isTw ? `首字 ${ttftFormatted} · 略過穩定性評估` : `首字 ${ttftFormatted} · 跳过稳定性评估`))
        : (isEn ? 'Stability skipped' : (isTw ? '略過穩定性評估' : '跳过稳定性评估'));
    } else {
      // 规则 4：常规组合（TTFT <= 30s 且样本充足）
      evalColor = speedTier.color;
      evalSeverity = speedTier.severity;
      evalGlyph = speedTier.glyph;
      evalTitle = speedTier.title;
      const ttftExtra = (ttftSec !== null && ttftSec >= 10)
        ? (isEn ? ` (First token waited ${ttftFormatted}.)` : (isTw ? ` (首字等待了 ${ttftFormatted}.)` : ` (首字等待了 ${ttftFormatted}.)`))
        : '';
      evalComment = `${speedTier.comment}${ttftExtra}`;
      const ttftPart = ttftSec !== null ? `${isEn ? 'TTFT' : '首字'} ${ttftFormatted} · ` : '';
      subLabel = `${ttftPart}${isEn ? 'Stream' : '流式'} ${streamSpeed} tok/s${stableSuffix}`;
    }

    // 阶段 3 完成态主徽章：若 E 有效显示 E 分与等级；样本过少或缺失时显式兜底；流式进行中显示实时流速主档位
    let mainBadgeText = evalTitle;
    let mainBadgeColor = evalColor;
    let mainBadgeSeverity = evalSeverity;
    let mainBadgeGlyph = evalGlyph;
    let finalHeadline = evalTitle;
    let finalComment = evalComment;

    if (phase === 'final') {
      if (efficiency.available && efficiency.tier) {
        mainBadgeText = `${efficiency.score} ${isEn ? 'pts' : '分'} · ${efficiency.grade}`;
        mainBadgeColor = efficiency.tier.color;
        mainBadgeSeverity = efficiency.tier.severity;
        mainBadgeGlyph = efficiency.tier.glyph;
        finalHeadline = `${efficiency.score} ${isEn ? 'pts' : '分'} · ${efficiency.tier.title}`;
        finalComment = isLongTtft ? evalComment : efficiency.tier.comment;
      } else if (efficiency.skippedReason === 'insufficient_sample') {
        mainBadgeText = isShortStreamOnly
          ? (isEn ? 'Short Stream · No Score' : (isTw ? '時長過短 · 略過評分' : '流式过短 · 跳过综合评分'))
          : (isEn ? 'Sparse · No Score' : (isTw ? '樣本過少 · 略過評分' : '样本过少 · 跳过综合评分'));
        mainBadgeColor = isLongTtft ? evalColor : '#9CA3AF';
        mainBadgeSeverity = isLongTtft ? evalSeverity : 'neutral';
        mainBadgeGlyph = isLongTtft ? evalGlyph : '⏳';
        finalHeadline = mainBadgeText;
      } else {
        mainBadgeText = evalTitle;
      }
    }

    return {
      phase,
      scoreRuleVersion: ELV91_SCORE_RULE_VERSION,
      badge: {
        text: mainBadgeText,
        color: mainBadgeColor,
        severity: mainBadgeSeverity,
        glyph: mainBadgeGlyph
      },
      shortTitle: finalHeadline,
      speedShortTitle: evalTitle,
      speedColor: evalColor,
      comment: finalComment,
      speedComment: evalComment,
      subLabel,
      elapsedFormatted,
      ttftFormatted,
      durationFormatted,
      ttftRatioPct,
      streamSpeed,
      overallTps,
      outputTokens,
      isSampleSparse,
      lowStreamTokens,
      shortStreamTime,
      isReliableSpeed,
      shortWindowEstimateSpeed,
      ttftTier,
      speedTier,
      durationTier,
      stability,
      efficiency
    };
  }

  const api = {
    summarize,
    classifyRequestError,
    resolveModelQuota,
    getModelPoolKey,
    getSharedQuotaGroupKey,
    parseQuotaFraction,
    parseStrictResetTimestamp,
    formatQuotaPercentText,
    formatQuotaResetMeta,
    classifyModelQuotaAvailability,
    isDecorativeBadgeTagTitle,
    selectPrimaryQuotaBucket,
    buildModelQuotaSnapshot,
    splitModelDisplayAndEffort,
    resolvePlaceholderModelInfo,
    formatApproxTokensShort,
    inferQuotaWindowDurationMs,
    QUOTA_CAL_TTL_MS,
    computeBucketTokenEstimate,
    applyQuotaTokenEstimates,
    formatResetTimeZh,
    measure,
    add,
    empty,
    analyzeSteps,
    parseDurationSec,
    GEMINI_PRICING_TABLE,
    SUBSCRIPTION_ACQUISITION_PRESETS,
    SUBSCRIPTION_REGIONS_PRESET,
    findRegionPreset,
    convertToCNY,
    convertCurrency,
    CURRENCY_SYMBOLS,
    normalizeModelId,
    resolveStableModelId,
    UNATTRIBUTED_MODEL_KEY,
    lookupModelDisplayLabel,
    resolveModelUsageBucket,
    getModelChartColor,
    summarizeModelUsageWindow,
    normalizeCallInputCacheTokens,
    computeCacheReadStats,
    summarizeCacheReadStats,
    summarizeDailyMapCacheStats,
    normalizeSessionCallRecord,
    sanitizeTurnPreviewText,
    groupSessionCallsByTurns,
    ELV91_SCORE_RULE_VERSION,
    formatHumanDuration,
    classifyStreamSpeedTier,
    classifyTtftTier,
    classifyDurationTier,
    classifyEfficiencyGrade,
    computeStreamStability,
    calculateExperienceScore,
    evaluateGenerationExperience,
    EFFORT_WHITELIST,
    formatEffortLabel,
    detectModelVendor,
    groupModelProduct,
    formatTokensK,
    isValidSpeedSample,
    computeMedian,
    summarizeSpeedByModel,
    MAX_SPEED_SAMPLES_PER_MODEL,
    calculateRequestApiCost,
    summarizeApiCost,
    calculateReferenceModelCost,
    resolveEffectivePlanStatus,
    parseUserPlanStatus,
    extractCallId,
    parseGeneratorCall,
    extractModelString,
    normalizeTokenHistoryPayload,
    getLvlForRange,
    computeMixedScaleResponse,
    computePiecewiseAnchorScale,
    computeColorScaleResponse,
    resolveScaleEnvelope,
    mapBubbleDiameter,
    mapBarHeightPx,
    allocateStackedSegmentHeights,
    interpolateHslHex,
    interpolateScaleColorHsl,
    shouldShowYearlyPeakBadge,
    computeLogRulerPosition,
    computeCumulativeStripSummary,
    getDailyModelCost,
    calculateIntervalCost,
    clearDailyCostCache,
    parseSemver,
    compareVersions,
    filterReleases,
    findReleaseAsset,
    isValidExternalUrl
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__AGContextMeterCore = api;
})(globalThis);
