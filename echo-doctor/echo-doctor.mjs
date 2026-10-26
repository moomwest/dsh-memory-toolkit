#!/usr/bin/env node
// echo-doctor.mjs —— 回声系统体检（回声 Echo · 自检器）v2
// ============================================================================
// 使用者 2026-10-08 04:22 要求：把回声做成独立面板，实时检测运行状态。
// 使用者 2026-10-08 04:42 追加：体检太慢，要仪表盘 + 四级轮询
//   （1级 5 分钟 / 2级 10 分钟 / 3级 30 分钟 / 4级 手动，默认 3 级）。
//
// ★★★ v2 的关键改动：**拆成快层与深层层**。
//   起因：十项检查里九项是毫秒级的（读文件时间、meta.json、数《墨》行数），
//   只有两项要解那份 74MB 的多帧日志（门牌实测 / 压缩统计）—— 而 v1 把那份日志**解了两遍**，
//   于是 17 秒里有 16 秒花在重复解码上。这不是「体检慢」，这是「我算重了」。
//   · fast（毫秒级）：不解日志。面板的秒级刷新靠它。
//   · deep（约 5-8 秒）：真要解日志。靠 decodeCached 只解一次、两项共用。
//
// ★ 两条纪律（今晚的教训，一条都不许省）：
//   ① **门牌那一项必须真去取一次**，不看配置 —— 今晚的故障就是「配置看着对、实际取不出来」，
//      只读配置的体检会全部报绿，那种绿比红更坏。
//   ② **判据不许被注释骗** —— 版本漂移第一次跑报了 5 处，全是我当天写的修复注释。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import * as CFG from "./echo-config.mjs";

const HUB = CFG.HUB;
const SOUL = CFG.SOUL;
const MEM = CFG.MEM;
const SESSIONS = CFG.SESSIONS;
// ★★ 2026-10-18 真机实测踩到：没配 ECHO_SOUL / ECHO_MEMORY 时 CFG.HUB 是 null，
//    而这几行在**模块加载阶段**就 path.join(null, ...) —— 直接 TypeError，
//    doctor 连一行 JSON 都吐不出来。面板只看到空输出，只能说「输出不是 JSON」。
//    ★ 而体检器的职责恰恰是「告诉人哪里没配好」—— 它必须先能开口。
//    所以：没有根目录就留 null，由下面的各项检查各自报「没配」，绝不在这里炸。
const safeJoin = (base, ...rest) => (base ? path.join(base, ...rest) : null);
const IDX = safeJoin(HUB, "index");
const MO = safeJoin(SOUL, "02-墨.jsonl");
const SELF_MD = safeJoin(HUB, "SELF.md");
const HEARTBEAT_DIR = safeJoin(HUB, "heartbeat");
const RUNTIME = CFG.RUNTIME;

const MARK = "⛬ 压缩索引（非原文）";
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
// ★ 版本无感：认 session.v<N>.jsonl.zstd，不认死 v3（2026-10-08 的故障根因）。
const LOG_RE = /^session\.v(\d+)\.jsonl\.zstd$/;

// ──────────────────────────── 工具 ────────────────────────────

