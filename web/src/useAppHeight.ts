import { useEffect } from "react";

/**
 * 用 100dvh + visualViewport 高度驱动外层布局高度：
 * 移动端软键盘弹出时 visualViewport 变矮，输入框仍然贴在可视区底部、不被遮挡。
 */
export function useAppHeight(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    const apply = (): void => {
      const height = vv ? vv.height : window.innerHeight;
      document.documentElement.style.setProperty("--app-height", `${Math.round(height)}px`);
    };
    apply();
    vv?.addEventListener("resize", apply);
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", apply);
    return () => {
      vv?.removeEventListener("resize", apply);
      window.removeEventListener("resize", apply);
      window.removeEventListener("orientationchange", apply);
    };
  }, []);
}
