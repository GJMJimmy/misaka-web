import { useCallback, useEffect, useRef, useState } from "react";
import { listRuns } from "./api";
import { statusTone } from "./format";
import type { RunSummary } from "./types";

/** 标签页标题前缀用；index.html 里的 <title> 也是这个。 */
export const BASE_TITLE = "MISAKA WebUI";

const POLL_MS = 30_000;

export type ReminderCounts = { awaiting: number; failed: number; attention: number };

const ZERO: ReminderCounts = { awaiting: 0, failed: 0, attention: 0 };

function countsOf(runs: RunSummary[]): ReminderCounts {
  let awaiting = 0;
  let failed = 0;
  for (const run of runs) {
    const pending = Number(run.awaiting_approval);
    if (Number.isFinite(pending) && pending > 0) awaiting += pending;
    if (statusTone(run.status) === "err") failed += 1;
  }
  return { awaiting, failed, attention: awaiting + failed };
}

/**
 * 待办提醒（不引 Web Push）：
 * - 页面**可见**时每 30s 拉一次 GET /api/runs，隐藏时停；
 * - 「待审批数 + 失败数」写进 document.title 前缀，并作为研究 tab 的小圆点；
 * - 只有用户已授予 Notification 权限、且计数**增加**时，才发一条本地通知
 *   （页面打开时的提醒，不是服务端推送）；权限请求只由设置里的按钮触发。
 */
export function useReminders(enabled: boolean): {
  counts: ReminderCounts;
  notificationSupported: boolean;
  permission: NotificationPermission | "unsupported";
  requestPermission: () => Promise<void>;
} {
  const [counts, setCounts] = useState<ReminderCounts>(ZERO);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  const previous = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setCounts(ZERO);
      previous.current = 0;
      return;
    }

    let alive = true;
    let timer: number | null = null;

    const poll = async () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      try {
        const runs = await listRuns();
        if (!alive) return;
        const next = countsOf(runs);
        setCounts(next);

        const canNotify = typeof Notification !== "undefined" && Notification.permission === "granted";
        if (canNotify && next.attention > previous.current) {
          try {
            const body =
              next.failed > 0
                ? `${next.awaiting} 个待审批、${next.failed} 个失败 —— 打开研究页看一眼。`
                : `${next.awaiting} 个运行在等你审批。`;
            const note = new Notification(`MISAKA：${next.attention} 项待办`, {
              body,
              tag: "misaka-runs",
            });
            note.onclick = () => {
              window.focus();
              note.close();
            };
          } catch {
            /* 某些环境（非安全上下文）会抛错，静默 */
          }
        }
        previous.current = next.attention;
      } catch {
        /* 网络/认证问题静默：别用提醒把界面吵醒 */
      }
    };

    const start = () => {
      if (timer !== null) return;
      timer = window.setInterval(() => void poll(), POLL_MS);
    };
    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void poll();
        start();
      } else {
        stop();
      }
    };

    void poll();
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      alive = false;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);

  useEffect(() => {
    document.title = counts.attention > 0 ? `(${counts.attention}) ${BASE_TITLE}` : BASE_TITLE;
  }, [counts.attention]);

  const requestPermission = useCallback(async () => {
    if (typeof Notification === "undefined") return;
    try {
      setPermission(await Notification.requestPermission());
    } catch {
      /* ignore */
    }
  }, []);

  return {
    counts,
    notificationSupported: typeof Notification !== "undefined",
    permission,
    requestPermission,
  };
}
