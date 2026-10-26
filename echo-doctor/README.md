# dsh-echo-doctor

给 DSH 的记忆层做体检的命令行工具。全库逐帧核查 `memory/hub`（记忆中枢）与 `soul`（书房），
把「配置指错一层目录、索引没装配、SELF 没重建、各层互相不一致」这类问题变成**人类可读的报错**，
而不是让它静默继续。

## 用

```bash
# 方式一：环境变量
ECHO_SOUL=/path/to/soul ECHO_MEMORY=/path/to/memory npx dsh-echo-doctor

# 方式二：命令行参数
npx dsh-echo-doctor --soul /path/to/soul --memory /path/to/memory

# 方式三：echo.config.json（脚本同目录或上级）
#   { "soul": "...", "memory": "..." }
```

**配置优先级：命令行参数 > 环境变量 > echo.config.json > 推断。**
`soul` 或 `memory` 缺了会**直接停下并告诉你怎么办** —— 这是它与同类工具最大的区别：
宁可报错，也不猜一个错的路径继续跑。

## 它不管什么

不改你的任何文件，不写记忆，不修问题 —— 只**报告**。
要照它说的改，是你自己的动作。

## License

MIT