const readText = (p) => { try { return fs.readFileSync(p, "utf8") } catch { return null } };
const statSafe = (p) => { try { return fs.statSync(p) } catch { return null } };
// ★ 2026-10-25 补正用：读文本，读不到返回 null（不猜、不抛）。
//   给「源码树 vs installed 到底同步没有」做**内容比对**用 —— mtime 只证明"被碰过"，
//   不证明"内容不同"（见 memoryPatchMtime 里的假黄记录）。
const readTextSafe = (p) => { try { return fs.readFileSync(p, "utf8") } catch { return null } };
// ★ 2026-10-09 修：原来这里是 `new Date(d).toISOString()` —— 而 **toISOString 永远输出 UTC**，
//   于是本地 10-08 04:36 被显示成 10-07 20:36，**整整差 8 小时**。
//   ★ 症状为什么难缠：`hoursSince()` 用的是 Date 差值，所以「距今 34.7 小时」是对的 ——
//     **只有绝对时刻错**。于是一个人看着「34.7 小时前」觉得没毛病，
//     却对着「最后一次 10-07 20:36」去日志里找，永远找不到那一行（日志里写的是 10-08 4:36）。
//   ★ 这是「一半对一半错」的典型：它比整段全错更容易骗过人。
const iso = (d) => {
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return "(无效时间)";
  const p = (n) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} `
       + `${p(x.getHours())}:${p(x.getMinutes())}:${p(x.getSeconds())}`;
};
const hoursSince = (t) => (Date.now() - Number(t)) / 3600000;
const round1 = (n) => Math.round(n * 10) / 10;

/** 多帧 zstd → 事件数组。半行/坏行跳过，不因一行坏掉整份日志。 */
function decodeZstd(file) {
  let buf;
  try { buf = fs.readFileSync(file) } catch { return { events: [], frames: 0, failed: 0 } }
  const frames = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i >= 0) {
    const n = buf.indexOf(MAGIC, i + 4);
    frames.push(buf.subarray(i, n === -1 ? buf.length : n));
    i = n;
  }
  // ★★★ 2026-10-18 修：解压总量封顶，且从**尾部**往前解。
  //   起因：本会话自己的日志 session-1099f531 已达 155 MB（zstd），解压后 1 GB 以上，
  //   `Buffer.concat(chunks).toString("utf8")` 直接抛
  //   `Cannot create a string longer than 0x1fffffe8 characters`（约 512 MB 上限），
  //   于是深检整轮崩掉 → 面板永远停在「待深度检测…」。体检器被被体检的对象撑爆了。
  //   为什么从尾部解不损失语义：门牌实测要「最后一次 compaction/summary」、
  //   压缩统计要最近的 compaction/*、换气要最近的 turn/end —— 全都在日志末端。
  const MAX_TOTAL = 192 * 1024 * 1024;   // 解压后总字节上限
  const chunks = [];
  let failed = 0;
  let total = 0;
  for (let k = frames.length - 1; k >= 0; k--) {
    let b;
    try { b = zlib.zstdDecompressSync(frames[k]) } catch { failed++; continue }
    if (total + b.length > MAX_TOTAL) {
      if (chunks.length === 0) {
        // 单帧就超限：只取尾部，前面的半行会被 JSON.parse 的 try 吃掉
        chunks.unshift(b.subarray(b.length - MAX_TOTAL));
        total = MAX_TOTAL;
      }
      break;
    }
    chunks.unshift(b);
    total += b.length;
    if (total >= MAX_TOTAL) break;
  }
  const events = [];
  for (const line of Buffer.concat(chunks).toString("utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)) } catch { /* 半行 */ }
  }
  // ★★★ 2026-10-08 手滑回归：这里原本写成 `{ events, frames, failed }` ——
  //   把**帧数组本身**（几百个大 Buffer）当成"帧数"返回了出去。
  //   后果不是报错，而是 deep 模式的 JSON 被撑到 **2.8 亿字符**，
  //   `JSON.stringify` 抛 `RangeError: Invalid string length`，
  //   于是"深检永远拿不到报告、面板永远显示待深检"。
  //   而 fast 模式不用这个字段 ⇒ 症状只在深检出现，极难一眼看穿。
  //   ★ 教训：重写文件时的"手滑回归"，比新写的 bug 更难找 —— 因为旧版是对的。
  return { events, frames: frames.length, failed };
}

/**
 * ★★ v2 的缓存 —— 「体检从 17 秒降到 5 秒」的全部秘密。
 * 门牌实测与压缩统计要的是**同一份**日志；v1 各解一遍 = 白花一倍时间。
 * 键带 size+mtime：日志一被追加就自动失效，不会拿旧数据糊弄。
 */
const _decCache = new Map();
function decodeCached(file) {
  const st = statSafe(file);
  const key = `${file}|${st ? st.size : 0}|${st ? st.mtimeMs : 0}`;
  const hit = _decCache.get(key);
  if (hit) return hit;
  const r = decodeZstd(file);
  _decCache.clear();               // 只留最新一份，别把内存吃光
  _decCache.set(key, r);
  return r;
}

/** 列出所有会话日志（版本无感），按 mtime 降序。 */
function listLogs() {
  const out = [];
  let buckets = [];
  try { buckets = fs.readdirSync(SESSIONS) } catch { return out }
  for (const b of buckets) {
    const bp = path.join(SESSIONS, b);
    if (!statSafe(bp)?.isDirectory()) continue;
    let sids = [];
    try { sids = fs.readdirSync(bp) } catch { continue }
    for (const sid of sids) {
      const sd = path.join(bp, sid);
      if (!statSafe(sd)?.isDirectory()) continue;
      let names = [];
      try { names = fs.readdirSync(sd) } catch { continue }
      for (const n of names) {
        const m = LOG_RE.exec(n);
        if (!m) continue;
        const st = statSafe(path.join(sd, n));
        if (!st?.isFile()) continue;
        out.push({ bucket: b, sid, name: n, ver: Number(m[1]), file: path.join(sd, n), bytes: st.size, mtime: st.mtimeMs });
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// ──────────────────── 快层：不解日志，毫秒级 ────────────────────

/**
 * ★★★ 移植自作者 2026-10-23 修 C3 的下半截：**报错报了，但下一步给错了；而且这句话有两份。**
 *   上一轮已经把「MEM 传深一层」从静默降级改成明确报错（见 echo-config.mjs），
 *   可这里原来无论什么配置问题，结尾都写「先跑一次 agent_soul_scaffold」。
 *   于是用户在 `--memory .../memory/hub` 撞墙时，会照着这句话去重跑 scaffold ——
 *   而 scaffold 修不了「参数传错一层」，他修的是一个不存在的问题（实机报告 C3 的同一形状）。
 *   ★ 更要紧的是：**同一句话原来在 checkConfigState() 和 runDoctor() 的提前返回里各写一份**
 *     —— 改了一处、另一处还是旧的（本次实测就抓到了）。这正是这批 bug 的统一形状。
 *     所以收成一个函数：**下一步建议只有一份来源**。
 *   ★ 判据：配置问题的下一步分两类 ——
 *     ① 目录/文件真的没有 → scaffold 有用；② 参数形状不对 → 只能改参数，不能重跑。
 */
function configAdvice(problems) {
  const shape = problems.filter((p) => p.includes("传深了一层") || p.includes("下面没有 hub/"));
  return {
    pathShapeWrong: shape.length > 0,
    text: shape.length
      ? " —— 这不是「没装」，是**路径参数给错了**：按下面的提示改 --soul/--memory 或 echo.config.json，重跑 scaffold 不会修好它"
      : " —— 先跑一次 agent_soul_scaffold，它会把目录建出来",
  };
}

/** ★ 配置本身有没有到位 —— 这一项必须排在最前面。
 *  因为「装完了但还没配」是每个新人的第一步，那时候其余各项全是「读不到」，
 *  光看那些看不出根因。这一项直接说：先去跑 scaffold。 */
function checkConfigState() {
  const r = CFG.checkConfig({ allowMissingSessions: true })
  if (r.ok) {
    return {
      id: "config", label: "配置（三个根）", status: "ok",
      detail: `书房 ${CFG.SOUL} ｜ 中枢 ${CFG.MEM} ｜ 日志 ${CFG.SESSIONS || "（还没推出来）"}`,
      evidence: CFG.describe(),
    }
  }
  const advice = configAdvice(r.problems);
  return {
    id: "config", label: "配置（三个根）", status: "error",
    detail: "还没配好：" + r.problems.join("；") + advice.text,
    evidence: { problems: r.problems, hints: r.hints, pathShapeWrong: advice.pathShapeWrong },
  }
}

function checkLogs(logs) {
  if (logs.length === 0) {
    // ★ 「一个日志都没有」要分清楚，别混成一种（2026-10-18 修了三版才收敛）。
    //
    //   ★ 关键词：会话日志是 **DSH 自己产生的**，不是我们建的。
    //     ECHO_SESSIONS 只是指向它。所以「目录不在」多半是「DSH 还没跑过」，
    //     那是**正常的新装状态**，不是故障。
    //
    //   ① 根本没配 SESSIONS        → **error**。门没了，这才是真故障。
    //   ② 配了、目录不在 / 空着    → **warn**。还没开始用，第一次对话之后就有了。
    //
    //   ★ 原来一律报 error。后果：新用户装完跑第一次体检就看见一片红，
    //     而那红色全是「你还没开始用」。**体检器是保险，不该对「还没开始」拉警报** ——
    //     第一次就红，人只会学会忽略它，那这层保险就废了。
    if (!CFG.SESSIONS) {
      return {
        id: "logs", label: "会话日志", status: "error",
        detail: "没找到会话日志目录，也没配置 ECHO_SESSIONS —— 这一层没有门",
        evidence: { root: null },
      };
    }
    const dir = SESSIONS.replace(/\//g, path.sep);
    const dirExists = fs.existsSync(dir);
    return {
      id: "logs", label: "会话日志", status: "warn",
      detail: dirExists
        ? "目录在，但还没有日志 —— 你还没开始用。第一次对话之后这里就会有东西"
        : "目录还不存在 —— DSH 还没产生会话日志，或者路径填错了。第一次对话之后再看",
      evidence: { root: SESSIONS, dirExists },
    };
  }
  const newest = logs[0];
  const age = hoursSince(newest.mtime);
  const vers = {};
  for (const l of logs) vers[l.ver] = (vers[l.ver] || 0) + 1;
  const versStr = Object.keys(vers).sort((a, b) => a - b).map((v) => `v${v}×${vers[v]}`).join(" / ");
  const bySid = {};
  for (const l of logs) (bySid[l.sid] ||= []).push(l.ver);
  const multi = Object.entries(bySid).filter(([, v]) => new Set(v).size > 1);
  const status = age > 24 ? "warn" : "ok";
  return {
    id: "logs", label: "会话日志", status,
    detail: `${logs.length} 份日志，版本 ${versStr}；最新一份 ${round1(age)} 小时前`,
    evidence: {
      total: logs.length, versions: vers,
      newest: { sid: newest.sid, file: newest.name, bytes: newest.bytes, ageHours: round1(age) },
      multiVersionSessions: multi.length,
      note: multi.length ? `${multi.length} 个会话同时有多版本日志（宿主行为；读取端必须版本无感）` : null,
    },
  };
}

/**
 * ★ L0 时钟 —— 移植自作者 2026-10-23 版本（与 kit/echo/self.mjs 写 lastSelfAt/selfRuns 是一对）。
 *
 * 为什么要有这一项：`state.json` 曾停更一个月，而原来的体检里**没有任何一项会报**
 * —— 一个「没人写」的状态文件看起来和「一切正常」一模一样。
 * 现在 `self.mjs` 每次装配写 `lastSelfAt` + `selfRuns` 递增，这一项读它：
 * **超过 26 小时没更新 = self.mjs 没在跑**。
 *
 * ★ 顺带纠正一个读法：`lastTurnAt` 的语义是「最后一条手写状态」，
 * **不是时钟**。它停在很久以前只能说明「很久没手写状态」，不能说明「系统停了」。
 */
function checkClock() {
  const STATE = path.join(HUB, "state.json");
  const raw = readText(STATE);
  if (!raw) return { id: "clock", label: "L0 时钟（state.json）", status: "warn", detail: "state.json 不存在 —— self.mjs 装配时会写它", evidence: {} };
  let st;
  try { st = JSON.parse(raw) } catch { return { id: "clock", label: "L0 时钟（state.json）", status: "error", detail: "state.json 解析失败", evidence: {} } }

  const selfAt = st.lastSelfAt ? new Date(String(st.lastSelfAt).replace(" ", "T")) : null;
  const selfAgeH = selfAt && !Number.isNaN(selfAt.getTime()) ? (Date.now() - selfAt.getTime()) / 3600000 : null;
  const noteAt = st.lastTurnAt ? new Date(st.lastTurnAt) : null;
  const noteAgeH = noteAt && !Number.isNaN(noteAt.getTime()) ? (Date.now() - noteAt.getTime()) / 3600000 : null;

  let status = "ok";
  const notes = [];
  if (selfAgeH === null) {
    // ★★★ 作者 2026-10-23 修实机报告 R1 的观测面那一半：**「字段缺失」和「字段过期」要分开说。**
    //   这两种状态的下一步完全不同：
    //     · 缺字段  = 装配器这一层**还没启用 / 还没跑过**（新装、或推插件没装上）
    //     · 有过期  = 它**跑过，但停了**（这才是真异常）
    //   原来两句话都说「self.mjs 还没在修好的版本上跑过」，把「没启用」说成了「版本不对」，
    //   于是新用户会去查一段根本不存在的历史。★ 状态仍是 warn：没时钟确实要看一眼。
    status = "warn";
    notes.push("state.json 里没有 lastSelfAt —— 装配器（self.mjs）还没在这一层跑过：要么推送层没装，要么装上之后一次都没装配");
    notes.push("  （字段存在但很久没更新 = 真停更；字段整个没有 = 未启用。两者不是一个病）");
  } else if (selfAgeH > 26) {
    status = "warn";
    notes.push(`lastSelfAt 已 ${round1(selfAgeH)} 小时没更新 —— self.mjs 可能没在跑`);
  } else {
    notes.push(`self.mjs 最近一次装配 ${round1(selfAgeH)} 小时前`);
  }
  if (noteAgeH !== null) {
    const d = Math.round(noteAgeH / 24);
    notes.push(`最后一条手写状态 ${d} 天前（★ 这不是时钟，别当钟读）`);
  }

  return {
    id: "clock", label: "L0 时钟（state.json）", status,
    detail: notes.join("；"),
    evidence: {
      lastSelfAt: st.lastSelfAt || null, selfRuns: st.selfRuns || 0,
      lastTurnAt: st.lastTurnAt || null, lastNoteAt: st.lastNoteAt || null,
      selfAgeHours: selfAgeH === null ? null : round1(selfAgeH),
    },
  };
}

/** ★ 深度项：门牌实测。deep=false 时返回 info，由调用方补上次深检结果。 */
function checkDoorSign(logs, deep) {
  const measurable = logs.filter((l) => l.bytes > 0);
  if (measurable.length === 0) return { id: "doorsign", label: "门牌回取（实测）", status: "warn", detail: "没有可测的日志", evidence: {}, deep: true };
  if (!deep) return { id: "doorsign", label: "门牌回取（实测）", status: "info", detail: "待深度检测…", evidence: { skipped: true }, deep: true };

  // ★★ 2026-10-25 修（单份样本冒充全库 ⇒ 假黄）：原来是
  //      `const target = logs.find((l) => l.bytes > 0)` —— 只测第一份非空日志，
  //      然后拿那份日志的「最后一次压缩」当**全库最近一次压缩**汇报。
  //      实测事故（10-25 15:19）：选中的那份最近一次压缩是 10-19、无门牌，
  //      而全库有 4 次带门牌 ⇒ 报「机制可能坏了」，把人指向一个不存在的故障。
  //      ★ 与 checkCompaction（10-24 修）同款病的第四张脸。修法：**全库逐帧**，
  //        「最近一次」从全库里挑；everTagged 也从全库算（机制在**任何**日志里
  //        证明过能工作，就算证明过 —— 原来只认"这一份里有过"，同样偏窄）。
  const all = scanAllSummaries(measurable);
  if (all.length === 0) {
    return { id: "doorsign", label: "门牌回取（实测）", status: "warn", detail: `全库 ${measurable.length} 份日志里还没有压缩摘要，无可测门牌`, evidence: { scannedLogs: measurable.length, summaries: 0 }, deep: true };
  }
  const last = pickLatestSummary(all);
  const everTagged = all.some((s) => s.hasTag);
  const target = measurable.find((l) => l.file === last.file) || { file: last.file, sid: last.sid };

  // 完整 data 只全解最近一次所在的那一份（四要素判定要用 shadowedRange / summary blocks）。
  const { events, frames, failed } = decodeCached(target.file);
  if (events.length === 0) {
    return { id: "doorsign", label: "门牌回取（实测）", status: "error", detail: "全库最近一次压缩所在的那份日志解不出任何事件", evidence: { file: target.file, frames, failed }, deep: true };
  }
  const summary = events.find((e) => e.type === "compaction/summary" && e.seq === last.seq);
  if (!summary) {
    // 全库扫到了、全解却找不到同 seq 的那条 ⇒ 两套读法不一致。**不猜**，按失败报。
    return { id: "doorsign", label: "门牌回取（实测）", status: "warn", detail: `全库扫到 seq=${last.seq} 的摘要，但全解该文件时找不到同 seq 的那条 —— 两套读法不一致，不猜`, evidence: { file: target.file, wantSeq: last.seq, events: events.length }, deep: true };
  }
  const lastEvent = summary;
  const raw = JSON.stringify(lastEvent.data || {});
  const m = /#seq=(\d+)/.exec(raw);
  if (!m) {
    // ★★★ 2026-10-23 修：这里原来是**一律 error**，于是把「接管后还没压缩过」
    //   报成「门牌机制坏了」—— 那是最坏的一种误报：
    //   它指向一个并不存在的故障，逼人去修一个好着的机制。
    //   ★ 而 doctor 自己的规矩是「还没建、还没跑、还没装，都不是故障」
    //     （见本文件 checkMo / checkHeartbeat 里的同一条判据）—— 这里漏守了。
    //
    //   实测现场（2026-10-23 全库扫描 104 份日志）：
    //     共 9 条 compaction/summary，**9 条全部无门牌**，且全部早于 2026-10-23 的接管 ——
    //     它们是**旧的内置压缩器**写的，那个压缩器本来就不写门牌。
    //     接管之后至今 **0 次压缩** ⇒ 门牌一次都没在真实环境验过。
    //
    //   ★ 所以判据分两种，且**随证据自动收紧**（这才是体检器该有的样子）：
    //     A. 这份日志里**从没有过**带门牌的摘要 ⇒ 无法断定机制坏了，
    //        更可能是「新压缩还没发生过」⇒ **warn**（不确定，交给人看），
    //        并在 detail 里给出验证办法。
    //     B. 这份日志里**曾经有过**带门牌的摘要 ⇒ 机制在本日志里证明过能工作，
    //        那么最新这条没有门牌就是**真故障** ⇒ **error**（判据收紧）。
    //
    //   ★★ 反过来的一条纪律：绝不能因为「想让它变绿」就把它改成恒定 warn。
    //      一旦本日志出现过带门牌的摘要，这里立刻恢复 error —— 绿是证据给的，不是改出来的。
    //
    //   ★★★ 2026-10-24 取作者的修法（**与我们的 everTagged 自动收紧设计有分歧，见下**）：
    //     作者把「结构合格但没有精确 seq」单独判为**降级式门牌 → ok**：
    //     拿不到范围时压缩器只写会话号级指针（log:session-xxx，不带 #seq=），
    //     那是**设计内的行为**，不是故障，但要说清它没有精确坐标。
    //     ★ 分歧点：我们原本的设计是「everTagged=true 即收紧为 error」。
    //       这里按任务书要求取作者 2026-10-24 修法 —— 降级式（有会话号指针、无精确 seq）
    //       在 everTagged=false 时算 **ok 带说明**；everTagged=true（本日志证明过能写出
    //       带 seq 的门牌）时**维持 error**。
    //     ★ 若假绿反弹（明明回取链断了却报绿），把这里改回 error —— 绿必须是证据给的。
    const blocksNow = Array.isArray(lastEvent.data?.summary) ? lastEvent.data.summary : [];
    const headNow = firstTextBlock(blocksNow).trim();
    // 降级式的长相：有会话号级指针（log:session-…）或门牌标记，但**没有 #seq=
    const degraded = /^>?\s*(⛬|log:session-[0-9a-f-]+)/i.test(headNow)
      && !/#seq=\d+/.test(headNow)
      && headNow.length > 0 && headNow.length < 500;
    if (degraded && !everTagged) {
      return {
        id: "doorsign", label: "门牌回取（实测）", status: "ok",
        detail: `有门牌（${blocksNow.length} 块结构正确），但这一条没带精确 seq —— 压缩时拿不到范围，退化成会话号级指针（★ 作者 2026-10-24 修法：降级式不算故障；此处取该修法，与我们的 everTagged 自动收紧设计有分歧，若假绿反弹改回 error）`,
        evidence: {
          summarySeq: lastEvent.seq, time: iso(lastEvent.time), blocks: blocksNow.length, everTagged, degraded: true,
          headPreview: headNow.replace(/\s+/g, " ").slice(0, 160),
        }, deep: true,
      };
    }
    return {
      id: "doorsign", label: "门牌回取（实测）",
      // 走到这儿的 degraded 必是 everTagged=true ⇒ 维持 error（作者修法与我们的收紧设计在此汇合）
      status: everTagged ? "error" : "warn",
      detail: everTagged
        ? `全库最近一次压缩（${iso(lastEvent.time)}，会话 ${lastEvent.sid} seq=${lastEvent.seq}）的摘要里没有门牌，而全库 ${all.length} 次压缩里有过带门牌的 —— 机制证明过能工作，这次是真故障`
        : `全库最近一次压缩（${iso(lastEvent.time)}，会话 ${lastEvent.sid} seq=${lastEvent.seq}）的摘要里没有门牌；全库 ${all.length} 次压缩里也从没有过带门牌的 —— 尚不能断定机制坏了：多半是接管后还没发生过压缩（门牌一次都没验过）。★ 验证：①等一次真实压缩后复查 ②离线跑 plugins/compaction/test/doorsign.mjs`,
      evidence: {
        summarySeq: lastEvent.seq, time: iso(lastEvent.time), hasMark: raw.includes(MARK),
        scannedLogs: measurable.length, summaryCount: all.length, everTagged, degraded,
        note: everTagged ? null : "没有门牌基线样本 ⇒ 判据暂降为 warn；一旦出现过带门牌的摘要即自动收紧为 error",
      }, deep: true,
    };
  }
  const want = Number(m[1]);
  const hit = events.find((e) => e.seq === want);
  const sr = lastEvent.data?.shadowedRange;
  // ★★ 移植自作者 2026-10-23（C2 的收尾）：**「没有可核对的东西」不等于「核对不上」。**
  //   原判据 `srMatch = sr && ...` 在 sr 为空时得到 false，于是走 warn「但与 shadowedRange 不符」
  //   —— 摘要根本没带 shadowedRange 也叫「不符」，是一条永远响的警报（C2 的假阳性换个位置）。
  //   现在分三档：没有 → 无法交叉核对（不算错）；有且一致 → 一致；有但不一致 → 不符。
  const srState = !sr ? "absent" : (Number(sr.start) === want ? "match" : "mismatch");
  const srMatch = srState !== "mismatch";
  const srNote = srState === "match" ? "，且与 shadowedRange 一致"
    : srState === "mismatch" ? `，但与 shadowedRange（start=${sr.start}）不符`
      : "，但摘要没带 shadowedRange，无法交叉核对（这不是错）";
  const hasMark = raw.includes(MARK);
  // ★ 门牌的「位置」也是契约的一部分：它必须落在摘要**第一段**的开头。
  //   门牌埋在正文中间 ⇒ 人根本看不见回取命令 ⇒ 等于没有门牌。
  const blocks = Array.isArray(lastEvent.data?.summary) ? lastEvent.data.summary : [];
  const firstText = firstTextBlock(blocks);
  const markAtHead = hasMark && firstText.trimStart().replace(/^>\s*/, "").startsWith(MARK);
  if (!hit) {
    return {
      id: "doorsign", label: "门牌回取（实测）", status: "error",
      detail: `门牌写着 seq=${want}，但在日志里取不到 —— 这就是「静默失效」的长相`,
      evidence: { summarySeq: lastEvent.seq, want, hasMark, markAtHead, file: target.file, events: events.length, maxSeq: Math.max(...events.map((e) => e.seq || 0)) }, deep: true,
    };
  }
  // ★★ 2026-10-23 复核阻断项（外部复核）：原来这里只凭「seq 取得到 + range 对得上」就报 ok，
  //   `hasMark` 只记证据、**不参与判定** ⇒ 造出一条假绿路径：
  //   摘要里哪怕根本没有门牌行，只要**别处**冒出一个 `#seq=N`（比如模型自己在正文里
  //   引用了回取命令），seq 恰好存在、range 恰好对上 ⇒ 照样报绿。
  //   ★ 修法：判定改为四要素全过才 ok —— 指针可达 / MARK 在 / MARK 在首段 / range 一致。
  //     判定抽成纯函数 judgeDoorSign（可单测，见 plugins/echo/test/doctor-judge.spec.mjs）。
  // ★ everTagged 传进判定函数：这份日志**曾经**出现过带门牌的摘要 ⇒ 机制在这里
  //   证明过能工作 ⇒ 这次缺门牌/门牌位置不对就是**真故障**（error），不是"待观察"。
  const verdict = judgeDoorSign({ hit: !!hit, hasMark, markAtHead, srMatch, everTagged });
  const REASON_TEXT = {
    ok: `门牌 seq=${want} 真取到了（${hit.type}）${srNote}`,
    "range-mismatch": `门牌 seq=${want} 取到了（${hit.type}）${srNote} —— 门牌指到的起点不是被遮段的起点`,
    "mark-missing": `摘要里能解析出 #seq=${want} 且该 seq 存在，但**没有门牌标记「${MARK}」** —— 那多半是模型自己在正文里引用了回取命令，不是真门牌 ⇒ 不能报绿`,
    "mark-not-at-head": `门牌标记在，但**不在摘要第一段开头**（回取命令被埋进正文 ⇒ 人看不见）。门牌必须落在首段开头`,
  };
  return {
    id: "doorsign", label: "门牌回取（实测）", status: verdict.status,
    detail: REASON_TEXT[verdict.reason] || `门牌判定 ${verdict.reason}`,
    evidence: {
      summarySeq: lastEvent.seq, time: iso(lastEvent.time), want, gotType: hit.type,
      hasMark, markAtHead, verdict: verdict.reason,
      shadowedRange: sr || null, rangeMatches: srMatch, rangeState: srState,
      scannedLogs: measurable.length, summaryCount: all.length, events: events.length, frames, failed,
    },
    deep: true,
  };
}

