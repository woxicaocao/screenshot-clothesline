# 快捷方式绿色箭头检查

2026-10-13 根据用户提供的 Photoshop 图标截图，检查了晾衣架源码、Windows 快捷方式配置及系统默认角标。

- 截图中的箭头位于快捷方式左下角。Windows 会为快捷方式添加角标，见 [微软 Shell Links 文档](https://learn.microsoft.com/en-us/windows/win32/shell/links)。
- 晾衣架的运行源码没有注册表写入、快捷方式创建/修改、系统图标缓存清理或全局箭头替换代码。程序自身的图标只用于自己的窗口及托盘。
- 当前检查没有发现 HKCU / HKLM `Explorer\Shell Icons` 下的全局箭头替换配置。快捷方式的 `IsShortcut` 与标准图标处理器仍存在。
- 用微软的 [SHGetStockIconInfo](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shgetstockiconinfo) 只读取得 `SIID_LINK`，当前系统默认角标来自 `imageres.dll`，资源索引 -163，显示蓝色箭头；对照图在 `test-artifacts/v0.8.0/system-shortcut-overlay.png`。
- 系统还注册了下载工具、网盘和 Adobe 等软件的图标叠加扩展。因此截图中的绿色样式可能涉及其他图标叠加或缓存，但这些信息不足以确定是哪个扩展导致，也不能据此归因于晾衣架。
- 已发送一次 Windows `SHChangeNotify` 图标刷新通知；没有改注册表、停止资源管理器或删除图标缓存文件。无法仅凭旧截图确认桌面角标是否已恢复。

这项系统图标检查与刷新不是晾衣架的常驻功能，不会增加晾衣架运行时的内存。若绿色箭头仍存在，需要结合“只有 Photoshop 变化还是其他快捷方式也变化”的范围继续定位；不能把尚未确认的原因写作已修复。
