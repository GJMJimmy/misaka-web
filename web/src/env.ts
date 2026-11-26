/** 构建期配置：VITE_API_BASE（后端地址）、VITE_MOCK（本地 mock 后端）。 */
const RAW_BASE = import.meta.env.VITE_API_BASE;

/** 后端基址，末尾斜杠去掉；留空表示同源（生产形态：Python 服务直接托管 dist/）。 */
export const API_BASE: string =
  typeof RAW_BASE === "string" ? RAW_BASE.replace(/\/+$/, "") : "";

/** VITE_MOCK=1 时挂载 src/mock.ts 的本地后端。 */
export const MOCK: boolean =
  import.meta.env.VITE_MOCK === "1" || import.meta.env.VITE_MOCK === "true";

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export const API_BASE_LABEL: string = API_BASE === "" ? "同源" : API_BASE;