/**
 * 门牌判定（纯函数 · 供单测直击，2026-10-23 复核阻断项抽出）
 *
 * ★ 为什么抽出来：checkDoorSign 依赖宿主日志解码与真实会话文件，
 *   在测试环境里跑不起来 ⇒ 判定逻辑等于**没有测试** —— 假绿路径就是这么漏过去的。
 *
 * 四要素全过才 ok（任一不满足都**不许**报绿）：
 *   hit        门牌指的那个 seq 在日志里真存在（指针可达）
 *   hasMark    摘要里有门牌标记文本
 *   markAtHead 标记落在摘要第一个 text block 的开头（人看得见）
 *   srMatch    门牌的 seq == shadowedRange.start（指的就是被遮掉的那段）
 *
 * ★★ 等级随证据自动收紧（2026-10-23 二轮复核，外部复核 D1"等级不一致"）：
 *   `everTagged` = 这份日志里**曾经**出现过带门牌的摘要。
 *     · 曾有过 ⇒ 机制在这里证明过能工作 ⇒ 这次缺门牌/位置不对 = **真故障** ⇒ error
 *     · 从没有 ⇒ 也可能是"接管后还没压缩过" ⇒ **warn**（不确定，交给人看）
 *   ★ 不收紧的代价就是任务书里那句"自动收紧"成了空话：明明声称会升级成 error，
 *     实测却停在 warn —— 报告读者按 error 级别对待，代码按 warn 级别报告。
 *
 * @param {{hit:boolean, hasMark:boolean, markAtHead:boolean, srMatch:boolean, everTagged?:boolean}} e
 * @returns {{status:'ok'|'warn'|'error', reason:string}}
 */
/**
 * 取摘要里**第一个有内容的** text block（纯函数 · 可单测）
 *
 * ★ 为什么不直接 `blocks.find(b => b.type === 'text')`：
 *   宿主哪天在门牌前面插一个**空文本 block**（或只有空白的），那个 find 会选中空串
 *   ⇒ `startsWith(MARK)` 必然失败 ⇒ 把好端端的门牌判成"位置不对" ⇒ **假黄**。
 *   ★ 这跟 D2 那次是同一类病：探测器自己制造故障。所以这里必须跳过空/纯空白 block。
 *
 * @param {Array} blocks 摘要 blocks（[{type:'text',text}, ...]）
 * @returns {string} 第一个非空 text block 的文本；没有则返回空串
 */
export function firstTextBlock(blocks) {
  if (!Array.isArray(blocks)) return "";
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (b.type !== "text" || typeof b.text !== "string") continue;
    if (b.text.trim() === "") continue; // ★ 跳过空/纯空白 block
    return b.text;
  }
  return "";
}

export function judgeDoorSign(e) {
  const hit = !!e?.hit, hasMark = !!e?.hasMark, markAtHead = !!e?.markAtHead, srMatch = !!e?.srMatch;
  const everTagged = !!e?.everTagged;
  if (!hit) return { status: "error", reason: "pointer-unreachable" };
  // 机制证明过能工作 ⇒ 这一次是故障（error）；没证明过 ⇒ 只是不确定（warn）
  if (!hasMark) return { status: everTagged ? "error" : "warn", reason: "mark-missing" };
  if (!markAtHead) return { status: everTagged ? "error" : "warn", reason: "mark-not-at-head" };
  if (!srMatch) return { status: "warn", reason: "range-mismatch" };
  return { status: "ok", reason: "ok" };
}

/** memory 插件给 runtime context 打的来源标记（2026-10-23 全库实测：63/63 条都是它） */
export const RUNTIME_CTX_KIND = "runtime-context";

/**
 * 注入证据的**保鲜期**（小时）：超过这个年纪的注入证据，不许再当"当前健康"的凭据。
 *
 * ★ 可用环境变量 `ECHO_CTX_MAX_AGE_H` 覆盖（比如有个长久不开的会话想放宽）。
 * ★ 为什么是 48h 而不是 24h：这个环境的会话每天都活跃，48h 足够包容隔天/周末；
 *   再宽就失去意义了 —— 十天前的成功不该顶今天的账。
 *   ★ 但也不能无限收紧：会话停一晚上就报黄，那是**假黄**，与假绿同罪。
 */
export const DEFAULT_CTX_MAX_AGE_H = 48;

/**
 * 挑出**真正的** runtime context 注入事件（纯函数 · 可单测）
 *
 * ★★ 2026-10-23 二轮复核（外部复核 D3 假绿路径）：原来只筛
 *   `type==='user/message'` + 全文含「【此刻】」，**不核验来源**。
 *   ⇒ 一条**普通用户消息**只要在正文里引用了「【此刻】」那行（甚至连同 SELF.md 的
 *     正文指纹一起引用 —— 比如我在跟她讨论这个告警时贴出来的原文），
 *     就会被当成"宿主真的注入了自我层" ⇒ 后面的 injected / hasBody 全绿 ⇒ **假绿**。
 *   ★ 假绿比假红危险：面板上一切正常，其实自我层根本没进去。
 *
 * ★ 修法（v2，三轮复核后定型）：认 `data.source.kind === 'runtime-context'`（memory 插件每轮注入时自己打的标）。
 *   ★ 但**留退路，不搞一刀切**：万一宿主哪天改了 kind 的取值，"没有严格集"会把好着的系统
 *     报成"没证据" ⇒ **假红**（与假绿同款）。所以**全集照常返回**（不丢弃任何候选），
 *     只把"最新这条核不核实"作为**标志位**交出去 ⇒
 *     核到 ⇒ 正常判定；核不到 ⇒ 由 judgeSelfEvidence 判 warn（"扫到了但认不出来源"）。
 *     **两边都不绿、也都不红** —— 这是我坚持的分寸。
 *   ★★ 三轮复核又修掉一条更隐蔽的（详见函数体内注释）：v1 是"有严格集就只用严格集"，
 *     那条路会让「注入停止」和「kind 换了值」两种故障拿到**陈旧证据**还报绿。
 *     现在改成**先取最新、再判这条**，而不是"先筛合格、再取最后一条合格的"。
 *
 * @param {Array} events
 * @returns {{ctxEvents:Array, strictCount:number, looseCount:number, kindVerified:boolean, everVerified:boolean, kinds:object}}
 */
