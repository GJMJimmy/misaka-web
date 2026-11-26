import { useCallback, useEffect, useState } from "react";

/**
 * Service Worker 注册 + 更新提示（手写 SW，见 public/sw.js）。
 *
 * **只在生产构建里注册**：dev 服务器的模块热更新会被缓存干扰。
 * 这里的每个 navigator.serviceWorker 访问都在 ENABLED 判断之后。
 */
const ENABLED = import.meta.env.PROD;

export function useServiceWorker(): {
  updateReady: boolean;
  applyUpdate: () => void;
  offline: boolean;
} {
  const [updateReady, setUpdateReady] = useState(false);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    if (!ENABLED) return; // dev: 不注册
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    let cancelled = false;

    const register = async () => {
      try {
        const scope = import.meta.env.BASE_URL || "./";
        const registration = await navigator.serviceWorker.register(`${scope}sw.js`, { scope });
        if (cancelled) return;
        setRegistration(registration);

        // 已有 waiting 的 SW = 上次留下的新版本
        if (registration.waiting && navigator.serviceWorker.controller) setUpdateReady(true);

        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            // 有 controller 才说明这是"更新"，而不是首次安装
            if (installing.state === "installed" && navigator.serviceWorker.controller) setUpdateReady(true);
          });
        });
      } catch {
        /* SW 注册失败不影响主流程 */
      }
    };

    void register();
    return () => {
      cancelled = true;
    };
  }, []);

  const applyUpdate = useCallback(() => {
    const waiting = registration?.waiting;
    if (waiting) waiting.postMessage({ type: "SKIP_WAITING" });
    window.setTimeout(() => window.location.reload(), 150);
  }, [registration]);

  return { updateReady, applyUpdate, offline: useOffline() };
}

/** 离线状态：banner 用，恢复在线自动消失。 */
export function useOffline(): boolean {
  const [offline, setOffline] = useState(
    () => typeof navigator !== "undefined" && navigator.onLine === false,
  );

  useEffect(() => {
    const goOnline = () => setOffline(false);
    const goOffline = () => setOffline(true);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return offline;
}
