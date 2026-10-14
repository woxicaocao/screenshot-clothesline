# 截图晾衣架 0.8.6 · 首次公开发布

**截图和灵感，随手挂在桌面上。** 自动挂图、悬浮对照、彩色便签，让需要的内容随时看得见。

## 先了解「自动捕捉」

照常用 Windows、微信等工具截图，只要新图片进入剪贴板，晾衣架就会自动保存并挂上。复制网页图片也可以自动收集。

工具栏显示 **「暂停」**，表示正在自动捕捉；点击后停止自动收集。显示 **「继续」**，表示已暂停；点击后恢复收集后续新图片。暂停后仍可点击「粘贴」，或把鼠标移到展开的晾衣架按 **Ctrl+V** 手动挂图。启动和恢复时会跳过剪贴板已有内容，重复图片不会反复添加。

## 下载与使用

**Windows 10 / 11 x64 用户请下载 [`screenshot-clothesline-0.8.6-win-x64.zip`](https://github.com/woxicaocao/screenshot-clothesline/releases/download/v0.8.6/screenshot-clothesline-0.8.6-win-x64.zip)**，完整解压后双击「截图晾衣架.exe」，无需安装 Node.js。请保留程序旁边的配套文件。

下方自动生成的 **Source code**，以及 `screenshot-clothesline-0.8.6-source.zip` 都是开发源码，不是可以直接双击运行的 Windows 程序。

## 这一版可以做什么

- 复制网页图片，悬停晾衣架按 Ctrl+V，按需整理素材。
- 点击查看原图，拖动图片移动窗口，拖动边框调整大小。
- 同时打开多张图片，各自悬浮置顶，边工作边对照。
- 把原图拖进文件夹保存，或拖进支持拖放的聊天窗口后确认发送。
- 添加彩色便签，自定义颜色与字号，支持多张便签和独立置顶。
- 开启自动隐藏，快、中、慢分别为立即、1 秒、2 秒收起，移到对应屏幕顶部重新展开。
- 普通展示「赞赏」入口；截图、便签与设置仅在本机保存。

## 观看演示

[观看 / 下载完整视频「截图晾衣架功能演示_0.8.6OK.mp4」](https://github.com/woxicaocao/screenshot-clothesline/releases/download/v0.8.6/%E6%88%AA%E5%9B%BE%E6%99%BE%E8%A1%A3%E6%9E%B6%E5%8A%9F%E8%83%BD%E6%BC%94%E7%A4%BA_0.8.6OK.mp4)，横屏 16:9，约 49 秒。`demo-preview.mp4` 是同内容、同配音的较小播放副本；完整原视频保留不变。

原图、便签和设置保存在 `%APPDATA%\screenshot-clothesline`。升级时先退出旧版，保留该数据目录即可继续使用。

源码采用 MIT 许可证。下载附件包含 `使用说明.md`、`LICENSE-MIT.txt` 和 `SHA256SUMS.txt`；校验文件用于核对下载完整性。详细功能与常见问题见[项目介绍](https://github.com/woxicaocao/screenshot-clothesline)，问题反馈请[提交 Issue](https://github.com/woxicaocao/screenshot-clothesline/issues)。