export function classifyCtxEvents(events) {
  const list = Array.isArray(events) ? events : [];
  const cands = [], kinds = {};
  for (const e of list) {
    if (!e || e.type !== "user/message") continue;
    if (!JSON.stringify(e.data || {}).includes("【此刻】")) continue;
    const kind = (e.data && e.data.source && e.data.source.kind) || "(无 source.kind)";
    kinds[kind] = (kinds[kind] || 0) + 1;
    cands.push({ e, kind });
  }
  // ★★ 2026-10-23 **三轮**复核（外部复核 D3「历史证据滞留」）：
  //   上一版是 `kindVerified = strict.length > 0` 且 `ctxEvents = strict` ——
  //   **只要历史上存在过一条 runtime-context，就永远只从严格集里取**。
  //   于是两种真故障会被静默吞掉，而且拿到的是**陈旧证据**：
  //     (a) 宿主后来**停止注入**了 ⇒ 严格集最后一条是几天前的 ⇒ 仍被当成"当前证据"
  //     (b) 最新那条**换了 source.kind**（宿主改了取值）⇒ 它被排除在严格集之外，
  //         取到的 `last` 落在它**前面**那条旧的 ⇒ 用旧成功顶当前的账
  //   ★ 病根与门牌 / D2 / D4 完全同款（本日第五次）：**证据没有时效性，旧成功能顶新账**。
  //
  //   ★★ 修法两条，顺序很关键：
  //   ① **先按原文顺序取全集，再从全集里取最后一条** —— 保证 `last` 是时间上最新的一条。
  //      「先筛后取尾」取到的是"最后一条合格的"，那不是一回事：筛选会跳过不合格的。
  //   ② `kindVerified` 判定**最新这一条本身**，而不是"历史上有没有过"。
  //
  //   ★ `everVerified` 保留，只用来**区分两种不核实**：
  //      从未打过标（宿主没这个功能）vs 以前打过、现在这条没打（载体退化）。
  //     两者都**不许绿**，但报出来的话不同 —— 前者是"我没法验"，后者是"它变了"。
  const newest = cands.length ? cands[cands.length - 1] : null;
  const kindVerified = newest ? newest.kind === RUNTIME_CTX_KIND : false;
  const everVerified = cands.some((c) => c.kind === RUNTIME_CTX_KIND);
  return {
    ctxEvents: cands.map((c) => c.e),
    strictCount: cands.filter((c) => c.kind === RUNTIME_CTX_KIND).length,
    looseCount: cands.length,
    kindVerified,
    everVerified,
    kinds,
  };
}

/** ★ 深度项：压缩统计。与门牌共用同一个 decodeCached，不再各解一遍。 */
/**
 * 从一段解压出的明文里统计 compaction/* 事件（纯函数 · 供单测）
 *
 * ★ 为什么抽：全库逐帧扫描 + 逐行 parse 的逻辑写在"必须解真实日志"的函数里
 *   就等于没有测试（本文件反复踩过的坑）。
 */
export function tallyCompactionTypes(text) {
  const tally = {};
  if (typeof text !== "string" || !text) return tally;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try { e = JSON.parse(t) } catch { continue }   // 半帧残行：跳过
    if (typeof e?.type === "string" && e.type.startsWith("compaction/")) {
      tally[e.type] = (tally[e.type] || 0) + 1;
    }
  }
  return tally;
}

/**
 * 单份日志的 compaction 计数 —— **逐帧解码、扫完即弃**（内存只占一帧）
 *
 * ★ 为什么不用 decodeCached（全解）：全库 100+ 份全解一次在沙箱里跑不完
 *   （U8 实测 2 分钟被 SIGTERM）。逐帧 + 只取 type 不保留文本，实测 57 秒/104 份。
 * ★ 与 tools/scan-doorsign.mjs 同一套切帧逻辑（MAGIC = zstd 帧魔数）。
 */
function tallyCompactionInFile(file) {
  let buf;
  try { buf = fs.readFileSync(file) } catch { return {} }
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const frames = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i >= 0) {
    const n = buf.indexOf(MAGIC, i + 4);
    frames.push(buf.subarray(i, n === -1 ? buf.length : n));
    i = n;
  }
  const tally = {};
  for (const fr of frames) {
    let b;
    try { b = zlib.zstdDecompressSync(fr) } catch { continue }   // 坏帧/半帧：跳过
    const t = tallyCompactionTypes(b.toString("utf8"));
    for (const [k, v] of Object.entries(t)) tally[k] = (tally[k] || 0) + v;
  }
  return tally;
}

/**
 * 从轻量摘要清单里挑「全库最近一次」压缩（纯函数 · 供单测）。
 *
 * ★ 为什么抽出来：`Number(a.time) >= Number(b.time)` 这种比较写在扫描函数里
 *   就等于没有测试（本文件反复踩过的坑）。
 *
 * ★★ 2026-10-25 写测试时才发现的坑：原来用 `reduce((a,b) => Number(a.time) >=
 *   Number(b.time) ? a : b)` —— `Number(null)=0`、`Number(undefined)=NaN`，
 *   而 **`0 >= NaN` 恒为 false** ⇒ 只要碰上一个时间不可比的条目，就会**换成后者**，
 *   一路 reduce 到底返回**最后一条**。异常数据下"挑最近一次"变成了"挑最后一条"，
 *   而两者在日志里并不是一回事（代次文件、归档顺序都会让最后一条不是最新）。
 *   ★ 修法：显式判 `Number.isFinite`，**任一不可比就保持原选择不动** ——
 *     宁可保留先出现的那条，也不在数据可疑时换人（"不猜"的老规矩）。
 *
 * @param {Array<{time:number|string, seq:number}>} list
 * @returns {object|null} 空列表返回 null（调用方按「没有样本」处理）
 */
export function pickLatestSummary(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  let best = list[0];
  for (const item of list.slice(1)) {
    const tb = Number(best.time);
    const ti = Number(item.time);
    if (Number.isFinite(tb) && Number.isFinite(ti) && ti > tb) best = item;
  }
  return best;
}

/**
 * 全库逐帧收集 `compaction/summary` 的**轻量元信息**（file/sid/seq/time/hasTag）。
 *
 * ★★ 2026-10-25 修（checkDoorSign 单份样本冒充全库，假黄）：
 *   checkDoorSign 原来是 `logs.find(l => l.bytes > 0)` —— **只测第一份非空日志**。
 *   实测事故（10-25 15:19 收官体检）：选中的那份日志最近一次压缩是 **10-19**、无门牌，
 *   而全库明明有 **4 次带门牌**的压缩（10-23 / 10-24×2 / 10-25）⇒ 报「门牌机制可能坏了」，
 *   看报告的人会去修一个好着的机制 —— 最坏的一种误报。
 *   ★ 与 checkCompaction 10-24 修掉的是**同款病的第四张脸**（单份样本冒充全库），
 *     也是 10-24 用户提醒"如果 diagnose 里还有类似的单份样本逻辑，建议一并 review"时
 *     **漏扫的那一处**。修法与 checkCompaction 一致：**全库逐帧，口径写进 detail**。
 *
 * ★ 为什么只收轻量信息、不全解：全库 111 份全解跑不完（U8 实测 2 分钟被 SIGTERM）。
 *   逐帧 + 每条 summary 只做一次 JSON.stringify + 正则，实测与 checkCompaction 同量级。
 *   完整 data（四要素判定要用的 shadowedRange / summary blocks）**只全解最近一次那一份**。
 */
