# game-assets-cocos

Cocos Creator 3.8.8 最小验收工程：用 `artcraft-game-assets` 扩展导入
`test_data/game_assets/pack_v2_minimal`（manifest 2.0 固定样例包），核对
导入、幂等、面板与引擎报告链路。

工程只提交 `package.json` 与 `assets/main.scene`。扩展编译产物与样例包副本由
`sync_fixtures.sh` 从源位置同步（不入库）；`settings/`、`library/` 等状态目录
由编辑器首次打开时生成（已忽略），因此无需手写任何 settings。

## 验收步骤

```sh
./sync_fixtures.sh
/Applications/Cocos/Creator/3.8.8/CocosCreator.app/Contents/MacOS/CocosCreator --project "$(pwd)"
```

1. 工程打开后菜单出现「Artcraft 资产」（扩展随 `extensions/` 自动加载）。
2. 「Artcraft 资产 / 导入资产包」选择 `assets/game_assets/pack_v2_minimal`
   目录（含 manifest.json）；导入成功后文件安装在受管目录
   `assets/game_assets/pack_v2_minimal_v1/`。
3. 「Artcraft 资产 / 打开面板」查看已安装资产、依赖与导入报告
   （hero / walk_2d / spin_3d 三项）。
4. 重复第 2 步：再次导入应全部 unchanged（journal 幂等）。
5. 引擎报告 JSON 落在 `game_assets_reports/`，可回到工作台对应交付记录上传核对。

自动化替代（无需手动操作，临时工程自建同样结构并驱动真实编辑器）：

```sh
python3 script/artcraft/game-assets/test_cocos_probes.py            # 结束行 ARTCRAFT_COCOS_PROBES_OK
python3 script/artcraft/game-assets/test_cocos_import_lifecycle.py  # 结束行 ARTCRAFT_COCOS_LIFECYCLE_OK
```

## 目录

```
package.json        # creator 3.8.8 工程清单（uuid 固定）
assets/main.scene   # 最小场景（相机 + 平行光 + 全局设置，编辑器自动导入）
extensions/         # sync_fixtures.sh 同步的 artcraft-game-assets 扩展
assets/game_assets/ # 样例包副本（pack_v2_minimal）与扩展受管安装目录
game_assets_reports/ # 扩展写入的引擎报告
```
