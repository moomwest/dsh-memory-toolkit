# dsh-memory-toolkit

给 [DSH（DeepSeek Harness）](https://github.com/xingj404-lab/dsh-desktop) 的记忆/压缩系统打的几块「补丁」。
目标很简单：**压缩之后，你仍能看见、能恢复、有安全网、还能事前体检。**

> 缘起：DSH 内置的兜底压缩（`@deepseek-ai/dsh-compaction-basic`）压完之后，产物是「每一条都对、每一条都无从核对」的——这也是上游长期讨论的「压缩后缺手动恢复路径」限制的由来。
> 本仓库不重复造压缩轮子，而是在它的基础上补齐「可见性 / 恢复 / 安全 / 体检」这几块公认缺口。

---

## 先读这个（30 秒）

**它不会让压缩变好，它让压缩之后可追溯。** 压缩本身仍由 DSH 宿主完成，本仓库只补四件事：
门牌（摘要里留可回取的指针）、净化层（只观测不改产物）、剥离（避开会引起失败的坏块）、体检（事前报错而不是静默）。

**什么情况下先别装：**

- 你的 DSH 不是 0.1.x —— 本仓库对着 0.1.7-rc.1 实测，0.2.x 的 preset 接管行为不同（那版还有 `sanitizeProfile` 重置 profile 的坑）。
- 你只有一个 profile 且它是你唯一在用的 —— 装错要回退，先读下面的「回退」。
- 你期待它提升压缩质量 —— 它不改压缩算法，一行摘要也是宿主写的。

**装完没生效，先别怀疑安装** —— 读 [`compaction/HOW-TO-TAKEOVER.md`](./compaction/HOW-TO-TAKEOVER.md)。
cordis 的服务注册是**先到先得**：同名 Service 后注册的**不报错、不警告、静默不生效**。
那一页讲的就是「为什么我装了，兜底压缩还是内置那套」，以及两条接管路径。

---

## 组件

### 1. `compaction/` —— 给兜底压缩装「门牌」

- **门牌（doorsign）**：自动摘要前插入可回溯指针（`⛬ 压缩索引（非原文）`），列出被遮蔽全集（含区间外的条目），让兜底产物也能按记忆架构回取原文。
- **净化层（purify / purify-shadow）**：**零侵入**影子观测——只把新摘要写进影子日志，**绝不改动你的会话产物**；对敏感块做 R0 脱敏，是别人没做的「只记录、不干预」安全网。
- **strip**：摘要前剥离非文本块（image/audio/file 等引用式块），避免因坏块导致压缩在本地准备阶段就失败。

### 2. `echo-doctor/` —— 记忆体检器

全库逐帧核查 DSH 记忆中枢（`memory/hub`）与书房（`soul`）的健康状态：配置是否指错一层目录、索引/SELF 是否装配、各层一致性……给出**人类可读的报错与修复提示**，而不是静默继续。

---

## 目录结构

```
dsh-memory-toolkit/
├── compaction/          # dsh-agent-compaction 插件
│   ├── index.js         # YanqingCompaction 接管 + 门牌
│   ├── lib/
│   │   ├── doorsign.js  # 门牌生成 / shadowedSeqs 切片
│   │   ├── purify.js     # 净化层核心（脱敏 + 影子日志）
│   │   └── strip.js      # 非文本块剥离
│   ├── tools/           # 接管工具 / 扫描器 / 探针
│   ├── test/            # 单元测试 + 集成测试
│   ├── cordis.patch.yml # preset 接管补丁（参考）
│   └── HOW-TO-TAKEOVER.md  # ★ 装完没生效，读这个
├── echo-doctor/         # 记忆体检器
│   ├── echo-doctor.mjs
│   └── echo-config.mjs  # 唯一的配置源（env / 命令行 / config.json）
├── LICENSE
└── README.md
```

---

## 安装与使用

两个组件都是**独立**的，可单独使用。

### 0. 拿到代码：npm 或 clone

两个包都已发布到 npm：

| 包 | 用途 | |
|---|---|---|
| [`dsh-agent-compaction`](https://www.npmjs.com/package/dsh-agent-compaction) | 压缩门牌 + 净化层 + 剥离 | 0.1.0 |
| [`dsh-echo-doctor`](https://www.npmjs.com/package/dsh-echo-doctor) | 记忆体检器（CLI） | 0.1.0 |

**体检器可以直接跑，不用 clone：**

```bash
npx dsh-echo-doctor --soul /path/to/soul --memory /path/to/memory
```

**压缩插件要接进 profile**，而 `dsh plugin add` 收的是**目录路径**而不是包名，所以先把它落到本地：

```bash
npm i dsh-agent-compaction      # 装进 node_modules，再把那个目录指给 dsh plugin add
# 或者直接 clone 整个仓库（带测试与工具）
git clone https://github.com/moomwest/dsh-memory-toolkit.git
```

> 无运行时依赖，不需要构建，也不需要 `npm install` 之外的其他步骤。

### 1. compaction 插件

它是 DSH 的一个 bundle 插件，靠 `cordis.patch.yml` 接管 preset 内的压缩器。关键配置（在你的 profile 里）：

```yaml
- id: compaction-basic
  name: dsh-agent-compaction      # 只换 name 不换 id = 替换，不触发先到先得
  config:
    thresholdRatio: 0.5           # 中文按 CHARS_PER_TOKEN=4 被低估 3–4 倍，故比默认 0.7 更激进
    retainRatio: 0.16
    auto: true
  isolate: ...                    # 必须保留：提供服务者与其消费者须同 realm
```

环境变量：

| 变量 | 作用 | 默认 |
|---|---|---|
| `DSH_COMPACTION_DEBUG_LOG` | 门牌生成诊断日志路径 | `~/.dsh/compaction-debug.log` |
| `DSH_HOME` | DSH home（会话日志在 `<home>/sessions`） | `~/.dsh` |

### echo-doctor 体检器

```bash
# 方式一：环境变量
export ECHO_SOUL=/path/to/soul
export ECHO_MEMORY=/path/to/memory
node echo-doctor/echo-doctor.mjs

# 方式二：命令行参数
node echo-doctor/echo-doctor.mjs --soul /path/to/soul --memory /path/to/memory

# 方式三：echo.config.json（放在脚本同目录或上级）
#   { "soul": "...", "memory": "..." }
```

> 配置优先级：**命令行参数 > 环境变量 > echo.config.json > 推断**。`soul` 和 `memory` 缺了会直接停下并告诉你怎么办（不静默继续）。

---

---

## 回退（先看这个再动手）

装的过程会动你的 profile：`bundles` 的顺序、以及内置压缩项的启用状态。
**要退，就退这几处，然后重启 DSH：**

1. `bundles` 里删掉 `dsh-agent-compaction`（以及你可能一起排过的 pruner）。
2. 把被禁用的内置压缩项恢复回 `bundles`。
3. 重启 DSH（宿主半只在进程启动时加载一次）。

★ **改之前先复制一份 profile 的 `package.json`**。具体字段以你那份快照为准，别照抄别人的。

**回退不会丢记忆。** 本仓库的边界是：不碰落盘策略、不改 `compaction-basic` 的任何文件、不改你的 checkpoint、不碰 `soul/`。
它只在摘要**生成前**插入一段文本，以及往影子日志写观测记录。压缩失败时它降级成「照常压缩，只是没加指针」。

想确认自己装到哪一步了，不用等一次真实压缩 —— 见 [`compaction/HOW-TO-TAKEOVER.md`](./compaction/HOW-TO-TAKEOVER.md) 的「怎么验」一节。

## 测试

```bash
cd compaction
node --test                     # 单元 + 集成；集成测试需本机 DSH

# 跑针对你本机 DSH 安装的集成测试（缺省会自动跳过）：
DSH_TEST_ASAR="C:/.../resources/app.asar" \
DSH_TEST_PROFILE="路径/cordis.patch.yml" \
node --test
```

- 单测不依赖任何个人数据，开箱即跑。
- 集成测试（`test/preset-takeover.mjs`）需要你本机的 `app.asar` 和一份 profile 快照，未设置环境变量时**自动跳过**，不会红。

---

## 与上游的关系

本仓库是 DSH 生态的**补充层**，不是 fork：

- 压缩实质仍由宿主完成，我们只是薄壳接管；
- 门牌 / 净化层 / 体检器的思路，直接回应了上游「压缩后缺手动恢复路径」这一公认限制；
- 兼容 `dsh-compaction-basic` / `dsh-compaction` 的 peer 约定。

欢迎基于本仓库向 DSH 上游或社区插件市场贡献。

## License

[MIT](./LICENSE) · © 2026 dsh-agent-organs contributors