function scanAllSummaries(logs) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const out = [];
  for (const l of logs) {
    if (!l || !(l.bytes > 0)) continue;
    let buf;
    try { buf = fs.readFileSync(l.file) } catch { continue }
    let i = buf.indexOf(MAGIC, 0);
    while (i >= 0) {
      const n = buf.indexOf(MAGIC, i + 4);
      let b;
      try { b = zlib.zstdDecompressSync(buf.subarray(i, n === -1 ? buf.length : n)) } catch { i = n; continue }
      for (const line of b.toString("utf8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        let e;
        try { e = JSON.parse(t) } catch { continue }   // 半帧残行：跳过，不猜
        if (e && e.type === "compaction/summary") {
          const raw = JSON.stringify(e.data || {});
          out.push({ file: l.file, sid: l.sid, seq: e.seq, time: e.time, hasTag: /#seq=(\d+)/.test(raw) });
        }
      }
      i = n;
    }
  }
  return out;
}

function checkCompaction(logs, deep) {
  const measurable = logs.filter((l) => l.bytes > 0);
  if (measurable.length === 0) return { id: "compaction", label: "压缩机制", status: "warn", detail: "没有可测的日志", evidence: {}, deep: true };
  if (!deep) return { id: "compaction", label: "压缩机制", status: "info", detail: "待深度检测…", evidence: { skipped: true }, deep: true };

  // ★★ 2026-10-24 修（外部复核/新会话体检抓到的假绿）：原来这里是
  //      `logs.find(l => l.bytes > 0)` —— **只统计最新一份日志**，却以
  //      「压缩机制」的名义汇报，读者会以为是全库统计。
  //      实测事故：师姐在新会话里跑体检，最新一份恰好是她自己那个
  //      **还没触发过压缩的新会话** ⇒ 报 start 0 / summary 0 / prune 0，
  //      而全库实际有 26 次压缩、接管后 2 次都带门牌。
  //      ★ 又是"单份样本冒充全库结论"——与 C1（scan-doorsign 只解尾部）
  //        同款病的第三张脸。修法：**全库逐帧统计**，口径写进 detail。
  const tally = {};
  for (const l of measurable) {
    const t = tallyCompactionInFile(l.file);
    for (const [k, v] of Object.entries(t)) tally[k] = (tally[k] || 0) + v;
  }
  const start = tally["compaction/start"] || 0;
  const sum = tally["compaction/summary"] || 0;
  const end = tally["compaction/end"] || 0;
  const prune = tally["compaction/prune"] || 0;
  // error 需要事件详情，逐帧版不保留 —— 改从最新一份全解里取（那里有详情）
  const target = measurable[0];
  const { events } = decodeCached(target.file);
  const errs = events.filter((e) => e.type === "compaction/end" && e.data && e.data.error);
  const ratio = start ? sum / start : 1;
  let status = "ok";
  if (start === 0) status = "warn";
  else if (ratio < 0.9 || errs.length > 0) status = "warn";
  const lastEnd = [...events].reverse().find((e) => e.type === "compaction/end");
  return {
    id: "compaction", label: "压缩机制", status,
    detail: `全库 ${measurable.length} 份日志：start ${start} / summary ${sum} / end ${end} / prune ${prune}${errs.length ? `；${errs.length} 次带 error` : ""}`,
    evidence: { tally, scannedLogs: measurable.length, ratio: round1(ratio * 100) / 100, errors: errs.slice(-3).map((e) => ({ seq: e.seq, error: e.data.error })), lastEndAt: lastEnd ? iso(lastEnd.time) : null, lastEndIn: target.sid },
    deep: true,
  };
}

/**
 * ★ 门牌可回取（在中枢里那几份解日志的脚本，会不会一解巨串就崩）—— 移植自作者 2026-10-23 版。
 *
 * ★ 为什么这一项存在：门牌指向的原文要靠**中枢里的解码脚本**打开。
 *   那些脚本若还在「全帧 concat 成一个巨串再 toString」，会话日志一大就会抛
 *   ERR_STRING_TOO_LONG —— 门牌本身是对的，**门后面堵着**，回取链照样断。
 *
 * ★ 判据落在「会不会拼出巨串」上（`Buffer.concat(` + `zstdDecompressSync`），
 *   不是「提没提过这个 API」—— 作者第一版只认 zstdDecompressSync，
 *   立刻误报了 session-store.mjs（它只在注释里提到这个函数名）。
 */
function checkAnchor(logs, deep) {
  const files = [];
  let es;
  try { es = fs.readdirSync(HUB) } catch {
    return { id: "anchor", label: "门牌可回取", status: "info", detail: "读不到 HUB 目录", evidence: {}, deep: true };
  }
  for (const n of es) {
    if (!/\.mjs$/.test(n)) continue;
    if (/_probe|\.bak|^_/.test(n)) continue;   // 坏样本/探针是故意留的
    let s;
    try { s = fs.readFileSync(path.join(HUB, n), "utf8") } catch { continue }
    if (!/zstdDecompressSync/.test(s)) continue;
    // ★ 必须有 Buffer.concat( 才算危险形状。判据要落在「会不会拼出巨串」上。
    if (!/Buffer\.concat\(/.test(s)) continue;
    const guarded = /carry/.test(s) || /MAX_TOTAL|MAX_LINE/.test(s);
    files.push({ name: n, guarded });
  }
  if (!files.length) {
    return { id: "anchor", label: "门牌可回取", status: "info", detail: "没扫到解日志的脚本", evidence: {}, deep: true };
  }
  const bad = files.filter((f) => !f.guarded).map((f) => f.name);
  const okList = files.filter((f) => f.guarded).map((f) => f.name);
  if (bad.length) {
    return {
      id: "anchor", label: "门牌可回取", status: "warn",
      detail: `${bad.join(" / ")} 解大日志会抛 ERR_STRING_TOO_LONG —— 门牌指向的原文打不开`,
      evidence: { bad, ok: okList, how: "要么逐帧+carry，要么加总量封顶" },
      deep: true,
    };
  }
  let lastSeq = null;
  if (deep) {
    const target = logs.find((l) => l.bytes > 0);
    if (target) {
      try {
        const { events } = decodeCached(target.file);
        const sum = [...events].reverse().find((e) => e.type === "compaction/summary");
        if (sum && sum.seq !== undefined) lastSeq = String(sum.seq);
      } catch { /* 解不开就是别的项的问题 */ }
    }
  }
  return {
    id: "anchor", label: "门牌可回取", status: "ok",
    detail: `${files.length} 个解日志的脚本都有保护（${okList.join(" / ")}）${lastSeq ? `；最近门牌 seq=${lastSeq}` : ""}`,
    evidence: { ok: okList, lastSeq },
    deep: true,
  };
}

/**
 * ★ 深度项：换气（思考预算）—— 稳态的时间维。
 * 为什么需要它：换气的判定参数（相似度 0.8 / 连续 3 次 / 上限 4 次 / 推理门槛 2048 字符）
 * 一次调好之后**没有任何反馈回路** —— 断过几次、有没有误伤，此前无人知道。
 * ★ 2026-10-14 实测确认：换气**不写事件**（没有 huanqi/* 之类），
 *   所以这里不测"药效"，测**病症**：一个回合烧光预算、正文一个字没出来。
 *   形状 = assistant/message 的 content 里只有 reasoning，没有 text / tool-call。
 * ★ 双插件对账：换气只收「推理 >= minReasoningChars（默认 2048）」的，
 *   ★ 2026-10-19：空回合这一条已经并进换气（judge ④），不再需要 dsh-stalled-turn-continue。
 *   那个独立插件会另记一套 maxConsecutive，两边都续就是一轮变两轮。
 */
function checkHuanqi(logs, deep) {
  if (!deep) return { id: "huanqi", label: "换气（思考预算）", status: "info", detail: "待深度检测…", evidence: { skipped: true }, deep: true };
  const targets = logs.filter((l) => l.bytes > 0).slice(0, 8);
  if (!targets.length) return { id: "huanqi", label: "换气（思考预算）", status: "warn", detail: "没有可测的日志", evidence: {}, deep: true };

  const MIN_REASONING = 2048; // = 换气默认 minReasoningChars
  let total = 0, noReply = 0, overThreshold = 0;
  const reasons = {};
  const samples = [];
  for (const t of targets) {
    const { events } = decodeCached(t.file);   // 与门牌/压缩共用同一份缓存
    for (const e of events) {
      if (e.type === "turn/end" && e.data && e.data.reason) {
        const k = typeof e.data.reason.kind === "string" ? e.data.reason.kind : "unknown";
        reasons[k] = (reasons[k] || 0) + 1;
      }
      if (e.type !== "assistant/message") continue;
      const content = e.data && e.data.message && e.data.message.content;
      if (!Array.isArray(content)) continue;
      total++;
      const visible = content.some((p) => p && (p.type === "text" || p.type === "tool-call" || p.type === "tool_call"));
      if (visible) continue;
      noReply++;
      const rlen = content.reduce((a, p) => a + (p && p.type === "reasoning" && p.text ? p.text.length : 0), 0);
      if (rlen >= MIN_REASONING) {
        overThreshold++;
        if (samples.length < 5) samples.push({ sid: t.sid.slice(0, 12), seq: e.seq, reasoningChars: rlen });
      }
    }
  }

  // ★ 判据：有病症却零介入 = 该响的没响。这是这一项存在的全部意义。
  const hasSymptom = overThreshold > 0;
  const everBroke = Object.keys(reasons).some((k) => /repetitive|loop|no-visible/i.test(k));
  let status = "ok";
  let note = "";
  if (hasSymptom && !everBroke) { status = "warn"; note = "；该介入的回合存在，但日志里零介入痕迹"; }
  else if (hasSymptom && everBroke) { note = "；已见过介入痕迹"; }

  return {
    id: "huanqi", label: "换气（思考预算）", status,
    detail: `无输出回合 ${noReply}/${total}（推理 ≥${MIN_REASONING} 的 ${overThreshold} 条）${note}`,
    evidence: {
      logsSampled: targets.length, assistantMessages: total, noVisibleOutput: noReply,
      overReasoningThreshold: overThreshold, minReasoningChars: MIN_REASONING,
      turnEndReasons: reasons, samples,
      crossCheck: "换气自己覆盖四种退化（含空回合）；不再需要 dsh-stalled-turn-continue —— 两套账会让一轮被续成两轮",
    },
    deep: true,
  };
}

function checkIndex(logs) {
  const metaPath = path.join(IDX, "meta.json");
  const meta = readText(metaPath);
  // ★ 「还没建」不是「坏了」。索引没建过 → warn（下一步就是建它）；
  //   meta.json 在但解析不了 → 那才是 error（真坏了，修不好得重建）。
  if (!meta) return { id: "index", label: "索引层 L4", status: "warn", detail: "索引还没建过 —— 跑一次 memindex.mjs build 就好", evidence: { metaPath } };
  let m;
  try { m = JSON.parse(meta) } catch { return { id: "index", label: "索引层 L4", status: "error", detail: "meta.json 解析失败", evidence: { metaPath } } }
  const built = new Date(m.builtAt).getTime();
  const lagH = hoursSince(built);
  const newer = logs.filter((l) => l.mtime > built).length;
  // ★ 「新增几份日志」只作信息、不作判据 —— 任何一轮对话都会产生新日志，
  //   拿它当警告会让面板永远亮黄灯。真判据是滞后时间。
  let status = "ok";
  if (lagH > 72) status = "error";
  else if (lagH > 24) status = "warn";
  return {
    id: "index", label: "索引层 L4", status,
    detail: `建于 ${iso(built)}（${round1(lagH)} 小时前）；摘要 ${m.summaries ?? "?"} / 原话 ${m.words ?? "?"}；之后新增 ${newer} 份`,
    evidence: { builtAt: m.builtAt, elapsedSec: m.elapsedSec, summaries: m.summaries, words: m.words, logs: m.logs, logsNewerThanIndex: newer, lagHours: round1(lagH) },
  };
}

/**
 * memory 插件补丁的 mtime —— 用来判断「selfPath 改了之后有没有新的注入轮次」。
 *
 * ★★ 2026-10-23 三轮复核（外部复核 U19 假黄）：原版取**三份候选的最新者**，
 *   其中包含 `plugins-src` **源码树**。源码树只是开发副本，**不参与宿主运行** ——
 *   我改它并不会让运行中的 memory 插件行为发生任何变化。
 *   但"取最新" ⇒ **我每改一次源码，stale 就恒真** ⇒ SELF 凭空变黄。
 *   ★ 与 D2/D4 同款（本日第七次）：把「文件被碰过」当成了「运行行为变了」。
 *
 *   ★ 修法：stale **只认真正会被加载的那两份 installed 补丁**；
 *     源码树那份单独以 `srcNewer` 返回 —— 它表示的是"**改了还没同步**"，
 *     那是另一件事（该提示回同步），**不该让 SELF 替它背黄**。
 *
 * ★ 2026-10-25 再补正（U19 只修了一半）：改成只认 installed 之后，实测**三份内容
 *   逐字节相同、源码树 mtime 仅晚 20 秒**（同步方式保留了源 mtime / 后碰过一次），
 *   ⇒ `srcNewer` 恒真 ⇒ SELF 项**又**挂一条"改了还没回同步"的假黄。
 *   ★ 与 D2/D4 同款（本日第八次）：**mtime 只证明"被碰过"，不证明"内容不同"**。
 *
 *   ★ 修法：判据从"mtime 谁新"改成"**内容比不比得过**"——
 *       内容不同 ⇒ 真没同步（不管 mtime 谁新谁旧）；
 *       内容相同 ⇒ 已同步（**包括源码树 mtime 更旧的情况**，那种以前会漏报）。
 *     mtime 仍然照算（stale 判据要用），但**不再拿它当同步与否的证据**。
 *
 * ★ 两份 installed 都找不到 ⇒ mtime 返回 null —— 不猜，也不因此放宽结论。
 *
 * @returns {{mtime:number|null, srcNewer:boolean}}
 */
function memoryPatchMtime() {
  const root = path.join(HUB, "..", ".."); // HUB = ~/.dsh/memory/hub ⇒ root = ~/.dsh
  const installed = [
    path.join(root, "profiles", "desktop", "node_modules", "dsh-agent-memory", "cordis.patch.yml"),
    path.join(root, "profiles", "desktop", "node_modules", "dsh-agent-soul", "plugins", "memory", "cordis.patch.yml"),
  ];
  const src = path.join(root, "plugins-src", "dsh-agent-soul", "plugins", "memory", "cordis.patch.yml");
  let best = null;
  let bestText = null;
  for (const p of installed) {
    const s = statSafe(p);
    if (s && (best === null || s.mtimeMs > best)) { best = s.mtimeMs; bestText = readTextSafe(p); }
  }
  const srcText = readTextSafe(src);
  // ★ 内容优先：一样就是同步了，mtime 谁新谁旧不算证据。
  //   installed 一份都读不到（best===null）时保守报"不同"—— 那种情况本来就要人去看。
  const srcNewer = !!(best !== null && srcText !== null && srcText !== bestText);
  return { mtime: best, srcNewer };
}

function checkSelf(logs, deep) {
  const st = statSafe(SELF_MD);
  // ★ 还没装配 → warn（改完 SELF.src.md 跑一次 self.mjs 就好）。
  //   装配过却长期没更新 → 那才是后面的滞后判据要管的事。
  if (!st) return { id: "self", label: "推送层 SELF", status: "warn", detail: "SELF.md 还没装配 —— 跑一次 self.mjs 就好", evidence: {} };
  const h = hoursSince(st.mtime);
  const txt = readText(SELF_MD) || "";
  const sizeLine = /(\d+)\s*B\s*\/\s*预算\s*(\d+)\s*B/.exec(txt);
  const pct = sizeLine ? Math.round((Number(sizeLine[1]) / Number(sizeLine[2])) * 100) : null;
  // ★★ 文件在 ≠ 被读到。2026-10-18 沙箱实测踩到的假绿：
  //    SELF.md 明明装配好了，每轮 runtime context 还在喊「SELF.md 读不到（./SELF.md）」——
  //    因为 dsh-agent-memory 的 selfPath 指向别处（默认 './SELF.md'），而 scaffold 把它写在 memory/hub/。
  //    只查「文件存在」的话，这一项永远 ✓，而推送层其实一点没吃到。
  //    所以深检要从**真实注入过的日志**里找证据 —— 这是唯一的硬判据。
  let injected = null // null = 快检，没验
  let lastCtxAt = null
  let ctxCount = 0
  let truncated = false // 读到了，但被 maxBytes 截断
  let hasBody = false // 注入里确实含有 SELF.md 的正文开头
  let kindVerified = false // 最新那条注入的来源核到了 runtime-context 吗（D3）
  let everVerified = false // 历史上**曾经**核到过吗（区分"从未打标" vs "载体退化"）
  let kindStats = {} // 候选里各种 source.kind 的分布，供人工看
  // ★ 以下三个是 2026-10-24 移植作者「sections 读法」带来的
  let injectInfo = null // 深检时记下「证据长什么样」，好让报错能指到具体位置
  let snapshotReadFail = false // 快照节里明说「读不到」⇒ **正面故障证据**（维持 error）
  let snapshotMissing = false // 快照里根本没有 SELF 节 ⇒ 证有不证无（warn）
  // ★ 拿 SELF.md 的开头一小段当"正文指纹"，注入文本里找得到它才算真吃到了。
  //   不靠标题字符串 —— 标题会随 SELF.md 被改写而变化，而文件开头一小段更稳。
  //
  // ★★ 必须转义成与 `JSON.stringify(data)` **同构**的形态再比对（2026-10-23 实测踩到）：
  //   比对对象是 `JSON.stringify(e.data)`，里面的换行是**两字符的 `\n`**，
  //   而 readText 读出来的是**一字符的真实换行** ⇒ 直接比对必然 false ⇒ **假阴性**
  //   （表现成"runtime context 在但没找到自我层正文"，其实自我层好端端在那）。
  const selfHeadRaw = (readText(SELF_MD) || "").trim().slice(0, 60)
  const selfHead = selfHeadRaw ? JSON.stringify(selfHeadRaw).slice(1, -1) : ""
  if (deep) {
    const targetLog = logs.find((l) => l.bytes > 0)
    if (targetLog) {
      try {
        const { events } = decodeCached(targetLog.file)

        // ★★★ 2026-10-24 移植作者三修后的**取证核心**：
        //   **注入的证据只能从注入通道里取，不能从整个日志里取。**
        //
        //   为什么必须换（作者本机实测，决定性证据）：
        //     ① 旧写法把整个日志拼成大串再 includes ⇒ **早期那一次**「SELF.md 读不到」
        //        会永远压住后面成功的注入（判据无时效性，路径修好了也还是红）；
        //     ② 「后出现者优先」那版仍然错：日志里既记录系统事件、也记录**人对系统的讨论**。
        //        实测同一状态、间隔 97 秒，中间只做了一件事（读 echo-doctor 源码），
        //        结论就从 ✓ 翻成 ✗ —— 那段源码里同时含这两个字串。
        //     ③ 更坏的是**自锁死**：这一项一旦报错，错误文本本身就进了日志，
        //        下一轮读日志又看见它 ⇒ 永远报错。
        //
        //   ★ 真实结构（作者本机 seq=115626 实测，推送插件注入的那条）：
        //     type=user/message
        //     data.source = { kind:"runtime-context", form:"snapshot",
        //                     sections:[ {name:"yanqing:self", text:"【此刻】…\n\n# SELF · 定长自我层…"}, … ] }
        //   ★ 判据 = 最后一条 runtime-context 快照里，有没有一节真装着 SELF 正文。
        //     这一改同时把「人说的话」彻底排除在证据之外 —— 它们根本不在 sections 里。
        const SELF_MARK = /#\s*SELF\s*[·・\-—]|##\s*我是谁|四条硬线/;
        let lastSnap = null;
        for (const e of events) {
          if (e?.type !== "user/message") continue;
          const src = e?.data?.source;
          if (src?.kind !== "runtime-context") continue;
          lastSnap = { seq: e.seq, time: e.time, sections: Array.isArray(src.sections) ? src.sections : [] };
        }
        // ★★ 只看【最后一条】注入，不看全文（2026-10-23 修）。
        //
        //   原来的写法是把所有事件的 data 拼成一个大字符串再 includes('SELF.md 读不到')——
        //   只要这份日志里**历史上任何一轮**报过一次，这一项就永远红，**改好配置也还是红**。
        //   判据把「曾经坏过」当成了「现在还坏」，跟门牌那次是同一类病：证据没有时效性。
        //
        //   正解：取最后一条带 runtime context（含「自我层」/「SELF.md」）的事件，
        //   只由它判定 —— 那才是「最近一轮注入」的真实状态。
        // ★★ 注入载体的识别必须严格，否则会出现【假绿】（2026-10-23 实测踩到）：
        //   只按「文本里提到 SELF.md」筛事件，会连 **assistant 在讨论这个告警** 的
        //   消息一起算进来 —— 另一条会话 18:37:08 那条 assistant/message 恰好在说
        //   "the SELF.md warning repeats"，它**不含**「读不到」⇒ injected=true ⇒ **假绿**。
        //   ★ 假绿比假红危险得多：它会让人以为已经修好了。
        //
        //   真正的注入载体 = 每一轮 **user/message** 里拼进去的 runtime context。
        //★★ 载体标志必须用「【此刻】」而不是「【自我层】」（2026-10-23 三修，实测踩到）：
        //   原以为自我层的标志是「【自我层】★ …」，实则那是**超预算时才打印的告警行**
        //   （lib/index.js:151 —— 只在 `bytes > cfg.maxBytes` 时才 push 这一行）。
        //   ★ 于是：自我层**健康时根本没有这一行**，判据筛出 ctxCount=0 ⇒ 判据**静默失效**；
        //     它此前"能用"纯属侥幸 —— 那时一直在超预算，告警行一直在。
        //     把超预算修好之后，判据反而抓不到任何注入。
        //   ★ 教训：拿「故障时才出现的字符串」当存在标志，等于做了一个只在故障时工作的探测器。
        //
        //   「【此刻】」是 memory 插件**每轮必注入**的时钟行（正常与否都在），
        //   用它当 runtime context 的存在标志才稳。
        // ★★ 来源核验（D3，我们的保留件）：交给 classifyCtxEvents —— 认 data.source.kind。
        //   它给出 ctxCount / kindVerified / everVerified / kindStats，
        //   供下面的 judgeSelfEvidence 判「有没有注入证据 / 证据新不新」。
        const cls = classifyCtxEvents(events)
        const ctxEvents = cls.ctxEvents
        kindVerified = cls.kindVerified
        everVerified = cls.everVerified
        kindStats = cls.kinds
        ctxCount = ctxEvents.length
        const last = ctxEvents[ctxEvents.length - 1]
        if (last) lastCtxAt = Number(last.time) || null

        // ★★ 真正的 injected 判据（2026-10-24 起）：只认最后一条 runtime-context 快照的 sections[]
        if (lastSnap) {
          const strs = lastSnap.sections.filter((s) => s && typeof s.text === "string");
          // ① 先按节名认（推送插件注册的 context 名，作者本机是 yanqing:self）；
          // ② 认不到再按正文标记认 —— 节名可改，正文骨架不会改。
          const hit =
            strs.find((s) => /self/i.test(String(s.name || "")) && s.text.length > 200) ||
            strs.find((s) => SELF_MARK.test(s.text));
          const snapshotText = strs.map((s) => s.text).join("\n");
          if (hit) {
            injected = true;
            injectInfo = { seq: lastSnap.seq, section: hit.name || null, chars: hit.text.length, at: lastSnap.time };
            // ★ 正文指纹（我们的保留件）：注入文本里找得到 SELF.md 开头那一小段才算真吃到
            //   （这里比对的是**真实文本**，不是 JSON.stringify 后的转义串，故用 selfHeadRaw）
            if (selfHeadRaw) hasBody = hit.text.includes(selfHeadRaw);
            truncated = /超预算/.test(hit.text);
          } else {
            injected = false;
            // ★★ injected=false 分两路（这是本次 merge 的两个冲突点之一）：
            //   ① 快照节里明说「读不到」/「注入失败」 ⇒ **正面故障证据** ⇒ 下面维持 **error**；
            //   ② 根本没有 SELF 节 ⇒ 也可能走了不落日志的通道 ⇒ **warn** + 作者的「证有不证无」文案。
            snapshotReadFail = snapshotText.includes("SELF.md 读不到") || snapshotText.includes("自我层注入失败");
            snapshotMissing = !snapshotReadFail;
            injectInfo = snapshotReadFail
              ? { seq: lastSnap.seq, section: null, chars: 0, at: lastSnap.time }
              : { seq: lastSnap.seq, sections: strs.map((s) => s.name || "(无名节)"), at: lastSnap.time };
            truncated = /超预算/.test(snapshotText);
          }
          if (lastCtxAt === null) lastCtxAt = Number(lastSnap.time) || null;
        } else if (last && kindVerified) {
          // 没有 sections 结构的旧式注入：退回原来的字面判据（不静默放过）
          const raw = JSON.stringify(last.data || {})
          injected = raw.includes("SELF.md 读不到") || raw.includes("自我层注入失败") ? false : true
          snapshotReadFail = injected === false
          truncated = raw.includes("超预算")
          if (selfHead) hasBody = raw.includes(selfHead)
          injectInfo = { seq: last.seq, section: null, chars: null, at: last.time, legacy: true }
        }
        // 连 runtime-context 快照都没有 ⇒ injected 保持 null：没有证据就不下结论，别猜。
      } catch { /* 解不出来就不下结论，别猜 */ }
    }
  }

  // ★★ 没有注入证据就不许报健康（2026-10-23 复核阻断项，外部复核指出）：
  //   深检跑完却一条 `【此刻】` 注入都没扫到 ⇒ `injected` 留 null ⇒ 下面所有分支都不命中
  //   ⇒ 直接落到默认 `status="ok"`，于是**"没验到"被显示成"验过了、健康"** —— 又一条假绿。
  //   ★ 假绿比假红危险：它让人以为自我层好着，其实这一轮压根没证据。
  //   ★ 快检（deep=false）本就不解日志，ctxCount 必然 0，故只在 deep 时生效。
  const ctxAgeHours = lastCtxAt ? (Date.now() - lastCtxAt) / 3600000 : null
  const maxAgeHours = Number(process.env.ECHO_CTX_MAX_AGE_H) || DEFAULT_CTX_MAX_AGE_H
  const evVerdict = judgeSelfEvidence({ deep, ctxCount, injected, kindVerified, everVerified, ctxAgeHours, maxAgeHours });
  const DETAIL_NO_EVIDENCE = {
    "no-injection-evidence": `SELF.md 在磁盘上（${st.size} B），但深检在日志里**没找到任何 runtime context 注入**（一条含「【此刻】」的 user/message 都没有）—— 没有证据就不能报健康。★ 在任一会话里发一条消息、产生一轮注入后再复查`,
    undecidable: `SELF.md 在磁盘上（${st.size} B），扫到了 ${ctxCount} 条注入却判不出是否读到自我层 —— 不下结论，请人工看日志`,
    // ★★ D3：形似注入但核不到来源 ⇒ 可能是普通消息在引用「【此刻】」这行文本
    "carrier-unverified": `扫到 ${ctxCount} 条形似注入的事件，但**没有一条**带 \`data.source.kind='${RUNTIME_CTX_KIND}'\` —— 无法确认它们真是宿主注入的 runtime context（普通消息引用这段文本也会命中）⇒ 不能据此报健康。★ source.kind 分布：${JSON.stringify(kindStats)}`,
    // ★★ D3 三轮：历史证据滞留 —— 以前一直核得到，最新这条核不到了
    "carrier-regressed": `日志里 ${ctxCount} 条候选里**历史上有** \`source.kind='${RUNTIME_CTX_KIND}'\` 的注入，但**最新那一条（${lastCtxAt ? iso(lastCtxAt) : "?"}）不是** ⇒ 要么宿主改了 kind 取值，要么注入在最新一轮已经停了。★ 不能拿更旧那条成功当当前证据（${everVerified ? "历史" : "当前"}有 / 最新无）。kind 分布：${JSON.stringify(kindStats)}`,
    // ★★ 证据保鲜期：旧成功顶新账
    "evidence-stale": `最后一次注入是 ${lastCtxAt ? `${round1(ctxAgeHours)} 小时前（${iso(lastCtxAt)}）` : "?"}，超过保鲜期 ${maxAgeHours} 小时 —— 那是那时候的健康，不是现在的。★ 在任一会话里发一条消息、产生一轮新注入后再复查，才是当前证据`,
  };
  if (evVerdict.status !== "ok") {
    return {
      id: "self", label: "推送层 SELF", status: evVerdict.status,
      detail: DETAIL_NO_EVIDENCE[evVerdict.reason] || `SELF.md 在磁盘上（${st.size} B），但注入证据不充分（${evVerdict.reason}）`,
      evidence: { bytes: st.size, path: SELF_MD, injected, snapshot: injectInfo, ctxCount, kindVerified, everVerified, kindStats, reason: evVerdict.reason, deep, lastCtxAt: lastCtxAt ? iso(lastCtxAt) : null, ctxAgeHours: ctxAgeHours === null ? null : round1(ctxAgeHours), maxAgeHours },
    };
  }

  // ★ 配置改过 ≠ 配置生效。改完 selfPath 之后，要等宿主**再注入一轮**才有新证据。
  //   如果最后一次注入早于补丁改动时间，说明「新配置还没被跑过」。
  //
  // ★★ 2026-10-23 二轮复核（外部复核 D4 假绿）：原来 `stale` 只在 `injected === false` 时算
  //   ⇒ 「旧注入**成功** → 之后补丁被改 → 还没有新注入」这条路上，
  //      拿**改动之前那次成功**当成**当前**健康 ⇒ 假绿。
  //      ★ 病根和门牌那次一模一样：**证据没有时效性**，旧的成功能顶新配置的账。
  //   ★ 修法：stale 与 injected **解耦** —— 只要最后一次注入早于补丁改动时刻，
  //     无论那次读到没读到，都说明「当前证据是旧配置留下的」⇒ warn。
  // ★ 只取 installed 那份的 mtime；源码树改动另行以 `srcNewer` 提示（U19）
  const patch = memoryPatchMtime()
  const patchMtime = patch.mtime
  const stale = !!(lastCtxAt && patchMtime && lastCtxAt < patchMtime)

  if (stale) {
    return {
      id: "self", label: "推送层 SELF", status: "warn",
      detail: injected === false
        ? `最后一次注入（${iso(lastCtxAt)}）读不到，但那次发生在 selfPath 改动（${iso(patchMtime)}）之前 —— 新配置还没有被跑过。★ 在任一会话里发一条消息，等它注入一轮后复查，才是真证据`
        : `最后一次注入（${iso(lastCtxAt)}）读到了自我层，但那次发生在补丁改动（${iso(patchMtime)}）**之前** —— 这是旧配置留下的证据，新配置还没被跑过 ⇒ 不能拿它当当前健康。★ 在任一会话里发一条消息、产生一轮新注入后再复查`,
      evidence: { bytes: st.size, path: SELF_MD, injected, stale: true, snapshot: injectInfo, lastCtxAt: iso(lastCtxAt), patchMtime: iso(patchMtime), ctxCount, kindVerified },
    }
  }
  if (injected === false) {
    // ★★ 两路（2026-10-24 merge，本文件两个冲突点之一）：
    //   ① snapshotReadFail —— 快照节里明说「读不到」/「注入失败」= **正面故障证据** ⇒ **维持 error**
    //      （这是我们的判据：有正面故障证据时，不许因为它"也可能是别的"就降级）
    //   ② snapshotMissing —— 快照里根本没有 SELF 节 ⇒ 移植作者 2026-10-23 四修的
    //      「证有不证无」：两条推送通道只有一条落日志，
    //      走 ctx.systemPrompt.context() 的那条**不落日志**，体检看不到。
    //      ⇒ 报 error 的代价是假红（让人去修一个不存在的故障）⇒ **warn**。
    if (snapshotMissing) {
      const names = injectInfo?.sections?.length ? injectInfo.sections.join(" / ") : "（空）";
      return {
        id: "self", label: "推送层 SELF", status: "warn",
        detail: `SELF.md 在磁盘上（${st.size} B），但最近一轮 runtime context 快照（seq=${injectInfo?.seq ?? "?"}）里没有 SELF 正文 —— 那一轮注入了这些节：${names}。`
          + `★ 这不一定是故障：如果推送插件走的是 ctx.systemPrompt.context()（agent-soul 自带的 dsh-agent-memory 就是这样），它不进日志，体检看不到。`
          + `自己确认一条就够：GUI 里这一轮 agent 到底读不读得到 SELF。读得到 → 虚警；读不到 → 查推送插件的 selfPath / maxBytes。`,
        evidence: {
          bytes: st.size, path: SELF_MD, injected: false, reason: "no-self-section",
          snapshot: injectInfo, ctxCount, kindVerified, everVerified, kindStats,
          lastCtxAt: lastCtxAt ? iso(lastCtxAt) : null,
          ctxAgeHours: ctxAgeHours === null ? null : round1(ctxAgeHours), maxAgeHours,
        },
      }
    }
    return {
      id: "self", label: "推送层 SELF", status: "error",
      detail: `SELF.md 在磁盘上（${st.size} B），但最近一轮注入（${lastCtxAt ? iso(lastCtxAt) : "?"}）时读不到 —— 查 dsh-agent-memory 的 selfPath 指到哪了，现在它多半在找 ./SELF.md`,
      evidence: {
        bytes: st.size, path: SELF_MD, injected: false, reason: "read-failed",
        snapshot: injectInfo, ctxCount, kindVerified,
        lastCtxAt: lastCtxAt ? iso(lastCtxAt) : null,
      },
    }
  }

  // ★ 读到了但被截断 —— 不算健康。之前这一项被静默漏掉（正则认的是「/预算」而
  //   实际文本是「超预算 N B > M B」），现在直接从注入文本里认，格式无关。
  if (truncated) {
    return {
      id: "self", label: "推送层 SELF", status: "warn",
      detail: `最近的注入（${lastCtxAt ? iso(lastCtxAt) : "?"}）里自我层**被预算截断** —— 调大 dsh-agent-memory 的 maxBytes 或精简 SELF.src.md`,
      evidence: { bytes: st.size, path: SELF_MD, injected: true, truncated: true, hasBody, snapshot: injectInfo, lastCtxAt: lastCtxAt ? iso(lastCtxAt) : null, ctxCount, kindVerified },
    }
  }
  // ★ runtime context 在（有【此刻】），却找不到 SELF.md 的正文开头 ——
  //   说明自我层这一路没进去，但也没报错。这种"静默缺席"最该报出来。
  if (injected === true && !hasBody && selfHead) {
    return {
      id: "self", label: "推送层 SELF", status: "warn",
      detail: `最近的注入（${lastCtxAt ? iso(lastCtxAt) : "?"}）有 runtime context，但**没有自我层正文** —— 自我层静默缺席，查 dsh-agent-memory 的 includeSelf / selfPath`,
      evidence: { bytes: st.size, path: SELF_MD, injected: true, hasBody: false, snapshot: injectInfo, lastCtxAt: lastCtxAt ? iso(lastCtxAt) : null, ctxCount, kindVerified },
    }
  }

  let status = "ok";
  if (h > 72) status = "error"; else if (h > 24) status = "warn";
  if (pct !== null && pct > 95 && status === "ok") status = "warn";

  return {
    id: "self", label: "推送层 SELF", status,
    // ★ 证据年龄一并报出来 —— 让人自己也能看见"这条结论有多新鲜"，不必只信 status 颜色
    detail: `${st.size} B${pct !== null ? `（预算 ${pct}%）` : ""}，装配于 ${iso(st.mtime)}（${round1(h)} 小时前）`
      + (injected === true && hasBody ? "，最近的注入里读到了完整自我层" : injected === true ? "，最近的注入里读到了" : injected === null ? "" : "")
      + (ctxAgeHours !== null ? `（证据 ${round1(ctxAgeHours)} 小时前 / 保鲜 ${maxAgeHours}h）` : "")
      + (patch.srcNewer ? "　★ 源码树的 memory 补丁比 installed 新 —— 改了还没回同步（**不影响本次判定**，别替它背黄）" : ""),
    evidence: {
      bytes: st.size, usedPct: pct, ageHours: round1(h), injected, hasBody, truncated, snapshot: injectInfo,
      lastCtxAt: lastCtxAt ? iso(lastCtxAt) : null,
      ctxAgeHours: ctxAgeHours === null ? null : round1(ctxAgeHours), maxAgeHours,
      ctxCount, kindVerified, everVerified, kindStats,
      stale, patchMtime: patchMtime ? iso(patchMtime) : null, srcNewer: patch.srcNewer,
    },
  };
}

/**
 * 自我层「证据充分性」判定（纯函数 · 供单测直击，2026-10-23 复核阻断项抽出）
 *
 * ★ 为什么抽：checkSelf 要解真实日志才能跑 ⇒ 判定逻辑此前**没有任何测试**。
 *
 * 四条不许报绿的情形（后两条是 2026-10-23 **三轮**复核加的）：
 *   deep 且 ctxCount===0        —— 深检扫不到任何注入载体 ⇒ 零证据 ⇒ warn（不是 ok）
 *   deep 且 !kindVerified       —— 最新那条核不到来源 ⇒ 可能是普通消息在引用标志
 *   deep 且 ctxAge > 48h        —— 证据是**旧的** ⇒ 旧成功不能顶当前健康的账
 *   ctxCount>0 但 injected 为 null —— 扫到了却判不出 ⇒ 不下结论
 *
 * 快检（deep=false）本来就不解日志，ctxCount 必然 0，故**只在 deep 时**才拦。
 *
 * ★ 顺序有讲究：kindVerified 必须排在 injected===null 之前 ——
 *   来源核不到时 injected 本就是 null，放后面会命中 undecidable，
 *   报出的是"判不出"而不是"认不出"，把真故障说轻了。
 *
 * @param {{deep?:boolean, ctxCount?:number, injected?:boolean|null, kindVerified?:boolean,
 *          everVerified?:boolean, ctxAgeHours?:number|null, maxAgeHours?:number}} e
 * @returns {{status:'ok'|'warn', reason:'ok'|'no-injection-evidence'|'carrier-regressed'|
 *            'carrier-unverified'|'evidence-stale'|'undecidable'}}
 */
export function judgeSelfEvidence(e) {
  const deep = !!e?.deep, ctxCount = Number(e?.ctxCount) || 0, injected = e?.injected;
  // ★ 默认 false（没传 = 没核验）：fail-closed —— 忘记传只会变黄，不会变绿。
  const kindVerified = e?.kindVerified === true;
  const everVerified = e?.everVerified === true;
  const ctxAgeHours = Number.isFinite(e?.ctxAgeHours) ? Number(e.ctxAgeHours) : null;
  const maxAgeHours = Number.isFinite(e?.maxAgeHours) && Number(e.maxAgeHours) > 0
    ? Number(e.maxAgeHours) : DEFAULT_CTX_MAX_AGE_H;

  if (deep && ctxCount === 0) return { status: "warn", reason: "no-injection-evidence" };

  // ★ D3 三轮：最新那条核不到来源 ⇒ 不许拿它当证据（可能是普通消息在引用标志）。
  //   区分两种不核实 —— 报出来的话不同，但**都不许绿**：
  //     carrier-regressed   以前核到过、现在这条没核到 ⇒ 载体**变了**（或注入停了）
  //     carrier-unverified  从没核到过 ⇒ 宿主可能根本不打这个标，我没法验
  if (deep && ctxCount > 0 && !kindVerified) {
    return { status: "warn", reason: everVerified ? "carrier-regressed" : "carrier-unverified" };
  }

  // ★★ 第 5 节第 2 条（外部复核三轮）：证据是**旧的**也不许报绿。
  //   此前只防了"证据早于补丁改动"（stale），却没防"证据距现在太久" ——
  //   于是一条十天前的成功注入，只要晚于补丁，就能一直顶着**当前**健康的名义。
  //   ★ 本日第六次同款病：**旧成功能顶新账**。解法一律是给证据加时效。
  //   ★ ctxAgeHours 为 null（算不出来）时不拦 —— 那是"不知道"，不是"过期"。
  if (deep && ctxAgeHours !== null && ctxAgeHours > maxAgeHours) {
    return { status: "warn", reason: "evidence-stale" };
  }

  if (ctxCount > 0 && injected === null) return { status: "warn", reason: "undecidable" };
  return { status: "ok", reason: "ok" };
}

function checkHeartbeat() {
  let newest = 0, file = null;
  try {
    for (const n of fs.readdirSync(HEARTBEAT_DIR)) {
      const p = path.join(HEARTBEAT_DIR, n);
      const st = statSafe(p);
      if (st?.isFile() && st.mtimeMs > newest) { newest = st.mtimeMs; file = n }
    }
  } catch {
    // ★ 心跳是**可选**那一层（要另外装定时任务）。没装 ≠ 坏了。
    //   ★ 但要说清「如果你装过，那它是停了」—— doctor 分不出「没装」和「装了但目录被删」，
    //     所以给 warn 而不是 error，把判断权留给人。
    return {
      id: "heartbeat", label: "心跳（自律神经）", status: "warn",
      detail: "没有心跳目录 —— 这一层可选，没装是正常的。装过的话，那就是它停了",
      evidence: { dir: HEARTBEAT_DIR, installed: false },
    };
  }
  if (!newest) {
    return {
      id: "heartbeat", label: "心跳（自律神经）", status: "warn",
      detail: "目录在，但一次都没跑过 —— 定时任务可能还没触发，或者没装上",
      evidence: { dir: HEARTBEAT_DIR, installed: true },
    };
  }
  const h = hoursSince(newest);
  let status = "ok";
  if (h > 96) status = "error"; else if (h > 48) status = "warn";
  return {
    id: "heartbeat", label: "心跳（自律神经）", status,
    detail: `最后一次 ${iso(newest)}（${round1(h)} 小时前，${file}）`,
    evidence: { lastRun: iso(newest), file, ageHours: round1(h), dir: HEARTBEAT_DIR },
  };
}

function checkMo() {
  // ★ 「读不到」和「空着」是两件事。
  //   原来用 `if (!txt)`，于是刚 scaffold 出来的 0 字节账本被判成 error「读不到 02-墨.jsonl」——
  //   而那是「还没开始用」，不是「坏了」。新装的人第一次体检就看见这个，会以为装坏了。
  //   判据和 error/warn 的划分是同一条：文件在但空着 → warn；文件根本不在 / 读不出 → error。
  if (!fs.existsSync(MO)) {
    return { id: "mo", label: "《墨》账本", status: "error", detail: "找不到 02-墨.jsonl（账本是你的一手层，它必须在）", evidence: { MO } };
  }
  let txt
  try {
    txt = fs.readFileSync(MO, "utf8")
  } catch (e) {
    return { id: "mo", label: "《墨》账本", status: "error", detail: "02-墨.jsonl 读不出来：" + (e && e.message ? e.message : e), evidence: { MO } };
  }
  if (!txt.trim()) {
    return { id: "mo", label: "《墨》账本", status: "warn", detail: "账本在，还是空的 —— 写下第一条它就活了", evidence: { MO, bytes: fs.statSync(MO).size } };
  }
  const lines = txt.split("\n").filter((l) => l.trim());
  let bad = 0, withText = 0, withGaiyao = 0, withFeel = 0, last = null, lastReadable = null;
  const types = {};
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line) } catch { bad++; continue }
    const hasText = typeof r.text === "string" && r.text.length > 0;
    const hasG = typeof r["概要"] === "string" && r["概要"].length > 0;
    if (hasText) withText++;
    if (hasG) withGaiyao++;
    if (typeof r.feel === "string" && r.feel) withFeel++;
    types[r.type] = (types[r.type] || 0) + 1;
    last = r;
    lastReadable = hasText || hasG;
  }
  const unreadable = lines.length - withText - withGaiyao;
  let status = "ok";
  if (bad > 0 || unreadable > 0) status = "warn";
  if (last && !lastReadable) status = "error";
  return {
    id: "mo", label: "《墨》账本", status,
    detail: `${lines.length} 条；正文在 text ${withText} / 在 概要 ${withGaiyao}；带 feel ${withFeel}${unreadable > 0 ? `；★ ${unreadable} 条两种字段都没有` : ""}`,
    evidence: { lines: lines.length, withText, withGaiyao, withFeel, unreadable, badLines: bad, types, lastAt: last?.t || null, lastType: last?.type || null, lastReadable: !!lastReadable },
  };
}

