export const INTEGRATION_COMPONENTS = {
  godot: { name: "Godot 插件与预览工程", version: "0.5.0", engineVersion: "4.7.2", url: new URL("./integration-bundles/artcraft-godot-0.5.0.zip", import.meta.url).href },
  bevy: { name: "Bevy 集成 crate 与运行示例", version: "0.3.0", engineVersion: "0.20.0", url: new URL("./integration-bundles/artcraft-bevy-0.3.0.zip", import.meta.url).href },
  cocos: { name: "Cocos Creator 扩展与运行示例", version: "0.1.0", engineVersion: "3.8.8", url: new URL("./integration-bundles/artcraft-cocos-0.1.0.zip", import.meta.url).href },
} as const;
