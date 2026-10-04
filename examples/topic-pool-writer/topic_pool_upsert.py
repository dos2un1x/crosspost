#!/usr/bin/env python3
"""候选池写入 —— 项目侧**只做转发**（通用实现在引擎里，见同目录 README）。

参数形状与本脚本的前身一致，所以写作 SOP 里那几条调用不用改：

    python3 topic_pool_upsert.py --date 2026-10-01 --slot hotspot \
      --json '[["<kw>","",87,"rejected","<原因>"]]'

    python3 topic_pool_upsert.py --date 2026-10-01 --slot hotspot --manual \
      --article-id 2026-10-01-hotspot-<slug> \
      --json '[["<kw>","<标题>",70,"generated","人工指定采用（Console 一键生成）"]]'

为什么不再自己实现：同一份 `topic-pool.json` 有两个写入者（引擎回填 / 项目侧候选入库），
行形状、合并规则、写锁散成两份实现时，任何一份漏掉一条，症状都出现在别处。
真正的规则在引擎的 `crosspost-runtime/src/topic-pool.mjs`，这里只转发。

退出码：0 写入成功；1 被拒（形状不对、条目数会减少、找不到引擎或项目）——**原样透传**，
让那一轮响亮失败，而不是悄悄跳过。
"""
import os
import subprocess
import sys

ENGINE_REPO = os.environ.get('CROSSPOST_ENGINE_REPO', '/Users/me/crosspost')
CLI = os.path.join(ENGINE_REPO, 'crosspost-runtime', 'src', 'cli.mjs')


def main(argv):
    if not os.path.isfile(CLI):
        print('找不到引擎 CLI：%s' % CLI, file=sys.stderr)
        print('把引擎放在别处就用 CROSSPOST_ENGINE_REPO 指过去（本项目不自己实现写入）',
              file=sys.stderr)
        return 1
    node_bin = os.environ.get('CROSSPOST_NODE') or 'node'
    try:
        # 不走 shell：参数原样传给引擎，避免二次解释（候选 JSON 里可能带引号/中文标点）
        proc = subprocess.run([node_bin, CLI, 'topicPoolUpsert'] + list(argv))
    except FileNotFoundError:
        print('找不到 node（可用 CROSSPOST_NODE 指定）', file=sys.stderr)
        return 1
    return proc.returncode


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