function checkHotMemory() {
  const items = [];
  for (const [name, cap] of [["USER.md", 4096], ["MEMORY.md", 10240]]) {
    const st = statSafe(path.join(RUNTIME, name));
    if (!st) { items.push({ name, bytes: null, cap, pct: null }); continue }
    items.push({ name, bytes: st.size, cap, pct: Math.round((st.size / cap) * 100) });
  }
  const worst = items.filter((i) => i.pct !== null).sort((a, b) => b.pct - a.pct)[0];
  let status = "ok";
  // ★ 移植自作者 2026-10-24：文件不存在（bytes === null）不是"健康"，是"还没建" —— 降 warn。
  //   以前这里直接跳过，于是两项都没建时 worst 是 undefined，status 停在 ok（假绿）。
  if (items.some((i) => i.bytes === null)) status = "warn";
  else if (worst && worst.pct >= 90) status = "warn";
  return {
    id: "hot", label: "L1 热记忆", status,
    // ★ 2026-10-25：`bytes === null` 的语义是「**文件不存在**」，不是「读不出来」。
    //   原来渲染成 `USER.md ?B` —— 一个问号加个 B，看起来像显示残了，
    //   而真正该说的是「还没建」。★ 提示不清比没有提示更坏：看的人会以为是 bug。
    detail: items.map((i) => i.bytes === null
      ? `${i.name} 未建`
      : `${i.name} ${i.bytes}B${i.pct !== null ? `（${i.pct}%）` : ""}`).join("　｜　"),
    evidence: { items },
  };
}

