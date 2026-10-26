#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
zstd-dump.py —— 影子管道的解压子进程（S3）
用法：python zstd-dump.py <session.v4.jsonl.zstd> > out.jsonl

职责单一：把多帧 zstd 会话文件解压成明文 jsonl 写到 stdout。

★★ 2026-10-24 重构（外部复核第六轮阻断链的最后一环）：
   原来用 `stream_reader(f, read_across_frames=True)`。实测发现它**对截断帧既不抛
   异常也不告警**——读到尾部不完整的帧就静默停止：
     · 半帧文件（帧1 完整 + 帧2 截断）⇒ exit 0、stdout 只有帧1、**stderr 全空**
     · 于是 node 侧拿不到"只读到一部分"的信号 ⇒ partial-read 判据形同虚设
     · 帧2 的内容被静默丢弃，且长得跟"完整读完"一模一样
   试过并**否决**的三种检测办法（都测过，别重走）：
     ① `f.tell()`     —— stream_reader 是缓冲读取，tell 反映**文件位置**而非
                          "成功解压的位置"（半帧文件 tell = 文件总大小）⇒ 测不出
     ② 包装 reader 记 read 量 —— stream_reader 会**预读整个文件** ⇒ 半帧也读到 EOF ⇒ 测不出
     ③ `decompress(data, read_across_frames=True)` —— 该 API 在 zstandard 0.25.0 **未实现**
   采用：**逐帧 decompressobj + 流式小块喂入**。能可靠区分，且不退化性能。

   ★ 性能坑（实测，改这段前必读）：
     · 逐帧但每帧喂"剩余全部数据" ⇒ `unused_data` 每帧全量复制 ⇒ **O(n²)**，
       4.8MB / 2182 帧实测 **15.31 秒**（stream_reader 只要 0.09s，慢 170 倍）
     · 改用 `data.find(MAGIC)` 定位边界 ⇒ 每帧全量扫描 ⇒ 仍 O(n²)，实测 **21.06 秒**
     · **正解：小块喂入（64KB/次）** ⇒ unused_data 只剩一小块 ⇒ O(n)，
       同样 2182 帧实测 **0.27 秒**。帧边界靠 `fed - len(unused_data)` 精确定位。

契约（保持不变）：
   · 坏帧/截断 ⇒ **仍然 exit 0**（不把管道搞崩，任务书 S3 工程约束②）
   · 已读到的完整帧照常写到 stdout（半帧保护）
   · **stderr 必须留告警** —— node 侧 `judgeScanCompletion` 靠它判 `partial-read`，
     留空就等于把"只抢救到一部分"伪装成"完整扫完"（漏报比报错更坏）
   · 只在"缺 zstandard 库 / 参数不足"时 exit 2
"""
import mmap
import os
import sys

try:
    import zstandard as zstd
except ImportError:
    print('[zstd-dump] 缺 zstandard 库（managed python 应有）：pip install zstandard', file=sys.stderr)
    sys.exit(2)

# 喂入块大小：太大 ⇒ unused_data 每帧复制量大（O(n²)）；太小 ⇒ API 调用次数爆炸
CHUNK = 1 << 16

def main():
    if len(sys.argv) < 2:
        print('[zstd-dump] 用法: zstd-dump.py <file.jsonl.zstd>', file=sys.stderr)
        sys.exit(2)
    path = sys.argv[1]
    dctx = zstd.ZstdDecompressor()
    out = sys.stdout.buffer
    n = os.path.getsize(path)
    # ★ 空文件（0 字节）直接算读完 —— 里面确实没有内容，也不算失败。
    #   mmap 不接受长度 0，所以这条分支必须在前。
    if n == 0:
        sys.exit(0)
    with open(path, 'rb') as f:
        # ★ mmap 而非 open().read()（外部复核第七轮观察）：
        #   原实现把整个压缩文件读进内存（最大实测 45.1MB），峰值 RSS ≈ 文件大小。
        #   mmap 只建映射、按需调页，语义上才是"不把整个文件拽进内存"。
        #   ★ 不显式 mv.release()/mm.close()：decompressobj 内部会缓存最后一片
        #     memoryview，显式 close 会撞 BufferError。这是**一次性子进程**，
        #     进程退出即由 OS 回收映射，无需手动清理。
        mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        mv = memoryview(mm)
        pos = 0
        warned = False
        while pos < n:
            dobj = dctx.decompressobj()
            fed = pos
            try:
                while not dobj.eof and fed < n:
                    piece = mv[fed:min(fed + CHUNK, n)]
                    chunk = dobj.decompress(piece)
                    if chunk:
                        out.write(chunk)
                        out.flush()
                    fed += len(piece)
            except Exception as e:
                # 坏帧：已输出的完整帧继续可用，残行由消费侧 JSON parse 容错
                if not warned:
                    print('[zstd-dump] 坏帧，已输出 %d 字节完整内容，剩余 %d 字节未解压: %s'
                          % (pos, n - pos, e), file=sys.stderr)
                    warned = True
                break
            if not dobj.eof:
                # ★ 帧未完整结束 = 尾部截断（会话文件 append 中很常见）。
                #   **必须告警**：node 侧靠这条判 partial-read，静默就等于放行漏读。
                if not warned:
                    print('[zstd-dump] 尾部帧未完整结束（截断/写入中），已输出 %d 字节，'
                          '未消费 %d 字节' % (fed - pos, n - fed), file=sys.stderr)
                    warned = True
                break
            adv = fed - pos - len(dobj.unused_data)
            if adv <= 0:
                # 防御：不推进就退，宁可告警也不要死循环
                if not warned:
                    print('[zstd-dump] 帧解压无进展，停止于 %d/%d' % (pos, n), file=sys.stderr)
                    warned = True
                break
            pos += adv
    # 正常走完（pos == n）不告警
    sys.exit(0)

if __name__ == '__main__':
    main()
