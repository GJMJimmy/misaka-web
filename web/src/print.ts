/**
 * 导出/打印：加一个 body class 让 @media print 知道该只打印 sheet 还是整页。
 *
 * 摘掉 class 只依赖 afterprint：打印对话框可能开着十几秒，早摘会让用户点「打印」时拿到
 * 屏幕布局。60s 只是一条防止事件丢失的保险丝（屏幕上不影响任何东西）。
 */
export function printCurrentView(mode: "page" | "sheet" = "page"): void {
  const className = mode === "sheet" ? "print-sheet" : "print-page";
  document.body.classList.add(className);

  const cleanup = () => {
    document.body.classList.remove(className);
    window.removeEventListener("afterprint", cleanup);
  };

  // 有的浏览器（Safari、headless Chromium）在对话框出现前就发 afterprint；
  // beforeprint 才是「马上要排版了」那一刻，在这里把 class 补回去。
  window.addEventListener("beforeprint", () => document.body.classList.add(className));
  window.addEventListener("afterprint", cleanup, { once: true });
  // 若浏览器在打印前重排，class 仍在；事件丢了的兜底足够长，不会截断打印对话框。
  window.setTimeout(cleanup, 60_000);
  window.print();
}