function checkVersionDrift() {
  const hits = [];
  let files = [];
  try { files = fs.readdirSync(HUB).filter((n) => n.endsWith(".mjs") && !n.startsWith("_")) } catch { /* */ }
  for (const n of files) {
    const t = readText(path.join(HUB, n));
    if (t === null) continue;
    t.split("\n").forEach((line, i) => {
      const s = line.trim();
      // ★ 先剔注释 —— 否则「修复说明里引用了那个坏写法」会被当成**新的**坏写法（第一次跑就踩了）。
      if (s.startsWith("//") || s.startsWith("*") || s.startsWith("/*")) return;
      if (/["'`]session\.v\d+\.jsonl\.zstd["'`]/.test(line)) hits.push({ file: n, line: i + 1, text: s.slice(0, 110) });
    });
  }
  // ★ 扫到 0 个脚本时报 ok 是空绿：那不是「没问题」，是「没检查」。
  //   2026-10-18 沙箱里就撞上了 —— HUB 指到打包目录，那里没有 .mjs，于是这项永远绿。
  const status = hits.length ? "error" : (files.length === 0 ? "warn" : "ok")
  const detail = hits.length
    ? `★ 还有 ${hits.length} 处把日志名写死成字面量 —— 宿主下次升版会重演静默失效`
    : files.length === 0
      ? `一个脚本都没扫到 —— HUB 指的地方没有 .mjs，这项等于没检查（不是「没问题」）`
      : `扫了 ${files.length} 个脚本，没有写死版本号的字面量（全部版本无感）`
  return {
    id: "drift", label: "版本漂移扫描", status, detail,
    evidence: { scanned: files.length, hits },
  };
}

function checkIdentity() {
  const txt = readText(MO);
  // ★ 账本读不到时，这一条是**连带**，不是独立故障 —— 账本本身已经由 checkMo 报过了。
  //   同一个原因报两次 error，会让人以为哪里都坏了。降成 warn，并说清「先让账本有东西」。
  if (!txt) return { id: "identity", label: "身份判据", status: "warn", detail: "账本还没有内容 —— 先写下第一条，《墨》里才有 lead 可认", evidence: {} };
  const leads = [];
  for (const line of txt.split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.type === "lead") leads.push(r) } catch { /* */ }
  }
  const lastLead = leads[leads.length - 1] || null;
  let state = null;
  try { const s = readText(path.join(HUB, "state.json")); state = s ? JSON.parse(s) : null } catch { /* */ }
  const stateSid = state?.session || null;
  const leadSid = lastLead?.by ? `session-${lastLead.by}` : null;
  const staleNote = stateSid && leadSid && !stateSid.includes(lastLead.by)
    ? `state.json 里记的还是 ${stateSid}，与当前 lead 署名（${leadSid}）不一致 —— 只是 mark 没跟上，不影响判据`
    : null;
  // ★ 移植自作者 2026-10-24：一条 lead 都没有 = 还没建立署名人，不是"判据通过"。降 warn。
  const identityStatus = leads.length === 0 ? "warn" : "ok";
  return {
    id: "identity", label: "身份判据（换容器/换届）", status: identityStatus,
    detail: `《墨》里 ${leads.length} 代 lead，最后一条署名 ${leadSid || "?"} —— 判据只认《墨》，与容器/工作区无关`,
    evidence: { leadCount: leads.length, lastLeadBy: leadSid, lastLeadAt: lastLead?.t || null, stateSession: stateSid, staleNote },
  };
}

