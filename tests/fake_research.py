"""Stand-in for the misaka research CLI in tests: commits a run to the board, then idles.

With --resume it creates nothing, so resume tests do not litter the board.
"""

from __future__ import annotations

import os
import pathlib
import sys
import time


def main() -> int:
    argv = sys.argv[1:]
    if "--resume" in argv:
        print("fake research child resumed", argv[-1], flush=True)
        time.sleep(float(os.environ.get("MISAKA_WEB_FAKE_SLEEP", "30")))
        return 0

    from misaka.core.platform import tasks as task_store
    from misaka.core.research import runs as upstream

    question = argv[0] if argv else "测试问题"
    home = pathlib.Path(os.environ["MISAKA_WEB_MISAKA_HOME"])
    (home / "state").mkdir(parents=True, exist_ok=True)
    con = task_store.connect(str(home / "state" / "board.db"))
    upstream.init(con)
    run = upstream.create(con, workspace=os.getcwd(), question=question, limits=upstream.normalize_limits({}))
    con.commit()
    print("fake research child started", run["id"], flush=True)
    time.sleep(float(os.environ.get("MISAKA_WEB_FAKE_SLEEP", "30")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
