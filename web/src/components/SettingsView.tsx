import { useState } from "react";
import SettingsKeys from "./SettingsKeys";
import SettingsModel from "./SettingsModel";
import SettingsProjects from "./SettingsProjects";
import SettingsSisters from "./SettingsSisters";

type Props = {
  onAuthLost: () => void;
  /** 项目建好之后的那句「去研究里起 run」。 */
  onGoResearch: () => void;
};

type Block = "model" | "sisters" | "projects";

const BLOCKS: Array<{ id: Block; label: string }> = [
  { id: "model", label: "模型与密钥" },
  { id: "sisters", label: "Sisters" },
  { id: "projects", label: "项目" },
];

/** 配置台（CONTRACT §3.7）：三块，都在这一页里，不引入路由库。 */
export default function SettingsView({ onAuthLost, onGoResearch }: Props) {
  const [block, setBlock] = useState<Block>("model");

  return (
    <div className="list">
      <div className="chip-row" role="group" aria-label="设置分区">
        {BLOCKS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={"btn btn--chip" + (block === item.id ? " btn--chip-active" : "")}
            aria-pressed={block === item.id}
            onClick={() => setBlock(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {block === "model" ? (
        <>
          <SettingsModel onAuthLost={onAuthLost} />
          <SettingsKeys onAuthLost={onAuthLost} />
        </>
      ) : block === "sisters" ? (
        <SettingsSisters onAuthLost={onAuthLost} />
      ) : (
        <SettingsProjects onAuthLost={onAuthLost} onGoResearch={onGoResearch} />
      )}
    </div>
  );
}