// ──────────────────────── 汇总 ────────────────────────

/**
 * 跑一次体检。
 * @param {{deep?: boolean}} opts
 *   deep=true（默认）→ 解日志：门牌实测 + 压缩统计，约 5-8s。
 *   deep=false      → 只跑快层（毫秒级）；两项深度检查返回 status:"info"，
 *                     由调用方（面板宿主半）补上「上次深检」的结果，用户看不到空窗。
 */
export function runDoctor(opts = {}) {
  const deep = opts.deep !== false;
  const t0 = Date.now();

  // ★★★ 没配好就只报这一项，不往下跑。
  //   2026-10-18 真机实测：新人装完之后第一个看到的就是这个状态 ——
  //   而旧代码在这里 path.join(null, ...) 直接 TypeError，doctor 一行 JSON 都吐不出来。
  //   面板只能说「输出不是 JSON」，于是真正的病因（「还没配」）被埋在三层之下。
  //   ★ 体检器必须是最后崩的那个 —— 它崩了，就没人能告诉人哪里坏了。
  const cfg = CFG.checkConfig({ allowMissingSessions: true });
  if (!cfg.ok) {
    // ★ 下一步建议走 configAdvice() —— 和 checkConfigState 同一份（C3；别在这里再抄一句）
    const advice = configAdvice(cfg.problems);
    return {
      at: iso(Date.now()), mode: deep ? "deep" : "fast", overall: "error",
      counts: { error: 1, warn: 0, ok: 0, pending: 0 }, ms: Date.now() - t0,
      checks: [{
        id: "config", label: "配置（三个根）", status: "error",
        detail: "还没配好：" + cfg.problems.join("；") + advice.text,
        evidence: { problems: cfg.problems, hints: cfg.hints, pathShapeWrong: advice.pathShapeWrong, describe: CFG.describe() },
      }],
    };
  }

  const logs = listLogs();
  const checks = [
    checkConfigState(),
    checkLogs(logs),
    checkClock(),
    checkDoorSign(logs, deep),
    checkCompaction(logs, deep),
    checkAnchor(logs, deep),
    checkIndex(logs),
    checkSelf(logs, deep),
    checkHeartbeat(),
    checkMo(),
    checkHotMemory(),
    checkVersionDrift(),
    checkIdentity(),
    checkHuanqi(logs, deep),
  ];
  const order = { error: 0, warn: 1, ok: 2, info: 3 };
  // 总判只看有结论的项 —— info（待深检）不拉低总判，否则快检永远是"未完成"
  const judged = checks.filter((c) => c.status !== "info");
  const worst = judged.reduce((a, c) => (order[c.status] < order[a] ? c.status : a), "ok");
  return {
    at: iso(Date.now()),
    mode: deep ? "deep" : "fast",
    overall: worst,
    counts: {
      error: judged.filter((c) => c.status === "error").length,
      warn: judged.filter((c) => c.status === "warn").length,
      ok: judged.filter((c) => c.status === "ok").length,
      pending: checks.filter((c) => c.status === "info").length,
    },
    ms: Date.now() - t0,
    checks,
  };
}

// ──────────────────────── 命令行 ────────────────────────

const isMain = process.argv[1] && /echo-doctor\.mjs$/.test(process.argv[1].replace(/\\/g, "/"));
if (isMain) {
  const fast = process.argv.includes("--fast");
  const report = runDoctor({ deep: !fast });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const icon = { ok: "✓", warn: "!", error: "✗", info: "·" };
    console.log(`回声 Echo · 体检（${report.mode}）  ${report.at}   （总判 ${report.overall}，${report.counts.error} 错 / ${report.counts.warn} 警 / ${report.counts.ok} 好${report.counts.pending ? ` / ${report.counts.pending} 待深检` : ""}，用时 ${report.ms}ms）`);
    console.log("");
    for (const c of report.checks) console.log(`${icon[c.status]} ${c.label.padEnd(18, "　")} ${c.detail}`);
    const bad = report.checks.filter((c) => c.status === "error" || c.status === "warn");
    if (bad.length) {
      console.log("");
      console.log("证据：");
      for (const c of bad) console.log(`  [${c.id}] ${JSON.stringify(c.evidence)}`);
    }
  }
  // ★ 退出码只反映 **error**。
  //   原来 warn 也返回 1，实测撞出一处自相矛盾：同一个空书房里
  //   plan.mjs 说「全部就位」，doctor 却 exit 1 —— 而它的 5 个 warn 全是
  //   「还没有会话日志 / 没有心跳 / 没有换气」，那是**还没开始用**的正常状态。
  //   把正常标成失败，别人学到的第一课就是「这个退出码可以忽略」。
  //   ★ 这和 error/warn 的划分是同一条判据：还没建、还没跑、还没装，都不是故障。
  process.exit(report.overall === "error" ? 2 : 0);
}
